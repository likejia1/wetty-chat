import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { HeightCache } from './virtualScroll/heightCache';
import { MeasuredRow } from './virtualScroll/MeasuredRow';
import { useCoreManager } from './virtualScroll/useCoreManager';
import { useMountedWindow } from './virtualScroll/useMountedWindow';
import { useStagingBatch } from './virtualScroll/useStagingBatch';
import type {
  BatchDirection,
  ChatVirtualScrollProps,
  CoreRange,
  LayoutIntent,
  MountedWindow,
  MutationType,
  PendingBatch,
  Phase,
} from './virtualScroll/types';
import {
  AT_BOTTOM_THRESHOLD_PX,
  BOOTSTRAP_HEIGHT_MULTIPLIER,
  BOUNDARY_HEIGHT_PX,
  CORE_CAP,
  MOUNT_CAP,
  SCROLL_IDLE_MS,
  STAGING_BATCH_SIZE,
  VIEWPORT_TRIGGER_PX,
} from './virtualScroll/types';
import styles from './ChatVirtualScroll.module.scss';

// ── Utilities ──

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function isPrefix(prefix: string[], full: string[]): boolean {
  if (prefix.length > full.length) return false;
  return prefix.every((v, i) => full[i] === v);
}

function isSuffix(suffix: string[], full: string[]): boolean {
  if (suffix.length > full.length) return false;
  const offset = full.length - suffix.length;
  return suffix.every((v, i) => full[offset + i] === v);
}

function classifyKeyMutation(prev: string[], next: string[]): MutationType {
  // Use message keys only for classification. Date separator keys can shift
  // position during prepend (e.g. when prepended messages share a date with
  // existing messages), which would cause isSuffix to fail and misclassify
  // a prepend as a reset.
  const prevMsgs = prev.filter((k) => k.startsWith('msg:'));
  const nextMsgs = next.filter((k) => k.startsWith('msg:'));
  if (arraysEqual(prevMsgs, nextMsgs)) return 'none';
  if (prevMsgs.length === 0 || nextMsgs.length === 0 || nextMsgs.length < prevMsgs.length) return 'reset';
  if (isSuffix(prevMsgs, nextMsgs)) return 'prepend';
  if (isPrefix(prevMsgs, nextMsgs)) return 'append';
  return 'reset';
}

// ── Component ──

