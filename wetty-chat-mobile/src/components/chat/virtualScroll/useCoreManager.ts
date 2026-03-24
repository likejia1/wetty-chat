import { useCallback, useRef } from 'react';
import type { HeightCache } from './heightCache';
import type { BatchDirection, ChatRow, CoreRange, PendingBatch } from './types';
import { CORE_CAP, STAGING_BATCH_SIZE } from './types';

export interface CoreManagerResult {
  coreRef: React.MutableRefObject<CoreRange | null>;
  /** Expand the core with newly measured rows. Returns the height delta added above the viewport (for scroll preservation). */
  expandCore: (batch: PendingBatch, heights: Map<string, number>) => number;
  /** Instantly re-expand core using cached heights (no staging needed). Returns height delta added above viewport. */
  expandCoreFromCache: (direction: BatchDirection, count: number) => number;
  /** Reset core to a specific range (used by bootstrap and recentering). */
  resetCore: (range: CoreRange) => void;
  /** Prune the core from the far side if it exceeds CORE_CAP. Returns height removed above viewport. */
  pruneCore: (viewportCenter: number) => number;
  /** Check if rows beyond core edge have cached heights (for instant re-expansion). */
  canExpandFromCache: (direction: BatchDirection) => boolean;
  /** Create a staging batch for rows beyond the core edge. Returns null if no unmeasured rows exist. */
  createBatch: (direction: BatchDirection) => PendingBatch | null;
  /** Create the initial bootstrap batch near the anchor. */
  createBootstrapBatch: (anchorIndex: number) => PendingBatch | null;
  /** Sum of all heights in the core. */
  coreHeight: () => number;
  /** Sum of heights for core rows in [coreStart..index-1]. */
  coreHeightBefore: (index: number) => number;
  /** Sum of heights for core rows in [index+1..coreEnd]. */
  coreHeightAfter: (index: number) => number;
}

