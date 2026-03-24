# Chat Virtual Scroll Redesign

This component is for the chat thread UI, not for generic feed virtualization. The design should optimize for chat correctness first, while still avoiding the "measure the whole store on first render" failure that the older implementation had.

## What we learned from the two versions

The older Fenwick-tree version got a few important things right:

- it had a stable global height model for the whole loaded window
- it could keep DOM size bounded to the visible area
- it handled scroll-to-index and thumb dragging naturally because the full scroll range existed

But it paid for that by rendering every item invisibly during the initial measuring phase. That is exactly what hurts when the store already contains a large loaded window.

The current committed-frontier rewrite fixed the startup cost:

- it only measures small hidden batches
- it preserves more invariants around "only measured rows affect visible layout"
- it moved network loading policy out to the parent, which is the right direction

But it now carries too much chat behavior inside one frontier-expansion model:

- local reveal, network prepend, append, jump, and reset all interact through the same committed range
- there is no stable global geometry outside the committed frontier
- the committed frontier only grows, so complexity and mounted DOM grow over time
- imperative jumps and thumb teleports are awkward because the visible world only exists where the frontier has already been measured

## Design goal

We want all of these at once:

1. No all-items measuring pass on initial load.
2. Stable, chat-correct scroll preservation for prepend, append, resize, jump, and optimistic confirmation.
3. A real global scroll range so dragging, jumping, and bottom anchoring feel natural.
4. A bounded mounted DOM so long sessions do not keep growing forever.
5. Clear separation between virtualizer geometry and page-level network policy.

## Proposed architecture

Use a hybrid model:

- a sparse global height model for all logical rows
- a bounded measured window around the viewport
- top and bottom spacer blocks for everything outside that window
- a small hidden staging batch for rows that are about to enter the mounted window

This keeps the good part of the old spacer/tree approach without the "measure everything first" cost, and keeps the good part of the current staging approach without making the entire scroll model depend on a single ever-growing frontier.

## Row model

`chat-thread.tsx` should stop treating "date separator + message bubble" as one virtual row.

Instead, build a flat `ChatRow[]` model such as:

- `date:${yyyy-mm-dd}`
- `msg:${client_generated_id || id}`

Benefits:

- one DOM measurement unit maps to one virtual row
- separator rows have stable keys and predictable heights
- message rows keep stable identity across optimistic confirmation
- height estimation can be row-type aware
- scroll-to-message can target the exact message row key

The virtualizer should operate on `ChatRow[]`, not raw messages.

## Core data structures

### 1. Keyed height cache

- `measuredHeightByKey: Map<string, number>`
- survives append, prepend, jump windows, and optimistic confirmation
- keyed by stable row key, never by array index

### 2. Sparse height tree

- one entry per logical row in the current `items`
- each entry is either:
  - measured height from the cache
  - estimated height from a chat-specific estimator
- supports:
  - `offsetOf(index)`
  - `indexAtOffset(scrollTop)`
  - `totalHeight()`

This restores a global geometry model without requiring every row to be measured first.

### 3. Mounted window

- `windowRange = { start, end }`
- contiguous block of mounted rows around the viewport
- contains only measured rows plus a small overscan
- hard size cap so the DOM does not grow forever

### 4. Hidden staging batch

- `pendingBatch = { direction | recenter, keys[] }`
- rows render in a hidden staging lane only for measurement
- commit happens atomically once the whole batch is measured

### 5. Scroll anchor snapshot

- `anchorKey`
- `anchorOffsetWithinViewport`
- optional `anchorMode = preserve | bottom | item`

This is the source of truth for prepend preservation and recenter operations.

## Estimation strategy

Unmeasured rows outside the mounted window should use estimates, but visible rows should still be measured before they are promoted into the mounted window.

Recommended estimator tiers:

- date separator: fixed small height
- plain text message: default medium height
- deleted message: small height
- message with attachments: larger estimate
- message with reply preview: slightly larger estimate

The estimator does not need to be perfect. Its job is to keep the scroll range stable enough until real measurements arrive.

## State machine

Keep the lifecycle simple:

- `WAITING_VIEWPORT`
- `BOOTSTRAP`
- `READY`
- `RECENTERING`

Do not encode prepend-vs-reveal-vs-fetch as top-level phases. Those are layout intents, not lifecycle phases.

## Bootstrap

### Bottom-open

1. Wait for a real viewport height.
2. Seed a small tail range near the last row, for example 12 to 16 rows.
3. Measure only that seed in hidden staging.
4. If measured seed height is still less than about `1.5 * viewportHeight`, extend backward in small batches.
5. Reveal once:
   - the anchor row is measured
   - the mounted window covers enough real height for the first paint

Everything outside the mounted window is represented by spacer estimates, not by hidden full-list measurement.

### Jump-to-message

1. Resolve the target key in the current logical rows.
2. Enter `RECENTERING`.
3. Seed a small range around the target key.
4. Measure that range in staging.
5. Reveal with the target row anchored into view.

Do not drain batch-by-batch from the current frontier to reach the target.

## Ready-state scrolling

### Normal scrolling

The visible list is:

- top chrome
- top spacer
- mounted measured rows
- bottom spacer

When the user nears the top or bottom edge of the mounted window:

1. queue a small adjacent staging batch
2. measure it hidden
3. commit it atomically
4. prune rows from the far side if the window exceeds its cap

