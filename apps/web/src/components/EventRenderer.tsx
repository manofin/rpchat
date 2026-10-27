import type { ChatEvent, Message } from '../types';
import { EVENT_CONTRACT_UNAVAILABLE, eventUiData, hasEventContract } from '../lib/chatEvents';
import { BeatUiPanel } from './view';
import { CharacterPortrait } from './CharacterPortrait';
import { DialogSavedState } from './DialogSavedState';

export function EventRenderer({ events, focusId, portraits = [] }: { events: ChatEvent[]; streaming?: boolean; focusId?: string | null; portraits?: NonNullable<Message['meta']['roster_portraits']> }) {
  const shown = new Set<string>();
  return <>{events.map((event) => {
    switch (event.type) {
      case 'dialogue': {
        const portrait = portraits.find(p => p.id === event.actorId && !shown.has(p.id));
        if (portrait) shown.add(portrait.id);
        return <div key={event.id} className={`beat-dialogue${focusId && event.actorId === focusId ? ' is-focus' : ''}`}>
          {portrait && <CharacterPortrait src={portrait.image_url} name={portrait.name} />}
          <div className="bubble beat-dialogue-bubble">
            {event.actorName ? <><span className="beat-dialogue-speaker">[{event.actorName}]</span><span className="beat-dialogue-sep"> : </span></> : null}
            <span className="beat-dialogue-speech">"{event.text}"</span>
          </div>
        </div>;
      }
      case 'narration':
        return <div key={event.id} className="beat-narration">{event.text}</div>;
      case 'system': {
        const ui = eventUiData(event);
        if (ui) return <BeatUiPanel key={event.id} ui={{ ...ui, focus_id: ui.focus_id ?? focusId ?? null }} />;
        const className = event.presentation === 'header' ? 'beat-header' : event.presentation === 'info' ? 'beat-info' : 'chat-event-system';
        return event.text ? <div key={event.id} className={className}>{event.text}</div> : null;
      }
      case 'state_patch':
        // Scene state is owned and applied by the server, never by rendering a message.
        return null;
      case 'error':
        return <div key={event.id} className="chat-event-error" role="status">{event.message}</div>;
      default:
        return null;
    }
  })}</>;
}

export function MessageEvents({ message, streaming, focusId }: {
  message: Pick<Message, 'events' | 'eventVersion' | 'status'> & Partial<Pick<Message, 'role' | 'meta'>>;
  streaming?: boolean;
  focusId?: string | null;
}) {
  if (!hasEventContract(message)) return <div className="chat-event-system" role="status">{EVENT_CONTRACT_UNAVAILABLE}</div>;
  if (!message.events.length) return streaming ? <span className="muted">…</span> : null;
  return <>
    <EventRenderer events={message.events} streaming={streaming} focusId={focusId} portraits={message.meta?.party_output_version === 1 && message.meta.chat_event_script ? message.meta.roster_portraits : undefined} />
    {message.role && <DialogSavedState message={{ role: message.role, status: message.status, meta: message.meta }} />}
  </>;
}
