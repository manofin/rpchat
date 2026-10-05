import assert from 'node:assert/strict';
import { secretRulesFromPacket, scriptSecretViolations, segmentSecretViolations } from '../apps/server/src/prompt/dialogSecretOutput.js';
import type { ActorContext } from '../apps/server/src/prompt/dialogActorContext.js';
const secret = { memory_id: 's', kind: 'fact' as const, text: '봉인 암호 7391' };
const packet: ActorContext = { version: 1, legacy_policy: 'narrator_reference_unspecified', boundary: 'single_narrator_request',
  public_facts: [{ ...secret, memory_id: 'public' }], narrator_facts: [], excluded: [],
  actors: [{ id: 'n', name: '나리', public_memory_ids: ['public'], facts: [secret] },
    { id: 's', name: '세라', public_memory_ids: ['public'], facts: [] },
    { id: 'h', name: '하연', public_memory_ids: ['public'], facts: [secret] }] };
const speakers = [{ id: 'n', name: '나리', aliases: ['나리별명'] }, { id: 's', name: '세라' }, { id: 'h', name: '하연' }];
const rules = secretRulesFromPacket(packet);
assert.equal(rules.length, 1);
assert.equal(scriptSecretViolations('나리별명 | 봉인 암호 7391\n하연 | 봉인 암호 7391', speakers, rules).length, 0);
console.log('ok 1 multiple assigned holders and canonical alias resolution');
assert.deepEqual(scriptSecretViolations('**세라** | 봉인 암호 7391', speakers, rules), [{ actorId: 's', memoryId: 's' }]);
console.log('ok 2 decorated nonrecipient name rejected without secret in report');
assert.equal(scriptSecretViolations('세라 | 암호는 칠삼구일이야.', speakers, rules).length, 0);
console.log('ok 3 paraphrase is explicitly outside exact-text detector');
assert.equal(scriptSecretViolations('서술자가 봉인 암호 7391을 기록한다.', speakers, rules).length, 0);
console.log('ok 4 narrator access is distinct from NPC speech');
assert.equal(scriptSecretViolations('<think>세라 | 봉인 암호 7391</think>\n세라 | 기다리자.\n<choices>["봉인 암호 7391"]</choices>', speakers, rules).length, 0);
console.log('ok 5 existing control-text sanitation and choices separation reused');
const segmented = segmentSecretViolations([
  { audience: 'public', text: '하연 | 봉인 암호 7391' },
  { audience: 'actor:n', text: '나리 | 봉인 암호 7391' },
  { audience: 'actor:n', text: '세라 | 봉인 암호 7391' },
  { audience: 'narrator', text: '창가에 봉인 암호 7391이 적혀 있다.' },
], speakers, rules);
assert.deepEqual(segmented, [{ audience: 'actor:n', actorId: 's', memoryId: 's' }]);
assert.ok(!JSON.stringify(segmented).includes('7391'));
console.log('ok 6 each public/private segment is checked separately and reported by ID only');
