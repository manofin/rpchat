# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Two roots

| Path | What it is |
|---|---|
| `/home/hermes/rpchat` | Working root. Planning docs, live DB, backups, user note dumps (`Notes_*.txt`, `Dialog.txt`). **Not** a git repo. |
| `/home/hermes/rpchat/app` | **Git root.** Server + web + bench. All `git` and `npm` commands run here. |
| `/home/hermes/rpchat/data/rpchat.db` | Live SQLite (`DATA_DIR`). Not `/tmp`. |
| `/home/hermes/rpchat/planning_documents` | STATUS index, ADRs, named-lock docs. Outside git. |
| `/home/hermes/rpchat/repo.stale` | Dead copy of an old tree. Never edit; it is not live. |

`apps/server/dist` and `apps/web/dist` are build output, never the spec.

## Commands

All from `/home/hermes/rpchat/app`:

```bash
npm install
npm run typecheck                    # both workspaces, tsc --noEmit
npm run build                        # web (vite) then server (tsc) → dist/
npm run dev --workspace @rpchat/web      # http://127.0.0.1:5173
npm run dev --workspace @rpchat/server   # tsx watch, reads app/.env, :8787
```

Tests are standalone `tsx` scripts under `bench/` — no test framework, no `npm test`:

```bash
npx tsx bench/focusResolve.test.ts                  # one file
for f in bench/*.test.ts; do npx tsx "$f" || echo "FAIL $f"; done   # whole suite (72 files)
```

Each prints `ok N <name>` lines and exits non-zero on the first assertion failure. The file's top comment gives its exact invocation and what it is isolated from.

Live service (systemd **user** unit, runs `apps/server/dist/index.js`):

```bash
systemctl --user is-active rpchat.service
systemctl --user show -p MainPID --value rpchat.service
curl -sS http://127.0.0.1:8787/api/health
```

Live `CONTEXT_TOKENS` comes from `/proc/<MainPID>/environ`, not `config.ts` defaults. Never print `.env` in full.

### Suite state as of `v0.0.19-99-g8590a09`

- Full suite: 71 pass / 1 flaky. `bench/partyBeatPersist.test.ts` test 4 ("greeting opens an extra speaker") fails roughly 1 run in 4 on an otherwise clean tree — intermittent, not a tree-dirtiness signal. Re-run before blaming a change.
- `bench/settingsRegression.test.ts` is a **fence**: it asserts `git diff HEAD -- apps/server` is empty and greps CSS/`useChat.ts` contracts. Committing makes it true. Never edit the fence to make it pass.

## Architecture

Galaxy PWA → (Tailscale Serve HTTPS) → Ubuntu Fastify+SQLite → (OpenAI-compatible `/v1`) → Mac Studio model. Single user, private tailnet, no public port, `trustProxy=false`. The browser only ever talks to the Fastify app; the model URL/key stay server-side.

### Server (`apps/server/src`)

`index.ts` wires: `openDb` (runs `migrations/NNNN_*.sql` in filename order, tracked in `schema_migrations`) → `interruptOrphanStreaming` (folds messages left `streaming` by a crash) → `seed` (sample characters from `content/`, only into an empty DB) → `ModelClient` + `GenerationQueue(1)` → `registerAuthHook` → route plugins. `Ctx` (`ctx.ts`) is the handle every route gets.

Auth (`auth.ts`), three modes via `AUTH_MODE`: `tailscale` (matches the `Tailscale-User-Login` header against `ALLOWED_LOGIN`; safe only because `HOST=127.0.0.1`), `token` (one-time `APP_TOKEN` → HttpOnly cookie session), `none` (localhost dev only). Live is `tailscale`, so protected routes returning 401 on plain localhost is **correct**; proof paths go through Serve HTTPS. Never forge the header.

**Generation has two paths**, both in `routes/chat.ts`:

1. **1:1 (default)** — `prompt/builder.ts` `buildPrompt` assembles one system block under a token budget: fixed 25% / lore 15% / memory 15%, remainder to recent turns, `REPLY_MARGIN` reserved. Inputs: character card, persona snapshot, scene, story injection (`resolveStory`), keyword-triggered lore (`loreMatch`, scans last 6 messages, honours `selective` + `secondary_keys`), approved memories/summaries, 4-tier rolling summaries (`summaryBudget`), user note (`userContextBudget`). Token estimates self-calibrate from real `usage` via EMA (`prompt/tokens.ts`). Then a single SSE stream.
2. **Party beat (F9)** — taken when the conversation has a `story_id` whose story characters include **≥2** with a `party:` tag (`tagsCatalog.ts` `castFromCharacters`; the `story_characters.role` column is *not* the test). `generateBeat` runs the pipeline planned purely in `prompt/composeBeat.ts`: scene-delta proposal → `applySceneDelta` (server allow-list) → `resolveFocus` (deterministic: stage-direction `*…*` names beat spoken names, two names = silence, no LLM, no randomness) → `eligibleExtras` → `approveExtras` (default 0, `MAX_EXTRAS = 2`, `EXTRA_SCORE_ENABLED = false`) → ambient picks → Pass N narration → Pass F focus line (streamed, split on `속마음:` into `line` + `thought`) → Pass E per extra → `finishBeat` → persist blocks → commit `conversations.scene_json`. One user input becomes several message rows tagged `meta.block_kind` (`header`/`narration`/`line`/`thought`/`ui`) plus `beat_seq`; `header` and `ui` are rendered by the server (`renderBeat.ts`), not the model.

