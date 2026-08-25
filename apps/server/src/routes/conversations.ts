import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { PROMPT_VERSION, config } from '../config.js';
import { many, nowIso, one, parseJson, run, uid } from '../db/index.js';
import { interruptOrphanStreaming } from '../db/generation.js';
import { deepestLeaf, getPath, insertMessage, messageOut, setHead, updateMessage } from '../db/tree.js';
import { buildPrompt, resolvePersona } from '../prompt/builder.js';
import { substitute } from '../prompt/templates.js';
import type { CharacterRow, ConversationRow, MessageRow, PersonaRow, Scene } from '../types.js';
import { characterOut, personaOut } from './characters.js';

const sceneSchema = z.object({
  place: z.string().max(300).optional(),
  time: z.string().max(300).optional(),
  goal: z.string().max(500).optional(),
  genre: z.string().max(200).optional(),
  conflict: z.string().max(500).optional(),
  mood: z.string().max(200).optional(),
});

const createSchema = z.object({
  characterId: z.string().min(1),
  personaId: z.string().nullable().optional(),
  title: z.string().max(120).optional(),
  mode: z.enum(['chat', 'story']).default('chat'),
  profileName: z.string().max(60).optional(),
  scene: sceneSchema.default({}),
});

const patchSchema = z.object({
  title: z.string().max(120).optional(),
  mode: z.enum(['chat', 'story']).optional(),
  profileName: z.string().max(60).optional(),
  scene: sceneSchema.optional(),
  personaId: z.string().nullable().optional(),
  favorite: z.boolean().optional(),
  archived: z.boolean().optional(),
  userNote: z.string().max(4000).nullable().optional(),
});

export function conversationOut(c: ConversationRow) {
  return { ...c, scene: parseJson<Scene>(c.scene_json, {}), favorite: !!c.favorite, archived: !!c.archived };
}

export function loadConversation(ctx: Ctx, id: string): ConversationRow | undefined {
  return one<ConversationRow>(ctx.db, 'SELECT * FROM conversations WHERE id = ?', id);
}

