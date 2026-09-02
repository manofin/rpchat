/**
 * long-rp-v2 실측 러너. 제품 코드 무수정.
 * 실행: npx tsx bench/longRp/run-long-rp-v2.ts
 * 사전등록: bench/longRp/preregistration-v2.md
 * v1 픽스처/비트/스코어키 재사용. 요약 approve(whole only) 가 유일한 추가 변수.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const HOST = process.env.RPCHAT_HOST ?? 'http://127.0.0.1:8787';
const HEADER = { 'Tailscale-User-Login': 'manofin@github' };
const DB_PATH = process.env.RPCHAT_DB ?? '/home/hermes/rpchat/data/rpchat.db';
const FROST_CHARACTER_ID = 'f89ace9b-8684-4d97-96dc-e00c4b25a819';
const KEEP = process.env.KEEP_LONGRP === '1';
const SUMMARIZE_AT = [20, 45, 75];
const DIR = path.dirname(new URL(import.meta.url).pathname);

function loadFrostConversationIds(dbPath: string): Set<string> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare('SELECT id FROM conversations WHERE character_id = ?')
      .all(FROST_CHARACTER_ID) as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  } finally {
    db.close();
  }
}

function refuseIfFrost(label: string, id: string | undefined, frostConvIds: Set<string>): asserts id is string {
  if (!id) throw new Error(`refused: empty ${label}`);
  if (id === FROST_CHARACTER_ID) throw new Error(`refused: frost character ${label} ${id}`);
  if (frostConvIds.has(id)) throw new Error(`refused: frost conversation ${label} ${id}`);
}

type Fact = { id: string; must_hold_at: number[] };
type Probe = { id: string; horizon: number; fact_ids: string[]; ask: string };
type ScoreKey = { must: string[]; forbid: string[] };

const fixtures = JSON.parse(fs.readFileSync(path.join(DIR, 'fixtures/long-rp-fixtures-v1.json'), 'utf8')) as {
  facts: Fact[];
  probes: Probe[];
};
const beatsDoc = JSON.parse(fs.readFileSync(path.join(DIR, 'beats-v1.json'), 'utf8')) as { beats: string[] };
const scoreDoc = JSON.parse(fs.readFileSync(path.join(DIR, 'score-keys-v1.json'), 'utf8')) as {
  probes: Record<string, ScoreKey>;
};

function norm(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function scoreProbe(id: string, text: string): { pass: boolean; missing: string[]; hitForbid: string[] } {
  const key = scoreDoc.probes[id];
  if (!key) throw new Error(`missing score key ${id}`);
  const t = norm(text);
  const missing = key.must.filter((m) => !t.includes(norm(m)));
  const hitForbid = key.forbid.filter((f) => t.includes(norm(f)));
  return { pass: missing.length === 0 && hitForbid.length === 0, missing, hitForbid };
}

async function api(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${HOST}${pathname}`, {
    ...init,
    headers: { ...HEADER, ...(init?.headers ?? {}) },
  });
}

async function drainSse(res: Response): Promise<{
  ok: boolean;
  status: number;
  type: string;
  text: string;
  userMessageId?: string;
  assistantId?: string;
  error?: string;
}> {
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, status: res.status, type: 'http', text: '', error: body.slice(0, 400) };
  }
  const reader = res.body?.getReader();
  if (!reader) return { ok: false, status: res.status, type: 'nobody', text: '', error: 'no body' };
  const dec = new TextDecoder();
  let buf = '';
  let userMessageId: string | undefined;
  let assistantId: string | undefined;
  let lastType = '';
  let text = '';
  let error: string | undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop() ?? '';
    for (const block of chunks) {
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let ev: { type?: string; text?: string; message?: { id?: string; content?: string }; userMessage?: { id?: string }; messageId?: string };
      try {
        ev = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      lastType = ev.type ?? lastType;
      if (ev.type === 'start') {
        userMessageId = ev.userMessage?.id;
        assistantId = ev.messageId;
      }
      if (ev.type === 'token' && ev.text) text += ev.text;
      if (ev.type === 'done') {
        assistantId = ev.message?.id ?? assistantId;
        text = ev.message?.content ?? text;
      }
      if (ev.type === 'error') error = ev.text ?? (ev as { message?: string }).message;
    }
  }
  return {
    ok: lastType === 'done' && !error,
    status: res.status,
    type: lastType || 'empty',
    text,
    userMessageId,
    assistantId,
    error,
  };
}

async function send(convId: string, content: string) {
  const res = await api(`/api/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return drainSse(res);
}

type SummarizeSlot = {
  at: number;
  ok: boolean;
  status: number;
  summaryId?: string;
  approvedStatus?: string;
  tier?: string;
  error?: string;
  attempts: number;
};

async function summarizeAndApproveWhole(convId: string, at: number): Promise<SummarizeSlot> {
  let lastStatus = 0;
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await api(`/api/conversations/${convId}/summarize`, { method: 'POST' });
    lastStatus = res.status;
    const raw = await res.text();
    let body: { summary?: { id?: string; tier?: string; status?: string }; error?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      lastErr = raw.slice(0, 400);
      continue;
    }
    const whole = body.summary;
    if (!res.ok || !whole?.id) {
      lastErr = typeof body.error === 'string' ? body.error : raw.slice(0, 400);
      if (res.status !== 502) {
        return { at, ok: false, status: res.status, error: lastErr, attempts: attempt };
      }
      continue;
    }
    const patch = await api(`/api/summaries/${whole.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    const patchedRaw = await patch.text();
    let patched: { id?: string; status?: string; tier?: string; error?: unknown };
    try {
      patched = JSON.parse(patchedRaw) as typeof patched;
    } catch {
      return { at, ok: false, status: patch.status, summaryId: whole.id, error: patchedRaw.slice(0, 400), attempts: attempt };
    }
    const ok = patch.ok && patched.status === 'approved' && patched.tier === 'whole';
    return {
      at,
      ok,
      status: patch.status,
      summaryId: patched.id ?? whole.id,
      approvedStatus: patched.status,
      tier: patched.tier,
      error: ok ? undefined : patchedRaw.slice(0, 400),
      attempts: attempt,
    };
  }
  return { at, ok: false, status: lastStatus, error: lastErr, attempts: 2 };
}

async function main() {
  if (beatsDoc.beats.length !== 100) throw new Error(`beats n=${beatsDoc.beats.length}`);
  for (const p of fixtures.probes) {
    if (!scoreDoc.probes[p.id]) throw new Error(`score key missing ${p.id}`);
  }

  const frostConvIds = loadFrostConversationIds(DB_PATH);
  console.error('FROST_GUARD char', FROST_CHARACTER_ID, 'convs', frostConvIds.size);

  const healthRes = await api('/api/health');
  const health = await healthRes.json() as {
    ok?: boolean;
    promptVersion?: string;
    model?: { resolvedModel?: string; contextTokens?: number; ok?: boolean };
    generation?: { active?: unknown[] };
  };
  const active = health.generation?.active ?? [];
  if (active.length > 0) {
    console.log('ABORT_USER_ACTIVE', JSON.stringify(active));
    process.exit(2);
  }

  const charRes = await api('/api/characters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '린-longrp-v2',
      tagline: '합성 벤치 — 절벽 등대',
      description: '이름은 린. 외딴 절벽 등대에 산다. 합성 시나리오. 서리/카이 세계와 무관.',
      personality: '과묵하고 실무적이다. 말은 짧다.',
      speech_style: '짧은 평서문. 과한 비유 없음.',
      scenario: '폭풍 다음 날. 낯선 사람이 등대 문을 두드린다.',
      first_message: '문을 반쯤 연 채 젖은 사람을 내려다본다. "아직 바람이 안 죽었다. 들어오든가."',
      taboos: '서리, 카이, 라이브 사용자 세계관을 끌어오지 않는다.',
      tags: ['TEST', 'longrp'],
    }),
  });
  const character = await charRes.json() as { id?: string; error?: unknown };
  if (!character.id) throw new Error(`character create failed ${JSON.stringify(character)}`);
  refuseIfFrost('created character', character.id, frostConvIds);

  const convRes = await api('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      characterId: character.id,
      mode: 'chat',
      title: '[TEST-longrp-v2]',
      scene: { place: '절벽 등대', time: '폭풍 다음', mood: '차갑고 젖음' },
    }),
  });
  const conv = await convRes.json() as { id?: string };
  if (!conv.id) throw new Error(`conv create failed ${JSON.stringify(conv)}`);
  refuseIfFrost('created conversation', conv.id, frostConvIds);
  const convId = conv.id;
  console.error('conv', convId, 'char', character.id);

  const story: Array<{ turn: number; ok: boolean; type: string; ms: number; chars: number; error?: string }> = [];
  const probesOut: Array<{
    id: string;
    horizon: number;
    ok: boolean;
    text: string;
    pass: boolean;
    missing: string[];
    hitForbid: string[];
    error?: string;
  }> = [];
  const summariesOut: SummarizeSlot[] = [];

  const resultsDir = path.join(DIR, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const partialPath = path.join(resultsDir, 'long-rp-v2-partial.json');

  const savePartial = () => {
    fs.writeFileSync(partialPath, JSON.stringify({ convId, characterId: character.id, story, probesOut, summariesOut }, null, 2));
  };

  try {
    for (let i = 0; i < 100; i++) {
      const t0 = Date.now();
      const r = await send(convId, beatsDoc.beats[i]);
      story.push({ turn: i + 1, ok: r.ok, type: r.type, ms: Date.now() - t0, chars: r.text.length, error: r.error });
      console.error(`story ${i + 1}/100 ${r.ok ? 'ok' : 'FAIL'} ${Date.now() - t0}ms`);
      if (!r.ok) break;

      const turn = i + 1;
      if (SUMMARIZE_AT.includes(turn)) {
        const slot = await summarizeAndApproveWhole(convId, turn);
        summariesOut.push(slot);
        console.error(`summarize@${turn} ${slot.ok ? 'ok' : 'FAIL'} status=${slot.status} id=${slot.summaryId ?? ''}`);
      }

      if (turn === 30 || turn === 60 || turn === 100) {
        const due = fixtures.probes.filter((p) => p.horizon === turn);
        for (const p of due) {
          const pt0 = Date.now();
          const pr = await send(convId, `(OOC) ${p.ask}`);
          const scored = scoreProbe(p.id, pr.text);
          probesOut.push({
            id: p.id,
            horizon: turn,
            ok: pr.ok,
            text: pr.text,
            pass: pr.ok && scored.pass,
            missing: scored.missing,
            hitForbid: scored.hitForbid,
            error: pr.error,
          });
          console.error(`probe ${p.id} ${pr.ok && scored.pass ? 'PASS' : 'fail'} ${Date.now() - pt0}ms`);
          if (pr.userMessageId) {
            await api(`/api/messages/${pr.userMessageId}`, { method: 'DELETE' });
          }
        }
      }
      savePartial();
    }

    const storyComplete = story.filter((s) => s.ok).length;
    const probeComplete = probesOut.filter((p) => p.ok).length;
    const summarizeOk = summariesOut.filter((s) => s.ok).length;
    const storyOk = storyComplete === 100 && story.every((s) => s.ok);
    const probeOk = probeComplete === 9 && probesOut.every((p) => p.ok);
    const summaryOk = summarizeOk === 3 && summariesOut.length === 3;
    const valid = storyOk && probeOk && summaryOk;

    const hold: Record<string, { scored: string[]; held: string[]; missed: string[]; unscored: string[]; hold_rate: number | null }> = {};
    for (const h of [30, 60, 100]) {
      const dueFacts = fixtures.facts.filter((f) => f.must_hold_at.includes(h)).map((f) => f.id);
      const hs = probesOut.filter((p) => p.horizon === h);
      const scored: string[] = [];
      const held: string[] = [];
      const missed: string[] = [];
      for (const fid of dueFacts) {
        const linked = fixtures.probes.filter((p) => p.horizon === h && p.fact_ids.includes(fid));
        if (linked.length === 0) continue;
        scored.push(fid);
        const allPass = linked.every((p) => hs.find((x) => x.id === p.id)?.pass);
        if (allPass) held.push(fid);
        else missed.push(fid);
      }
      const unscored = dueFacts.filter((id) => !scored.includes(id));
      hold[String(h)] = {
        scored,
        held,
        missed,
        unscored,
        hold_rate: valid && scored.length ? held.length / scored.length : null,
      };
    }

    const runLabel = valid ? 'VALID' : (storyOk && probeOk ? 'INVALID_NO_SUMMARY' : 'INVALID');
    const out = {
      run: 'run-long-rp-v2',
      valid,
      runLabel,
      convId,
      characterId: character.id,
      startedHealth: {
        promptVersion: health.promptVersion ?? null,
        resolvedModel: health.model?.resolvedModel ?? null,
        contextTokens: health.model?.contextTokens ?? null,
        modelOk: health.model?.ok ?? null,
      },
      storyComplete,
      probeComplete,
      summarizeOk,
      story,
      probes: probesOut,
      summaries: summariesOut,
      hold,
    };

    const stamp = Date.now();
    const file = path.join(resultsDir, `long-rp-v2-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(JSON.stringify({
      RUN: runLabel,
      file,
      storyComplete,
      probeComplete,
      summarizeOk,
      hold: Object.fromEntries(Object.entries(hold).map(([k, v]) => [k, { hold_rate: v.hold_rate, held: v.held.length, scored: v.scored.length, unscored: v.unscored }])),
    }, null, 2));
    console.error('saved', file);
  } finally {
    if (!KEEP) {
      refuseIfFrost('cleanup conversation', convId, frostConvIds);
      refuseIfFrost('cleanup character', character.id, frostConvIds);
      await api(`/api/conversations/${convId}`, { method: 'DELETE' });
      await api(`/api/characters/${character.id}`, { method: 'DELETE' });
      const db = new Database(DB_PATH);
      db.prepare('DELETE FROM generation_log WHERE conversation_id = ?').run(convId);
      db.close();
      console.error('cleaned', convId);
    } else {
      console.error('KEEP_LONGRP=1, left', convId);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
