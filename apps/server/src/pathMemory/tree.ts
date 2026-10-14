export type MessageRow = Readonly<{
  id: string;
  parent: string | null;
  role: string;
  status: string;
  internal: boolean;
}>;

export type MessageTree = Readonly<{
  order: 'oldest-to-newest';
  rows: readonly MessageRow[];
}>;

function indexTree(tree: MessageTree): Map<string, MessageRow> {
  if (tree.order !== 'oldest-to-newest') throw new Error('explicit row order required');
  const index = new Map(tree.rows.map(row => [row.id, row]));
  if (index.size !== tree.rows.length) throw new Error('duplicate message ID');
  return index;
}

export function structuralPath(tree: MessageTree, head: string | null): readonly MessageRow[] {
  const index = indexTree(tree), seen = new Set<string>(), rows: MessageRow[] = [];
  while (head !== null) {
    if (seen.has(head)) throw new Error('cyclic message path');
    seen.add(head);
    const row = index.get(head);
    if (!row) throw new Error('missing message ancestor');
    rows.push(row);
    head = row.parent;
  }
  return rows.reverse();
}

export function displayPath(tree: MessageTree, head: string | null): readonly MessageRow[] {
  return structuralPath(tree, head).filter(row => !row.internal);
}

export function descendForSelect(tree: MessageTree, start: string): string {
  const index = indexTree(tree), seen = new Set<string>();
  if (!index.has(start)) throw new Error('missing select start');
  let head = start;
  for (;;) {
    if (seen.has(head)) throw new Error('cyclic message descent');
    seen.add(head);
    const children = tree.rows.filter(row => row.parent === head && !row.internal);
    const latest = children[children.length - 1];
    if (!latest) return head;
    head = latest.id;
  }
}

export function returnToReceipt(tree: MessageTree, anchorId: string): string {
  const anchor = indexTree(tree).get(anchorId);
  if (!anchor?.internal || anchor.role !== 'memory-anchor') throw new Error('receipt anchor required');
  return descendForSelect(tree, anchorId);
}

export function siblingsOf(tree: MessageTree, id: string): readonly string[] {
  const row = indexTree(tree).get(id);
  if (!row) throw new Error('missing sibling target');
  return row.internal ? [] : tree.rows
    .filter(other => !other.internal && other.parent === row.parent && other.role === row.role)
    .map(other => other.id);
}

export type DisplayProjection = Readonly<{
  head: string | null;
  messages: readonly Readonly<{ id: string; parent: string | null }>[];
}>;

export function projectForDisplay(tree: MessageTree, head: string | null): DisplayProjection {
  const visible = displayPath(tree, head);
  return {
    head: visible[visible.length - 1]?.id ?? null,
    messages: visible.map((row, i) => ({ id: row.id, parent: visible[i - 1]?.id ?? null })),
  };
}

/** Every row id -> nearest visible ancestor-or-self (null when none). Throws on a missing ancestor or a cycle anywhere in the tree. */
export function buildDisplayIndex(tree: MessageTree): ReadonlyMap<string, string | null> {
  const index = indexTree(tree);
  const out = new Map<string, string | null>();
  for (const start of tree.rows) {
    const chain: MessageRow[] = [];
    const onChain = new Set<string>();
    let cur: string | null = start.id;
    let resolved: string | null = null;
    while (cur !== null) {
      if (out.has(cur)) { resolved = out.get(cur) as string | null; break; }
      if (onChain.has(cur)) throw new Error('cyclic message path');
      const row = index.get(cur);
      if (!row) throw new Error('missing message ancestor');
      onChain.add(cur);
      chain.push(row);
      cur = row.parent;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const row = chain[i]!;
      if (!row.internal) resolved = row.id;
      out.set(row.id, resolved);
    }
  }
  return out;
}
