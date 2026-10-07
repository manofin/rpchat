import type { Scene, SceneCatalogPlace } from '../types';

/** Display only: missing state stays missing; scenario is never current state. */
export function sceneDisplay(scene: Scene = {}, places: SceneCatalogPlace[] = []) {
  const location = scene.location?.trim();
  const place = scene.place?.trim()
    || places.find(p => p.id === location)?.name?.trim() || location || '';
  const minutes = scene.clock_minutes;
  const clock = typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0
    ? `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}` : '';
  const parts = [scene.time?.trim() || clock, scene.goal?.trim(), scene.mood?.trim()];
  if (typeof scene.user_sheet?.hp === 'number') parts.push(`HP\u00a0${scene.user_sheet.hp}`);
  if (typeof scene.user_sheet?.money === 'number') parts.push(`소지금\u00a0${scene.user_sheet.money}`);
  if (scene.present_ids?.length) parts.push(`동행 ${new Set(scene.present_ids).size}명`);
  const summary = parts.filter(Boolean).join(' · ');
  const hasScene = Boolean(place || summary);
  return { place, summary, hasScene, title: place || '장면',
    text: hasScene ? [place || '장소 미지정', summary].filter(Boolean).join(' · ') : '' };
}
