import { createElement, type ComponentType, type ReactNode } from 'react';
import type { SceneActionIntent, SceneStatusSpec } from '../../lib/sceneStatusCatalog';
import { SCENE_STATUS_REGISTRY } from './registry';

export function SceneStatusRenderer({
  spec,
  onIntent,
}: {
  spec: SceneStatusSpec;
  onIntent?: (intent: SceneActionIntent) => void;
}): ReactNode {
  return renderNode(spec.root, spec, onIntent);
}

function renderNode(
  id: string,
  spec: SceneStatusSpec,
  onIntent?: (intent: SceneActionIntent) => void,
): ReactNode {
  const el = spec.elements[id];
  if (!el) return null;
  const Comp = SCENE_STATUS_REGISTRY[el.type] as ComponentType<Record<string, unknown>>;
  const children = el.children.map((cid) => renderNode(cid, spec, onIntent));
  const extra = el.type === 'SceneAction' ? { onIntent } : {};
  return createElement(Comp, {
    key: id,
    ...el.props,
    ...extra,
    children,
  });
}
