import { SceneStatus } from './SceneStatus';
import { CastRow } from './CastRow';
import { LocationPill } from './LocationPill';
import { SceneAction } from './SceneAction';
import { EmptyHint } from './EmptyHint';
import { AlertInline } from './AlertInline';

export const SCENE_STATUS_REGISTRY = {
  SceneStatus,
  CastRow,
  LocationPill,
  SceneAction,
  EmptyHint,
  AlertInline,
} as const;
