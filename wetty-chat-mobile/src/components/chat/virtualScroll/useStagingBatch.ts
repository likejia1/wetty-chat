import { useCallback, useRef, useState } from 'react';
import type { PendingBatch } from './types';

export interface StagingBatchResult {
  pendingBatch: PendingBatch | null;
  queueBatch: (batch: PendingBatch) => boolean;
  cancelBatch: () => void;
  handleStagingMeasure: (key: string, height: number) => void;
}

/**
 * Manages the hidden staging batch lifecycle:
 * queue -> measure all keys in hidden area -> call onBatchReady with measurements.
 */
export function useStagingBatch(
  onBatchReady: (batch: PendingBatch, heights: Map<string, number>) => void,
): StagingBatchResult {
  const [pendingBatch, setPendingBatch] = useState<PendingBatch | null>(null);
  const pendingBatchRef = useRef<PendingBatch | null>(null);
  const pendingMeasurementsRef = useRef(new Map<string, number>());

  const queueBatch = useCallback((batch: PendingBatch): boolean => {
    if (!batch.keys.length || pendingBatchRef.current) return false;
    pendingMeasurementsRef.current = new Map();
    pendingBatchRef.current = batch;
    setPendingBatch(batch);
    return true;
  }, []);

  const cancelBatch = useCallback(() => {
    pendingMeasurementsRef.current = new Map();
    pendingBatchRef.current = null;
    setPendingBatch(null);
  }, []);

  const handleStagingMeasure = useCallback(
    (key: string, height: number) => {
      const batch = pendingBatchRef.current;
      if (!batch || !batch.keys.includes(key)) return;

      pendingMeasurementsRef.current.set(key, height);

      if (batch.keys.every((k) => pendingMeasurementsRef.current.has(k))) {
        const heights = pendingMeasurementsRef.current;
        pendingMeasurementsRef.current = new Map();
        pendingBatchRef.current = null;
        setPendingBatch(null);
        onBatchReady(batch, heights);
      }
    },
    [onBatchReady],
  );

  return { pendingBatch, queueBatch, cancelBatch, handleStagingMeasure };
}
