import { type RefObject, useLayoutEffect, useRef } from 'react';
import type { LayoutIntent, MutationType } from './types';

interface LayoutSnapshot {
  flowHeight: number;
  scrollTop: number;
}

/**
 * The critical layout effect for scroll preservation.
 * Runs after every render to apply layout intents and capture snapshots.
 */
export function useScrollPreservation(
  containerRef: RefObject<HTMLDivElement | null>,
  flowRef: RefObject<HTMLDivElement | null>,
  layoutIntentRef: React.MutableRefObject<LayoutIntent | null>,
  mutation: MutationType,
  isAtBottom: boolean,
  deps: unknown[], // additional dependency triggers
): void {
  const snapshotRef = useRef<LayoutSnapshot | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const flow = flowRef.current;
    if (!container || !flow) return;

    const intent = layoutIntentRef.current;
    layoutIntentRef.current = null;

    // 1. Preserve scroll position when height is added above viewport
    if (intent?.preserveHeightDelta && intent.preserveHeightDelta !== 0) {
      container.scrollTop += intent.preserveHeightDelta;
    }

    // 2. Scroll to bottom
    if (intent?.scrollToBottom) {
      container.scrollTop = container.scrollHeight - container.clientHeight;
    }

    // 3. Scroll to specific key (done via direct DOM lookup)
    if (intent?.scrollToKey) {
      // The caller sets scrollToKey; actual DOM scroll is handled by ChatVirtualScroll
      // since it has access to rowRefs. This hook just clears the intent.
    }

    // 4. Append while at bottom: auto-scroll
    if (mutation === 'append' && isAtBottom && !intent?.scrollToKey) {
      container.scrollTop = container.scrollHeight - container.clientHeight;
    }

    // Capture snapshot for next render
    snapshotRef.current = {
      flowHeight: flow.scrollHeight,
      scrollTop: container.scrollTop,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
