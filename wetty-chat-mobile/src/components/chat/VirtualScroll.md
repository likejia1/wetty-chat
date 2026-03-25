# Chat Virtual Scroll — Design & Implementation Notes

This is the chat message list virtualizer for `ChatVirtualScroll.tsx`. It is chat-specific, not a generic virtual scroll. This document records the architecture, key decisions, and lessons learned during implementation.

## Architecture: "Measured Core" Model

### Why not estimated spacers

The original design doc proposed a sparse global height tree with estimates for unmeasured rows. This was rejected because **iOS Safari ignores programmatic `scrollTop` changes during momentum scroll**. When estimates are corrected to real heights, content shifts. Correcting via `scrollTop` fails during momentum. Letting it shift is a visible glitch.

### What we use instead

Only measured content participates in scroll geometry. Unmeasured regions are hidden behind fixed-height opaque boundary spinners. The scroll range grows as we measure more content, rather than being pre-estimated.

This means:
- No estimate-to-real correction ever needed in the visible area
- No programmatic `scrollTop` adjustment for measurement corrections
- The scroll thumb won't represent the full chat history (acceptable for chat)
- `scrollTop` adjustment is only used to preserve the visible viewport when measured content is inserted above it

## Three-Tier Data Model

### Tier 1: Full rows array (`ChatRow[]`)
All messages in the current store window transformed into flat rows (date separators + message rows). Possibly thousands of items. Only used for key lookups and to know what exists.

### Tier 2: Measured core (`CoreRange { start, end }`)
A contiguous subset of rows that have been measured and participate in scroll geometry. Heights stored in a persistent keyed cache. Starts small at bootstrap, grows as user scrolls. Bounded by `CORE_CAP` (~200 rows) with pruning from the far side.

The height cache is **never pruned** — it persists for the lifetime of the chat session. When core is pruned, heights remain in the cache. Re-expansion of previously measured regions is instant (no staging needed).

### Tier 3: Mounted window (`MountedWindow { start, end }`)
A contiguous subset of the core with actual DOM nodes. Normally bounded by `MOUNT_CAP` (~80 rows). Rows in the core but outside the mounted window use spacers with their exact measured heights.

If the core still contains uncached rows, the mounted window is allowed to temporarily exceed `MOUNT_CAP` so those rows stay mounted until measured. This avoids zero-height spacer fallbacks and keeps scroll geometry stable.

## Row Model

Date separators are separate `ChatRow` entries computed by `useChatRows()`.

Key scheme:
- First message's date separator: `datefirst:YYYY-MM-DD` (distinct prefix to avoid collision on prepend)
- Date boundary separators: `date:YYYY-MM-DD`
- Message rows: `msg:${client_generated_id || id}`

The `datefirst:` prefix exists because when messages are prepended on the same date, the date separator key would collide if it used the same `date:` prefix. See "Mutation Classification" below for why this matters.

## State Machine

```
WAITING_VIEWPORT  -->  BOOTSTRAP  -->  READY
                                        |  ^
                                        v  |
                                    RECENTERING
```

## Key Design Decisions & Lessons Learned

### 1. No core expansion during active scrolling

**Problem**: Expanding the core during scroll events (`handleScroll`) requires `scrollTop += delta` for scroll preservation. This fights with iOS momentum scrolling and creates a feedback loop (scroll event -> expand -> scrollTop change -> scroll event -> expand...).

**Solution**: `handleScroll` only does mounted window recomputation (which rows within the existing core to render). All core expansion happens in `handleScrollIdle` (150ms debounce after last scroll event). This means the user momentum-scrolls freely without any `scrollTop` interference.

### 2. Exact-edge loads deferred to scroll idle with one-shot arming

**Problem**: Triggering `loadOlder.onLoad()` during active scrolling caused two issues:
1. After fetch + prepend + local expansion, user is still parked at top -> immediate re-fetch -> infinite loop
2. After fetch + prepend, user is stopped at top with no scroll events -> new rows never expand