export function ChatVirtualScroll({
  rows,
  renderRow,
  initialAnchor,
  scrollApiRef,
  loadOlder,
  loadNewer,
  header,
  bottomPadding = 0,
  onAtBottomChange,
}: ChatVirtualScrollProps) {
  // ── Refs ──
  const containerRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const rowRefsMap = useRef(new Map<string, HTMLDivElement>());
  const heightCacheRef = useRef(new HeightCache());
  const heightCache = heightCacheRef.current;

  const layoutIntentRef = useRef<LayoutIntent | null>(null);
  const isAtBottomRef = useRef(true);
  const scrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const initialAnchorRef = useRef(initialAnchor);
  initialAnchorRef.current = initialAnchor;

  const pendingScrollKeyRef = useRef<string | null>(null);
  const pendingScrollBehaviorRef = useRef<ScrollBehavior>('auto');
  const pendingScrollToBottomRef = useRef(false);
  const isScrollIdleRef = useRef(true);

  // Network load arming: armed when user is NOT near the edge, disarmed after a load fires.
  // Re-armed when user scrolls away from the edge. Prevents infinite load loops.
  const topLoadArmedRef = useRef(true);
  const bottomLoadArmedRef = useRef(true);

  // ── Derived ──
  const rowKeys = useMemo(() => rows.map((r) => r.key), [rows]);
  const keyToIndex = useMemo(() => {
    const map = new Map<string, number>();
    rowKeys.forEach((k, i) => map.set(k, i));
    return map;
  }, [rowKeys]);
  const prevKeysRef = useRef<string[]>([]);

  // ── State ──
  const [phase, setPhase] = useState<Phase>('WAITING_VIEWPORT');
  const phaseRef = useRef<Phase>('WAITING_VIEWPORT');
  const [containerHeight, setContainerHeight] = useState(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  // renderTick drives re-renders when internal state changes
  const [renderTick, setRenderTick] = useState(0);
  const triggerRender = useCallback(() => setRenderTick((t) => t + 1), []);

  const setPhaseState = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  // ── Core manager ──
  const {
    coreRef,
    expandCore,
    expandCoreFromCache,
    resetCore,
    pruneCore,
    canExpandFromCache,
    createBatch,
    createBootstrapBatch,
    coreHeight,
    coreHeightBefore,
    coreHeightAfter,
  } = useCoreManager(rowKeys, heightCache);

  // ── Mounted window ──
  const { mountedRef, recomputeMounted, resetMounted, topSpacerHeight, bottomSpacerHeight } = useMountedWindow(
    rowKeys,
    heightCache,
  );

  // ── Staging batch ──
  const handleBatchReady = useCallback(
    (batch: PendingBatch, heights: Map<string, number>) => {
      const heightDelta = expandCore(batch, heights);
      const core = coreRef.current;
      if (!core) return;

      const action: LayoutIntent = {};

      if (phaseRef.current === 'BOOTSTRAP' || phaseRef.current === 'RECENTERING') {
        const totalHeight = coreHeight();
        const viewportH = containerRef.current?.clientHeight || 0;
        const enoughTotal = totalHeight >= viewportH * BOOTSTRAP_HEIGHT_MULTIPLIER;
        const coveredAll = core.start === 0 && core.end === rowKeys.length - 1;

        // For item anchors, we also need enough content BELOW the target
        // to fill the viewport — otherwise scrollToKey can't position
        // the target at the top of the viewport (scrollTop gets clamped).
        let enoughBelowAnchor = true;
        const anchor = initialAnchorRef.current;
        if (anchor.type === 'item') {
          const anchorIdx = keyToIndex.get(anchor.key);
          if (anchorIdx != null) {
            const heightAfter = coreHeightAfter(anchorIdx);
            enoughBelowAnchor = heightAfter >= viewportH || core.end >= rowKeys.length - 1;
          }
        }

        const enoughHeight = enoughTotal && enoughBelowAnchor;

        if (enoughHeight || coveredAll) {
          resetMounted(core);

          // Handle scroll target
          if (pendingScrollKeyRef.current) {
            const targetIdx = keyToIndex.get(pendingScrollKeyRef.current);
            if (targetIdx != null && targetIdx >= core.start && targetIdx <= core.end) {
              action.scrollToKey = { key: pendingScrollKeyRef.current, behavior: pendingScrollBehaviorRef.current };
            }
          } else if (initialAnchorRef.current.type === 'item') {
            const anchorIdx = keyToIndex.get(initialAnchorRef.current.key);
            if (anchorIdx != null && anchorIdx >= core.start && anchorIdx <= core.end) {
              action.scrollToKey = { key: initialAnchorRef.current.key, behavior: 'auto' };
            }
          }

          if (
            initialAnchorRef.current.type === 'bottom' ||
            pendingScrollToBottomRef.current
          ) {
            action.scrollToBottom = true;
          }

          layoutIntentRef.current = action;
          pendingScrollToBottomRef.current = false;
          if (action.scrollToKey && pendingScrollKeyRef.current === action.scrollToKey.key) {
            pendingScrollKeyRef.current = null;
          }
          setPhaseState('READY');
          triggerRender();
          return;
        }

        // Not enough height yet — queue another batch
        layoutIntentRef.current = null;
        triggerRender();
        // Continue bootstrap in the effect
        return;
      }

      // READY state batch commit
      if (batch.direction === 'backward' && heightDelta > 0) {
        action.preserveHeightDelta = heightDelta;
      }
      if (batch.direction === 'forward' && isAtBottomRef.current) {
        action.scrollToBottom = true;
      }
      if (pendingScrollKeyRef.current) {
        const targetIdx = keyToIndex.get(pendingScrollKeyRef.current);
        if (targetIdx != null && targetIdx >= core.start && targetIdx <= core.end) {
          action.scrollToKey = { key: pendingScrollKeyRef.current, behavior: pendingScrollBehaviorRef.current };
          pendingScrollKeyRef.current = null;
        }
      }
      if (pendingScrollToBottomRef.current && !hasNewerGap()) {
        action.scrollToBottom = true;
        pendingScrollToBottomRef.current = false;
      }

      layoutIntentRef.current = action;

      // Recompute mounted window
      const container = containerRef.current;
      if (container) {
        recomputeMounted(core, container.scrollTop, container.clientHeight, topChromeHeight());
      }

      triggerRender();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expandCore, coreHeight, resetMounted, recomputeMounted, keyToIndex, rowKeys],
  );

  const { pendingBatch, queueBatch, cancelBatch, handleStagingMeasure } = useStagingBatch(handleBatchReady);

  // ── Helper functions ──

  const hasOlderGap = useCallback(
    (core?: CoreRange | null) => {
      const c = core ?? coreRef.current;
      return c ? c.start > 0 : rowKeys.length > 0;
    },
    [rowKeys.length],
  );

  const hasNewerGap = useCallback(
    (core?: CoreRange | null) => {
      const c = core ?? coreRef.current;
      return c ? c.end < rowKeys.length - 1 : rowKeys.length > 0;
    },
    [rowKeys.length],
  );

  const topChromeHeight = useCallback(() => {
    let h = headerHeight;
    if (loadOlder.loading) h += 36;
    const core = coreRef.current;
    if (phase === 'READY' && core && core.start > 0) h += BOUNDARY_HEIGHT_PX;
    return h;
  }, [headerHeight, loadOlder.loading, phase]);

  const updateAtBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const atBottom = !hasNewerGap() && container.scrollHeight - (container.scrollTop + container.clientHeight) <= AT_BOTTOM_THRESHOLD_PX;
    if (atBottom !== isAtBottomRef.current) {
      isAtBottomRef.current = atBottom;
      onAtBottomChange?.(atBottom);
    }
  }, [hasNewerGap, onAtBottomChange]);

  const scrollToBottomInternal = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight - container.clientHeight;
  }, []);

  const scrollToKeyInternal = useCallback((key: string, behavior: ScrollBehavior = 'auto') => {
    const container = containerRef.current;
    const row = rowRefsMap.current.get(key);
    if (!container || !row) return;
    const target = Math.max(0, Math.min(row.offsetTop, container.scrollHeight - container.clientHeight));
    container.scrollTo({ top: target, behavior });
  }, []);

  const registerRow = useCallback((key: string, node: HTMLDivElement | null) => {
    if (node) rowRefsMap.current.set(key, node);
    else rowRefsMap.current.delete(key);
  }, []);

  // ── Measurement handler for mounted rows ──
  const handleMountedMeasure = useCallback(
    (key: string, height: number) => {
      const prev = heightCache.get(key);
      if (prev == null) {
        // First measure of a previously cached row that's now mounted — just update
        heightCache.set(key, height);
        return;
      }
      if (prev === height) return;

      // Row resized (image load, etc.)
      heightCache.set(key, height);
      const container = containerRef.current;
      const row = rowRefsMap.current.get(key);
      if (!container || !row) return;

      if (isAtBottomRef.current) {
        scrollToBottomInternal();
      } else if (row.offsetTop < container.scrollTop) {
        container.scrollTop += height - prev;
      }
    },
    [heightCache, scrollToBottomInternal],
  );

  // ── Expansion logic ──

  const maybeExpandOrQueue = useCallback(
    (direction: BatchDirection) => {
      if (phaseRef.current !== 'READY') return;

      // Try instant re-expansion from cache first
      if (canExpandFromCache(direction)) {
        const count = Math.min(STAGING_BATCH_SIZE, direction === 'backward' ? (coreRef.current?.start ?? 0) : (rowKeys.length - 1 - (coreRef.current?.end ?? 0)));
        if (count > 0) {
          const delta = expandCoreFromCache(direction, count);
          if (delta > 0) {
            layoutIntentRef.current = { preserveHeightDelta: delta };
          }
          const core = coreRef.current;
          const container = containerRef.current;
          if (core && container) {
            recomputeMounted(core, container.scrollTop, container.clientHeight, topChromeHeight());
          }
          triggerRender();
          return;
        }
      }

      // Queue staging batch for unmeasured rows
      const batch = createBatch(direction);
      if (batch) queueBatch(batch);
    },
    [canExpandFromCache, expandCoreFromCache, createBatch, queueBatch, recomputeMounted, topChromeHeight, triggerRender, rowKeys.length],
  );

  // ── Scroll-idle handler: network loads + core pruning ──
  // Network loads are intentionally deferred to scroll idle so that:
  // 1. iOS momentum scroll can finish without interference
  // 2. Fetched messages don't cause an infinite load loop during fast scrolling
  // The one-shot arm prevents re-triggering while the user stays parked at the edge.

  const handleScrollIdle = useCallback(() => {
    isScrollIdleRef.current = true;

    const container = containerRef.current;
    const core = coreRef.current;
    if (!container || !core) return;

    // Prune core if needed
    const coreSize = core.end - core.start + 1;
    if (coreSize > CORE_CAP) {
      const m = mountedRef.current;
      const viewportCenter = m ? Math.floor((m.start + m.end) / 2) : Math.floor((core.start + core.end) / 2);
      const delta = pruneCore(viewportCenter);
      if (delta !== 0) {
        container.scrollTop += delta;
      }
      triggerRender();
    }

    // Network load triggers — only on idle, with one-shot arming
    const chromeH = topChromeHeight();
    const scrollDistFromTop = container.scrollTop - chromeH;
    const scrollDistFromBottom = container.scrollHeight - (container.scrollTop + container.clientHeight);

    if (scrollDistFromTop < VIEWPORT_TRIGGER_PX && !hasOlderGap()) {
      if (loadOlder.hasMore && !loadOlder.loading && topLoadArmedRef.current) {
        topLoadArmedRef.current = false;
        loadOlder.onLoad();
      }
    }

    if (scrollDistFromBottom < VIEWPORT_TRIGGER_PX && !hasNewerGap()) {
      if (loadNewer?.hasMore && !loadNewer.loading && bottomLoadArmedRef.current) {
        bottomLoadArmedRef.current = false;
        loadNewer.onLoad();
      }
    }

    // If there's a local gap after idle, expand into it
    if (hasOlderGap() && scrollDistFromTop < VIEWPORT_TRIGGER_PX) {
      maybeExpandOrQueue('backward');
    }
    if (hasNewerGap() && scrollDistFromBottom < VIEWPORT_TRIGGER_PX) {
      maybeExpandOrQueue('forward');
    }
  }, [hasNewerGap, hasOlderGap, loadNewer, loadOlder, maybeExpandOrQueue, pruneCore, topChromeHeight, triggerRender]);

  // ── Scroll handler ──

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    const core = coreRef.current;
    if (!container || !core) return;

    // Throttle mounted window recompute to rAF
    if (scrollRafRef.current == null) {
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        const c = coreRef.current;
        const cont = containerRef.current;
        if (c && cont) {
          recomputeMounted(c, cont.scrollTop, cont.clientHeight, topChromeHeight());
          triggerRender();
        }
      });
    }

    // Scroll idle tracking — reset timer on every scroll event
    isScrollIdleRef.current = false;
    if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
    scrollIdleTimerRef.current = setTimeout(handleScrollIdle, SCROLL_IDLE_MS);

    updateAtBottom();

    // Re-arm network loads when user scrolls away from the edge
    const chromeH = topChromeHeight();
    const scrollDistFromTop = container.scrollTop - chromeH;
    const scrollDistFromBottom = container.scrollHeight - (container.scrollTop + container.clientHeight);

    if (scrollDistFromTop >= VIEWPORT_TRIGGER_PX) {
      topLoadArmedRef.current = true;
    }
    if (scrollDistFromBottom >= VIEWPORT_TRIGGER_PX) {
      bottomLoadArmedRef.current = true;
    }

    // Core expansion is intentionally NOT done here. Expanding the core requires
    // scrollTop adjustments (preserveHeightDelta) which fight with iOS momentum
    // scrolling and create a feedback loop. All core expansion happens on scroll
    // idle via handleScrollIdle.
  }, [handleScrollIdle, recomputeMounted, topChromeHeight, triggerRender, updateAtBottom]);

  // ── Layout effect for scroll preservation ──

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const intent = layoutIntentRef.current;
    const mutation = classifyKeyMutation(prevKeysRef.current, rowKeys);

    // Apply scroll preservation
    if (intent?.preserveHeightDelta && intent.preserveHeightDelta !== 0) {
      container.scrollTop += intent.preserveHeightDelta;
    }

    if (intent?.scrollToBottom) {
      scrollToBottomInternal();
      pendingScrollToBottomRef.current = false;
    }

    if (intent?.scrollToKey) {
      scrollToKeyInternal(intent.scrollToKey.key, intent.scrollToKey.behavior);
      if (pendingScrollKeyRef.current === intent.scrollToKey.key) {
        pendingScrollKeyRef.current = null;
      }
    }

    // Resolve pending scroll-to-key: the target may now be in the mounted DOM
    // after a recomputeMounted + re-render cycle (e.g. from scrollToItem).
    if (pendingScrollKeyRef.current && !intent?.scrollToKey) {
      const targetRow = rowRefsMap.current.get(pendingScrollKeyRef.current);
      if (targetRow) {
        scrollToKeyInternal(pendingScrollKeyRef.current, pendingScrollBehaviorRef.current);
        pendingScrollKeyRef.current = null;
      }
    }

    // Handle mutations detected from key arrays
    if (mutation === 'reset' && phaseRef.current === 'READY') {
      cancelBatch();
      resetCore({ start: 0, end: -1 });
      mountedRef.current = null;
      setPhaseState('BOOTSTRAP');
    } else if (mutation === 'prepend') {
      // Index re-alignment already happened in the render phase.
      // Eagerly expand into the local gap so new rows become visible.
      if (hasOlderGap()) {
        maybeExpandOrQueue('backward');
      }
    } else if (mutation === 'append' && isAtBottomRef.current && !intent?.scrollToKey) {
      if (!hasNewerGap()) {
        scrollToBottomInternal();
      } else {
        pendingScrollToBottomRef.current = true;
        maybeExpandOrQueue('forward');
      }
    }

    updateAtBottom();
    layoutIntentRef.current = null;
    prevKeysRef.current = rowKeys;
  }, [rowKeys, renderTick, cancelBatch, hasNewerGap, hasOlderGap, maybeExpandOrQueue, resetCore, scrollToBottomInternal, scrollToKeyInternal, setPhaseState, updateAtBottom]);

  // ── Container resize observer ──

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let prevHeight = container.clientHeight;
    const ro = new ResizeObserver(() => {
      const nextHeight = container.clientHeight;
      if (nextHeight === prevHeight) return;
      prevHeight = nextHeight;
      setContainerHeight(nextHeight);

      if (phaseRef.current === 'WAITING_VIEWPORT' && nextHeight > 0) {
        setPhaseState('BOOTSTRAP');
      }

      // If at bottom, snap to bottom after resize (keyboard open/close)
      if (phaseRef.current === 'READY' && isAtBottomRef.current) {
        scrollToBottomInternal();
      }
    });

    setContainerHeight(container.clientHeight);
    if (phaseRef.current === 'WAITING_VIEWPORT' && container.clientHeight > 0) {
      setPhaseState('BOOTSTRAP');
    }

    ro.observe(container);
    return () => ro.disconnect();
  }, [setPhaseState, scrollToBottomInternal]);

  // ── Header resize observer ──

  useEffect(() => {
    const headerNode = headerRef.current;
    if (!headerNode) {
      setHeaderHeight(0);
      return;
    }
    const ro = new ResizeObserver(() => {
      setHeaderHeight(headerNode.getBoundingClientRect().height);
    });
    ro.observe(headerNode);
    return () => ro.disconnect();
  }, [header]);

  // ── Reset on anchor token change ──

  useEffect(() => {
    const anchor = initialAnchorRef.current;

    // Reset all state
    rowRefsMap.current.clear();
    heightCache.clear();
    cancelBatch();
    layoutIntentRef.current = null;
    pendingScrollKeyRef.current = null;
    pendingScrollToBottomRef.current = false;
    prevKeysRef.current = rowKeys;
    resetCore({ start: 0, end: -1 }); // empty core
    mountedRef.current = null;

    flushSync(() => {
      setPhaseState(containerHeight > 0 ? 'BOOTSTRAP' : 'WAITING_VIEWPORT');
      triggerRender();
    });

    isAtBottomRef.current = anchor.type === 'bottom';
    onAtBottomChange?.(anchor.type === 'bottom');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAnchor.token]);

  // ── Bootstrap effect ──

  useEffect(() => {
    if (phase !== 'BOOTSTRAP' && phase !== 'RECENTERING') return;
    if (pendingBatch) return; // already measuring
    if (containerHeight <= 0 || rowKeys.length === 0) return;

    const core = coreRef.current;

    if (!core || core.end < core.start) {
      // First batch — seed near anchor
      const anchor = initialAnchorRef.current;
      let anchorIndex: number;
      if (anchor.type === 'item') {
        anchorIndex = keyToIndex.get(anchor.key) ?? rowKeys.length - 1;
      } else {
        anchorIndex = rowKeys.length - 1;
      }

      const batch = createBootstrapBatch(anchorIndex);
      if (batch) queueBatch(batch);
      return;
    }

    // Check if we have enough height — must match the check in handleBatchReady
    const totalHeight = coreHeight();
    const targetHeight = containerHeight * BOOTSTRAP_HEIGHT_MULTIPLIER;
    const coveredAll = core.start === 0 && core.end === rowKeys.length - 1;

    if (coveredAll) return; // handleBatchReady will finalize

    const enoughTotal = totalHeight >= targetHeight;

    // For item anchors, also need a viewport's worth of content below the target
    const anchor = initialAnchorRef.current;
    let needsForward = false;
    if (anchor.type === 'item') {
      const anchorIdx = keyToIndex.get(anchor.key);
      if (anchorIdx != null) {
        const heightAfter = coreHeightAfter(anchorIdx);
        if (heightAfter < containerHeight && core.end < rowKeys.length - 1) {
          needsForward = true;
        }
      }
    }

    if (enoughTotal && !needsForward) return; // handleBatchReady will finalize

    // Need more — expand forward if we need content below the anchor,
    // otherwise expand backward
    let direction: BatchDirection;
    if (needsForward) {
      direction = 'forward';
    } else {
      direction = core.start > 0 ? 'backward' : 'forward';
    }
    const batch = createBatch(direction);
    if (batch) queueBatch(batch);
  }, [phase, pendingBatch, containerHeight, rowKeys, keyToIndex, coreHeight, coreHeightAfter, createBatch, createBootstrapBatch, queueBatch]);

  // ── Pending scroll-to-bottom / scroll-to-key after core expansion ──

  useEffect(() => {
    if (phase !== 'READY') return;

    if (pendingScrollToBottomRef.current && hasNewerGap()) {
      maybeExpandOrQueue('forward');
      return;
    }

    if (pendingScrollKeyRef.current) {
      const targetIdx = keyToIndex.get(pendingScrollKeyRef.current);
      if (targetIdx == null) {
        pendingScrollKeyRef.current = null;
        return;
      }
      const core = coreRef.current;
      if (!core) return;
      if (targetIdx < core.start) {
        maybeExpandOrQueue('backward');
      } else if (targetIdx > core.end) {
        maybeExpandOrQueue('forward');
      }
    }
  }, [phase, renderTick, keyToIndex, hasNewerGap, maybeExpandOrQueue]);

  // ── Scroll API ──

  useEffect(() => {
    if (!scrollApiRef) return;

    scrollApiRef.current = {
      scrollToBottom: () => {
        pendingScrollKeyRef.current = null;
        pendingScrollToBottomRef.current = true;

        if (phaseRef.current !== 'READY') return;

        // Always scroll to the bottom of current content immediately
        // so the user sees visual feedback on the first click.
        scrollToBottomInternal();
        isAtBottomRef.current = true;
        onAtBottomChange?.(true);

        // If there's a newer gap, expand toward it — pendingScrollToBottomRef
        // ensures we'll snap to the true bottom when expansion completes.
        if (hasNewerGap()) {
          maybeExpandOrQueue('forward');
        } else {
          pendingScrollToBottomRef.current = false;
        }
      },
      scrollToItem: (key: string, behavior: ScrollBehavior = 'auto') => {
        const targetIdx = keyToIndex.get(key);
        if (targetIdx == null) return;

        pendingScrollToBottomRef.current = false;

        // Case 1: Target is in mounted window
        const mounted = mountedRef.current;
        if (mounted && targetIdx >= mounted.start && targetIdx <= mounted.end) {
          scrollToKeyInternal(key, behavior);
          return;
        }

        // Case 2: Target is in rows but outside mounted window — RECENTER
        pendingScrollKeyRef.current = key;
        pendingScrollBehaviorRef.current = behavior;

        const core = coreRef.current;
        if (phaseRef.current === 'READY' && core) {
          if (targetIdx >= core.start && targetIdx <= core.end) {
            // Target is in core but outside mounted window. Recompute mounted
            // to include the target, then let the layout effect scroll to it
            // after React re-renders the new mounted rows into the DOM.
            const container = containerRef.current;
            if (container) {
              const targetOffset = coreHeightBefore(targetIdx) + topChromeHeight();
              container.scrollTop = Math.max(0, targetOffset);
              recomputeMounted(core, container.scrollTop, container.clientHeight, topChromeHeight());
              triggerRender();
              // pendingScrollKeyRef stays set — layout effect will call scrollToKeyInternal
              return;
            }
          }

          // Target outside core — enter RECENTERING
          cancelBatch();
          resetCore({ start: 0, end: -1 });
          mountedRef.current = null;
          setPhaseState('RECENTERING');
          triggerRender();
        }
      },
    };

    return () => {
      if (scrollApiRef.current) scrollApiRef.current = null;
    };
  }, [
    scrollApiRef,
    keyToIndex,
    hasNewerGap,
    maybeExpandOrQueue,
    scrollToBottomInternal,
    scrollToKeyInternal,
    onAtBottomChange,
    cancelBatch,
    resetCore,
    setPhaseState,
    triggerRender,
    recomputeMounted,
    topChromeHeight,
    coreHeightBefore,
  ]);

  // ── Cleanup ──

  useEffect(() => {
    return () => {
      if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
      if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  // ── Synchronous index adjustment on prepend ──
  // When rows are prepended, array indices shift but core/mounted refs still hold
  // old indices. We detect this during the render phase (before JSX) so that the
  // mounted rows point to the correct items. This block only fires when rowKeys
  // itself changes (store update), NOT on internal re-renders from expansion.
  const adjustPrevKeysRef = useRef<string[]>([]);
  if (rowKeys !== adjustPrevKeysRef.current) {
    if (adjustPrevKeysRef.current.length > 0) {
      const mut = classifyKeyMutation(adjustPrevKeysRef.current, rowKeys);
      if (mut === 'prepend') {
        const prependCount = rowKeys.length - adjustPrevKeysRef.current.length;
        const core = coreRef.current;
        if (core && core.end >= core.start) {
          core.start += prependCount;
          core.end += prependCount;
        }
        const mounted = mountedRef.current;
        if (mounted) {
          mounted.start += prependCount;
          mounted.end += prependCount;
        }
      }
    }
    adjustPrevKeysRef.current = rowKeys;
  }

  // ── Render ──

  const core = coreRef.current;
  const mounted = mountedRef.current;

  const mountedRows: ReactNode[] = [];
  if (mounted && core) {
    for (let i = mounted.start; i <= mounted.end; i++) {
      const row = rows[i];
      if (!row) continue;
      mountedRows.push(
        <MeasuredRow key={row.key} rowKey={row.key} onMeasure={handleMountedMeasure} registerRow={registerRow}>
          {renderRow(row)}
        </MeasuredRow>,
      );
    }
  }

  const stagingRows: ReactNode[] = [];
  if (pendingBatch) {
    for (const key of pendingBatch.keys) {
      const idx = keyToIndex.get(key);
      if (idx == null) continue;
      const row = rows[idx];
      if (!row) continue;
      stagingRows.push(
        <MeasuredRow key={`staging-${key}`} rowKey={key} hidden onMeasure={handleStagingMeasure}>
          {renderRow(row)}
        </MeasuredRow>,
      );
    }
  }

  const showTopBoundary = phase === 'READY' && core && core.start > 0;
  const showBottomBoundary = phase === 'READY' && core && core.end < rowKeys.length - 1;
  const topSpacer = core && mounted ? topSpacerHeight(core) : 0;
  const bottomSpacer = core && mounted ? bottomSpacerHeight(core) : 0;

  return (
    <div
      ref={containerRef}
      className={styles.container}
      onScroll={handleScroll}
      style={phase !== 'READY' ? { opacity: 0 } : undefined}
    >
      <div ref={flowRef} className={styles.flowContent} style={{ paddingBottom: bottomPadding }}>
        {header && <div ref={headerRef}>{header}</div>}
        {loadOlder.loading && (
          <div className={styles.loadingRow} style={{ height: 36 }}>
            Loading…
          </div>
        )}
        {showTopBoundary && (
          <div className={styles.boundaryRow} style={{ height: BOUNDARY_HEIGHT_PX }}>
            Loading…
          </div>
        )}
        {topSpacer > 0 && <div className={styles.spacer} style={{ height: topSpacer }} />}
        {mountedRows}
        {bottomSpacer > 0 && <div className={styles.spacer} style={{ height: bottomSpacer }} />}
        {showBottomBoundary && (
          <div className={styles.boundaryRow} style={{ height: BOUNDARY_HEIGHT_PX }}>
            Loading…
          </div>
        )}
        <div className={styles.stagingArea}>{stagingRows}</div>
      </div>
    </div>
  );
}
