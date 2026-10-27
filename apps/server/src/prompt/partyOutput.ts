import type { FastifyReply } from 'fastify';
import type { Ctx } from '../ctx.js';
import { many, one, run, nowIso, uid } from '../db/index.js';
import { getPath, insertMessage, messageOut, parseMessageMeta, setHead, updateMessage } from '../db/tree.js';
import type { ConversationRow, MessageMeta, MessageRow, Scene } from '../types.js';
import { PROMPT_VERSION } from '../config.js';
import { createChatEventStream } from '../contracts/chatEventAdapter.js';
import { createLineGate, type LineGateConfig, type VerifiedUnit } from './partyLineGate.js';
import { supportsPartyObservation, loadStoryRoster } from './dialogContext.js';
import { PUBLIC, type Audience } from './observation.js';
import type { GenParams, GenResult } from '../model/adapter.js';
import { PrivateValidationError, classifyTurnTermination } from '../model/generationFailure.js';
import { TurnDeadline, withCallDeadline, isTurnDeadlineError } from '../model/turnDeadline.js';
import { PartyMetrics } from '../model/partyMetrics.js';
import { estimateMessageTokens, getCalibration } from './tokens.js';

/** Runtime flag is sampled once per turn; off uses the original implementation. */
export const partyOutputEnabled = () => process.env.RPCHAT_PARTY_OUTPUT === '1';
export function partyOutputMutationBlocked(ctx: Ctx, conversationId?: string | null, characterId?: string | null): boolean {
  if (!partyOutputEnabled()) return false;
  return ctx.queue.activeList.some(g => {
    const conv = one<ConversationRow>(ctx.db, 'SELECT * FROM conversations WHERE id=?', g.conversationId);
    return conv && supportsPartyObservation(ctx.db, conv) && (conv.id === conversationId || Boolean(characterId && (conv.character_id === characterId || loadStoryRoster(ctx.db, conv).some(c => c.id === characterId))));
  });
}

/** Model roles do not grant the player permission to receive a private result. */
export function userVisibleRequests<T extends { audience: NonNullable<GenParams['audience']>; outputAudience?: Audience }>(requests: T[]): Array<T & { outputAudience: Audience }> {
  return requests.flatMap(request => {
    const audience = request.outputAudience ?? (request.audience.kind === 'public' ? PUBLIC :
      { visibility: 'private' as const, recipient_ids: [request.audience.kind === 'actor' ? request.audience.actor_id : 'gm'], observer_ids: [] });
    if (audience.visibility === 'private' && !audience.recipient_ids.includes('user')) return [];
    return [{ ...request, outputAudience: audience }];
  });
}
class OutputRequestError extends Error { }
export type OutputRequest = {
  pass: string;
  params: Omit<GenParams, 'signal'>;
  gate: LineGateConfig;
  audience: Audience;
  exposure: 'public_verified_stream' | 'private_hold_until_turn_success';
  hold?: boolean;
  timeoutMs: number;
  optional?: boolean;
};

/** Own writes change only head/messages, never the accepted permission inputs. */
export class OutputPermissionGuard {
  private readonly snapshot: string;
  private readonly sourceIds: string[];
  private readonly characterIds: string[];
  constructor(private ctx: Ctx, private conv: ConversationRow) {
    this.sourceIds = getPath(ctx.db, conv).map(row => row.id);
    this.characterIds = [conv.character_id, ...loadStoryRoster(ctx.db, conv).map(c => c.id)].filter((id): id is string => typeof id === 'string').sort();
    this.snapshot = this.read();
  }
  private read(): string {
    const { db } = this.ctx;
    const c = one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', this.conv.id);
    const messages = this.sourceIds.map(id => one(db, 'SELECT id,parent_id,content,status,meta_json FROM messages WHERE id = ?', id));
    return JSON.stringify({
      scene: c?.scene_json, participants: c?.story_participant_ids_snapshot, character: c?.character_id,
      messages, memories: many(db, "SELECT * FROM memories WHERE conversation_id = ? OR (scope = 'character' AND character_id IN (SELECT value FROM json_each(?))) ORDER BY id", this.conv.id, JSON.stringify(this.characterIds)),
      summaries: many(db, 'SELECT * FROM summaries WHERE conversation_id = ? ORDER BY id', this.conv.id)
    });
  }
  check(head: string | null): void {
    const current = one<{ head_message_id: string | null }>(this.ctx.db, 'SELECT head_message_id FROM conversations WHERE id = ?', this.conv.id);
    if (!current || current.head_message_id !== head || this.read() !== this.snapshot) throw new PrivateValidationError();
  }
}

