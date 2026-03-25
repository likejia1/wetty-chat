import { useVirtualizer } from '@tanstack/react-virtual';
import { t } from '@lingui/core/macro';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { HeightCache } from './virtualScroll/heightCache';
import type { ChatVirtualScrollProps, MutationType, VirtualScrollAnchor } from './virtualScroll/types';
import { AT_BOTTOM_THRESHOLD_PX, EDGE_EPSILON_PX, EDGE_REARM_PX, SCROLL_IDLE_MS } from './virtualScroll/types';
import styles from './ChatVirtualScroll.module.scss';

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isPrefix(prefix: string[], full: string[]): boolean {
  if (prefix.length > full.length) return false;
  return prefix.every((value, index) => full[index] === value);
}

function isSuffix(suffix: string[], full: string[]): boolean {
  if (suffix.length > full.length) return false;
  const offset = full.length - suffix.length;
  return suffix.every((value, index) => full[offset + index] === value);
}

function classifyKeyMutation(prev: string[], next: string[]): MutationType {
  const prevMessages = prev.filter((key) => key.startsWith('msg:'));
  const nextMessages = next.filter((key) => key.startsWith('msg:'));

  if (arraysEqual(prevMessages, nextMessages)) return 'none';
  if (prevMessages.length === 0 || nextMessages.length === 0 || nextMessages.length < prevMessages.length) return 'reset';
  if (isSuffix(prevMessages, nextMessages)) return 'prepend';
  if (isPrefix(prevMessages, nextMessages)) return 'append';
  return 'reset';
}

function roundScrollValue(value: number): number {
  return Math.round(value);
}

function hasMeaningfulScrollDelta(current: number, next: number): boolean {
  return Math.abs(next - current) >= 1;
}

type ViewportAnchor = { key: string; offsetTop: number };

function getRowScrollTop(container: HTMLElement, row: HTMLElement): number {
  const containerRect = container.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  return roundScrollValue(container.scrollTop + (rowRect.top - containerRect.top));
}

interface VirtualRowItemProps {
  index: number;
  rowKey: string;
  start: number;
  registerRow: (rowKey: string, node: HTMLDivElement | null) => void;
  onMeasure: (rowKey: string, node: HTMLDivElement, height: number) => void;
  measureElement: (node: HTMLDivElement) => void;
  children: ReactNode;
}

