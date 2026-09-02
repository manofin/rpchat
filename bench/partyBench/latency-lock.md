# f9-bench-latency lock (2026-09-01T16:14:24Z)

Token: `f9-bench-latency`. Isolated under `app/bench/partyBench/`.

Not F9B. Not F9C `pickSpeaker.ts`. Not `apps/**`. Not `0010_*.sql`. Not live DB. Not systemd. Not commit. Not deploy.

## Mix (locked here; not a post-run reshuffle)

- Percentile sample: N=50 turns of Prompt-A. Each turn = call #1 (delta JSON) + call #2 (speaker markdown), serial.
- Overflow probe: Prompt-B one 2-call turn after the 50. Not in p50/p95. Counts toward overflow only.
- Queue depth = 1. No `Promise.all`. Direct live model endpoint. No `POST /api/conversations/:id/messages`. No conversation INSERT.

## Cuts (preregistration.md §0-3, do not soften)

- p50 ≤ 90s AND p95 ≤ 120s AND overflow = 0
- CONTEXT_TOKENS = 16384 (live bind)
- p50 ≥ 150s → F9 설계 재검토 (폴백 잠금과 별개)
- 38.08s · ≈76s are not this cut
- Fallback 1-call 2-channel is a **new lock name**. Not this file.

## Prompt bodies

- Prompt-A: scene lobby 6 fields, participants 3 (민아/지우/설화), recent 10, main 민아, secondary 지우
- Prompt-B: same scene, participants 5 (CAST), compressed cast, recent 20, pad to est_tokens target 12000, cap 16384
- Synthetic CAST only. Forbidden live ids/names.

## Model call (product-shaped, isolated)

- stream + include_usage + chat_template_kwargs.enable_thinking=false
- call1 temperature 0.3 max_tokens 400
- call2 temperature 0.8 max_tokens 400 top_p 0.95
- timeout 180000 ms/call
- turn_ms = call1_ms + call2_ms
- overflow if usage.prompt_tokens > 16384 (either call)

Incomplete N<50 → 벤치 무효, not FAIL. Do not drop turns to improve p50.
