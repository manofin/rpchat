import { audienceSchema, type Audience } from '../prompt/observation.js';

export type MemoryNode = Readonly<{
  node_id: string;
  label: string;
  body?: string;
  state: 'active' | 'closed';
  audience: Audience;
}>;

declare const authorized: unique symbol;
export type AuthorizedNodePacket = Readonly<{
  node_id: string;
  label: string;
  body?: string;
  [authorized]: true;
}>;
export type RecipientPacket = readonly AuthorizedNodePacket[];

/** No unfiltered index, diagnostic count or observer notification is part of the return type. */
export function projectNodes(nodes: readonly MemoryNode[], recipient: string): RecipientPacket {
  const packet: AuthorizedNodePacket[] = [];
  for (const node of nodes) {
    const parsed = audienceSchema.safeParse(node.audience);
    if (!parsed.success) throw new Error('invalid memory audience');
    const audience: Audience = parsed.data;
    if (node.state !== 'active') continue;
    const allowed = audience.visibility === 'public' || audience.recipient_ids.includes(recipient);
    if (!allowed) continue;
    packet.push({ node_id: node.node_id, label: node.label,
      ...(node.body === undefined ? {} : { body: node.body }) } as AuthorizedNodePacket);
  }
  return packet;
}
