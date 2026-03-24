import { useCallback, useRef } from 'react';
import type { HeightCache } from './heightCache';
import type { CoreRange, MountedWindow } from './types';
import { MOUNT_CAP, MOUNT_OVERSCAN } from './types';

export interface MountedWindowResult {
  mountedRef: React.MutableRefObject<MountedWindow | null>;
  /** Recompute the mounted window based on scrollTop and viewport height. */
  recomputeMounted: (core: CoreRange, scrollTop: number, viewportHeight: number, topChromeHeight: number) => void;
  /** Reset mounted window to match the core (used after bootstrap/recentering). */
  resetMounted: (core: CoreRange) => void;
  /** Get top spacer height (core rows above mounted). */
  topSpacerHeight: (core: CoreRange) => number;
  /** Get bottom spacer height (core rows below mounted). */
  bottomSpacerHeight: (core: CoreRange) => number;
}

export function useMountedWindow(
  rowKeys: string[],
  heightCache: HeightCache,
): MountedWindowResult {
  const mountedRef = useRef<MountedWindow | null>(null);
  const rowKeysRef = useRef(rowKeys);
  rowKeysRef.current = rowKeys;

  const recomputeMounted = useCallback(
    (core: CoreRange, scrollTop: number, viewportHeight: number, topChromeHeight: number) => {
      const keys = rowKeysRef.current;
      const mounted = mountedRef.current;

      // Find which core rows are visible by walking cumulative heights
      // The scroll offset into the core content area is scrollTop minus chrome above core
      const coreScrollOffset = Math.max(0, scrollTop - topChromeHeight);

      let cumHeight = 0;
      let visibleStart = core.start;
      let visibleEnd = core.start;

      // Find first visible row
      for (let i = core.start; i <= core.end; i++) {
        const h = heightCache.get(keys[i]) ?? 0;
        if (cumHeight + h > coreScrollOffset) {
          visibleStart = i;
          break;
        }
        cumHeight += h;
        visibleStart = i;
      }

      // Find last visible row
      cumHeight = 0;
      let afterStart = 0;
      for (let i = core.start; i <= core.end; i++) {
        const h = heightCache.get(keys[i]) ?? 0;
        afterStart += h;
        if (afterStart >= coreScrollOffset) {
          // This is approximately where visibility begins; now find end
          let visibleHeight = afterStart - coreScrollOffset;
          visibleEnd = i;
          for (let j = i + 1; j <= core.end; j++) {
            if (visibleHeight >= viewportHeight) break;
            visibleHeight += heightCache.get(keys[j]) ?? 0;
            visibleEnd = j;
          }
          break;
        }
      }

      // Add overscan
      const newStart = Math.max(core.start, visibleStart - MOUNT_OVERSCAN);
      let newEnd = Math.min(core.end, visibleEnd + MOUNT_OVERSCAN);

      // Cap mounted window size
      if (newEnd - newStart + 1 > MOUNT_CAP) {
        // Keep centered on visible range
        const center = Math.floor((visibleStart + visibleEnd) / 2);
        const halfCap = Math.floor(MOUNT_CAP / 2);
        const cappedStart = Math.max(core.start, center - halfCap);
        const cappedEnd = Math.min(core.end, cappedStart + MOUNT_CAP - 1);
        mountedRef.current = { start: cappedStart, end: cappedEnd };
        return;
      }

      // Try to preserve existing mounted range to avoid unnecessary remounts
      if (mounted) {
        const expandedStart = Math.min(mounted.start, newStart);
        const expandedEnd = Math.max(mounted.end, newEnd);
        if (expandedEnd - expandedStart + 1 <= MOUNT_CAP) {
          mountedRef.current = {
            start: Math.max(core.start, expandedStart),
            end: Math.min(core.end, expandedEnd),
          };
          return;
        }
      }

      mountedRef.current = { start: newStart, end: newEnd };
    },
    [heightCache],
  );

  const resetMounted = useCallback((core: CoreRange) => {
    // After bootstrap/recentering, mount the entire core (it's small enough)
    const size = core.end - core.start + 1;
    if (size <= MOUNT_CAP) {
      mountedRef.current = { start: core.start, end: core.end };
    } else {
      // Mount from the end (bottom anchor case)
      mountedRef.current = { start: core.end - MOUNT_CAP + 1, end: core.end };
    }
  }, []);

  const topSpacerHeight = useCallback(
    (core: CoreRange): number => {
      const mounted = mountedRef.current;
      if (!mounted) return 0;
      const keys = rowKeysRef.current;
      let total = 0;
      for (let i = core.start; i < mounted.start; i++) {
        total += heightCache.get(keys[i]) ?? 0;
      }
      return total;
    },
    [heightCache],
  );

  const bottomSpacerHeight = useCallback(
    (core: CoreRange): number => {
      const mounted = mountedRef.current;
      if (!mounted) return 0;
      const keys = rowKeysRef.current;
      let total = 0;
      for (let i = mounted.end + 1; i <= core.end; i++) {
        total += heightCache.get(keys[i]) ?? 0;
      }
      return total;
    },
    [heightCache],
  );

  return { mountedRef, recomputeMounted, resetMounted, topSpacerHeight, bottomSpacerHeight };
}
