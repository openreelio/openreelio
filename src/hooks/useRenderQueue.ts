/**
 * useRenderQueue Hook
 *
 * Manages batch render queue state, per-item progress tracking, range export,
 * and individual job cancellation. Communicates with the Rust backend via
 * Tauri IPC and event listeners.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { commands } from '@/bindings';
import type { BatchRenderItemDto } from '@/bindings';
import { save } from '@tauri-apps/plugin-dialog';
import { EXPORT_PRESETS, getPresetExtension } from '@/components/features/export/constants';
import type {
  RenderQueueItem,
  RenderQueueItemStatus,
  BatchRenderProgressEvent,
  BatchItemCompleteEvent,
  BatchRenderCompleteEvent,
} from '@/components/features/export/types';
import { createLogger } from '@/services/logger';

// =============================================================================
// Types
// =============================================================================

const logger = createLogger('useRenderQueue');

export interface UseRenderQueueProps {
  /** Sequence ID to export */
  sequenceId: string | null;
  /** Sequence name for default filenames */
  sequenceName?: string;
}

export interface UseRenderQueueResult {
  /** Items currently in the render queue */
  queue: RenderQueueItem[];
  /** Whether the batch is currently rendering */
  isBatchRendering: boolean;
  /** Active batch ID (null if not rendering) */
  batchId: string | null;
  /** Overall batch progress (0-100) */
  batchProgress: number;
  /** Whether range export is enabled */
  useRange: boolean;
  /** Toggle range export */
  setUseRange: (value: boolean) => void;
  /** In point for range export (seconds) */
  inPoint: number;
  /** Set In point */
  setInPoint: (value: number) => void;
  /** Out point for range export (seconds) */
  outPoint: number;
  /** Set Out point */
  setOutPoint: (value: number) => void;
  /** Add a preset to the queue */
  addToQueue: (presetId: string) => Promise<void>;
  /** Remove an item from the queue (only when not rendering) */
  removeFromQueue: (jobId: string) => void;
  /** Clear all pending items from the queue */
  clearQueue: () => void;
  /** Start the batch render */
  startBatchRender: () => Promise<void>;
  /** Cancel a specific render job */
  cancelJob: (jobId: string) => Promise<void>;
  /** Reset queue state after completion */
  resetQueue: () => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useRenderQueue({
  sequenceId,
  sequenceName = 'Untitled Sequence',
}: UseRenderQueueProps): UseRenderQueueResult {
  // ===========================================================================
  // State
  // ===========================================================================
  const [queue, setQueue] = useState<RenderQueueItem[]>([]);
  const [isBatchRendering, setIsBatchRendering] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batchProgress, setBatchProgress] = useState(0);
  const [useRange, setUseRange] = useState(false);
  const [inPoint, setInPoint] = useState(0);
  const [outPoint, setOutPoint] = useState(10);

  // ===========================================================================
  // Refs
  // ===========================================================================
  const unlistenRefs = useRef<UnlistenFn[]>([]);
  const batchIdRef = useRef<string | null>(null);
  const queueRef = useRef<RenderQueueItem[]>([]);

