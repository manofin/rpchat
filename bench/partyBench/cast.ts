/** Frozen synthetic cast. Live character UUIDs forbidden. */
import type { CastMember } from './types.ts';

export const CAST: CastMember[] = [
  {
    id: 'npc_mina',
    name: '민아',
    aliases: ['접수원'],
    duties: ['등록', '접수'],
    place: '로비',
    role: 'main',
  },
  {
    id: 'npc_jiu',
    name: '지우',
    aliases: ['안내원'],
    duties: ['안내', '길찾기'],
    place: '로비',
    role: 'secondary',
  },
  {
    id: 'npc_harin',
    name: '하린',
    aliases: ['측정원'],
    duties: ['측정', '검사'],
    place: '측정실',
    role: 'secondary',
  },
  {
    id: 'npc_doyun',
    name: '도윤',
    aliases: ['경비원'],
    duties: ['출입', '경비'],
    place: '정문',
    role: 'secondary',
  },
  {
    id: 'npc_bg',
    name: '설화',
    aliases: ['청소부'],
    duties: [],
    place: '로비',
    role: 'background',
  },
];

export const SCENE_LOBBY = {
  place: '로비',
  time: '오전',
  goal: '아카데미 등록',
  genre: '현대물',
  conflict: '대기 줄',
  mood: '긴장',
};

export const SCENE_LAB = {
  place: '측정실',
  time: '오전',
  goal: '기초 능력 측정',
  genre: '현대물',
  conflict: '장비 대기',
  mood: '집중',
};

export const SCENE_GATE = {
  place: '정문',
  time: '오전',
  goal: '출입 확인',
  genre: '현대물',
  conflict: '출입증 줄',
  mood: '경계',
};

export const FORBIDDEN_SUBSTRINGS = [
  'f89ace9b',
  '255f96a2',
  'a5073af0',
  '09e7827f',
  '서리',
  '카이',
  '임포트테스트',
  '한소연',
  '유키',
];
