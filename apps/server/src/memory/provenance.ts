import { createHash } from 'node:crypto';
import { z } from 'zod';
import { one, type DB } from '../db/index.js';
import { getPath } from '../db/tree.js';
import { parseMessageMeta } from '../db/messageMeta.js';
import { audienceSchema, audienceOf, audienceAllowsOutput, PUBLIC, type Audience } from '../prompt/observation.js';
import type { ConversationRow, MemoryRow, MessageRow, SummaryRow } from '../types.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z.object({
  kind: z.enum(['message', 'summary']), id: z.string().min(1), conversation_id: z.string().min(1),
  content_sha256: hash, projection_sha256: hash, provenance_sha256: hash.nullable(), audience: audienceSchema,
}).strict();
const schema = z.object({
  version: z.literal(1), basis: z.enum(['generated', 'user-declared']), content_sha256: hash,
  ceiling: audienceSchema, inputs: z.array(sourceSchema).max(10000),
}).strict().refine(p => p.basis === 'user-declared' || p.inputs.length > 0);
export type ProvenanceSource = z.infer<typeof sourceSchema>;
type Artifact = Pick<MemoryRow | SummaryRow, 'id' | 'content' | 'input_provenance_json'>;
export const contentHash = (text: string) => createHash('sha256').update(text).digest('hex');

function parse(raw: string | null | undefined) {
  if (!raw) return null;
  try { const p = schema.safeParse(JSON.parse(raw)); return p.success ? p.data : null; } catch { return null; }
}
function canonical(a: Audience): Audience {
  return a.visibility === 'public' ? PUBLIC : { visibility: 'private', recipient_ids: [...new Set(a.recipient_ids)].sort(), observer_ids: [] };
}
function intersect(audiences: Audience[]): Audience {
  const privateInputs = audiences.filter((a): a is Extract<Audience, { visibility: 'private' }> => a.visibility === 'private');
  return privateInputs.length ? canonical({ visibility: 'private', recipient_ids: privateInputs[0].recipient_ids.filter(id => privateInputs.every(a => a.recipient_ids.includes(id))), observer_ids: [] }) : PUBLIC;
}
export function encodeProvenance(content: string, inputs: ProvenanceSource[], basis: 'generated' | 'user-declared' = 'generated'): string {
  return JSON.stringify(schema.parse({ version: 1, basis, content_sha256: contentHash(content), ceiling: intersect(inputs.map(s => s.audience)), inputs }));
}
/** Editing text is not a declaration that its restricted sources became public. */
export function provenanceAfterEdit(row: Artifact, content: string): string | null {
  const p = parse(row.input_provenance_json);
  return p && p.content_sha256 === contentHash(row.content)
    ? JSON.stringify({ ...p, content_sha256: contentHash(content) }) : row.input_provenance_json ?? null;
}