**Solution**: Network fetches are deferred to scroll idle (`handleScrollIdle`), but they now fire only when the user reaches the exact top or bottom edge of the current content. A one-shot arm (`topLoadArmedRef`/`bottomLoadArmedRef`) is set to `false` after a load fires and only re-armed after the user leaves the edge by a small hysteresis distance. This prevents re-triggering while the user is parked at the edge without reintroducing eager near-edge loading.

Important: exact-edge detection controls only **when** loading is allowed. It does **not** change the scroll-preservation policy after rows are inserted. Once older rows arrive, prepend handling and backward core expansion still preserve the visible anchor instead of pinning the viewport to the top of the newly loaded page.

### 3. Immediate store commit for prepends (no buffering)

**Problem**: The V2 code buffered prepend data in `pendingPrependRef` until scroll idle. This caused "one bad commit" issues where the virtualizer's key arrays were out of sync with the store.

**Solution**: `prependMessages` dispatches to the store immediately. The virtualizer handles the visual timing — new rows enter the core via normal staging batches. The store is never stale.

### 4. Render-time index adjustment plus anchor restoration for prepends

**Problem**: When `rowKeys` changes due to prepend, array indices shift but `coreRef` and `mountedRef` still hold old indices. If not corrected before JSX is produced, the component renders the wrong rows (shows prepended/older messages instead of the ones the user was looking at).

**Why `useEffect` doesn't work**: The layout effect updates `prevKeysRef` before the mutation `useEffect` reads it, so the mutation effect never detects the prepend. Even if it did, `useEffect` runs after render — too late.

**Solution**: A synchronous block during the render phase (before JSX) detects prepend via `classifyKeyMutation` using a separate `adjustPrevKeysRef`, captures the first visible mounted row as an anchor, then shifts `core.start/end` and `mounted.start/end` by the prepend count. In `useLayoutEffect`, the virtualizer restores that anchor row to the same viewport offset. Anchor capture prefers visible `msg:` rows over date separators so prepend restoration tracks user-visible message content instead of structural chrome. This only fires when `rowKeys` reference changes (store update), NOT on internal re-renders from `triggerRender()`.

**Important**: An earlier attempt used key-based re-alignment (tracking `coreStartKeyRef`/`coreEndKeyRef` and re-resolving indices every render). This caused an infinite loop because it couldn't distinguish "indices changed due to prepend" from "indices changed due to normal core expansion" — it would undo expansions on every render.

### 5. Mutation classification filters out date keys

**Problem**: `classifyKeyMutation` uses `isSuffix(oldKeys, newKeys)` to detect prepend. But when prepended messages share a date with existing messages, date separator keys (`date:YYYY-MM-DD`) shift position, causing `isSuffix` to return false and misclassifying the prepend as a `reset` (which scrolls to bottom).

**Solution**: `classifyKeyMutation` filters to `msg:`-prefixed keys only before comparing. Message keys are stable across prepend; date separator keys are not. The prependCount for index shifting still uses full `rowKeys.length` difference.

### 6. MeasuredRow registration in useLayoutEffect

**Problem**: `scrollToKeyInternal` looks up the target row in `rowRefsMap`. But `MeasuredRow` originally registered nodes in `useEffect`, which runs AFTER the parent's `useLayoutEffect`. So the parent's layout effect tries to scroll to a key that isn't registered yet.

**Solution**: Split `MeasuredRow` into two effects:
- `useLayoutEffect` for row registration (`registerRow`) — available to parent's layout effect
- `useEffect` for `ResizeObserver` — doesn't need to run before paint, avoids flushSync-in-lifecycle errors

### 7. Bootstrap needs content on BOTH sides of item anchor

**Problem**: When jumping to an old message, `createBootstrapBatch` originally only seeded rows backward from the anchor. The anchor ended up at the bottom of the core with no content below. `scrollToKeyInternal` couldn't position the target at the top of the viewport because `scrollTop` was clamped by `scrollHeight - clientHeight`.

