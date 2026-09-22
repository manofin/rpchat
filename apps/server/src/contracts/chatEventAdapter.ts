import type { ChatEvent } from '@rpchat/contracts/chat-event';
import { sanitizeNarration } from '../prompt/templates.js';
import { parseScript } from '../prompt/dialogScript.js';
import { resolveEventActor, type EventActor } from './chatActor.js';

export { CHAT_SCRIPT_MAX_LINES, resolveEventActor, type EventActor } from './chatActor.js';
export type EventMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: string;
  meta?: {
    block_kind?: string;
    speaker_character_id?: string;
    speaker_name?: string;
    ooc?: boolean;
    chat_event_actors?: EventActor[];
    chat_event_script?: boolean;
    chat_event_default_actor?: EventActor;
  };
};
export type AdaptOptions = {
  actors?: EventActor[];
  defaultActor?: EventActor;
  streaming?: boolean;
};

export function createChatEventStream(message: EventMessage, options: AdaptOptions = {}) {
  let sent = '';
  return (raw: string): { messageId: string; eventVersion: 1; text: string; events: ChatEvent[] } => {
    const safe = sanitizeGeneratedContent(raw, { streaming: true });
    const delta = safe.startsWith(sent) ? safe.slice(sent.length) : '';
    if (safe.startsWith(sent)) sent = safe;
    return { messageId: message.id, eventVersion: 1, text: delta, events: adaptChatEvents({ ...message, content: raw }, { ...options, streaming: true }) };
  };
}

const THOUGHT_TAGS = ['think', 'thinking', 'analysis', 'thought'];
const THOUGHT_LABELS = ['속마음:', '속마음：', 'thought:', 'thinking:'];

/** A cumulative buffer is required: private markers may straddle any token boundary. */
export function stripThoughtContent(raw: string, options: { streaming?: boolean } = {}): string {
  return cleanGeneratedContent(raw, { ...options, preserveControls: true });
}

export function sanitizeGeneratedContent(raw: string, options: { streaming?: boolean } = {}): string {
  return cleanGeneratedContent(raw, options);
}

