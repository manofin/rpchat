import { sanitizeGeneratedContent } from '../contracts/chatEventAdapter.js';
import { extractChoices } from './templates.js';
import { resolveEventActor } from '../contracts/chatActor.js';
import { parseScript, PASS_S_MAX_LINES, type SpeakerSlot } from './dialogScript.js';

/** Actor supplements must not inherit the public parser's narration fallback. */
export function parseActorSupplement(text: string, actorId: string, speakers: SpeakerSlot[]) {
  const lines: string[] = [];
  let acceptedLines = 0;
  let activeLine: number | null = null;
  let rejectedLines = 0;
  let droppedLines = 0;
  const content = sanitizeGeneratedContent(extractChoices(text).content);
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === 'NO_LINE' || line === 'NO_NARRATION') continue;
    const sep = line.indexOf('|');
    if (sep < 0) {
      if (activeLine === null) rejectedLines++;
      else {
        lines[activeLine] += ` ${line}`;
        acceptedLines++;
      }
      continue;
    }
    activeLine = null;
    const actor = sep > 0 ? resolveEventActor(line.slice(0, sep).trim(), speakers) : undefined;
    const said = sep > 0 ? line.slice(sep + 1).trim() : '';
    if (!actor || actor.id !== actorId || !said || said.includes('|')) {
      rejectedLines++;
      continue;
    }
    const canonical = `${actor.name} | ${said}`;
    const item = parseScript(canonical, speakers).items[0];
    if (item?.kind !== 'line' || item.character_id !== actorId) {
      rejectedLines++;
      continue;
    }
    if (lines.length >= PASS_S_MAX_LINES) {
      droppedLines++;
      continue;
    }
    lines.push(canonical);
    activeLine = lines.length - 1;
    acceptedLines++;
  }
  return { text: lines.join('\n'), acceptedLines, rejectedLines, droppedLines };
}