/** One reader per synchronous request/snapshot. Never reuse across a model await. */
export function provenanceReader(db: DB, selectedPaths: ReadonlyMap<string, Set<string>> = new Map()) {
  const paths = new Map(selectedPaths);
  const messages = new Map<string, MessageRow | null>();
  const summaries = new Map<string, SummaryRow | null>();
  const audiences = new Map<string, Audience | null>();
  const message = (id: string) => {
    if (!messages.has(id)) messages.set(id, one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', id) ?? null);
    return messages.get(id)!;
  };
  const summary = (id: string) => {
    if (!summaries.has(id)) summaries.set(id, one<SummaryRow>(db, 'SELECT * FROM summaries WHERE id = ?', id) ?? null);
    return summaries.get(id)!;
  };
  const pathFor = (id: string) => {
    let ids = paths.get(id);
    if (!ids) {
      const c = one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', id);
      ids = new Set(c ? getPath(db, c).map(m => m.id) : []); paths.set(id, ids);
    }
    return ids;
  };
  const messageAudience = (m: MessageRow, includeOffBranch = false): Audience | null => {
    if (m.status !== 'complete' || (!includeOffBranch && !pathFor(m.conversation_id).has(m.id))) return null;
    const a = audienceOf(m);
    if (a) return canonical(a);
    const meta = parseMessageMeta(m.meta_json);
    if (Object.hasOwn(meta, 'observation')) return null;
    // Preserve the established unlabelled-message contract, not legacy derived
    // records: filtered beat requires classification; unfiltered/dialog does not.
    const c = one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', m.conversation_id);
    try {
      const scene = JSON.parse(c?.scene_json ?? '{}');
      return scene.format !== 'dialog' && scene.observation_filter === true ? null : PUBLIC;
    } catch { return null; }
  };
  const sourceMessage = (s: ProvenanceSource): MessageRow | null => {
    const m = message(s.id);
    return m && m.conversation_id === s.conversation_id && contentHash(m.content) === s.content_sha256 && s.provenance_sha256 === null ? m : null;
  };
  const sourceSummary = (s: ProvenanceSource): SummaryRow | null => {
    const row = summary(s.id);
    return row && row.status === 'approved' && row.conversation_id === s.conversation_id && contentHash(row.content) === s.content_sha256
      && row.input_provenance_json && contentHash(row.input_provenance_json) === s.provenance_sha256 ? row : null;
  };
  // Iterative post-order traversal validates each dependency once per snapshot.
  // A long legitimate summary chain is not a cycle or an invalid source.
  const artifactAudience = (row: MemoryRow | SummaryRow, kind: 'memory' | 'summary'): Audience | null => {
    type Frame = { row: MemoryRow | SummaryRow; kind: 'memory' | 'summary'; inputs?: ProvenanceSource[]; caps: Audience[]; index: number };
    const key = (f: Pick<Frame, 'row' | 'kind'>) => `${f.kind}:${f.row.id}`;
    const stack: Frame[] = [{ row, kind, caps: [], index: 0 }];
    const active = new Set<string>();
    const finish = (f: Frame, audience: Audience | null) => { audiences.set(key(f), audience); active.delete(key(f)); stack.pop(); };
    while (stack.length) {
      const f = stack[stack.length - 1];
      if (audiences.has(key(f))) { stack.pop(); continue; }
      if (!f.inputs) {
        if (f.row.input_provenance_json == null) {
          // Legacy automatic records are withheld. Directly authored memory
          // keeps its existing meaning, including restrictions on its evidence.
          if (f.kind !== 'memory' || (f.row as MemoryRow).source !== 'user') { finish(f, null); continue; }
          let ids: unknown;
          try { ids = JSON.parse((f.row as MemoryRow).evidence_message_ids_json); } catch { finish(f, null); continue; }
          if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) { finish(f, null); continue; }
          const caps = ids.map(id => { const m = message(id); return m && messageAudience(m); });
          finish(f, caps.every((a): a is Audience => !!a) ? intersect(caps) : null); continue;
        }
        const p = parse(f.row.input_provenance_json);
        if (!p || p.content_sha256 !== contentHash(f.row.content)
          || ((f.kind === 'summary' || (f.row as MemoryRow).source === 'model') && p.basis !== 'generated')) { finish(f, null); continue; }
        f.inputs = p.inputs; f.caps = [p.ceiling]; active.add(key(f));
      }
      if (f.index === f.inputs.length) { finish(f, intersect(f.caps)); continue; }
      const s = f.inputs[f.index];
      let current: Audience | null;
      if (s.kind === 'message') {
        const m = sourceMessage(s); current = m && messageAudience(m);
      } else {
        const source = sourceSummary(s);
        if (!source) { finish(f, null); continue; }
        const childKey = `summary:${source.id}`;
        if (active.has(childKey)) { finish(f, null); continue; }
        if (!audiences.has(childKey)) { stack.push({ row: source, kind: 'summary', caps: [], index: 0 }); continue; }
        current = audiences.get(childKey)!;
      }
      if (!current) { finish(f, null); continue; }
      f.caps.push(s.audience, current); f.index++;
    }
    return audiences.get(`${kind}:${row.id}`)!;
  };
  const sourceAudience = (s: ProvenanceSource): Audience | null => {
    if (s.kind === 'message') { const m = sourceMessage(s); return m && messageAudience(m); }
    const row = sourceSummary(s); return row && artifactAudience(row, 'summary');
  };
  const messageSource = (m: MessageRow, projection: string, options?: { includeOffBranch?: boolean }): ProvenanceSource | null => {
    const audience = messageAudience(m, options?.includeOffBranch);
    return audience ? { kind: 'message', id: m.id, conversation_id: m.conversation_id, content_sha256: contentHash(m.content),
      projection_sha256: contentHash(projection), provenance_sha256: null, audience } : null;
  };
  const summarySource = (row: SummaryRow, projection: string): ProvenanceSource | null => {
    const audience = artifactAudience(row, 'summary');
    return audience ? { kind: 'summary', id: row.id, conversation_id: row.conversation_id, content_sha256: contentHash(row.content),
      projection_sha256: contentHash(projection), provenance_sha256: contentHash(row.input_provenance_json!), audience } : null;
  };
  return {
    messageSource, summarySource,
    canUse: (row: MemoryRow | SummaryRow, kind: 'memory' | 'summary', output: Audience = PUBLIC) => audienceAllowsOutput(artifactAudience(row, kind) ?? undefined, output),
    audience: artifactAudience,
    unchanged: (inputs: ProvenanceSource[]) => inputs.every(s => {
      const current = sourceAudience(s);
      return current && JSON.stringify(canonical(current)) === JSON.stringify(canonical(s.audience));
    }),
  };
}