**Solution**:
- `createBootstrapBatch` seeds rows both before AND after the anchor (`anchorIndex +/- halfBatch`)
- The bootstrap effect prefers forward expansion for item anchors (to build scroll range below target)
- The bootstrap completion check (`handleBatchReady`) requires `heightAfterAnchor >= viewportHeight` for item anchors before declaring bootstrap complete
- The bootstrap effect mirrors this check to avoid a deadlock where total height is sufficient but below-anchor height is not

### 8. scrollToBottom provides immediate visual feedback

**Problem**: `scrollToBottom()` checked `hasNewerGap()` first. If the core didn't extend to the last row, it called `maybeExpandOrQueue('forward')` and returned without scrolling — the user perceived the first click as doing nothing.

**Solution**: Always call `scrollToBottomInternal()` immediately for visual feedback. Then, if there's a newer gap, expand toward it asynchronously. `pendingScrollToBottomRef` ensures we snap to the true bottom when expansion completes.

### 9. Bottom anchoring needs a settle pass on iOS Safari

**Problem**: On iOS Safari, the initial bottom snap could land "almost bottom" after the first ready render because the scroll container height and top chrome rows were not fully settled when the first `scrollTop` assignment happened.

**Solution**: Bottom-directed actions (`initialAnchor.type === 'bottom'`, append-at-bottom, explicit `scrollToBottom`) perform the immediate snap and then schedule a short post-layout settle pass over the next animation frames. This reconciles Safari's delayed layout without changing the measured-core model.

### 10. Unmeasured core rows must never fall back to spacers

**Problem**: During active scrolling, the mounted window could shift away from the top of the core before a few newly introduced rows had been measured. Those rows then contributed `0` through spacer math on one render and their real DOM height on the next, making `scrollHeight` oscillate and causing visible scrollbar jitter.

**Solution**: `useMountedWindow` treats `MOUNT_CAP` as a soft cap when the current core still contains uncached rows. Any unmeasured rows inside the core stay inside the mounted window until they receive exact heights. Only fully measured rows may be virtualized into top/bottom spacers.

## File Structure

```
src/components/chat/
  ChatVirtualScroll.tsx         - Main component, state machine, scroll handling
  ChatVirtualScroll.module.scss - Styles
  useChatRows.ts                - MessageResponse[] -> ChatRow[] transformation

src/components/chat/virtualScroll/
  types.ts          - All type definitions and constants
  heightCache.ts    - Persistent height cache (never pruned)
  MeasuredRow.tsx   - Row wrapper with ResizeObserver + useLayoutEffect registration
  useCoreManager.ts - Core range: expand, prune, reset, height queries
  useMountedWindow.ts - Mounted window within core
  useStagingBatch.ts  - Hidden batch lifecycle: queue -> measure -> commit
```

## Layout Structure (top to bottom in DOM)

```
[header (optional)]
[network-loading spinner (if loading older from server)]
[top-boundary: ~60px spinner if core doesn't reach start of rows]
[top-spacer: exact sum of measured heights for core rows above mounted window]
[mounted rows: actual DOM nodes with ResizeObserver]
[bottom-spacer: exact sum of measured heights for core rows below mounted window]
[bottom-boundary: ~60px spinner if core doesn't reach end of rows]
[bottom padding]
[staging area: position:absolute, visibility:hidden — for pre-measurement]
```

## Invariants

1. **Only measured heights in scroll geometry** — no estimates contribute to spacer heights or scroll range
2. **Stable row keys are the source of truth** — mutation classification, index adjustment, and height caching all key off `msg:` prefixed keys
3. **Prepend preservation happens before paint** — index shifting in render phase, anchor restoration in `useLayoutEffect`
4. **No scrollTop adjustments during active scrolling** — all core expansion deferred to scroll idle
5. **Edge expansion/loading is exact-edge only** — no eager near-edge expansion or fetches
6. **Network loading is parent policy** — virtualizer reports geometry, `chat-thread.tsx` decides when to fetch
7. **Unmeasured core rows stay mounted** — only rows with exact cached heights may move into spacers
8. **Height cache persists** — measurement work is never discarded, only the core range is bounded
9. **Optimistic confirmation must not remount a row** — `client_generated_id` is stable across confirmation

## Debug Test Plan

This plan is for reproducing and narrowing the chat-switch regressions seen in development:

