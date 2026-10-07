import { sceneDisplay } from './sceneDisplay';
import type { Scene, SceneCatalogPlace } from '../types';
import {
  parseSceneStatusSpec,
  type CastMember,
  type SceneActionItem,
  type SceneProgress,
  type SceneStatusSpec,
  type UiState,
} from './sceneStatusCatalog';

export type SceneStatusSpecInput = {
  conversationId: string;
  scene: Scene;
  places?: SceneCatalogPlace[];
  characterName?: string;
  hasBeatRoster: boolean;
  focusId?: string | null;
  generating?: boolean;
  loadError?: string | null;
  conversationEnded?: boolean;
};

function sceneProgress(scene: Scene, generating: boolean, conversationEnded: boolean): SceneProgress {
  if (conversationEnded) return 'ended';
  if (generating) return 'active';
  if (sceneDisplay(scene).hasScene) return 'active';
  return 'idle';
}

function panelUiState(input: SceneStatusSpecInput): UiState {
  if (input.loadError) return 'error';
  if (input.generating) return 'refreshing';
  if (!sceneDisplay(input.scene, input.places).hasScene) return 'empty';
  return 'default';
}

function castMembers(input: SceneStatusSpecInput): CastMember[] {
  const name = (input.characterName || '').trim();
  if (!name) return [];
  const id = input.focusId?.trim() || 'speaker';
  return [{ id, name, active: input.hasBeatRoster }];
}

const DEFAULT_ACTIONS: SceneActionItem[] = [
  { id: 'info', label: '장면 정보', intent: 'open_scene_info' },
  { id: 'state', label: '장면 상태', intent: 'open_scene_state' },
  { id: 'ctx', label: '컨텍스트', intent: 'open_context' },
];

/** Build a catalog spec from existing conv.scene. No writes. */
export function buildSceneStatusSpec(input: SceneStatusSpecInput): SceneStatusSpec {
  const uiState = panelUiState(input);
  const members = castMembers(input);
  const display = sceneDisplay(input.scene, input.places);
  const place = display.place;
  const elements: SceneStatusSpec['elements'] = {
    root: {
      type: 'SceneStatus',
      props: {
        title: display.title,
        progress: sceneProgress(input.scene, !!input.generating, !!input.conversationEnded),
        summary: display.summary || undefined,
        uiState,
      },
      children: [],
    },
  };
  const children: string[] = [];

  if (uiState === 'error') {
    elements.retry = {
      type: 'SceneAction',
      props: {
        actions: [{ id: 'retry', label: '다시 시도', intent: 'retry' }],
        uiState: 'default',
      },
      children: [],
    };
    children.push('retry');
  } else if (uiState === 'empty') {
    elements.hint = {
      type: 'EmptyHint',
      props: {
        title: '장면 정보가 없습니다.',
        body: '비트 상태나 장소 정보가 아직 없습니다.',
        uiState: 'empty',
      },
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
        props: { name: place, uiState: 'default' },
        children: [],
      };
      children.push('loc');
    } else {
      elements.locHint = {
        type: 'EmptyHint',
        props: { title: '장소 미지정', uiState: 'empty' },
        children: [],
      };
      children.push('locHint');
    }
    elements.actions = {
      type: 'SceneAction',
      props: { actions: DEFAULT_ACTIONS, uiState: 'default' },
      children: [],
    };
    children.push('actions');
  }

  elements.root.children = children;
  const spec = parseSceneStatusSpec({ root: 'root', elements });
  if (!spec) throw new Error('scene-status: built spec failed parse');
  return spec;
}
