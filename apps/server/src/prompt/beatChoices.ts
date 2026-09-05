/**
 * beat-post-extras-choices — Pass C: the beat's choices, written last.
 *
 * The 1:1 path gets `<choices>` out of the same call that writes the reply, and
 * that works there because that call *is* the turn. A beat is not one call. Asking
 * Pass F for the drafts would mean asking before Pass E has run, so the chips
 * could not answer the extra who spoke after them — the party engine's own reason
 * for existing, arriving as a defect in the one place the user actually clicks.
 *
 * So Pass C is a separate call at the end of the turn. It lives here and not in
 * `passes.ts` because it is the one pass that touches 1:1 choices text at all, and
 * that module is fenced to hold no runtime imports (`passPrompts.test.ts`).
 *
 * optimize-beat-choices-latency: it no longer reuses `STORY_CHOICES_INSTRUCTION`
 * verbatim. At n=50 that instruction cost 212 output tokens — the largest output
 * in the turn, larger than Pass F's reply — and Pass C decodes at the same ~26
 * tok/s as every other pass, so those tokens *are* the 8.14s. Its input was
 * already small (489 tokens, ttft 0.33s), so nothing on the prompt side was
 * available to cut: the only lever was how much the model is asked to write.
 *
 * The *wire* contract is unchanged and deliberately so — same `<choices>[…]`
 * tag, same parser, same three drafts, same rule that they differ in attitude.
 * What shrank is the prose each draft is asked for: 별표 묘사 한 조각 + 한 문장,
 * instead of 1문장 이상 + 3문장 이상. That is a real product change and it is
 * beat-only; `STORY_CHOICES_INSTRUCTION` itself is untouched and 1:1, dialog and
 * hunter keep the long form (`builder.ts`, `dialogScript.ts`, `hunterScript.ts`).
 *
 * Pure: no DB, no fetch, no model.
 */
import { extractChoices, substitute } from './templates.js';

/**
 * The beat's own choices contract. `{{user}}` is substituted the same way
 * `STORY_CHOICES_INSTRUCTION` is, and the emitted tag is byte-for-byte the shape
 * `extractChoices` already parses — the client is not being asked to learn a
 * second format, only to display shorter chips.
 *
 * The length rule is stated twice on purpose (한 문장 / 50자 이내): the `<choices>`
 * contract is the project's own worked example of a positive instruction landing
 * only ~80% of the time, and an over-long draft here costs a second of real
 * latency rather than a cosmetic slip.
 */
export const BEAT_CHOICES_INSTRUCTION =
  '응답은 <choices>["초안 1","초안 2","초안 3"]</choices> 한 줄만 출력한다. 각 초안은 별표로 감싼 짧은 행동·감정 묘사 한 조각으로 시작하고(예: *컵을 내려놓으며*, *한 발 물러서며*), 이어서 별표 밖에 {{user}}의 1인칭 대사를 **한 문장만** 붙인다. 초안 하나는 공백 포함 50자 이내로 짧게 쓴다. 세 초안은 서로 태도(거절·회피·거래·맞대응 등)가 뚜렷이 달라야 하고, 방금 장면에 실제로 나온 사물·인물·말에 근거해야 한다. 초안 문자열 안에 큰따옴표는 쓰지 않는다. 선택지는 입력창을 채우는 제안일 뿐 특정 선택지의 성공을 예고하지 않는다.';

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
  return choicesPrompt(input, BEAT_CHOICES_INSTRUCTION);
}

/**
 * The Pass C prompt with its contract left open.
 *
 * `renderPassC` is the shipped call and pins the instruction; this seam exists so
 * the latency bench can put the old contract and the new one through the *same*
 * wrapper and attribute the difference to the contract rather than to the
 * scaffolding around it. Nothing in `apps/` calls it with anything else.
 */
export function choicesPrompt(
  input: { userName: string; userText: string; blocks: TurnBlock[] },
  instruction: string,
): string {
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
    `- ${substitute(instruction, '', input.userName)}`,
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