  // Keep refs in sync with state
  useEffect(() => {
    batchIdRef.current = batchId;
  }, [batchId]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  // ===========================================================================
  // Event Listeners
  // ===========================================================================
  useEffect(() => {
    let isDisposed = false;

    const setupListeners = async (): Promise<void> => {
      // Clean previous
      for (const unlisten of unlistenRefs.current) {
        unlisten();
      }
      unlistenRefs.current = [];

      // Per-item progress
      const unlistenProgress = await listen<BatchRenderProgressEvent>(
        'batch-render-progress',
        (event) => {
          if (event.payload.batchId !== batchIdRef.current) return;

          const { jobId, itemPercent, batchPercent } = event.payload;
          setBatchProgress(batchPercent);

          setQueue((prev) =>
            prev.map((item) =>
              item.jobId === jobId
                ? { ...item, status: 'rendering' as RenderQueueItemStatus, progress: itemPercent }
                : item,
            ),
          );
        },
      );
      if (!isDisposed) {
        unlistenRefs.current.push(unlistenProgress);
      }

      // Per-item completion
      const unlistenItemComplete = await listen<BatchItemCompleteEvent>(
        'batch-item-complete',
        (event) => {
          if (event.payload.batchId !== batchIdRef.current) return;

          const { jobId, status, error } = event.payload;
          setQueue((prev) =>
            prev.map((item) =>
              item.jobId === jobId
                ? {
                    ...item,
                    status: status as RenderQueueItemStatus,
                    progress: status === 'completed' ? 100 : item.progress,
                    error,
                  }
                : item,
            ),
          );
        },
      );
      if (!isDisposed) {
        unlistenRefs.current.push(unlistenItemComplete);
      }

      // Batch completion
      const unlistenBatchComplete = await listen<BatchRenderCompleteEvent>(
        'batch-render-complete',
        (event) => {
          if (event.payload.batchId !== batchIdRef.current) return;

          batchIdRef.current = null;
          setIsBatchRendering(false);
          setBatchId(null);
          setBatchProgress(100);
        },
      );
      if (!isDisposed) {
        unlistenRefs.current.push(unlistenBatchComplete);
      }
    };

    void setupListeners();

    return () => {
      isDisposed = true;
      for (const unlisten of unlistenRefs.current) {
        if (typeof unlisten === 'function') {
          unlisten();
        }
      }
      unlistenRefs.current = [];
    };
  }, []);

  // ===========================================================================
  // Queue Management
  // ===========================================================================

  /** Add a preset to the render queue with a file save dialog. */
  const addToQueue = useCallback(
    async (presetId: string): Promise<void> => {
      const preset = EXPORT_PRESETS.find((p) => p.id === presetId);
      if (!preset) return;

      const extension = getPresetExtension(presetId);
      const selected = await save({
        defaultPath: `${sequenceName}_${preset.name.replace(/\s+/g, '_')}.${extension}`,
        filters: [{ name: 'Video', extensions: [extension] }],
        title: `Export - ${preset.name}`,
      });

      if (!selected) return;

      const newItem: RenderQueueItem = {
        jobId: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        presetId,
        presetName: preset.name,
        outputPath: selected,
        status: 'pending',
        progress: 0,
        inPoint: useRange ? inPoint : undefined,
        outPoint: useRange ? outPoint : undefined,
      };

      setQueue((prev) => [...prev, newItem]);
    },
    [sequenceName, useRange, inPoint, outPoint],
  );

  /** Remove a pending item from the queue. */
  const removeFromQueue = useCallback((jobId: string): void => {
    setQueue((prev) => prev.filter((item) => item.jobId !== jobId || item.status !== 'pending'));
  }, []);

  /** Clear all pending items from the queue. */
  const clearQueue = useCallback((): void => {
    setQueue((prev) => prev.filter((item) => item.status !== 'pending'));
  }, []);

  /** Reset queue to empty state. */
  const resetQueue = useCallback((): void => {
    batchIdRef.current = null;
    setQueue([]);
    setIsBatchRendering(false);
    setBatchId(null);
    setBatchProgress(0);
  }, []);

  // ===========================================================================
  // Batch Render
  // ===========================================================================

  /** Start the batch render for all pending items. */
  const startBatchRender = useCallback(async (): Promise<void> => {
    if (!sequenceId) return;

    // Read from ref to avoid stale closure on queue state
    const currentQueue = queueRef.current;
    const pendingItems = currentQueue.filter((item) => item.status === 'pending');
    if (pendingItems.length === 0) return;

    const invalidItem = pendingItems.find(
      (item) =>
        item.inPoint !== undefined &&
        item.outPoint !== undefined &&
        (item.inPoint < 0 || item.inPoint >= item.outPoint),
    );
    if (invalidItem) {
      logger.warn('Rejected batch render due to invalid queued range', {
        jobId: invalidItem.jobId,
        inPoint: invalidItem.inPoint,
        outPoint: invalidItem.outPoint,
      });
      return;
    }

    // Build the batch request items
    const items: BatchRenderItemDto[] = pendingItems.map((item) => ({
      preset: item.presetId,
      outputPath: item.outputPath,
      inPoint: item.inPoint ?? null,
      outPoint: item.outPoint ?? null,
    }));

    try {
      const res = await commands.batchRender(sequenceId, items);

      if (res.status === 'error') {
        batchIdRef.current = null;
        setQueue((prev) =>
          prev.map((item) =>
            item.status === 'pending'
              ? { ...item, status: 'failed' as const, error: String(res.error) }
              : item,
          ),
        );
        return;
      }

      const result = res.data;

      if (result.jobIds.length !== pendingItems.length) {
        logger.warn('Backend returned mismatched job ID count', {
          expected: pendingItems.length,
          received: result.jobIds.length,
        });
      }

      // Update queue items with real job IDs from backend
      setQueue((prev) => {
        const updated = [...prev];
        let pendingIdx = 0;
        for (let i = 0; i < updated.length; i++) {
          if (updated[i].status === 'pending' && pendingIdx < result.jobIds.length) {
            updated[i] = {
              ...updated[i],
              jobId: result.jobIds[pendingIdx],
              status: pendingIdx === 0 ? 'rendering' : 'pending',
            };
            pendingIdx++;
          }
        }
        return updated;
      });

      batchIdRef.current = result.batchId;
      setBatchId(result.batchId);
      setIsBatchRendering(true);
      setBatchProgress(0);
    } catch (error) {
      batchIdRef.current = null;
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Mark all pending items as failed
      setQueue((prev) =>
        prev.map((item) =>
          item.status === 'pending'
            ? { ...item, status: 'failed' as const, error: errorMessage }
            : item,
        ),
      );
    }
  }, [sequenceId]);

  /** Cancel a specific render job. */
  const cancelJob = useCallback(async (jobId: string): Promise<void> => {
    try {
      const res = await commands.cancelRender(jobId);

      if (res.status === 'error') {
        logger.warn('Failed to cancel render job', { jobId, error: String(res.error) });
        return;
      }

      if (res.data.cancelled) {
        setQueue((prev) =>
          prev.map((item) =>
            item.jobId === jobId ? { ...item, status: 'cancelled' as const } : item,
          ),
        );
        return;
      }

      logger.warn('Render job was not cancelled because it was not found', { jobId });
    } catch (error) {
      logger.warn('Failed to cancel render job', { jobId, error: String(error) });
    }
  }, []);

  // ===========================================================================
  // Return
  // ===========================================================================
  return {
    queue,
    isBatchRendering,
    batchId,
    batchProgress,
    useRange,
    setUseRange,
    inPoint,
    setInPoint,
    outPoint,
    setOutPoint,
    addToQueue,
    removeFromQueue,
    clearQueue,
    startBatchRender,
    cancelJob,
    resetQueue,
  };
}
