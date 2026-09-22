# Independent story browsing review

Read-only review of the working product changes. No build, repository mutation, model generation, live access or fixture mutation during review.

## Result

No open blocking finding in the reviewed implementation. Root-owned CUA and full regression gates remain separate evidence.

- Reader entry renders portrait cover, short catalog metadata and story/world/cast information. It does not fetch conversation history before the start action.
- Conversation chooser uses server-side story identity before pagination and preserves a stable story-only ordering. No character-only rooms leak into the story history.
- New room creation reloads story/cast, respects saved roster order, excludes archived/unavailable cards, guards empty and more-than-twelve rosters, preserves optional extra opening selection and prevents duplicate submissions through a synchronous ref.
- Pending results after unmount cannot navigate, toast or update state. Parent key reset, cancellable reads and preview sequence checks cover navigation races.
- Archived stories can resume earlier rooms while new creation is disabled. Server archived-story rejection remains enforced.
- Sheet offsets are scoped to the conversation-sheet wrapper, leaving the full editor's 94% height and bottom positioning untouched. Breakpoints match the existing 767/768 mobile navigation boundary. Actual viewport geometry remains CUA-owned verification.
- Existing cast mapping changes persist immediately; the editor now explains that behavior and the parent refreshes on both save and close.

## Finding fixed during review

Removing a cast member and closing without Save previously left stale IDs in stored default/extra opening present_ids. Reopening preserved the now-invisible IDs and subsequent saves failed hosted-cast validation. This was pre-existing editor behavior but directly relevant now that cast management lives there.

The implementation now filters opening draft IDs against the fresh hosted roster when opening the editor. An independent execution of the actual StoryEditor function confirmed default and extra IDs are cleaned, unrelated scenario/greeting text remains intact, and the corresponding server validator returns no errors. It does not mutate stored opening data just by reading/opening the editor.

## Independent execution evidence

`independent-story-review.mts` executes actual shipped callbacks via the shared deterministic hook harness. `independent-review-checks.json` records five passed checks: reopened-editor stale references, same-frame duplicate start plus late unmount, empty roster, archived story, and over-twelve roster.

`created-conversation-verification.json` independently checks the actual new UI-created room through GET health/story/story-filtered conversation list. It confirms rich story identity, roster order 이든 → 서하, byte-identical selected `rainy-stacks` opening snapshot, east_stack/동쪽 서고/별비, and exclusion of the unrelated character-only conversation.

The single-conversation GET route was deliberately unnecessary because it may perform orphan-stream interruption; the review used list GETs only. Active/queued model calls were zero.

## Limits

This review did not execute a real model turn, inspect production, test Galaxy hardware/keyboard/PWA behavior, run builds, or substitute for full regression/CUA verification. Source hashes identify the reviewed files and may precede later nonfunctional edits.
