/** Isolated Bench-A types. Not apps/**. Not F9C pickSpeaker.ts. */

export type CastRole = 'main' | 'secondary' | 'background';

export type CastMember = {
  id: string;
  name: string;
  aliases: string[];
  duties: string[];
  place: string;
  role: CastRole;
};

/** Existing scene_json 6 string fields. Not scene.time clock (F9B deferred). */
export type Scene6 = {
  place?: string;
  time?: string;
  goal?: string;
  genre?: string;
  conflict?: string;
  mood?: string;
};

export type Bucket = 'explicit_name' | 'duty_fit' | 'scene_position' | 'ambiguous';

export type AccuracyCase = {
  id: string;
  bucket: Bucket;
  expected_stage: 1 | 2 | 3 | 4;
  expected_main_speaker_id: string | null;
  forbidden_speakers: string[];
  user_text: string;
  scene: Scene6;
  cast: CastMember[];
};

export type ReachCase = {
  id: string;
  bucket: Bucket;
  user_text: string;
  scene: Scene6;
  cast: CastMember[];
};

export type RouterInput = {
  user_text: string;
  scene: Scene6;
  cast: CastMember[];
};

export type RouterOutput = {
  decided_stage: 1 | 2 | 3 | 4;
  scores: Record<string, number>;
  main_speaker_id: string | null;
  llm_reached: boolean;
};
