/**
 * beat-post-extras-choices — Pass C: the beat's choices, written last.
 *
 * The 1:1 path gets `<choices>` out of the same call that writes the reply, and
 * that works there because that call *is* the turn. A beat is not one call. Asking
 * Pass F for the drafts would mean asking before Pass E has run, so the chips
 * could not answer the extra who spoke after them — the party engine's own reason
 * for existing, arriving as a defect in the one place the user actually clicks.
 *
 * So Pass C is a separate call at the end of the turn, and it is the one pass that
 * deliberately reuses 1:1 prompt text: `STORY_CHOICES_INSTRUCTION`. The client
 * parses one choices contract, so there is one choices contract, restated nowhere.
 * That reuse is why this lives here and not in `passes.ts`, which is fenced to
 * hold no runtime imports and none of the 1:1 rule text (`passPrompts.test.ts`).
 *
 * Pure: no DB, no fetch, no model.
 */
import { STORY_CHOICES_INSTRUCTION, extractChoices, substitute } from './templates.js';

/**
 * A block of the turn as Pass C reads it back. Structural, so the serialized
 * `BeatBlock` fits without this module importing the renderer.
 */
export type TurnBlock = {
  kind: string;
  speaker_name?: string | null;
  text: string;
};

/**
 * The kinds Pass C is shown. `header` and `ui` are server state (S1) — the same
 * reason no other pass is trusted with them applies here, and a draft that quotes
 * the status panel back at the user reads like the app talking, not the user.
 */
function turnTranscript(blocks: TurnBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    const text = (b.text ?? '').trim();
    if (!text) continue;
    if (b.kind === 'narration') out.push(text);
    else if (b.kind === 'line') out.push(`${b.speaker_name ?? ''}: ${text}`.trim());
    else if (b.kind === 'thought') out.push(`${b.speaker_name ?? ''}(속마음): ${text}`.trim());
  }
  return out;
}

/**
 * Pass C — the choices, written against the turn that actually happened.
 *
 * No character card is passed in, and that is deliberate: this call must not be
 * able to speak as anyone. It reads the finished blocks and writes only the user's
 * side.
 */
export function renderPassC(input: {
  userName: string;
  userText: string;
  blocks: TurnBlock[];
}): string {
  const transcript = turnTranscript(input.blocks);
  const userText = (input.userText ?? '').trim();
  return [
    `너는 '${input.userName}'가 다음에 보낼 입력 초안만 쓴다. 인물의 대사·행동·서술을 새로 쓰지 않는다.`,
    '',
    ...(transcript.length
      ? ['## 방금 지나간 장면 (이미 화면에 있다. 다시 쓰지 말 것)', ...transcript, '']
      : []),
    ...(userText ? [`## '${input.userName}'의 직전 입력`, userText, ''] : []),
    '## 규칙',
    `- ${substitute(STORY_CHOICES_INSTRUCTION, '', input.userName)}`,
    '- 위 형식의 초안 3개 외에는 아무것도 출력하지 않는다. 머리말·설명·서술문·코드펜스 전부 금지.',
    '- 인물의 다음 대사·행동·생각을 대신 쓰지 않는다.',
    '- 지금까지 이미 일어난 일을 그대로 반복하는 초안은 쓰지 않는다.',
    '- 한국어로 답한다.',
  ].join('\n');
}

/**
 * Pass C's parser. Fail-open by construction: anything this cannot read becomes
 * `null`, which the beat renders as "no chips" — the same degradation
 * `extractChoices` already gives the 1:1 path when the tag is absent, and the
 * reason a bad choices call can never cost a turn that has already been written.
 */
export function parseChoicesPass(text: string): string[] | null {
  const { choices } = extractChoices((text ?? '').trim());
  return choices && choices.length ? choices : null;
}