The two paths are deliberately separate. `buildPrompt`, `templates.ts` `HARD_RULES`/`renderRules`, and `PROMPT_VERSION` belong to the 1:1 path and must stay byte-stable when working on beats — several gates assert exactly that.

Other invariants:
- **Message tree** (`db/tree.ts`): messages have `parent_id`; regenerate/swipe creates siblings; `conversations.head_id` picks the active branch and only that path enters the prompt. `getPath` is the reader.
- **Memory is consent-gated**: model-produced summaries/memories land as candidates and only reach the prompt after explicit user approval. Summarize is manual; auto-summarize (F6), conflict resolution, and embeddings are all deliberately off.
- **Streaming survives the client**: an aborted browser does not cancel generation; only `POST /generations/:id/abort` does. `GenerationQueue(1)` protects the single local model.
- **Scene** (`types.ts`) is one JSON blob per conversation; every key optional so a conversation that never ran a beat keeps byte-identical `scene_json`. Beat-owned keys (`day_index`, `roster`, `user_sheet`, `last_beat`, …) are absent from `applySceneDelta`'s allow-list — the model cannot propose them.
- Dump hooks are env-gated: `RPCHAT_PROMPT_DUMP=1`, `RPCHAT_REQUEST_DUMP=1` → files under `$DATA_DIR`. There is no HTTP dump API; do not invent one.

### Web (`apps/web/src`)

React 19 + Vite PWA, dependency-minimal: hand-rolled router (`lib/router.ts`, `useRoute`/`navigate`/`match`), `lib/api.ts` for fetch + SSE parsing, `lib/viewport.ts` for the Android keyboard (`visualViewport`). `pages/ChatPage.tsx` + `useChat.ts` own the chat screen; `components/view.tsx` renders beat blocks (`BeatHeader`/`BeatNarration`/`BeatThought`/`BeatUiPanel`) and falls back to the plain 1:1 bubble when `block_kind` is absent — old conversations must not be reinterpreted. Service worker caches the app shell only; API/SSE are never cached.

### Conventions

- Server source is NodeNext ESM: intra-package imports use **`.js`** specifiers (`./db/index.js`) even from `.ts`. Bench files import product source with **`.ts`** specifiers (tsx resolves them).
- New migration = next free number, `NNNN_<slug>.sql`. Never an empty migration file, never renumber.
- Comments, docs, and commit bodies are Korean; identifiers and newer bench comments are English. Match the file you are in.

## Working discipline in this repo

This project is run as an evidence-and-lock discipline, and the planning docs are written to be read that way:

- **Source-of-truth order**: user's current message → `git -C app describe --tags` → `RP-Chat-PRD.md` → `~/.hermes/skills/software-development/rpchat-pwa/references/lock-state.md` → `planning_documents/HANDOFF-2026-08-27.md` → `planning_documents/STATUS.md` → `app/PROGRESS.md`. STATUS is an index, not a queue; PROGRESS is append-only history — never rewrite an old block's HEAD/PID as current.
- **Planning docs are not tickets.** Several (`f9-beat-catalog-school.md`) are explicitly void. Check the matching STATUS row before treating any plan file as approved work.
- **Named locks**: `코드` (source + bench only), `배포` (build to disk only), `재시작` (unit restart), `Generate` (needs a *new*, unused token name), `커밋`. A spent token is never re-fired. Product-touching work needs a named lock in the user's message.
- **Live data is read-only** unless a lock says otherwise: 서리 `f89ace9b…`, 카이 `255f96a2…` and their rooms, 황지명 persona `b0df2d3a…`, QA room `69e0ad66…`. Do not seed fixture casts into the live DB.
- **Git hygiene**: never `git add -A`, never commit `.env` or `dist`, keep feature/layout/docs/dist changes in separate commits. Untracked `BRIEF-*`/`DESIGN-*`/`HANDOFF*.md`/`dist.bak/` at the app root are leftovers — leave them untracked.
- **Report measurements, not prose.** Paste the command and its stdout; a subagent's summary is self-report and cannot close a gate on its own. Run `date -u`, `git rev-parse HEAD`, `git describe --tags --dirty`, `git status --short`, `ls apps/server/migrations/`, `systemctl --user is-active rpchat.service`, `curl /api/health` before starting a slice.
- Assembly SHA recipe (do not invent another): `sha256` of `json.dumps(messages, ensure_ascii=False, separators=(",",":"))` over role+content only — no `sort_keys`, no SSE, no `budget_json`.

## Reference docs

`app/docs/SETUP.md` (install, env), `app/docs/NETWORKING.md` (Tailscale Serve, model publishing), `app/docs/OPERATIONS.md` (context assembly, memory workflow, backup/restore), `app/docs/GALAXY-CHECKLIST.md` (device checklist — only a human with the phone can check its boxes). `planning_documents/party-beat-rp-review-spec.md` is the fullest current description of the party-beat path.
