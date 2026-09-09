/** Display-only speech marks. Never used in prompts or stored message text. */
export function wrapSpeechMarks(text: string): string {
  if (!text) return text;
  const t = text.trim();
  if (!t) return text;
  // Already marked — leave the stored spelling alone.
  if (/[「『」』“”"']/.test(t)) return text;
  // Stage direction / markup at the start is not a spoken line.
  if (/^[*_<]/.test(t)) return text;
  return `「${t}」`;
}
