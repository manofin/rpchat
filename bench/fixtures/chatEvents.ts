import type { EventMessage, AdaptOptions } from '../../apps/server/src/contracts/chatEventAdapter.js';

const actors = [{ id: 'eden', name: '이든' }, { id: 'nari', name: '나리' }];
export const chatEventFixtures: Array<{
  name: string;
  message: EventMessage;
  options?: AdaptOptions;
  types: string[];
  texts: string[];
  actorIds?: Array<string | null>;
}> = [
  {
    name: '01_dialogue_only',
    message: { id: '01', role: 'assistant', content: '"안녕하세요."', meta: { block_kind: 'line', speaker_character_id: 'eden', speaker_name: '이든' } },
    types: ['dialogue'], texts: ['안녕하세요.'], actorIds: ['eden'],
  },
  {
    name: '02_narration_only',
    message: { id: '02', role: 'assistant', content: '창가로 햇살이 들어온다.', meta: { block_kind: 'narration' } },
    types: ['narration'], texts: ['창가로 햇살이 들어온다.'],
  },
  {
    name: '03_dialogue_and_narration',
    message: { id: '03', role: 'assistant', content: '*그가 손을 흔든다.*\n[이든] : "반가워요."' },
    options: { actors }, types: ['narration', 'dialogue'], texts: ['그가 손을 흔든다.', '반가워요.'], actorIds: ['eden'],
  },
  {
    name: '04_multiple_characters',
    message: { id: '04', role: 'assistant', content: '이든 | "먼저 갈게요."\n나리 | "기다려요."', meta: { chat_event_script: true } },
    options: { actors }, types: ['dialogue', 'dialogue'], texts: ['먼저 갈게요.', '기다려요.'], actorIds: ['eden', 'nari'],
  },
  {
    name: '05_unknown_actor',
    message: { id: '05', role: 'assistant', content: '[낯선 사람] : "실례합니다."' },
    options: { actors }, types: ['dialogue'], texts: ['실례합니다.'], actorIds: [null],
  },
  {
    name: '06_duplicate_display_name',
    message: { id: '06', role: 'assistant', content: '[이든] : "누구일까요?"' },
    options: { actors: [{ id: 'eden-1', name: '이든' }, { id: 'eden-2', name: '이든' }] },
    types: ['dialogue'], texts: ['누구일까요?'], actorIds: [null],
  },
  {
    name: '07_malformed_model_output',
    message: { id: '07', role: 'assistant', content: '<think>PRIVATE_FIXTURE unclosed internal block' },
    types: [], texts: [],
  },
  {
    name: '08_legacy_db_message',
    message: { id: '08', role: 'assistant', content: '예전의 속마음은 그대로 보존한다.', meta: { block_kind: 'thought' } },
    types: [], texts: [],
  },
  {
    name: '09_stream_interrupted',
    message: { id: '09', role: 'assistant', status: 'interrupted', content: '"여기까지."\n속마음: PRIVATE_FIXTURE' },
    options: { defaultActor: actors[0] }, types: ['dialogue'], texts: ['여기까지.'], actorIds: ['eden'],
  },
  {
    name: '10_session_resume',
    message: { id: '10', role: 'assistant', status: 'complete', content: '*문이 열린다.*\n[나리] : "돌아왔군요."' },
    options: { actors }, types: ['narration', 'dialogue'], texts: ['문이 열린다.', '돌아왔군요.'], actorIds: ['nari'],
  },
];