- After loading older history, switching to another chat and back can leave the thread blank
- After switching back, the thread is sometimes not pinned to bottom even though the page is expected to reopen at bottom

### Environment

- Dev server: `http://10.42.2.114:5173`
- Heavy-history chat: `/chats/chat/116143034872496128`
- Secondary chat for switch-away: any other chat visible in the left chat list with a stable route
- Run this on desktop width first so the chat list stays visible while switching chats

### Core Assertions

For every scenario below, verify all of these:

1. The returning chat renders actual message rows, not an empty/blank viewport
2. The virtual scroll container is in `READY` behaviorally:
   - content is visible
   - scrolling works
   - top/bottom boundaries appear only when expected
3. On re-entering the heavy-history chat, the viewport is pinned to bottom
4. No extra history fetch loop is triggered while parked at the top edge after an older-page load
5. Switching chats does not preserve a stale mid-history viewport from the previous visit unless that becomes an explicit product decision later

### What To Watch While Testing

- Visual:
  - blank message area
  - visible top or bottom boundary rows in the wrong state
  - landing above the latest messages after returning to the chat
- Console:
  - `[ChatVirtualScroll] scroll-position-write`
  - `[ChatVirtualScroll] scroll-idle`
  - `[ChatThread] loadMore resolved`
- DOM metrics from the virtual scroll container:
  - `scrollTop`
  - `clientHeight`
  - `scrollHeight`
  - `bottomDistance = scrollHeight - (scrollTop + clientHeight)`
  - container inline opacity

Suggested probe in DevTools console:

```js
const el = document.querySelector('div[class*="_container_"]');
({
  scrollTop: el?.scrollTop,
  clientHeight: el?.clientHeight,
  scrollHeight: el?.scrollHeight,
  bottomDistance: el ? el.scrollHeight - (el.scrollTop + el.clientHeight) : null,
  opacity: el ? getComputedStyle(el).opacity : null,
  textLength: el?.innerText?.trim().length ?? 0,
});
```

Pass guidance:

- Healthy bottom state: `bottomDistance <= 30`
- Blank-state suspicion: `opacity === "0"` after navigation settles, or `textLength === 0` while message data is known to exist

### Scenario 1: Baseline Open At Bottom

1. Open the heavy-history chat directly
2. Wait for initial bootstrap to settle
3. Confirm the latest messages are visible
4. Confirm `bottomDistance <= 30`

Expected:

- Initial anchor resolves to bottom
- No blank viewport during bootstrap completion

### Scenario 2: Load Older History, Stay In Same Chat

1. Start from the settled bottom state
2. Scroll upward repeatedly until older history loads
3. Stop at the top edge and wait for the fetch to resolve
4. Confirm the visible viewport is preserved after prepend
5. Move away from the exact top edge and confirm load re-arming works normally

Expected:

- Older page loads exactly once per top-edge arm
- After prepend, the visible content does not jump to unrelated rows
- The thread remains scrollable and non-blank

### Scenario 3: Load Older History, Switch Away, Return

1. From Scenario 2, after at least one successful older-history load, switch to another chat using in-app navigation
2. Wait for the second chat to settle
3. Switch back to the heavy-history chat using in-app navigation
4. Inspect the viewport immediately and again after a short settle delay

Expected:

- The heavy-history chat is visible immediately after re-entry
- The chat reopens at bottom, not at the old mid-history viewport
- No transient blank state that remains stuck after layout settles

### Scenario 4: Repeat Chat Switching

1. Perform Scenario 3 three to five times in a row
2. Vary the point where you switch away:
   - immediately after older-history load
   - while positioned mid-history
   - after manually scrolling back to bottom

Expected:

- Re-entry behavior is stable across repeated mounts/resets
- No cumulative drift in `bottomDistance`
- No one-time blank screen that only appears after the second or third switch

### Scenario 5: Fast Switch During Recent Scroll Activity

1. Scroll upward in the heavy-history chat
2. Before the interaction feels fully settled, switch to another chat
3. Switch back quickly

Expected:

