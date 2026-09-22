export type EventActor = { id: string; name: string; aliases?: string[] };

export const CHAT_SCRIPT_MAX_LINES = 12;

function foldName(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

export function resolveEventActor(name: string, actors: EventActor[]): EventActor | undefined {
  const key = foldName(name);
  const hits = actors.filter((actor) => [actor.name, ...(actor.aliases ?? [])].some((value) => foldName(value) === key));
  return new Set(hits.map((actor) => actor.id)).size === 1 ? hits[0] : undefined;
}
