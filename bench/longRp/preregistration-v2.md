# long-rp-v2 preregistration (summary-on contrast)

작성: 2026-08-25T03:08:19Z. 실행 전 고정. Append-only after this lock. Do not edit score-keys-v1 / fixtures-v1 / beats-v1 after seeing answers.

## Signal

`hold_rate[h] = held/scored` at h∈{30,60,100} on the **live** `POST /api/conversations/:id/messages` path, same formula as v1 (`REPORT.md` / `run-long-rp.ts`). Contrast vs v1 is **one variable**: approved `tier=whole` summaries are present in `buildPrompt` (latest approved whole on path).

## Control

v1 first VALID (`bench/longRp/REPORT.md`, file `results/long-rp-1787582894376.json`):

| h | held/scored | hold_rate |
|---|-------------|-----------|
| 30 | 0/6 | 0 |
| 60 | 4/6 | 0.6666666666666666 |
| 100 | 3/7 | 0.42857142857142855 |

v1 condition: window+card, no summarize, no memory approve. Same gold 20 / probes 9 / score-keys-v1 / beats-v1.

## Treatment (locked)

- Character name `린-longrp-v2`, title `[TEST-longrp-v2]`. Card = name/place only. Do not paste gold facts.
- After story turns **20, 45, 75** (before the next story turn; probes at 30/60/100 therefore see ≥1 approved whole):
  1. `POST /api/conversations/:id/summarize` (empty body)
  2. `PATCH /api/summaries/:id` `{ "status": "approved" }` on the returned **whole** row only
- Do **not** approve `state` / `scene` / `episode`.
- Do **not** pin/approve memories (candidates may be created; they must not inject).
- One retry of the same POST if 502 JSON parse. Then that slot fails.
- 400 `요약할 새 메시지가 없음` = slot fail (should not happen at 20/45/75).

## Success criteria

`RUN: VALID` iff all of:

- story_complete = 100 and every story turn `ok`
- probe_complete = 9 and every probe `ok` (HTTP/SSE done; score pass/fail is separate)
- summarize_ok = 3 (each slot produced an approved `tier=whole` row)

hold_rate is **measurement**, not a cut. 95% is not a target. Low hold is a valid result.

`RUN: INVALID` if story/probe incomplete.
`RUN: INVALID_NO_SUMMARY` if story+probes complete but summarize_ok < 3.

## Branch

- `/api/health` `generation.active` nonempty → exit 2, no create.
- Frost character `f89ace9b-8684-4d97-96dc-e00c4b25a819` or any of its conversations → refuse, no write.
- Story/probe HTTP fail → stop story loop, still cleanup, INVALID.
- Summarize slot fail → continue story/probes (keep the measurement), VALID denied.
- any exit: DELETE throwaway conv + character + `generation_log` for that conv id only. Never DELETE frost.

## Model spend (this lock)

- 100 story + 9 OOC probes + 3 summarize completes (optional +3 retries). Isolated throwaway only.
- Same live 31B as v1. Occupies the generate queue.

## Forbidden

- Edit `score-keys-v1.json` / fixtures / beats after this file exists.
- Prompt-tweak or card-stuff to “improve hold”.
- Product `apps/**` changes.
- Re-open P3 embeddings / expand lore-v1 cases in this slice.
- E1 / F1–F6 / Galaxy PASS.

## Files

- runner: `bench/longRp/run-long-rp-v2.ts` (new; do not mutate `run-long-rp.ts`)
- results: `bench/longRp/results/long-rp-v2-*.json`