function VirtualRowItem({ index, rowKey, start, registerRow, onMeasure, measureElement, children }: VirtualRowItemProps) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    registerRow(rowKey, node);
    return () => {
      registerRow(rowKey, null);
    };
  }, [registerRow, rowKey]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const handleMeasure = () => {
      const nextHeight = Math.round(node.getBoundingClientRect().height);
      if (nextHeight <= 0) return;
      measureElement(node);
      onMeasure(rowKey, node, nextHeight);
    };

    handleMeasure();

    const observer = new ResizeObserver(() => {
      handleMeasure();
    });

    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [measureElement, onMeasure, rowKey]);

  return (
    <div
      ref={ref}
      data-index={index}
      className={styles.flowItem}
      style={{ transform: `translateY(${start}px)` }}
    >
      {children}
    </div>
  );
}

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
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefsMap = useRef(new Map<string, HTMLDivElement>());
  const heightCacheRef = useRef(new HeightCache());
  const heightCache = heightCacheRef.current;

  const pendingInitialAnchorRef = useRef<VirtualScrollAnchor | null>(initialAnchor);
  const pendingScrollKeyRef = useRef<string | null>(null);
  const pendingScrollBehaviorRef = useRef<ScrollBehavior>('auto');
  const pendingPrependRestoreRef = useRef<ViewportAnchor | null>(null);
  const pendingAppendRestoreRef = useRef<ViewportAnchor | null>(null);
  const pendingOlderLoadAnchorRef = useRef<ViewportAnchor | null>(null);
  const pendingNewerLoadAnchorRef = useRef<ViewportAnchor | null>(null);
  const isAtBottomRef = useRef(initialAnchor.type === 'bottom');
  const initialAnchorResolvedRef = useRef(false);
  const topLoadArmedRef = useRef(true);
  const bottomLoadArmedRef = useRef(true);
  const prevKeysRef = useRef<string[]>([]);
  const renderMutationPrevKeysRef = useRef<string[]>([]);
  const scrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomSettleRafRef = useRef<number | null>(null);

  const rowKeys = useMemo(() => rows.map((row) => row.key), [rows]);
  const keyToIndex = useMemo(() => {
    const map = new Map<string, number>();
    rowKeys.forEach((key, index) => {
      map.set(key, index);
    });
    return map;
  }, [rowKeys]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getItemKey: (index) => rowKeys[index] ?? index,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => (rows[index]?.type === 'date' ? 40 : 96),
    overscan: 10,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const virtualKeySignature = virtualItems.map((item) => String(item.key)).join('|');

  const registerRow = useCallback((rowKey: string, node: HTMLDivElement | null) => {
    if (node) {
      rowRefsMap.current.set(rowKey, node);
      return;
    }
    rowRefsMap.current.delete(rowKey);
  }, []);

  const updateAtBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const atBottom = container.scrollHeight - (container.scrollTop + container.clientHeight) <= AT_BOTTOM_THRESHOLD_PX;
    if (atBottom === isAtBottomRef.current) return;

    isAtBottomRef.current = atBottom;
    onAtBottomChange?.(atBottom);
  }, [onAtBottomChange]);

  const scrollToBottomInternal = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const target = roundScrollValue(Math.max(0, container.scrollHeight - container.clientHeight));
    if (!hasMeaningfulScrollDelta(container.scrollTop, target)) return;
    container.scrollTop = target;
  }, []);

  const scrollToKeyInternal = useCallback((key: string, behavior: ScrollBehavior = 'auto') => {
    const container = containerRef.current;
    const row = rowRefsMap.current.get(key);
    if (!container || !row) return false;

    const target = getRowScrollTop(container, row);
    if (behavior === 'auto' && !hasMeaningfulScrollDelta(container.scrollTop, target)) {
      return true;
    }

    container.scrollTo({ top: target, behavior });
    return true;
  }, []);

  const restoreAnchorOffset = useCallback((key: string, offsetTop: number) => {
    const container = containerRef.current;
    const row = rowRefsMap.current.get(key);
    if (!container || !row) return false;

    const target = getRowScrollTop(container, row) - offsetTop;
    const nextScrollTop = roundScrollValue(Math.max(0, target));
    if (!hasMeaningfulScrollDelta(container.scrollTop, nextScrollTop)) return true;

    container.scrollTop = nextScrollTop;
    return true;
  }, []);

  const captureVisibleAnchor = useCallback((position: 'top' | 'bottom' = 'top') => {
    const container = containerRef.current;
    if (!container) return null;

    const containerRect = container.getBoundingClientRect();
    let fallbackAnchor: ViewportAnchor | null = null;
    const visibleAnchors: ViewportAnchor[] = [];

    for (const key of rowKeys) {
      const row = rowRefsMap.current.get(key);
      if (!row) continue;

      const rowRect = row.getBoundingClientRect();
      if (rowRect.bottom <= containerRect.top || rowRect.top >= containerRect.bottom) continue;

      const anchor = {
        key,
        offsetTop: roundScrollValue(rowRect.top - containerRect.top),
      };

      visibleAnchors.push(anchor);
      if (key.startsWith('msg:')) {
        if (position === 'top') return anchor;
        fallbackAnchor = anchor;
      }
      if (!fallbackAnchor) fallbackAnchor = anchor;
    }

    if (position === 'bottom' && fallbackAnchor) return fallbackAnchor;
    if (position === 'bottom') return visibleAnchors[visibleAnchors.length - 1] ?? null;
    return fallbackAnchor;
  }, [rowKeys]);

  const scheduleBottomSettle = useCallback(() => {
    if (bottomSettleRafRef.current != null) {
      cancelAnimationFrame(bottomSettleRafRef.current);
    }

    let framesRemaining = 3;

    const settle = () => {
      scrollToBottomInternal();
      updateAtBottom();
      framesRemaining -= 1;

      if (framesRemaining > 0) {
        bottomSettleRafRef.current = requestAnimationFrame(settle);
        return;
      }

      bottomSettleRafRef.current = null;
    };

    bottomSettleRafRef.current = requestAnimationFrame(settle);
  }, [scrollToBottomInternal, updateAtBottom]);

  const onMeasure = useCallback(
    (rowKey: string, node: HTMLDivElement, height: number) => {
      const previousHeight = heightCache.get(rowKey);
      heightCache.set(rowKey, height);

      if (previousHeight == null || previousHeight === height) return;

      const container = containerRef.current;
      if (!container) return;

      const currentlyAtBottom =
        container.scrollHeight - (container.scrollTop + container.clientHeight) <= AT_BOTTOM_THRESHOLD_PX;

      if (
        currentlyAtBottom &&
        pendingPrependRestoreRef.current == null &&
        pendingAppendRestoreRef.current == null &&
        pendingScrollKeyRef.current == null
      ) {
        scrollToBottomInternal();
        return;
      }

      const rowTop = getRowScrollTop(container, node);
      if (rowTop < container.scrollTop) {
        container.scrollTop = roundScrollValue(container.scrollTop + (height - previousHeight));
      }
    },
    [heightCache, scrollToBottomInternal],
  );

  const isAtTopEdge = useCallback(() => {
    const container = containerRef.current;
    return container ? container.scrollTop <= EDGE_EPSILON_PX : false;
  }, []);

  const isAtBottomEdge = useCallback(() => {
    const container = containerRef.current;
    if (!container) return false;
    return container.scrollHeight - (container.scrollTop + container.clientHeight) <= EDGE_EPSILON_PX;
  }, []);

  const handleScrollIdle = useCallback(() => {
    if (isAtTopEdge()) {
      if (loadOlder.hasMore && !loadOlder.loading && topLoadArmedRef.current) {
        topLoadArmedRef.current = false;
        pendingOlderLoadAnchorRef.current = captureVisibleAnchor();
        isAtBottomRef.current = false;
        onAtBottomChange?.(false);
        if (initialAnchorResolvedRef.current && bottomSettleRafRef.current != null) {
          cancelAnimationFrame(bottomSettleRafRef.current);
          bottomSettleRafRef.current = null;
        }
        loadOlder.onLoad();
      }
    }

    if (isAtBottomEdge()) {
      if (loadNewer?.hasMore && !loadNewer.loading && bottomLoadArmedRef.current) {
        bottomLoadArmedRef.current = false;
        pendingNewerLoadAnchorRef.current = captureVisibleAnchor('bottom');
        isAtBottomRef.current = false;
        onAtBottomChange?.(false);
        loadNewer.onLoad();
      }
    }
  }, [captureVisibleAnchor, isAtBottomEdge, isAtTopEdge, loadNewer, loadOlder, onAtBottomChange]);

  const handleScroll = useCallback(() => {
    updateAtBottom();

    const container = containerRef.current;
    if (!container) return;

    const distanceFromBottom = container.scrollHeight - (container.scrollTop + container.clientHeight);
    if (initialAnchorResolvedRef.current && distanceFromBottom > AT_BOTTOM_THRESHOLD_PX) {
      if (bottomSettleRafRef.current != null) {
        cancelAnimationFrame(bottomSettleRafRef.current);
        bottomSettleRafRef.current = null;
      }
    }

    if (container.scrollTop >= EDGE_REARM_PX) {
      topLoadArmedRef.current = true;
    }

    if (container.scrollHeight - (container.scrollTop + container.clientHeight) >= EDGE_REARM_PX) {
      bottomLoadArmedRef.current = true;
    }

    if (scrollIdleTimerRef.current) {
      clearTimeout(scrollIdleTimerRef.current);
    }
    scrollIdleTimerRef.current = setTimeout(handleScrollIdle, SCROLL_IDLE_MS);
  }, [handleScrollIdle, updateAtBottom]);

  useEffect(() => {
    pendingInitialAnchorRef.current = initialAnchor;
    pendingScrollKeyRef.current = null;
    pendingPrependRestoreRef.current = null;
    pendingAppendRestoreRef.current = null;
    pendingOlderLoadAnchorRef.current = null;
    pendingNewerLoadAnchorRef.current = null;
    initialAnchorResolvedRef.current = false;
    heightCache.clear();
    rowRefsMap.current.clear();
    topLoadArmedRef.current = true;
    bottomLoadArmedRef.current = true;
    prevKeysRef.current = rowKeys;
    renderMutationPrevKeysRef.current = rowKeys;
    virtualizer.measure();

    const container = containerRef.current;
    if (container) {
      container.scrollTop = 0;
    }

    isAtBottomRef.current = initialAnchor.type === 'bottom';
    onAtBottomChange?.(initialAnchor.type === 'bottom');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAnchor, onAtBottomChange]);

  if (rowKeys !== renderMutationPrevKeysRef.current) {
    const mutation = classifyKeyMutation(renderMutationPrevKeysRef.current, rowKeys);
    if (mutation === 'prepend') {
      pendingPrependRestoreRef.current = pendingOlderLoadAnchorRef.current ?? captureVisibleAnchor();
      pendingOlderLoadAnchorRef.current = null;
    } else if (mutation === 'append') {
      pendingAppendRestoreRef.current = pendingNewerLoadAnchorRef.current ?? captureVisibleAnchor('bottom');
      pendingNewerLoadAnchorRef.current = null;
    } else if (mutation !== 'none') {
      pendingOlderLoadAnchorRef.current = null;
      pendingNewerLoadAnchorRef.current = null;
    }
    renderMutationPrevKeysRef.current = rowKeys;
  }

  useLayoutEffect(() => {
    const pendingAnchor = pendingInitialAnchorRef.current;
    if (!pendingAnchor || rowKeys.length === 0) return;

    if (pendingAnchor.type === 'bottom') {
      scrollToBottomInternal();
      scheduleBottomSettle();
    } else {
      const targetIndex = keyToIndex.get(pendingAnchor.key);
      if (targetIndex != null) {
        pendingScrollKeyRef.current = pendingAnchor.key;
        pendingScrollBehaviorRef.current = 'auto';
        virtualizer.scrollToIndex(targetIndex, { align: 'start' });
        scrollToKeyInternal(pendingAnchor.key, 'auto');
      }
    }

    pendingInitialAnchorRef.current = null;
    initialAnchorResolvedRef.current = true;
    updateAtBottom();
  }, [keyToIndex, rowKeys.length, scheduleBottomSettle, scrollToBottomInternal, scrollToKeyInternal, updateAtBottom, virtualizer]);

  useLayoutEffect(() => {
    const mutation = classifyKeyMutation(prevKeysRef.current, rowKeys);

    if (
      mutation === 'append' &&
      pendingAppendRestoreRef.current == null &&
      isAtBottomRef.current &&
      pendingInitialAnchorRef.current == null &&
      pendingScrollKeyRef.current == null
    ) {
      scrollToBottomInternal();
      scheduleBottomSettle();
    }

    const pendingPrependRestore = pendingPrependRestoreRef.current;
    if (pendingPrependRestore) {
      const restored = restoreAnchorOffset(pendingPrependRestore.key, pendingPrependRestore.offsetTop);
      if (restored) {
        isAtBottomRef.current = false;
        onAtBottomChange?.(false);
        pendingPrependRestoreRef.current = null;
        pendingOlderLoadAnchorRef.current = null;
      } else {
        const targetIndex = keyToIndex.get(pendingPrependRestore.key);
        if (targetIndex != null) {
          virtualizer.scrollToIndex(targetIndex, { align: 'start' });
        }
      }
    }

    const pendingAppendRestore = pendingAppendRestoreRef.current;
    if (pendingAppendRestore) {
      const restored = restoreAnchorOffset(pendingAppendRestore.key, pendingAppendRestore.offsetTop);
      if (restored) {
        isAtBottomRef.current = false;
        onAtBottomChange?.(false);
        pendingAppendRestoreRef.current = null;
        pendingNewerLoadAnchorRef.current = null;
      } else {
        const targetIndex = keyToIndex.get(pendingAppendRestore.key);
        if (targetIndex != null) {
          virtualizer.scrollToIndex(targetIndex, { align: 'end' });
        }
      }
    }

    const pendingScrollKey = pendingScrollKeyRef.current;
    if (pendingScrollKey) {
      const didScroll = scrollToKeyInternal(pendingScrollKey, pendingScrollBehaviorRef.current);
      if (didScroll) {
        pendingScrollKeyRef.current = null;
      } else {
        const targetIndex = keyToIndex.get(pendingScrollKey);
        if (targetIndex != null) {
          virtualizer.scrollToIndex(targetIndex, { align: 'start' });
        }
      }
    }

    updateAtBottom();
    prevKeysRef.current = rowKeys;
  }, [
    keyToIndex,
    onAtBottomChange,
    restoreAnchorOffset,
    rowKeys,
    scheduleBottomSettle,
    scrollToBottomInternal,
    scrollToKeyInternal,
    updateAtBottom,
    virtualKeySignature,
    virtualizer,
  ]);

  useEffect(() => {
    if (!scrollApiRef) return;

    scrollApiRef.current = {
      scrollToBottom: () => {
        pendingInitialAnchorRef.current = null;
        pendingScrollKeyRef.current = null;
        scrollToBottomInternal();
        scheduleBottomSettle();
        isAtBottomRef.current = true;
        onAtBottomChange?.(true);
      },
      scrollToItem: (key: string, behavior: ScrollBehavior = 'auto') => {
        const targetIndex = keyToIndex.get(key);
        if (targetIndex == null) return;

        pendingInitialAnchorRef.current = null;
        pendingScrollKeyRef.current = key;
        pendingScrollBehaviorRef.current = behavior;

        if (scrollToKeyInternal(key, behavior)) {
          pendingScrollKeyRef.current = null;
          return;
        }

        virtualizer.scrollToIndex(targetIndex, { align: 'start', behavior });
      },
    };

    return () => {
      if (scrollApiRef.current) {
        scrollApiRef.current = null;
      }
    };
  }, [keyToIndex, onAtBottomChange, scheduleBottomSettle, scrollApiRef, scrollToBottomInternal, scrollToKeyInternal, virtualizer]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let previousHeight = container.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = container.clientHeight;
      if (nextHeight === previousHeight) return;

      previousHeight = nextHeight;
      virtualizer.measure();

      if (isAtBottomRef.current) {
        scheduleBottomSettle();
      }
    });

    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [scheduleBottomSettle, virtualizer]);

  useEffect(() => {
    if (!header) return;
    virtualizer.measure();
    if (isAtBottomRef.current) {
      scheduleBottomSettle();
    }
  }, [header, scheduleBottomSettle, virtualizer]);

  useEffect(() => {
    return () => {
      if (scrollIdleTimerRef.current) {
        clearTimeout(scrollIdleTimerRef.current);
      }
      if (bottomSettleRafRef.current != null) {
        cancelAnimationFrame(bottomSettleRafRef.current);
      }
    };
  }, []);

  const totalHeight = virtualizer.getTotalSize() + bottomPadding;

  return (
    <div ref={containerRef} className={styles.container} onScroll={handleScroll}>
      {header ? <div>{header}</div> : null}
      {loadOlder.loading ? <div className={styles.loadingRow}>{t`Loading…`}</div> : null}
      {loadNewer?.loading ? <div className={styles.loadingRow}>{t`Loading…`}</div> : null}
      <div className={styles.flowContent} style={{ height: totalHeight }}>
        {virtualItems.map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;

          return (
            <VirtualRowItem
              key={row.key}
              index={virtualRow.index}
              rowKey={row.key}
              start={virtualRow.start}
              registerRow={registerRow}
              onMeasure={onMeasure}
              measureElement={(node) => {
                virtualizer.measureElement(node);
              }}
            >
              {renderRow(row)}
            </VirtualRowItem>
          );
        })}
      </div>
    </div>
  );
}
