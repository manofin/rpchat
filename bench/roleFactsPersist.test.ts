// npm run test:benches -- roleFactsPersist
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb, one } from '../apps/server/src/db/index.js';
import { insertMessage, setHead } from '../apps/server/src/db/tree.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { roleFactRoutes } from '../apps/server/src/routes/roleFacts.js';
import { buildSideModePrompt } from '../apps/server/src/prompt/sideModePrompt.js';
import { confirmedRolesForInfo } from '../apps/server/src/prompt/conversationRoleFacts.js';
import { buildSceneSnapshot } from '../apps/server/src/db/sceneBase.js';
import { savedDialogStateRows } from '../apps/web/src/lib/dialogInfo.js';
import type { ConversationRow } from '../apps/server/src/types.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import { config } from '../apps/server/src/config.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-role-persist-'));
const originalAuthMode = config.auth.mode;
config.auth.mode = 'none';
const db = openMigratedDb(dir, path.resolve('apps/server/migrations'));
const app = Fastify();
const ctx = { db, queue: new GenerationQueue(1), resolvedModel: () => 'mock', model: {}, log: app.log } as unknown as Ctx;
for (const route of [characterRoutes, storyRoutes, conversationRoutes, roleFactRoutes]) app.register(route(ctx));
let checks = 0;
function ok(name: string, fn: () => void) { fn(); console.log(`ok ${++checks} ${name}`); }
async function api(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, payload });
  return { status: response.statusCode, body: response.json() };
}
const load = (id: string) => one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', id)!;
const promptData = (built: ReturnType<typeof buildSideModePrompt>) => JSON.parse(built.messages[0].content.split('참고 자료(JSON):\n')[1]);

async function main() {
  try {
    const alpha = (await api('POST', '/api/characters', { name: 'Alpha', first_message: '' })).body;
    const beta = (await api('POST', '/api/characters', { name: 'Beta', first_message: '' })).body;
    const story = (await api('POST', '/api/stories', { name: 'roles', setting: 'room', scene_catalog: { places: [{ id: 'room' }] } })).body;
    await api('POST', `/api/stories/${story.id}/characters`, { characterId: alpha.id, sortOrder: 0 });
    await api('POST', `/api/stories/${story.id}/characters`, { characterId: beta.id, sortOrder: 1 });
    const room = (await api('POST', '/api/conversations', { characterId: alpha.id, storyId: story.id, mode: 'story', scene: { format: 'dialog', user_sheet: { hp: 9 } } })).body;
    const root = insertMessage(db, room.id, null, 'user', '역할을 제안해 줘.', 'complete');
    const proposal = insertMessage(db, room.id, root.id, 'assistant', '안내를 맡는 건 어때?', 'complete', { block_kind: 'line', speaker_character_id: alpha.id, speaker_name: 'Alpha' });
    const claim = insertMessage(db, room.id, proposal.id, 'assistant', '너는 안내를 맡기로 했잖아.', 'complete', { block_kind: 'line', speaker_character_id: beta.id, speaker_name: 'Beta' });
    setHead(db, room.id, claim.id);

    const invalid = await api('POST', `/api/conversations/${room.id}/role-facts`, {
      id: 'client-key', anchorMessageId: root.id, kind: 'role', subjectId: 'user', description: '방문객 안내',
      proposedBy: alpha.id, sourceMessageIds: [proposal.id], audience: { visibility: 'public' },
    });
    ok('client cannot choose event or proposal keys', () => assert.equal(invalid.status, 400));

    const registered = await api('POST', `/api/conversations/${room.id}/role-facts`, {
      anchorMessageId: root.id, kind: 'role', subjectId: 'user', description: '방문객 안내',
      proposedBy: alpha.id, sourceMessageIds: [proposal.id], audience: { visibility: 'public' },
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const proposalId = registered.body.proposalId as string;
    ok('registration is proposed and absent from confirmed INFO', () => {
      assert.equal(registered.body.facts[0].status, 'proposed');
      assert.deepEqual(registered.body.confirmed, []);
      assert.deepEqual(confirmedRolesForInfo(db, load(room.id)), []);
    });
    ok('server owns key, recorder, ordering, and version', () => {
      const row = one<any>(db, 'SELECT * FROM role_fact_events WHERE proposal_id = ?', proposalId)!;
      assert.notEqual(row.id, 'client-key');
      assert.equal(row.recorded_by, 'human:local');
      assert.equal(row.expected_version, 0);
      assert.equal(row.sequence, 1);
    });

    const claimed = await api('POST', `/api/conversations/${room.id}/role-facts/${proposalId}/claim`, {
      anchorMessageId: root.id, speakerId: beta.id, sourceMessageId: claim.id, claimedStatus: 'accepted',
    });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    ok('NPC claim stays conflict and cannot confirm the role', () => {
      assert.equal(claimed.body.facts[0].status, 'proposed');
      assert.equal(claimed.body.conflicts[0].speaker_id, beta.id);
      assert.deepEqual(claimed.body.confirmed, []);
    });
    ok('persisted facts reach both side-mode prompts without fixture injection', () => {
      for (const mode of ['summary', 'community'] as const) {
        const packet = promptData(buildSideModePrompt(db, load(room.id), mode, '', 16384)).role_facts;
        assert.equal(packet.facts[0].status, 'proposed');
        assert.equal(packet.conflicts[0].speaker, 'Beta');
        assert.equal(packet.conflicts[0].statement, '너는 안내를 맡기로 했잖아.');
      }
    });

    const badDecision = await api('POST', `/api/conversations/${room.id}/role-facts/${proposalId}/decision`, {
      anchorMessageId: root.id, action: 'accept', decisionBy: beta.id,
    });
    ok('client cannot choose decision subject', () => assert.equal(badDecision.status, 400));
    const accepted = await api('POST', `/api/conversations/${room.id}/role-facts/${proposalId}/decision`, {
      anchorMessageId: root.id, action: 'accept',
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    ok('explicit subject decision alone enters confirmed INFO', () => {
      assert.equal(accepted.body.facts[0].status, 'accepted');
      assert.deepEqual(confirmedRolesForInfo(db, load(room.id)), ['방문객 안내']);
      const meta = { block_kind: 'info', scene_state: buildSceneSnapshot({ format: 'dialog' }, { format: 'dialog', user_sheet: { hp: 9 } }, confirmedRolesForInfo(db, load(room.id))) };
      const rows = savedDialogStateRows({ role: 'assistant', status: 'complete', meta });
      assert.deepEqual(rows, [{ label: '체력', value: '9' }, { label: '역할', value: '방문객 안내' }]);
    });

    setHead(db, room.id, root.id);
    ok('branch projection hides records whose evidence is not on the active path', () => {
      assert.deepEqual(confirmedRolesForInfo(db, load(room.id)), []);
      assert.equal(promptData(buildSideModePrompt(db, load(room.id), 'summary', '', 16384)).role_facts.facts.length, 0);
    });
  } finally {
    await app.close();
    config.auth.mode = originalAuthMode;
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
