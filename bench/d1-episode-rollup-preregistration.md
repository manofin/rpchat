# D1 preregistration — isolated episode live rollup

Date: 2026-08-25
Lock: user “D부터 착수” (Track D starts at D1). Model spend approved for this one `POST /api/conversations/:id/rollup-episode` only.
Scope: throwaway conversation on a non-frost character. No `apps/**` product change. No PRD / web / migration / 서리 character.

## Signal
Prove Approach X lifecycle on the live server (PID must be running the current dist):

1. draft rollup marks scenes but they still inject; no `### 지난 에피소드`
2. approve folds scenes out and injects episode heading
3. DELETE restores scenes and NULLs `rolled_up_into`
4. all `__test__` rows gone; frost character and existing live memories/summaries untouched

## Control
- Frost character `f89ace9b-8684-4d97-96dc-e00c4b25a819` — refuse if any write targets it or its convs
- Existing live `memories` / `summaries` counts captured before seed; after cleanup they must match
- `SCENE_RECENT_GUARD=24`; `covers_until = path[-(24+1)]`
- THRESHOLD=5; one real model call via `rollup-episode` (not summarize)

## Success criteria (raw markers)
- `FROST_GUARD_OK`
- `SEED_OK path_len>=25 scenes=5 covers_until_in_guard=0`
- `B_DRAFT_SCENE_KEEP=True` and `B_DRAFT_EPISODE_HEADING=False`
- `C_APPROVED_FOLDED=True` (`### 지난 에피소드` present, `__test__` scene marker absent)
- `D_RETURN_SCENES=True` and `D_ROLLED_NULL=True`
- `CLEANUP_OK leftover_test=0 conv_gone=1`
- `LIVE_UNTOUCHED memories_delta=0 summaries_delta=0` (excluding the throwaway conv while it exists; after cleanup global leftover `__test__`=0)

## Branch
- Model 502 / JSON parse fail: print raw, DELETE throwaway conv + probe rows, stop. Do not retry without reporting.
- Path shorter than 25 after seed: abort before model call.
- Accidental frost hit: refuse and stop.
- Do not proceed to D2 in this slice.