export function useCoreManager(
  rowKeys: string[],
  heightCache: HeightCache,
): CoreManagerResult {
  const coreRef = useRef<CoreRange | null>(null);
  const rowKeysRef = useRef(rowKeys);
  rowKeysRef.current = rowKeys;

  const expandCore = useCallback(
    (batch: PendingBatch, heights: Map<string, number>): number => {
      // Write all measurements to the persistent cache
      for (const [key, height] of heights) {
        heightCache.set(key, height);
      }

      const keys = rowKeysRef.current;
      const core = coreRef.current;

      // Find index range of the batch keys in the current rows
      const batchIndices: number[] = [];
      for (const key of batch.keys) {
        const idx = keys.indexOf(key);
        if (idx !== -1) batchIndices.push(idx);
      }
      if (batchIndices.length === 0) return 0;

      const batchStart = Math.min(...batchIndices);
      const batchEnd = Math.max(...batchIndices);

      if (!core) {
        coreRef.current = { start: batchStart, end: batchEnd };
        return 0;
      }

      let heightDelta = 0;
      if (batch.direction === 'backward' && batchStart < core.start) {
        // Adding above — compute height of newly added rows for scroll preservation
        for (let i = batchStart; i < core.start; i++) {
          heightDelta += heightCache.get(keys[i]) ?? 0;
        }
        core.start = batchStart;
      }
      if (batchEnd > core.end) {
        core.end = batchEnd;
      }

      return heightDelta;
    },
    [heightCache],
  );

  const expandCoreFromCache = useCallback(
    (direction: BatchDirection, count: number): number => {
      const keys = rowKeysRef.current;
      const core = coreRef.current;
      if (!core) return 0;

      let heightDelta = 0;

      if (direction === 'backward') {
        const newStart = Math.max(0, core.start - count);
        for (let i = newStart; i < core.start; i++) {
          heightDelta += heightCache.get(keys[i]) ?? 0;
        }
        core.start = newStart;
      } else {
        const newEnd = Math.min(keys.length - 1, core.end + count);
        core.end = newEnd;
      }

      return heightDelta;
    },
    [heightCache],
  );

  const resetCore = useCallback((range: CoreRange) => {
    coreRef.current = { ...range };
  }, []);

  const pruneCore = useCallback(
    (viewportCenterIndex: number): number => {
      const core = coreRef.current;
      const keys = rowKeysRef.current;
      if (!core) return 0;

      const coreSize = core.end - core.start + 1;
      if (coreSize <= CORE_CAP) return 0;

      const excess = coreSize - CORE_CAP;
      const distToStart = viewportCenterIndex - core.start;
      const distToEnd = core.end - viewportCenterIndex;

      let heightDelta = 0;

      if (distToStart > distToEnd) {
        // Prune from the top
        const pruneEnd = core.start + excess;
        for (let i = core.start; i < pruneEnd; i++) {
          heightDelta += heightCache.get(keys[i]) ?? 0;
        }
        core.start = pruneEnd;
        return -heightDelta; // negative = removed height above viewport
      } else {
        // Prune from the bottom — no scroll adjustment needed
        core.end = core.end - excess;
        return 0;
      }
    },
    [heightCache],
  );

  const canExpandFromCache = useCallback(
    (direction: BatchDirection): boolean => {
      const keys = rowKeysRef.current;
      const core = coreRef.current;
      if (!core) return false;

      if (direction === 'backward') {
        if (core.start <= 0) return false;
        // Check if at least some rows above core have cached heights
        const checkStart = Math.max(0, core.start - STAGING_BATCH_SIZE);
        for (let i = checkStart; i < core.start; i++) {
          if (!heightCache.has(keys[i])) return false;
        }
        return true;
      } else {
        if (core.end >= keys.length - 1) return false;
        const checkEnd = Math.min(keys.length - 1, core.end + STAGING_BATCH_SIZE);
        for (let i = core.end + 1; i <= checkEnd; i++) {
          if (!heightCache.has(keys[i])) return false;
        }
        return true;
      }
    },
    [heightCache],
  );

  const createBatch = useCallback(
    (direction: BatchDirection): PendingBatch | null => {
      const keys = rowKeysRef.current;
      const core = coreRef.current;
      if (!core || keys.length === 0) return null;

      if (direction === 'backward') {
        if (core.start <= 0) return null;
        const start = Math.max(0, core.start - STAGING_BATCH_SIZE);
        const batchKeys = keys.slice(start, core.start);
        return batchKeys.length > 0 ? { direction, keys: batchKeys } : null;
      } else {
        if (core.end >= keys.length - 1) return null;
        const end = Math.min(keys.length - 1, core.end + STAGING_BATCH_SIZE);
        const batchKeys = keys.slice(core.end + 1, end + 1);
        return batchKeys.length > 0 ? { direction, keys: batchKeys } : null;
      }
    },
    [],
  );

  const createBootstrapBatch = useCallback((anchorIndex: number): PendingBatch | null => {
    const keys = rowKeysRef.current;
    if (keys.length === 0) return null;

    const clampedAnchor = Math.min(Math.max(0, anchorIndex), keys.length - 1);
    const halfBatch = Math.floor(STAGING_BATCH_SIZE / 2);
    // Seed rows both before AND after the anchor so that:
    // - For bottom anchor: content above fills the viewport
    // - For item anchor: content below provides enough scroll range to
    //   position the target at the top of the viewport
    const start = Math.max(0, clampedAnchor - halfBatch);
    const end = Math.min(keys.length - 1, clampedAnchor + halfBatch);
    const batchKeys = keys.slice(start, end + 1);
    return batchKeys.length > 0 ? { direction: 'backward' as const, keys: batchKeys } : null;
  }, []);

  const coreHeight = useCallback((): number => {
    const core = coreRef.current;
    const keys = rowKeysRef.current;
    if (!core) return 0;

    let total = 0;
    for (let i = core.start; i <= core.end; i++) {
      total += heightCache.get(keys[i]) ?? 0;
    }
    return total;
  }, [heightCache]);

  const coreHeightBefore = useCallback(
    (index: number): number => {
      const core = coreRef.current;
      const keys = rowKeysRef.current;
      if (!core) return 0;

      let total = 0;
      for (let i = core.start; i < index; i++) {
        total += heightCache.get(keys[i]) ?? 0;
      }
      return total;
    },
    [heightCache],
  );

  const coreHeightAfter = useCallback(
    (index: number): number => {
      const core = coreRef.current;
      const keys = rowKeysRef.current;
      if (!core) return 0;

      let total = 0;
      for (let i = index + 1; i <= core.end; i++) {
        total += heightCache.get(keys[i]) ?? 0;
      }
      return total;
    },
    [heightCache],
  );

  return {
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
  };
}
