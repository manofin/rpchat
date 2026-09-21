import type { Scene } from '../types';
import {
  parseSceneStatusSpec,
  type CastMember,
  type SceneProgress,
  type SceneStatusSpec,
  type UiState,
} from './sceneStatusCatalog';

export type SceneStatusSpecInput = {
  conversationId: string;
  scene: Scene;
  characterName?: string;
  hasBeatRoster: boolean;
  focusId?: string | null;
  generating?: boolean;
  loadError?: string | null;
  conversationEnded?: boolean;
};

function sceneTitle(scene: Scene): string {
  return (scene.place || scene.location || '').trim() || '장면';
}

function sceneSummary(scene: Scene): string | undefined {
  const text = (scene.goal || scene.mood || scene.time || '').trim();
  return text || undefined;
}

function sceneProgress(scene: Scene, generating: boolean, conversationEnded: boolean): SceneProgress {
  if (conversationEnded) return 'ended';
  if (generating) return 'active';
  if (scene.place || scene.location || scene.time) return 'active';
  return 'idle';
}

function panelUiState(input: SceneStatusSpecInput): UiState {
  if (input.loadError) return 'error';
  if (input.generating) return 'refreshing';
  const s = input.scene;
  if (!(s.place || s.location || s.time || s.goal || s.mood)) return 'empty';
  return 'default';
}

function castMembers(input: SceneStatusSpecInput): CastMember[] {
  const name = (input.characterName || '').trim();
  if (!name) return [];
  const id = input.focusId?.trim() || 'speaker';
  if (input.hasBeatRoster) {
    return [{ id, name, presence: 'speaking' }];
  }
  return [{ id, name, presence: 'present' }];
}

/** Build a catalog spec from existing conv.scene. No writes. */
export function buildSceneStatusSpec(input: SceneStatusSpecInput): SceneStatusSpec {
  const uiState = panelUiState(input);
  const members = castMembers(input);
  const place = (input.scene.place || input.scene.location || '').trim();
  const elements: SceneStatusSpec['elements'] = {
    root: {
      type: 'SceneStatus',
      props: {
        title: sceneTitle(input.scene),
        progress: sceneProgress(input.scene, !!input.generating, !!input.conversationEnded),
        summary: sceneSummary(input.scene),
        uiState,
      },
      children: [],
    },
  };
  const children: string[] = [];

  if (uiState === 'error') {
    elements.retry = {
      type: 'SceneAction',
      props: { label: '다시 시도', intent: 'retry', uiState: 'default' },
      children: [],
    };
    children.push('retry');
  } else if (uiState === 'empty') {
    elements.hint = {
      type: 'EmptyHint',
      props: { message: '장면 정보가 없습니다.', uiState: 'empty' },
      children: [],
    };
    children.push('hint');
  } else if (uiState !== 'loading') {
    if (members.length) {
      elements.cast = {
        type: 'CastRow',
        props: { members, uiState: input.generating ? 'refreshing' : 'default' },
        children: [],
      };
      children.push('cast');
    }
    if (place) {
      elements.loc = {
        type: 'LocationPill',
        props: { place, uiState: 'default' },
        children: [],
      };
      children.push('loc');
    } else {
      elements.locHint = {
        type: 'EmptyHint',
        props: { message: '위치가 없습니다.', uiState: 'empty' },
        children: [],
      };
      children.push('locHint');
    }
    elements.info = {
      type: 'SceneAction',
      props: { label: '장면 정보', intent: 'open_scene_info', uiState: 'default' },
      children: [],
    };
    elements.state = {
      type: 'SceneAction',
      props: { label: '장면 상태', intent: 'open_scene_state', uiState: 'default' },
      children: [],
    };
    elements.ctx = {
      type: 'SceneAction',
      props: { label: '컨텍스트', intent: 'open_context', uiState: 'default' },
      children: [],
    };
    children.push('info', 'state', 'ctx');
  }

  elements.root.children = children;
  const spec = parseSceneStatusSpec({ root: 'root', elements });
  if (!spec) throw new Error('scene-status: built spec failed parse');
  return spec;
}
