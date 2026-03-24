import {
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import styles from './VirtualScroll.module.scss';

/*
Design criteria for the chat scroller:

1. Visible geometry must be derived only from committed, measured rows.
   Unmeasured rows may exist in the logical data set and in the hidden staging area,
   but they must not participate in visible offsets or scroll preservation until a
   whole batch has been measured and committed.

2. Prepend, append, and reset must be classified from stable row keys in the same
   render as the data change.
   A separate side channel such as prepended counts is too late and causes one bad
   commit where the scroller loses its frontier or applies the wrong scroll logic.

3. Any content inserted above the viewport must preserve the current viewport position
   in the same layout cycle.
   We do this with flow-height deltas instead of estimate-to-real correction or
   post-paint scroll repair.

4. Initial reveal must wait for a real viewport height and a measured committed range.
   Default open is anchored to the bottom of committed content.
   Jump-to-message bootstraps around a stable row key, not an array index.

5. Row identity must stay stable across optimistic confirmation.
   The scroller uses client_generated_id-or-id keys, so confirmation must not remount
   the row and disturb measurement or scroll state.
*/

export interface VirtualScrollHandle {
  scrollToBottom: () => void;
  scrollToItem: (key: string, behavior?: ScrollBehavior) => void;
}

export type VirtualScrollAnchor =
  | { type: 'bottom'; token: number }
  | { type: 'item'; key: string; token: number };

interface LoadController {
  hasMore: boolean;
  loading?: boolean;
  onLoad: () => void;
}

interface VirtualScrollProps<T> {
  items: T[];
  getItemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  initialAnchor: VirtualScrollAnchor;
  loadOlder: LoadController;
  loadNewer?: LoadController;
  scrollApiRef?: MutableRefObject<VirtualScrollHandle | null>;
  bottomPadding?: number;
  onAtBottomChange?: (atBottom: boolean) => void;
  onScrollIdle?: () => void;
  header?: ReactNode;
}

type Phase = 'WAITING_VIEWPORT' | 'BOOTSTRAP' | 'READY';
type BatchDirection = 'backward' | 'forward';
type MutationType = 'none' | 'prepend' | 'append' | 'reset';

interface Frontier {
  startKey: string | null;
  endKey: string | null;
}

interface FrontierIndices {
  start: number;
  end: number;
}

interface PendingBatch {
  direction: BatchDirection;
  keys: string[];
}

interface PendingLayoutAction {
  preserveHeightDelta?: boolean;
  scrollToBottom?: boolean;
  scrollToKey?: { key: string; behavior?: ScrollBehavior };
}

interface LayoutSnapshot {
  flowHeight: number;
  scrollTop: number;
  topChromeHeight: number;
  keys: string[];
}

function isFrontierEmpty(frontier: Frontier): boolean {
  return frontier.startKey == null || frontier.endKey == null;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isPrefix(prefix: string[], full: string[]): boolean {
  return prefix.every((value, index) => full[index] === value);
}

function isSuffix(suffix: string[], full: string[]): boolean {
  const offset = full.length - suffix.length;
  return suffix.every((value, index) => full[offset + index] === value);
}

function classifyKeyMutation(previous: string[], next: string[]): MutationType {
  if (arraysEqual(previous, next)) return 'none';
  if (previous.length === 0 || next.length === 0 || next.length < previous.length) return 'reset';
  if (isSuffix(previous, next)) return 'prepend';
  if (isPrefix(previous, next)) return 'append';
  return 'reset';
}

function MeasuredRow({
  itemKey,
  hidden = false,
  onMeasure,
  registerRow,
  children,
}: {
  itemKey: string;
  hidden?: boolean;
  onMeasure: (itemKey: string, height: number) => void;
  registerRow?: (itemKey: string, node: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    registerRow?.(itemKey, node);

    const ro = new ResizeObserver(() => {
      const height = node.getBoundingClientRect().height;
      if (height > 0) {
        onMeasure(itemKey, height);
      }
    });

    ro.observe(node);

    return () => {
      registerRow?.(itemKey, null);
      ro.disconnect();
    };
  }, [itemKey, onMeasure, registerRow]);

  return (
    <div
      ref={ref}
      className={hidden ? styles.stagingItem : styles.flowItem}
      aria-hidden={hidden || undefined}
    >
      {children}
    </div>
  );
}

const BOOTSTRAP_HEIGHT_MULTIPLIER = 2;
const MAX_BATCH_ITEMS = 20;
const FRONTIER_THRESHOLD_PX = 320;
const FRONTIER_SPINNER_HEIGHT = 40;

export function VirtualScroll<T>({
  items,
  getItemKey,
  renderItem,
  initialAnchor,
  loadOlder,
  loadNewer,
  scrollApiRef,
  bottomPadding = 0,
  onAtBottomChange,
  onScrollIdle,
  header,
}: VirtualScrollProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const flowContentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const heightCacheRef = useRef(new Map<string, number>());
  const pendingMeasurementsRef = useRef(new Map<string, number>());
  const pendingBatchRef = useRef<PendingBatch | null>(null);
  const pendingLayoutActionRef = useRef<PendingLayoutAction | null>(null);
  const pendingScrollKeyRef = useRef<string | null>(null);
  const pendingScrollBehaviorRef = useRef<ScrollBehavior>('auto');
  const pendingScrollToBottomRef = useRef(false);
  const scrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const pendingScrollTopRef = useRef(0);
  const isAtBottomRef = useRef(true);
  const phaseRef = useRef<Phase>('WAITING_VIEWPORT');
  const frontierRef = useRef<Frontier>({ startKey: null, endKey: null });
  const initialAnchorRef = useRef(initialAnchor);
  const keyToIndexRef = useRef<Map<string, number>>(new Map());
  const itemKeysRef = useRef<string[]>([]);
  const frontierIndicesRef = useRef<FrontierIndices | null>(null);
  const prevKeysRef = useRef<string[]>([]);
  const layoutSnapshotRef = useRef<LayoutSnapshot | null>(null);

  const [phase, setPhase] = useState<Phase>('WAITING_VIEWPORT');
  const [frontier, setFrontier] = useState<Frontier>({ startKey: null, endKey: null });
  const [pendingBatch, setPendingBatch] = useState<PendingBatch | null>(null);
  const [containerHeight, setContainerHeight] = useState(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [, setScrollTop] = useState(0);

  const itemKeys = useMemo(() => items.map((item, index) => getItemKey(item, index)), [getItemKey, items]);

  const keyToIndex = useMemo(() => {
    const map = new Map<string, number>();
    itemKeys.forEach((itemKey, index) => map.set(itemKey, index));
    return map;
  }, [itemKeys]);

  const frontierIndices = useMemo(() => {
    if (isFrontierEmpty(frontier)) return null;

    const start = keyToIndex.get(frontier.startKey);
    const end = keyToIndex.get(frontier.endKey);
    if (start == null || end == null || start > end) return null;

    return { start, end };
  }, [frontier, keyToIndex]);

  keyToIndexRef.current = keyToIndex;
  itemKeysRef.current = itemKeys;
  frontierIndicesRef.current = frontierIndices;
  initialAnchorRef.current = initialAnchor;

  const loadingRowHeight = 36;

  const setPhaseState = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const setFrontierState = useCallback((next: Frontier) => {
    frontierRef.current = next;
    setFrontier(next);
  }, []);

  const getViewportHeight = useCallback(() => containerRef.current?.clientHeight || containerHeight || 0, [containerHeight]);

  const getBootstrapTargetHeight = useCallback(
    () => Math.ceil(getViewportHeight() * BOOTSTRAP_HEIGHT_MULTIPLIER),
    [getViewportHeight],
  );

  const getRangeHeight = useCallback((range = frontierIndicesRef.current, keys = itemKeysRef.current) => {
    if (!range) return 0;

    let total = 0;
    for (let index = range.start; index <= range.end; index++) {
      total += heightCacheRef.current.get(keys[index]) ?? 0;
    }
    return total;
  }, []);

  const hasOlderGap = useCallback((range = frontierIndicesRef.current) => (range ? range.start > 0 : itemKeysRef.current.length > 0), []);
  const hasNewerGap = useCallback((range = frontierIndicesRef.current) => (range ? range.end < itemKeysRef.current.length - 1 : itemKeysRef.current.length > 0), []);

  const topSpinnerHeight = phase === 'READY' && hasOlderGap(frontierIndices) ? FRONTIER_SPINNER_HEIGHT : 0;
  const bottomSpinnerHeight = phase === 'READY' && hasNewerGap(frontierIndices) ? FRONTIER_SPINNER_HEIGHT : 0;
  const topChromeHeight = headerHeight + (loadOlder.loading ? loadingRowHeight : 0) + topSpinnerHeight;

  const clampScrollTop = useCallback(
    (value: number) => {
      const container = containerRef.current;
      const viewportHeight = container?.clientHeight || containerHeight || 0;
      const scrollHeight = container?.scrollHeight || 0;
      const max = Math.max(0, scrollHeight - viewportHeight);
      return Math.min(Math.max(0, value), max);
    },
    [containerHeight],
  );

  const registerRow = useCallback((itemKey: string, node: HTMLDivElement | null) => {
    if (node) {
      rowRefs.current.set(itemKey, node);
    } else {
      rowRefs.current.delete(itemKey);
    }
  }, []);

  const createBatch = useCallback(
    (direction: BatchDirection, range = frontierIndicesRef.current): PendingBatch | null => {
      const keys = itemKeysRef.current;
      if (keys.length === 0) return null;

      if (!range) {
        const anchor = initialAnchorRef.current;
        const anchorIndex = anchor.type === 'item' ? (keyToIndexRef.current.get(anchor.key) ?? (keys.length - 1)) : (keys.length - 1);
        const start = Math.max(0, anchorIndex - (MAX_BATCH_ITEMS - 1));
        const batchKeys = keys.slice(start, anchorIndex + 1);
        return batchKeys.length > 0 ? { direction: 'backward', keys: batchKeys } : null;
      }

      if (direction === 'backward') {
        if (range.start <= 0) return null;
        const start = Math.max(0, range.start - MAX_BATCH_ITEMS);
        const batchKeys = keys.slice(start, range.start);
        return batchKeys.length > 0 ? { direction, keys: batchKeys } : null;
      }

      if (range.end >= keys.length - 1) return null;
      const end = Math.min(keys.length - 1, range.end + MAX_BATCH_ITEMS);
      const batchKeys = keys.slice(range.end + 1, end + 1);
      return batchKeys.length > 0 ? { direction, keys: batchKeys } : null;
    },
    [],
  );

  const queueBatch = useCallback((batch: PendingBatch | null) => {
    if (!batch || batch.keys.length === 0 || pendingBatchRef.current) return false;
    pendingMeasurementsRef.current = new Map();
    pendingBatchRef.current = batch;
    setPendingBatch(batch);
    return true;
  }, []);

  const maybeQueueBootstrap = useCallback(() => {
    if (phaseRef.current !== 'BOOTSTRAP' || pendingBatchRef.current || getViewportHeight() <= 0) return;

    const currentRange = frontierIndicesRef.current;
    if (!currentRange) {
      queueBatch(createBatch('backward', currentRange));
      return;
    }

    if (getRangeHeight(currentRange) >= getBootstrapTargetHeight()) return;

    queueBatch(createBatch(currentRange.start > 0 ? 'backward' : 'forward', currentRange));
  }, [createBatch, getBootstrapTargetHeight, getRangeHeight, getViewportHeight, queueBatch]);

  const maybeQueueFrontier = useCallback(
    (direction: BatchDirection) => {
      if (phaseRef.current !== 'READY' || pendingBatchRef.current) return;
      queueBatch(createBatch(direction));
    },
    [createBatch, queueBatch],
  );

  const scrollToBottomInternal = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    container.scrollTop = clampScrollTop(container.scrollHeight);
    setScrollTop(container.scrollTop);
  }, [clampScrollTop]);

  const scrollToKeyInternal = useCallback(
    (itemKey: string, behavior: ScrollBehavior = 'auto') => {
      const container = containerRef.current;
      const row = rowRefs.current.get(itemKey);
      if (!container || !row) return;

      const target = clampScrollTop(row.offsetTop);
      container.scrollTo({ top: target, behavior });
      setScrollTop(target);
    },
    [clampScrollTop],
  );

  const updateAtBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const atBottom = !hasNewerGap() && container.scrollHeight - (container.scrollTop + container.clientHeight) <= 30;
    if (atBottom !== isAtBottomRef.current) {
      isAtBottomRef.current = atBottom;
      onAtBottomChange?.(atBottom);
    }
  }, [hasNewerGap, onAtBottomChange]);

  const commitBatch = useCallback(
    (batch: PendingBatch) => {
      if (!batch.keys.every((itemKey) => pendingMeasurementsRef.current.has(itemKey))) return;

      for (const itemKey of batch.keys) {
        heightCacheRef.current.set(itemKey, pendingMeasurementsRef.current.get(itemKey) ?? 0);
      }

      const batchIndices = batch.keys
        .map((itemKey) => keyToIndexRef.current.get(itemKey))
        .filter((index): index is number => index != null);

      if (batchIndices.length === 0) {
        pendingMeasurementsRef.current = new Map();
        pendingBatchRef.current = null;
        setPendingBatch(null);
        return;
      }

      const currentRange = frontierIndicesRef.current;
      const nextRange: FrontierIndices = currentRange
        ? {
            start: Math.min(currentRange.start, batchIndices[0]),
            end: Math.max(currentRange.end, batchIndices[batchIndices.length - 1]),
          }
        : { start: batchIndices[0], end: batchIndices[batchIndices.length - 1] };

      const nextKeys = itemKeysRef.current;
      const nextFrontier: Frontier = {
        startKey: nextKeys[nextRange.start] ?? null,
        endKey: nextKeys[nextRange.end] ?? null,
      };

      const nextRangeHeight = getRangeHeight(nextRange, nextKeys);
      const shouldReveal =
        phaseRef.current === 'BOOTSTRAP' &&
        (nextRangeHeight >= getBootstrapTargetHeight() || (nextRange.start === 0 && nextRange.end === nextKeys.length - 1));

      const action: PendingLayoutAction = {};
      if (phaseRef.current === 'READY' && batch.direction === 'backward' && currentRange) {
        action.preserveHeightDelta = true;
      }

      if (pendingScrollKeyRef.current) {
        const pendingIndex = keyToIndexRef.current.get(pendingScrollKeyRef.current);
        if (pendingIndex != null && pendingIndex >= nextRange.start && pendingIndex <= nextRange.end) {
          action.scrollToKey = {
            key: pendingScrollKeyRef.current,
            behavior: pendingScrollBehaviorRef.current,
          };
        }
      } else if (shouldReveal && initialAnchorRef.current.type === 'item') {
        const anchorIndex = keyToIndexRef.current.get(initialAnchorRef.current.key);
        if (anchorIndex != null && anchorIndex >= nextRange.start && anchorIndex <= nextRange.end) {
          action.scrollToKey = { key: initialAnchorRef.current.key, behavior: 'auto' };
        }
      }

      if (
        (phaseRef.current === 'READY' && batch.direction === 'forward' && isAtBottomRef.current) ||
        pendingScrollToBottomRef.current ||
        (shouldReveal && initialAnchorRef.current.type === 'bottom')
      ) {
        action.scrollToBottom = true;
      }

      pendingMeasurementsRef.current = new Map();
      pendingBatchRef.current = null;
      pendingLayoutActionRef.current = action;

      flushSync(() => {
        setFrontierState(nextFrontier);
        setPendingBatch(null);
        if (shouldReveal) {
          setPhaseState('READY');
        }
      });

      if (phaseRef.current === 'BOOTSTRAP' && !shouldReveal) {
        maybeQueueBootstrap();
      }
    },
    [getBootstrapTargetHeight, getRangeHeight, maybeQueueBootstrap, setFrontierState, setPhaseState],
  );

  const handleMeasure = useCallback(
    (itemKey: string, height: number) => {
      const pending = pendingBatchRef.current;
      if (pending?.keys.includes(itemKey)) {
        pendingMeasurementsRef.current.set(itemKey, height);
        if (pending.keys.every((key) => pendingMeasurementsRef.current.has(key))) {
          commitBatch(pending);
        }
        return;
      }

      const previous = heightCacheRef.current.get(itemKey);
      if (previous == null || previous === height) return;
      heightCacheRef.current.set(itemKey, height);

      const container = containerRef.current;
      const row = rowRefs.current.get(itemKey);
      if (!container || !row) return;

      if (isAtBottomRef.current) {
        scrollToBottomInternal();
      } else if (row.offsetTop < container.scrollTop) {
        container.scrollTop = clampScrollTop(container.scrollTop + (height - previous));
        setScrollTop(container.scrollTop);
      }
    },
    [clampScrollTop, commitBatch, scrollToBottomInternal],
  );

  useLayoutEffect(() => {
    const container = containerRef.current;
    const flow = flowContentRef.current;
    if (!container || !flow) return;

    const previous = layoutSnapshotRef.current;
    const action = pendingLayoutActionRef.current;
    const mutation = classifyKeyMutation(prevKeysRef.current, itemKeys);
    const topChromeChanged = previous != null && previous.topChromeHeight !== topChromeHeight;

    if (
      previous &&
      phaseRef.current === 'READY' &&
      !action?.scrollToBottom &&
      (action?.preserveHeightDelta || mutation === 'prepend' || topChromeChanged)
    ) {
      const nextHeight = flow.scrollHeight;
      container.scrollTop = clampScrollTop(previous.scrollTop + (nextHeight - previous.flowHeight));
    }

    if (action?.scrollToBottom) {
      scrollToBottomInternal();
      pendingScrollToBottomRef.current = false;
    }

    if (action?.scrollToKey) {
      scrollToKeyInternal(action.scrollToKey.key, action.scrollToKey.behavior);
      if (pendingScrollKeyRef.current === action.scrollToKey.key) {
        pendingScrollKeyRef.current = null;
      }
    }

    if (phaseRef.current === 'READY' && mutation === 'append' && isAtBottomRef.current && !action?.scrollToKey) {
      pendingScrollToBottomRef.current = true;
      if (hasNewerGap(frontierIndicesRef.current)) {
        maybeQueueFrontier('forward');
      } else {
        scrollToBottomInternal();
        pendingScrollToBottomRef.current = false;
      }
    }

    setScrollTop(container.scrollTop);
    updateAtBottom();
    pendingLayoutActionRef.current = null;
    layoutSnapshotRef.current = {
      flowHeight: flow.scrollHeight,
      scrollTop: container.scrollTop,
      topChromeHeight,
      keys: itemKeys,
    };
    prevKeysRef.current = itemKeys;
  }, [
    clampScrollTop,
    hasNewerGap,
    itemKeys,
    maybeQueueFrontier,
    scrollToBottomInternal,
    scrollToKeyInternal,
    topChromeHeight,
    updateAtBottom,
  ]);

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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let previousHeight = container.clientHeight;
    const ro = new ResizeObserver(() => {
      const nextHeight = container.clientHeight;
      if (nextHeight === previousHeight) return;
      previousHeight = nextHeight;
      setContainerHeight(nextHeight);

      if (phaseRef.current === 'WAITING_VIEWPORT' && nextHeight > 0) {
        setPhaseState('BOOTSTRAP');
      }
    });

    setContainerHeight(previousHeight);
    if (phaseRef.current === 'WAITING_VIEWPORT' && previousHeight > 0) {
      setPhaseState('BOOTSTRAP');
    }

    ro.observe(container);
    return () => ro.disconnect();
  }, [setPhaseState]);

  useEffect(() => {
    const anchor = initialAnchorRef.current;

    rowRefs.current.clear();
    heightCacheRef.current = new Map();
    pendingMeasurementsRef.current = new Map();
    pendingBatchRef.current = null;
    pendingLayoutActionRef.current = null;
    pendingScrollKeyRef.current = null;
    pendingScrollBehaviorRef.current = 'auto';
    pendingScrollToBottomRef.current = false;
    layoutSnapshotRef.current = null;
    prevKeysRef.current = itemKeysRef.current;

    flushSync(() => {
      setPendingBatch(null);
      setFrontierState({ startKey: null, endKey: null });
      setPhaseState(getViewportHeight() > 0 ? 'BOOTSTRAP' : 'WAITING_VIEWPORT');
      setScrollTop(0);
    });

    isAtBottomRef.current = anchor.type === 'bottom';
    onAtBottomChange?.(anchor.type === 'bottom');
  }, [getViewportHeight, initialAnchor.token, onAtBottomChange, setFrontierState, setPhaseState]);

  useEffect(() => {
    if (phase === 'BOOTSTRAP') {
      maybeQueueBootstrap();
    }
  }, [containerHeight, frontier.endKey, frontier.startKey, maybeQueueBootstrap, phase]);

  useEffect(() => {
    if (phase !== 'READY') return;

    if (pendingScrollToBottomRef.current && hasNewerGap(frontierIndices)) {
      maybeQueueFrontier('forward');
      return;
    }

    if (pendingScrollKeyRef.current) {
      const targetIndex = keyToIndex.get(pendingScrollKeyRef.current);
      if (targetIndex == null) {
        pendingScrollKeyRef.current = null;
        return;
      }

      if (!frontierIndices) return;
      if (targetIndex < frontierIndices.start) {
        maybeQueueFrontier('backward');
      } else if (targetIndex > frontierIndices.end) {
        maybeQueueFrontier('forward');
      }
    }
  }, [frontierIndices, hasNewerGap, keyToIndex, maybeQueueFrontier, phase]);

  useEffect(() => {
    if (!scrollApiRef) return;

    scrollApiRef.current = {
      scrollToBottom: () => {
        pendingScrollKeyRef.current = null;
        pendingScrollToBottomRef.current = true;

        if (phaseRef.current !== 'READY') return;

        if (hasNewerGap()) {
          maybeQueueFrontier('forward');
          return;
        }

        scrollToBottomInternal();
        isAtBottomRef.current = true;
        onAtBottomChange?.(true);
        pendingScrollToBottomRef.current = false;
      },
      scrollToItem: (itemKey: string, behavior: ScrollBehavior = 'auto') => {
        const currentRange = frontierIndicesRef.current;
        const targetIndex = keyToIndexRef.current.get(itemKey);
        if (targetIndex == null) return;

        pendingScrollToBottomRef.current = false;

        if (currentRange && targetIndex >= currentRange.start && targetIndex <= currentRange.end) {
          scrollToKeyInternal(itemKey, behavior);
          return;
        }

        pendingScrollKeyRef.current = itemKey;
        pendingScrollBehaviorRef.current = behavior;

        if (phaseRef.current === 'READY' && currentRange) {
          maybeQueueFrontier(targetIndex < currentRange.start ? 'backward' : 'forward');
        }
      },
    };

    return () => {
      if (scrollApiRef.current) {
        scrollApiRef.current = null;
      }
    };
  }, [hasNewerGap, maybeQueueFrontier, onAtBottomChange, scrollApiRef, scrollToBottomInternal, scrollToKeyInternal]);

  const onScrollIdleRef = useRef(onScrollIdle);
  onScrollIdleRef.current = onScrollIdle;

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container || !frontierIndicesRef.current) return;

    pendingScrollTopRef.current = container.scrollTop;
    if (scrollRafRef.current == null) {
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        setScrollTop(pendingScrollTopRef.current);
      });
    }

    if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
    scrollIdleTimerRef.current = setTimeout(() => {
      onScrollIdleRef.current?.();
    }, 150);

    updateAtBottom();

    const bottomDistance = container.scrollHeight - (container.scrollTop + container.clientHeight);

    if (container.scrollTop - topChromeHeight < FRONTIER_THRESHOLD_PX) {
      if (hasOlderGap()) {
        maybeQueueFrontier('backward');
      } else if (loadOlder.hasMore && !loadOlder.loading && container.scrollTop < FRONTIER_THRESHOLD_PX) {
        loadOlder.onLoad();
      }
    }

    if (bottomDistance < FRONTIER_THRESHOLD_PX) {
      if (hasNewerGap()) {
        maybeQueueFrontier('forward');
      } else if (loadNewer?.hasMore && !loadNewer.loading && bottomDistance < FRONTIER_THRESHOLD_PX) {
        loadNewer.onLoad();
      }
    }
  }, [hasNewerGap, hasOlderGap, loadNewer, loadOlder, maybeQueueFrontier, topChromeHeight, updateAtBottom]);

  useEffect(() => {
    return () => {
      if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
      if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  const committedRows: ReactNode[] = [];
  if (frontierIndices) {
    for (let index = frontierIndices.start; index <= frontierIndices.end; index++) {
      const item = items[index];
      const itemKey = itemKeys[index];
      committedRows.push(
        <MeasuredRow
          key={itemKey}
          itemKey={itemKey}
          onMeasure={handleMeasure}
          registerRow={registerRow}
        >
          {renderItem(item, index)}
        </MeasuredRow>,
      );
    }
  }

  const stagingRows = pendingBatch?.keys.map((itemKey) => {
    const index = keyToIndex.get(itemKey);
    if (index == null) return null;

    return (
      <MeasuredRow key={`staging-${itemKey}`} itemKey={itemKey} hidden onMeasure={handleMeasure}>
        {renderItem(items[index], index)}
      </MeasuredRow>
    );
  });

  return (
    <div
      ref={containerRef}
      className={styles.container}
      onScroll={handleScroll}
      style={phase !== 'READY' ? { opacity: 0 } : undefined}
    >
      <div ref={flowContentRef} className={styles.flowContent} style={{ paddingBottom: bottomPadding }}>
        {loadOlder.loading && (
          <div className={styles.loadingRow} style={{ height: loadingRowHeight }}>
            Loading…
          </div>
        )}
        {header && <div ref={headerRef}>{header}</div>}
        {topSpinnerHeight > 0 && (
          <div className={styles.loadingRow} style={{ height: topSpinnerHeight }}>
            Loading…
          </div>
        )}
        {committedRows}
        {bottomSpinnerHeight > 0 && (
          <div className={styles.loadingRow} style={{ height: bottomSpinnerHeight }}>
            Loading…
          </div>
        )}
        <div className={styles.stagingArea}>{stagingRows}</div>
      </div>
    </div>
  );
}