Good starting numbers:

- batch size: 8 to 12 rows
- overscan: 4 to 8 rows
- mounted cap: around 60 to 100 rows, or about `3x` viewport height

The important rule is that mounted rows are bounded.

### Thumb teleport / large fling

If the viewport lands far outside the mounted window according to `indexAtOffset(scrollTop)`:

1. keep the current scrollTop
2. compute an estimated target index from the height tree
3. enter `RECENTERING`
4. replace the mounted window with a newly measured seed around that index

This is the missing piece in the current frontier-only design.

## Mutation classification

Classify mutations only from stable keys in the same render:

- `none`
- `prepend`
- `append`
- `reset`

Do not use:

- `prependedCount`
- delayed side channels
- "we fetched older so it must be a prepend"

The rows themselves are the source of truth.

## Scroll preservation rules

### Real prepend from the server

When rows are inserted above the viewport:

1. capture the first visible measured row key before commit
2. capture its offset relative to `scrollTop`
3. after the prepend render, restore that same row to the same relative offset in the same layout cycle

This must happen before paint.

### Local window expansion above the viewport

If we are only mounting already-loaded rows from the local gap:

- preserve viewport using height delta or row anchor
- do not treat this like a network prepend

### Append while at bottom

If the user is at bottom, or a bottom-scroll intent is active:

- keep the last row pinned to the bottom
- do not let estimator correction pull the viewport upward

### Row resize after mount

If a measured row changes height:

- at bottom: snap to bottom
- above viewport: add the height delta to `scrollTop`
- inside viewport: allow natural reflow

### Top chrome changes

Header height and loading-row height must be modeled separately from row height.

If top chrome changes in the same render as prepend or local expansion, anchor preservation still wins.

## Network ownership split

`VirtualScroll` should own:

- row measurement
- height tree updates
- mounted window management
- spacer sizing
- layout preservation
- imperative scroll APIs
- boundary state reporting

`chat-thread.tsx` should own:

- `getMessages(...)`
- cursor state
- one-load-per-stop arming
- deciding when older/newer fetches are allowed
- jump-to-message window fetches

The virtualizer reports geometry. The page decides whether to hit the network.

## Recommended virtualizer API

Keep the current key-oriented API direction, but make it explicitly chat-focused:

- `rows`
- `getRowKey(row)`
- `estimateRowHeight(row)`
- `renderRow(row)`
- `initialAnchor`
- `scrollApiRef`
- `loadingOlder`
- `header`
- `bottomPadding`
- `onAtBottomChange`
- `onBoundaryStateChange`

`onBoundaryStateChange` should stay simple:

- `nearTop`
- `nearBottom`
- `hasLocalOlderGap`
- `hasLocalNewerGap`
- `atBottom`

That is enough for the page to decide whether to reveal local rows or fetch a page.

## Changes needed in `chat-thread.tsx`

### 1. Build chat rows up front

Memoize a `ChatRow[]` structure from `messages`.

That row builder should also compute:

- grouping flags for message rows
- date separator rows
- per-row estimate hints if needed

### 2. Scroll by row key, not message index

The current key-based API is the right long-term direction. Keep that.

### 3. Keep boundary arming in the page

The current `topIdleLoadArmedRef` / `bottomIdleLoadArmedRef` pattern is still useful. The virtualizer should not fetch directly.

### 4. Do not buffer fetched prepends behind scroll idle inside the page

Once older messages arrive, commit them to the store immediately and let the virtualizer preserve the viewport. Delaying the data mutation is what caused earlier "one bad commit" behavior.

## Why this design should fix the current problems

It avoids the old startup regression because we never measure the whole loaded list.

It avoids the current rewrite's scroll issues because:

- there is always a global scroll geometry model
- prepend preservation is key-anchored, not frontier-count based
- jump and thumb teleport can recenter directly instead of batch-draining
- local reveal and real prepend remain separate behaviors
- the mounted DOM stays bounded instead of growing with the frontier

## Implementation split

If this is rewritten, split it into smaller pieces:

- `useChatRowHeights`
- `useHeightTree`
- `useMountedWindow`
- `useScrollPreservation`
- `useBoundaryState`

The current file is doing too many jobs in one component, which makes chat edge cases hard to reason about.

## Rollout plan

1. Change `chat-thread.tsx` to build explicit `ChatRow[]` items.
2. Reintroduce a global height tree, but seed it from estimates instead of measuring all rows first.
3. Replace the ever-growing committed frontier with a bounded mounted window plus spacers.
4. Keep hidden staging batches, but only for rows about to enter the mounted window or a recenter target.
5. Preserve prepend/append behavior with keyed row anchors in layout effects.
6. Verify:
   - initial open at bottom
   - jump to older message
   - fetch older while parked at top
   - fast fling to top then stop
   - composer height changes
   - image load / attachment resize
   - optimistic send and confirm

## Invariants to keep

- stable row keys are the source of truth
- visible rows should be measured before they are committed into the mounted window
- prepend preservation happens before paint
- local reveal and server prepend are different behaviors
- network loading remains parent policy
- optimistic confirmation must not remount a row

If a rewrite cannot clearly explain how it keeps those invariants while supporting a global scroll range and a bounded mounted window, it is probably still missing a chat-specific edge case.