function cleanGeneratedContent(raw: string, options: { streaming?: boolean; preserveControls?: boolean }): string {
  let text = raw ?? '';
  const tags = options.preserveControls ? THOUGHT_TAGS : [...THOUGHT_TAGS, 'choices'];
  const privateTag = new RegExp(`<(/?)(${tags.join('|')})\\b[^>]*>`, 'gi');
  const stack: string[] = [];
  let cursor = 0;
  let visible = '';
  for (const match of text.matchAll(privateTag)) {
    if (!stack.length) visible += text.slice(cursor, match.index);
    const name = match[2].toLowerCase();
    if (match[1]) {
      const open = stack.lastIndexOf(name);
      if (open >= 0) stack.splice(open);
    } else if (!match[0].endsWith('/>')) stack.push(name);
    cursor = match.index! + match[0].length;
  }
  if (!stack.length) visible += text.slice(cursor);
  text = visible;
  for (const tag of tags) {
    text = text.replace(new RegExp(`<\\/?${tag}\\b[^>]*$`, 'gi'), '');
  }
  text = text.replace(/(?:[ \t>*_`-]*속마음\s*[:：]|(?:^|\n)[ \t>*_`-]*(?:thought|thinking)\s*:)[\s\S]*$/i, '');

  // Hold prefixes even on an interrupted final buffer; an unfinished private
  // marker is never useful visible story text.
  const lower = text.toLowerCase();
  let held = 0;
  for (const tag of tags.flatMap((name) => [`<${name}>`, `</${name}>`])) {
    for (let n = Math.min(tag.length - 1, lower.length); n > held; n--) {
      if (tag.startsWith(lower.slice(-n))) { held = n; break; }
    }
  }
  if (held) text = text.slice(0, -held);
  for (const label of options.streaming ? ['속마음:', '속마음：'] : []) {
    for (let n = label.length - 1; n > 0; n--) {
      if (text.endsWith(label.slice(0, n))) { text = text.slice(0, -n); break; }
    }
  }
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  const prefix = lastLine.replace(/^[ \t>*_`-]*/, '').toLowerCase();
  if (prefix && THOUGHT_LABELS.some((label) => label.startsWith(prefix))) {
    text = text.slice(0, text.length - lastLine.length);
  }
  if (options.preserveControls) return text;
  if (options.streaming && /^\s*\(o(?:o(?:c)?)?$/i.test(text)) return '';

  // A trailing control object is held until complete so its keys cannot flash
  // on screen before the existing sanitizer recognizes the finished object.
  if (options.streaming) text = text.replace(/(?:^|\n)[ \t]*\{[\s\S]*$/, '');
  return sanitizeNarration(text);
}

function unquote(text: string): string {
  const value = text.trim();
  const pairs = [['"', '"'], ['“', '”'], ['「', '」'], ['『', '』']] as const;
  for (const [open, close] of pairs) {
    if (value.startsWith(open) && value.endsWith(close) && value.length >= 2) return value.slice(1, -1).trim();
  }
  return value;
}

function narrationText(text: string): string {
  const value = text.trim();
  return /^\*[^*]+\*$/s.test(value) ? value.slice(1, -1).trim() : value;
}

/** The sole text-to-display adapter. Legacy rows are adapted without rewriting them. */
export function adaptChatEvents(message: EventMessage, options: AdaptOptions = {}): ChatEvent[] {
  const events: ChatEvent[] = [];
  const meta = message.meta ?? {};
  const kind = meta.block_kind;
  if (kind === 'thought') return events;
  const streaming = options.streaming ?? message.status === 'streaming';
  const defaultActor = meta.chat_event_default_actor ?? options.defaultActor;
  const actors = meta.chat_event_actors ?? options.actors ?? (defaultActor ? [defaultActor] : []);
  const explicitActor = meta.speaker_character_id || meta.speaker_name
    ? { id: meta.speaker_character_id ?? null, name: meta.speaker_name ?? null }
    : defaultActor ? { id: defaultActor.id, name: defaultActor.name } : { id: null, name: null };
  const nextId = () => `${message.id}:${events.length}`;
  const narrate = (text: string) => {
    const value = narrationText(text);
    if (value) events.push({ type: 'narration', id: nextId(), text: value });
  };
  const speak = (text: string, actor = explicitActor) => {
    const value = unquote(text);
    if (value) events.push({ type: 'dialogue', id: nextId(), actorId: actor.id, actorName: actor.name, text: value });
  };
  const lineEvents = (text: string, actor = explicitActor) => {
    if (!/["“「『]/.test(text)) speak(text, actor);
    else {
      const parts = text.split(/("[^"\n]+"|“[^”\n]+”|「[^」\n]+」|『[^』\n]+』)/g).filter(Boolean);
      for (const part of parts) {
        if (/^(?:".*"|“.*”|「.*」|『.*』)$/s.test(part)) speak(part, actor);
        else narrate(part);
      }
    }
  };
  if (message.role === 'user') {
    if (message.content) events.push({ type: 'dialogue', id: nextId(), actorId: null, actorName: null, text: message.content });
    return events;
  }
  if (kind === 'ui' || kind === 'panel') {
    let payload: unknown;
    try { payload = JSON.parse(message.content); } catch { payload = null; }
    events.push({ type: 'system', id: nextId(), presentation: kind, text: kind === 'panel' && payload === null ? sanitizeGeneratedContent(message.content) : '', payload });
    return events;
  }
  const script = !kind && meta.chat_event_script === true;
  const source = script && streaming ? message.content.slice(0, message.content.lastIndexOf('\n') + 1) : message.content;
  const text = sanitizeGeneratedContent(source, { streaming: streaming || message.status === 'interrupted' || message.status === 'error' });
  if (kind === 'header' || kind === 'info' || kind === 'system' || meta.ooc) {
    if (text) events.push({ type: 'system', id: nextId(), text, ...(kind === 'header' || kind === 'info' ? { presentation: kind } : {}) });
    return events;
  }
  if (kind === 'narration') { narrate(text); return events; }
  if (kind === 'line') { lineEvents(text); return events; }
  if (script) {
    for (const item of parseScript(text, actors).items) {
      if (item.kind === 'narration') narrate(item.text);
      else lineEvents(item.text, { id: item.character_id, name: item.name });
    }
    return events;
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const named = /^\s*(?:\[([^\]\n]{1,24})\]\s*[:：|]|([^|\n]{1,24})\s*\|)\s*(.+)$/.exec(line);
    if (named) {
      const name = (named[1] ?? named[2]).replace(/^[\s>*_`-]+|[\s*_`:：]+$/g, '').trim();
      const actor = resolveEventActor(name, actors);
      speak(named[3], { id: actor?.id ?? null, name: actor?.name ?? name });
      continue;
    }
    // Explicit quotation and action markers are the only attribution evidence
    // in old 1:1 prose. Plain prose remains narration instead of inventing speech.
    const parts = line.split(/(\*[^*]+\*|"[^"\n]+"|“[^”\n]+”|「[^」\n]+」|『[^』\n]+』)/g).filter(Boolean);
    for (const part of parts) {
      if (/^(?:".*"|“.*”|「.*」|『.*』)$/s.test(part)) speak(part);
      else narrate(part);
    }
  }
  return events;
}

export function isChatEvent(value: unknown): value is ChatEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (typeof event.id !== 'string') return false;
  switch (event.type) {
    case 'dialogue': return typeof event.text === 'string' && (event.actorId === null || typeof event.actorId === 'string') && (event.actorName === null || typeof event.actorName === 'string');
    case 'narration': return typeof event.text === 'string';
    case 'system': return typeof event.text === 'string' && (event.presentation === undefined || ['header', 'info', 'ui', 'panel'].includes(String(event.presentation)));
    case 'state_patch': return !!event.patch && typeof event.patch === 'object' && !Array.isArray(event.patch);
    case 'error': return typeof event.code === 'string' && typeof event.message === 'string';
    default: return false;
  }
}