- Pending scroll-idle work from the previous chat does not corrupt the new mount
- The returning chat still resolves to bottom and renders rows

### Scenario 6: Return After Explicit Scroll-To-Bottom Recovery

1. Load older history
2. Manually scroll back to bottom
3. Switch away and back

Expected:

- Bottom anchoring remains correct
- Return behavior should match Scenario 1, not preserve the earlier history exploration

### Failure Notes To Capture

When a failure happens, record:

- Which scenario failed
- Whether the failure was:
  - blank viewport
  - not at bottom
  - repeated fetch loop
  - wrong preserved anchor
- The virtual scroll metrics at failure time
- The last relevant console lines before and after the navigation
- Whether the issue self-healed after one animation frame / one second / manual scroll

### Observed DevTools Repros

These were reproduced against the live dev server in Chrome DevTools while switching away from the heavy-history chat and then returning to it.

#### 1. Spacer-only "blank" return state

Observed state:

- The container stayed in `READY` with `opacity: "1"`
- `bottomDistance` reported `0`
- `textLength` was tiny (`14`) because the only visible content was the `"Newer messages"` boundary row
- The flow DOM contained:
  - a giant top spacer
  - a giant bottom spacer
  - the bottom boundary row
  - no mounted message rows

Representative metrics:

```js
{
  scrollTop: 25057,
  clientHeight: 1092,
  scrollHeight: 26149,
  bottomDistance: 0,
  opacity: "1",
  textLength: 14,
}
```

What this taught us:

- This is not a normal hidden/bootstrap blank (`opacity: 0`)
- The failing state can be "spacer-only" while still looking bottom-anchored by metrics
- `useMountedWindow.recomputeMounted()` must be robust when `scrollTop` is beyond the measured core height
- If visible range derivation produces an invalid range (`start > end`), the render can collapse into spacers plus a boundary row

Patch note:

- `useMountedWindow.ts` was hardened to clamp the effective measured offset and normalize the mounted range so it cannot invert during recompute

#### 2. Return renders rows, but not at the true bottom

Observed state:

- The chat returned with real message rows mounted
- The latest message was still not visible
- The `"scroll to bottom"` affordance remained visible
- `bottomDistance` stayed well above the healthy threshold, sometimes by only one boundary row (`~60px`), sometimes by several thousand pixels

Representative metrics from one reproduced failure:

```js
{
  scrollTop: 7505,
  clientHeight: 1092,
  scrollHeight: 12192,
  bottomDistance: 3595,
}
```

Representative metrics from a near-bottom but still failing state:

```js
{
  scrollTop: 11070,
  clientHeight: 1092,
  scrollHeight: 12222,
  bottomDistance: 60,
}
```

What this taught us:

- This is a different bug from the spacer-only blank state
- The return path can perform multiple `scrollToBottomInternal()` writes and still settle above the latest message
- A successful early bottom write does not prove the final mounted/core geometry stayed aligned with the bottom
- It is important to inspect:
  - whether `hasNewerGap()` is still true after the initial bottom snap
  - whether forward expansion completes before the reopen-at-bottom intent is cleared
  - whether mounted-window recomputation is still showing a mid-history slice after a bottom write
  - whether late measurement/layout changes happen after the bottom-settle pass ends

### Likely Code Paths To Inspect When A Failure Reproduces

- Reset on anchor token change:
  - clears refs/cache
  - sets `container.scrollTop = 0`
  - re-enters `BOOTSTRAP`
- Bootstrap completion:
  - whether the component reaches `READY`
  - whether enough measured height exists below the anchor
- Bottom-directed settle path:
  - immediate `scrollToBottomInternal()`
  - follow-up `scheduleBottomSettle()` pass
  - whether reopen-at-bottom intent survives until `hasNewerGap()` is false and `bottomDistance` is actually near zero
  - whether mounted-window recomputation runs after the bottom write, not just before it
- Cross-chat stale work:
  - pending batch completion after navigation
  - pending scroll-idle callback from the prior chat
- Mounted/core geometry:
  - `core.start/end`
  - `mounted.start/end`
  - spacer heights versus visible rows