type Held = { content: string; meta: MessageMeta; units: number };
type Options = {
  ctx: Ctx; reply: FastifyReply; conv: ConversationRow; generationId: string;
  parentId: string | null; restoreHead: string | null; userMessage?: MessageRow;
  controller: AbortController; turn: TurnDeadline; guard: OutputPermissionGuard;
  metrics: PartyMetrics | null; format: string; budget?: Record<string, unknown>;
  commitScene?: (firstId: string, scene: Scene) => void;
  initialSeq?: number; baseMeta?: MessageMeta;
};

/** Only verified content enters this sink. No callbacks receive a raw buffer. */
export class PartyOutput {
  private head: string | null;
  private readonly rows: string[] = [];
  private readonly publicRows = new Set<string>();
  private readonly held: Held[] = [];
  private bodyCount = 0;
  private startedId: string | null = null;
  private done = false;
  private completed = false;
  get succeeded() { return this.completed; }
  constructor(private o: Options) { this.head = o.parentId; }
  private send(event: unknown) {
    if (!this.o.reply.raw.destroyed && !this.o.reply.raw.writableEnded) this.o.reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  private out(id: string) { return messageOut(this.o.ctx.db, one<MessageRow>(this.o.ctx.db, 'SELECT * FROM messages WHERE id = ?', id)!); }
  private atomic<T>(fn: () => T): T {
    const head = this.head;
    const rowCount = this.rows.length;
    const publicRows = [...this.publicRows];
    try {
      return this.o.ctx.db.transaction(() => {
        this.o.controller.signal.throwIfAborted(); this.o.guard.check(this.head); return fn();
      })();
    } catch (error) {
      // A rolled-back insert must also roll back the in-memory chain cursor.
      this.head = head;
      this.rows.splice(rowCount);
      this.publicRows.clear();
      publicRows.forEach(id => this.publicRows.add(id));
      throw error;
    }
  }
  private insert(content: string, status: MessageRow['status'], meta: MessageMeta): MessageRow {
    const row = insertMessage(this.o.ctx.db, this.o.conv.id, this.head, 'assistant', content, status, {
      generation_id: this.o.generationId, profile: this.o.conv.profile_name, prompt_version: PROMPT_VERSION,
      beat_seq: (this.o.initialSeq ?? 0) + this.rows.length, party_output_version: 1, observation: PUBLIC, ...this.o.baseMeta, ...meta,
    } as MessageMeta);
    this.rows.push(row.id); this.head = row.id; setHead(this.o.ctx.db, this.o.conv.id, row.id); return row;
  }
  header(text: string) {
    if (!text) return;
    const row = this.atomic(() => this.insert(text, 'complete', { block_kind: 'info' }));
    this.send({ type: 'aux', message: this.out(row.id) });
  }
  async request(req: OutputRequest): Promise<{ text: string; choices: string[] | null; result: GenResult | null }> {
    if (req.audience.visibility === 'private' && !req.audience.recipient_ids.includes('user')) throw new PrivateValidationError();
    const hold = req.hold || req.audience.visibility === 'private' || req.exposure !== 'public_verified_stream';
    const gate = createLineGate(req.gate);
    const units: VerifiedUnit[] = [];
    let row: MessageRow | undefined;
    let stream: ReturnType<typeof createChatEventStream> | undefined;
    const script = !req.gate.singleActor && req.gate.allowed.length > 0;
    const meta: MessageMeta = {
      observation: req.audience,
      ...(script ? { chat_event_script: true, chat_event_actors: req.gate.allowed, chat_event_cast: req.gate.roomCast }
        : { block_kind: req.gate.singleActor ? 'line' : 'narration', speaker_character_id: req.gate.singleActor?.id, speaker_name: req.gate.singleActor?.name })
    };
    const text = () => units.map(u => (u.break_before ? '\n' : '') + (script && u.kind === 'line' ? `${u.name} | ${u.text}` : u.text)).join('\n') + (units.length ? '\n' : '');
    const publish = (added: VerifiedUnit[]) => {
      if (!added.length) return;
      units.push(...added);
      if (hold) return;
      this.atomic(() => {
        if (!row) { row = this.insert('', 'streaming', meta); this.publicRows.add(row.id); }
        updateMessage(this.o.ctx.db, row.id, { content: text() }); this.publicRows.add(row.id);
      });
      if (!stream) {
        stream = createChatEventStream({ ...row!, meta });
        if (!this.startedId) {
          this.startedId = row!.id; this.o.ctx.queue.setMessageId(this.o.generationId, row!.id);
          this.send({ type: 'start', generationId: this.o.generationId, messageId: row!.id, eventVersion: 1, message: this.out(row!.id) });
        }
      }
      this.o.metrics?.output();
      if (row!.id === this.startedId) this.send({ type: 'token', ...stream(text()) });
      else this.send({ type: 'aux', message: this.out(row!.id) });
    };
    if (!hold) {
      row = this.atomic(() => this.insert('', 'streaming', meta));
      stream = createChatEventStream({ ...row, meta });
      if (!this.startedId) {
        this.startedId = row.id; this.o.ctx.queue.setMessageId(this.o.generationId, row.id);
        this.send({ type: 'start', generationId: this.o.generationId, messageId: row.id, eventVersion: 1, message: this.out(row.id) });
      }
    }
    const deadline = withCallDeadline(req.timeoutMs, this.o.turn.remainingMs(), this.o.controller.signal);
    const metric = this.o.metrics?.start(req.pass, req.params.messages.reduce((n, m) => n + estimateMessageTokens(m.content, getCalibration(this.o.ctx.db)), 0), req.gate.outputMaxTokens);
    try {
      const result = await this.o.ctx.queue.runGeneration(this.o.generationId, () => this.o.ctx.model.stream({ ...req.params, signal: deadline.signal }, delta => {
        deadline.signal.throwIfAborted(); publish(gate.push(delta));
      }), this.o.controller.signal);
      deadline.signal.throwIfAborted();
      const terminal = gate.end(result.finishReason === 'stop' ? 'stop' : 'length');
      if (terminal.request_failed) throw new OutputRequestError('Output validation failed');
      publish(terminal.units);
      if (metric) this.o.metrics?.end(metric, result);
      this.bodyCount += units.length;
      if (units.length && hold) {
        if (req.audience.visibility === 'private' || req.exposure === 'private_hold_until_turn_success') this.held.push({ content: text(), meta, units: units.length });
        else {
          const added = this.atomic(() => this.insert(text(), 'complete', meta));
          this.publicRows.add(added.id); this.send({ type: 'aux', message: this.out(added.id) });
        }
      } else if (row) {
        this.atomic(() => updateMessage(this.o.ctx.db, row!.id, { content: text(), status: 'complete' }));
        this.send({ type: 'aux', message: this.out(row.id) });
      }
      return { text: text().trim(), choices: terminal.choices, result };
    } catch (err) {
      if (metric) this.o.metrics?.fail(metric, this.o.controller.signal.aborted ? 'aborted' : 'error');
      if (isTurnDeadlineError(deadline.signal.reason)) this.o.turn.tripDeadline();
      if (!req.optional || this.o.controller.signal.aborted || err instanceof PrivateValidationError) throw (deadline.signal.reason ?? err);
      return { text: '', choices: null, result: null };
    } finally { deadline.done(); }
  }
  async choices(params: GenParams, timeoutMs: number): Promise<string[] | null> {
    if (!this.bodyCount) throw new PrivateValidationError();
    const deadline = withCallDeadline(timeoutMs, this.o.turn.remainingMs(), this.o.controller.signal);
    const metric = this.o.metrics?.start('C', params.messages.reduce((n, m) => n + estimateMessageTokens(m.content, getCalibration(this.o.ctx.db)), 0), params.max_tokens!);
    try {
      const result = await this.o.ctx.queue.runGeneration(this.o.generationId, () => this.o.ctx.model.complete({ ...params, signal: deadline.signal }), this.o.controller.signal);
      deadline.signal.throwIfAborted();
      if (metric) this.o.metrics?.end(metric, result);
      const gate = createLineGate({ allowed: [], roomCast: [], userName: '', allowNarration: false, outputMaxTokens: params.max_tokens! });
      gate.push(result.text); return gate.end(result.finishReason === 'stop' ? 'stop' : 'length').choices;
    } catch (err) {
      if (metric) this.o.metrics?.fail(metric, this.o.controller.signal.aborted ? 'aborted' : 'error');
      if (isTurnDeadlineError(deadline.signal.reason)) this.o.turn.tripDeadline();
      if (this.o.controller.signal.aborted) throw err;
      return null;
    } finally { deadline.done(); }
  }
  success(scene?: Scene, choices: string[] | null = null, tail?: { content: string; meta: MessageMeta }, portraits: NonNullable<MessageMeta['roster_portraits']> = []) {
    if (!this.bodyCount) throw new PrivateValidationError();
    const heldIds: string[] = [];
    this.atomic(() => {
      if (!this.o.turn.tryEnterCommit({ sceneVersionAtStart: 0, currentSceneVersion: 0, expectedHead: this.head, currentHead: this.head })) throw new PrivateValidationError();
      for (const h of this.held) heldIds.push(this.insert(h.content, 'complete', h.meta).id);
      if (tail) heldIds.push(this.insert(tail.content, 'complete', tail.meta).id);
      for (const id of this.rows) {
        const meta = parseMessageMeta(one<MessageRow>(this.o.ctx.db, 'SELECT * FROM messages WHERE id=?', id)!.meta_json);
        const portrait = portraits.find(p => p.id === meta.speaker_character_id);
        if (portrait || (meta.chat_event_script && portraits.length)) updateMessage(this.o.ctx.db, id, {meta:{
          ...(portrait ? {image_url:portrait.image_url} : {}), ...(meta.chat_event_script ? {roster_portraits:portraits} : {}),
        }});
      }
      if (choices?.length && this.head) updateMessage(this.o.ctx.db, this.head, { meta: { choices } });
      if (scene && this.o.commitScene) this.o.commitScene(this.rows[0], scene);
      this.log('complete', 'completed');
    });
    this.completed = true; this.done = true;
    this.held.length = 0;
    for (const id of this.rows) this.send({ type: 'aux', message: this.out(id) });
    this.closeDone();
  }
  private log(status: string, termination: 'completed' | 'user_cancelled' | 'internal_error' | 'turn_deadline_exceeded' | 'model_timeout') {
    run(this.o.ctx.db, `INSERT INTO generation_log (id,conversation_id,message_id,profile_name,prompt_version,est_prompt_tokens,total_ms,finish_reason,status,budget_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      uid(), this.o.conv.id, this.head, this.o.conv.profile_name, PROMPT_VERSION, 0, this.o.turn.elapsedMs(), this.o.format, status,
      JSON.stringify({ ...this.o.budget, turn_deadline: { ...this.o.turn.telemetry(), termination }, party_output_version: 1, ...(this.o.metrics ? { party_metrics: this.o.metrics.finish(termination) } : {}) }), nowIso());
  }
  private closeDone() {
    if (!this.head) return;
    const id = this.startedId && this.rows.includes(this.startedId) ? this.startedId : this.head;
    this.send({ type: 'aux', message: this.out(this.head) });
    this.send({ type: 'done', message: this.out(id), usage: null, ttftMs: null, totalMs: this.o.turn.elapsedMs() });
  }
  failure(err: unknown) {
    if (this.done) return;
    const term = classifyTurnTermination(this.o.controller, err, this.o.turn.termination);
    this.o.turn.recordTerminal(term);
    const keep = term === 'user_cancelled' && this.publicRows.size > 0;
    this.held.length = 0;
    if (keep) {
      this.o.ctx.db.transaction(() => {
        const empty = this.rows.filter(id => !this.publicRows.has(id) && one<MessageRow>(this.o.ctx.db, 'SELECT * FROM messages WHERE id=?', id)?.status === 'streaming');
        for (const id of empty.reverse()) {
          const row = one<MessageRow>(this.o.ctx.db, 'SELECT * FROM messages WHERE id=?', id)!;
          if (this.head === id) { this.head = row.parent_id; setHead(this.o.ctx.db, this.o.conv.id, this.head); }
          run(this.o.ctx.db, 'DELETE FROM messages WHERE id=?', id);
          this.rows.splice(this.rows.indexOf(id), 1);
        }
        if (this.startedId && !this.rows.includes(this.startedId)) this.startedId = null;
        for (const id of this.rows) updateMessage(this.o.ctx.db, id, { status: 'interrupted', meta: { finish_reason: 'aborted' } });
      })();
      this.closeDone();
    } else {
      const removed = [...this.rows, ...(this.o.userMessage ? [this.o.userMessage.id] : [])];
      this.o.ctx.db.transaction(() => {
        const current = one<{ head_message_id: string | null }>(this.o.ctx.db, 'SELECT head_message_id FROM conversations WHERE id=?', this.o.conv.id);
        if (current?.head_message_id === this.head) setHead(this.o.ctx.db, this.o.conv.id, this.o.restoreHead);
        const foreignChild = removed.length && one(this.o.ctx.db, 'SELECT id FROM messages WHERE parent_id IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT value FROM json_each(?)) LIMIT 1', JSON.stringify(removed), JSON.stringify(removed));
        if (!foreignChild) for (const id of [...removed].reverse()) run(this.o.ctx.db, 'DELETE FROM messages WHERE id=? AND conversation_id=?', id, this.o.conv.id);
      })();
      // Older open tabs only understand the existing error + authoritative GET flow.
      if (this.o.reply.request.headers['x-rpchat-output-retract'] === '1') {
        this.send({ type: 'retract', generationId: this.o.generationId, messageIds: removed });
      }
      this.send({ type: 'error', code: term === 'user_cancelled' ? 'user_cancelled' : 'validation', message: term === 'user_cancelled' ? '생성을 중단했습니다.' : '이번 응답을 저장하지 못했습니다. 이전 장면으로 돌아갑니다.' });
    }
    this.log(keep ? 'interrupted' : 'error', term); this.done = true;
  }
  async run(fn: (output: PartyOutput) => Promise<void>) {
    this.o.reply.hijack(); this.o.reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' });
    if (this.o.userMessage) this.send({ type: 'aux', message: messageOut(this.o.ctx.db, this.o.userMessage) });
    this.o.ctx.queue.watchProgress(this.o.generationId, g => this.send({ type: 'progress', generationId: g.id, phase: g.phase, startedAt: g.startedAt }));
    try { await fn(this); } catch (err) { this.failure(err); } finally { if (!this.o.reply.raw.destroyed && !this.o.reply.raw.writableEnded) this.o.reply.raw.end(); }
  }
}