export function conversationRoutes(ctx: Ctx) {
  const { db } = ctx;
  return async function plugin(app: FastifyInstance) {
    app.get<{ Querystring: { characterId?: string; limit?: string } }>('/api/conversations', async (req) => {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
      const rows = req.query.characterId
        ? many<ConversationRow & { character_name: string; preview: string | null }>(
            db,
            `SELECT v.*, c.name AS character_name, (SELECT content FROM messages m WHERE m.id = v.head_message_id) AS preview
             FROM conversations v JOIN characters c ON c.id = v.character_id
             WHERE v.archived = 0 AND v.character_id = ? ORDER BY v.last_message_at DESC NULLS LAST, v.created_at DESC LIMIT ?`,
            req.query.characterId, limit,
          )
        : many<ConversationRow & { character_name: string; preview: string | null }>(
            db,
            `SELECT v.*, c.name AS character_name, (SELECT content FROM messages m WHERE m.id = v.head_message_id) AS preview
             FROM conversations v JOIN characters c ON c.id = v.character_id
             WHERE v.archived = 0 ORDER BY v.last_message_at DESC NULLS LAST, v.created_at DESC LIMIT ?`,
            limit,
          );
      return rows.map((r) => ({ ...conversationOut(r), character_name: r.character_name, preview: (r.preview ?? '').slice(0, 120) }));
    });

    app.post('/api/conversations', async (req, reply) => {
      const p = createSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const d = p.data;
      const character = one<CharacterRow>(db, 'SELECT * FROM characters WHERE id = ? AND archived = 0', d.characterId);
      if (!character) return reply.code(404).send({ error: 'character not found' });
      if (d.personaId && !one(db, 'SELECT 1 FROM personas WHERE id = ?', d.personaId)) return reply.code(404).send({ error: 'persona not found' });
      const profileName = d.profileName ?? (d.mode === 'story' ? 'rp-creative' : 'rp-balanced');
      const id = uid();
      const t = nowIso();
      db.transaction(() => {
        run(
          db,
          `INSERT INTO conversations (id, character_id, persona_id, title, mode, profile_name, scene_json, head_message_id, prompt_version, created_at, updated_at, last_message_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
          id, character.id, d.personaId ?? null, d.title ?? '', d.mode, profileName, JSON.stringify(d.scene), PROMPT_VERSION, t, t,
        );
        const conv = loadConversation(ctx, id)!;
        const persona = resolvePersona(db, conv);
        const greeting = substitute(character.first_message, character.name, persona?.name || '나').trim();
        if (greeting) {
          const m = insertMessage(db, id, null, 'assistant', greeting, 'complete', { profile: profileName, prompt_version: PROMPT_VERSION });
          setHead(db, id, m.id);
        }
      })();
      return reply.code(201).send(conversationOut(loadConversation(ctx, id)!));
    });

    app.get<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
      const conv = loadConversation(ctx, req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      const character = one<CharacterRow>(db, 'SELECT * FROM characters WHERE id = ?', conv.character_id)!;
      const persona = resolvePersona(db, conv);
      interruptOrphanStreaming(db, {
        keepMessageIds: ctx.queue.activeList.map((g) => g.messageId),
        minAgeMs: 2000,
      });
      const messages = getPath(db, conv).map((m) => messageOut(db, m));
      const active = ctx.queue.activeList.find((g) => g.conversationId === conv.id);
      return {
        conversation: conversationOut(conv),
        character: characterOut(character),
        persona: persona ? personaOut(persona as PersonaRow) : null,
        messages,
        activeGeneration: active ? { id: active.id, messageId: active.messageId, startedAt: active.startedAt } : null,
      };
    });

    app.patch<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
      const conv = loadConversation(ctx, req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      const p = patchSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const d = p.data;
      if (d.personaId && !one(db, 'SELECT 1 FROM personas WHERE id = ?', d.personaId)) return reply.code(404).send({ error: 'persona not found' });
      // snapshot lock: personaId set → copy live row into snapshot columns in the same statement.
      // Reapply = PATCH the same personaId again.
      // personaId omitted → leave persona_id, snapshot, applied_at.
      // personaId:null → write NULL to those columns (never COALESCE explicit null).
      const personaTouched = d.personaId !== undefined;
      let snap: { n: string | null; a: string | null; ap: string | null; pe: string | null; pr: string | null; at: string | null } | null = null;
      if (d.personaId) {
        const src = one<any>(db, 'SELECT name, address_as, appearance, personality, relationship FROM personas WHERE id = ?', d.personaId)!;
        snap = { n: src.name ?? null, a: src.address_as ?? null, ap: src.appearance ?? null, pe: src.personality ?? null, pr: src.relationship ?? null, at: nowIso() };
      } else if (d.personaId === null) {
        snap = { n: null, a: null, ap: null, pe: null, pr: null, at: null };
      }
      const scene = d.scene ? { ...parseJson<Scene>(conv.scene_json, {}), ...d.scene } : null;
      const personaFlag = personaTouched ? 1 : 0;
      run(
        db,
        `UPDATE conversations SET title = COALESCE(?, title), mode = COALESCE(?, mode), profile_name = COALESCE(?, profile_name),
           scene_json = COALESCE(?, scene_json), persona_id = CASE WHEN ? THEN ? ELSE persona_id END,
           favorite = COALESCE(?, favorite), archived = COALESCE(?, archived),
           user_note = CASE WHEN ? THEN ? ELSE user_note END,
           persona_name_snapshot = CASE WHEN ? THEN ? ELSE persona_name_snapshot END,
           persona_address_snapshot = CASE WHEN ? THEN ? ELSE persona_address_snapshot END,
           persona_appearance_snapshot = CASE WHEN ? THEN ? ELSE persona_appearance_snapshot END,
           persona_personality_snapshot = CASE WHEN ? THEN ? ELSE persona_personality_snapshot END,
           persona_relationship_snapshot = CASE WHEN ? THEN ? ELSE persona_relationship_snapshot END,
           persona_applied_at = CASE WHEN ? THEN ? ELSE persona_applied_at END,
           updated_at = ? WHERE id = ?`,
        d.title ?? null, d.mode ?? null, d.profileName ?? null, scene ? JSON.stringify(scene) : null,
        personaFlag, d.personaId ?? null,
        d.favorite === undefined ? null : d.favorite ? 1 : 0, d.archived === undefined ? null : d.archived ? 1 : 0,
        d.userNote !== undefined ? 1 : 0, d.userNote ?? null,
        personaFlag, snap?.n ?? null,
        personaFlag, snap?.a ?? null,
        personaFlag, snap?.ap ?? null,
        personaFlag, snap?.pe ?? null,
        personaFlag, snap?.pr ?? null,
        personaFlag, snap?.at ?? null,
        nowIso(), conv.id,
      );
      return conversationOut(loadConversation(ctx, conv.id)!);
    });

    app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
      const r = run(db, 'DELETE FROM conversations WHERE id = ?', req.params.id);
      if (r.changes === 0) return reply.code(404).send({ error: 'not found' });
      return { ok: true };
    });

    // ---- 프롬프트 미리보기 (모델 호출 없음) ----
    app.get<{ Params: { id: string }; Querystring: { draft?: string } }>('/api/conversations/:id/prompt-preview', async (req, reply) => {
      const conv = loadConversation(ctx, req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      const history = getPath(db, conv);
      if (req.query.draft) {
        history.push({
          id: 'draft', conversation_id: conv.id, parent_id: conv.head_message_id, role: 'user', content: req.query.draft, status: 'complete', meta_json: '{}', bookmarked: 0, created_at: nowIso(),
        });
      }
      const built = buildPrompt(db, conv, history, config.model.contextTokens, ctx.resolvedModel(), undefined, { diagnostics: true });
      return { messages: built.messages, budget: built.budget, model: built.model, profile: built.profile, stop: built.stop, isOoc: built.isOoc };
    });

    // ---- 메시지 ----
    app.get<{ Params: { id: string } }>('/api/messages/:id', async (req, reply) => {
      const m = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', req.params.id);
      if (!m) return reply.code(404).send({ error: 'not found' });
      return messageOut(db, m);
    });

    const msgPatch = z.object({ content: z.string().max(20000).optional(), bookmarked: z.boolean().optional() });
    app.patch<{ Params: { id: string } }>('/api/messages/:id', async (req, reply) => {
      const m = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', req.params.id);
      if (!m) return reply.code(404).send({ error: 'not found' });
      if (m.status === 'streaming') return reply.code(409).send({ error: '생성 중인 메시지는 수정 불가' });
      const p = msgPatch.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      updateMessage(db, m.id, { content: p.data.content, bookmarked: p.data.bookmarked, status: p.data.content !== undefined && m.status === 'interrupted' ? 'complete' : undefined });
      return messageOut(db, one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', m.id)!);
    });

    // 형제(swipe) 선택: 해당 분기의 가장 최근 잎으로 head 이동
    app.post<{ Params: { id: string } }>('/api/messages/:id/select', async (req, reply) => {
      const m = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', req.params.id);
      if (!m) return reply.code(404).send({ error: 'not found' });
      const conv = loadConversation(ctx, m.conversation_id)!;
      if (ctx.queue.activeList.some((g) => g.conversationId === conv.id)) return reply.code(409).send({ error: '생성 중에는 분기를 바꿀 수 없음' });
      setHead(db, conv.id, deepestLeaf(db, m.id));
      return { messages: getPath(db, loadConversation(ctx, conv.id)!).map((x) => messageOut(db, x)) };
    });

    // 잎 메시지 삭제 (중단된 응답 버리기 등). head 는 부모로.
    app.delete<{ Params: { id: string } }>('/api/messages/:id', async (req, reply) => {
      const m = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', req.params.id);
      if (!m) return reply.code(404).send({ error: 'not found' });
      if (m.status === 'streaming') return reply.code(409).send({ error: '생성 중인 메시지는 삭제 불가' });
      const conv = loadConversation(ctx, m.conversation_id)!;
      db.transaction(() => {
        run(db, 'DELETE FROM messages WHERE id = ?', m.id); // 자식은 CASCADE
        if (conv.head_message_id === m.id || !one(db, 'SELECT 1 FROM messages WHERE id = ?', conv.head_message_id)) {
          // 같은 부모의 남은 형제가 있으면 그쪽 잎으로, 없으면 부모로
          const sib = one<{ id: string }>(db, 'SELECT id FROM messages WHERE conversation_id = ? AND parent_id IS ? ORDER BY created_at DESC LIMIT 1', conv.id, m.parent_id);
          setHead(db, conv.id, sib ? deepestLeaf(db, sib.id) : m.parent_id);
        }
      })();
      return { messages: getPath(db, loadConversation(ctx, conv.id)!).map((x) => messageOut(db, x)) };
    });

    // ---- 내보내기 ----
    app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/api/conversations/:id/export', async (req, reply) => {
      const conv = loadConversation(ctx, req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      const character = one<CharacterRow>(db, 'SELECT * FROM characters WHERE id = ?', conv.character_id)!;
      const persona = resolvePersona(db, conv);
      const path = getPath(db, conv);
      const stamp = conv.created_at.slice(0, 10);
      if (req.query.format === 'md') {
        const lines = [
          `# ${conv.title || character.name} (${stamp})`,
          '',
          `- 캐릭터: ${character.name}`,
          `- 페르소나: ${persona?.name ?? '나'}`,
          `- 모드: ${conv.mode} / 프로필: ${conv.profile_name} / 프롬프트 버전: ${conv.prompt_version}`,
          '',
        ];
        for (const m of path) {
          lines.push(`**${m.role === 'user' ? persona?.name ?? '나' : character.name}**${m.status !== 'complete' ? ` _(${m.status})_` : ''}`, '', m.content, '');
        }
        reply.header('content-type', 'text/markdown; charset=utf-8');
        reply.header('content-disposition', `attachment; filename="${encodeURIComponent(`${character.name}-${stamp}.md`)}"`);
        return lines.join('\n');
      }
      const allMessages = many<MessageRow>(db, 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at', conv.id);
      reply.header('content-type', 'application/json; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="${encodeURIComponent(`${character.name}-${stamp}.json`)}"`);
      return {
        exported_at: nowIso(),
        conversation: conversationOut(conv),
        character: characterOut(character),
        persona: persona ? personaOut(persona) : null,
        active_path_ids: path.map((m) => m.id),
        messages: allMessages.map((m) => ({ ...m, meta: parseJson(m.meta_json, {}), meta_json: undefined })),
        memories: many(db, 'SELECT * FROM memories WHERE conversation_id = ? OR (scope = ? AND character_id = ?)', conv.id, 'character', conv.character_id),
        summaries: many(db, 'SELECT * FROM summaries WHERE conversation_id = ? ORDER BY created_at', conv.id),
      };
    });

    app.get('/api/export/all', async (_req, reply) => {
      reply.header('content-type', 'application/json; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="rpchat-export-${nowIso().slice(0, 10)}.json"`);
      return {
        exported_at: nowIso(),
        prompt_version: PROMPT_VERSION,
        characters: many(db, 'SELECT * FROM characters'),
        personas: many(db, 'SELECT * FROM personas'),
        lorebooks: many(db, 'SELECT * FROM lorebooks'),
        lore_entries: many(db, 'SELECT * FROM lore_entries'),
        conversations: many(db, 'SELECT * FROM conversations'),
        messages: many(db, 'SELECT * FROM messages'),
        memories: many(db, 'SELECT * FROM memories'),
        summaries: many(db, 'SELECT * FROM summaries'),
        model_profiles: many(db, 'SELECT * FROM model_profiles'),
        settings: many(db, 'SELECT * FROM settings'),
      };
    });
  };
}
