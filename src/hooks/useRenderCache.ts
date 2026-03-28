/**
 * useRenderCache — Hook for managing render cache state.
 *
 * Fetches cache status from the backend, listens for progress events,
 * and provides actions to trigger/clear cache rendering.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { commands } from '@/bindings';
import type { RenderCacheStatus, CacheSegmentStatusDto } from '@/bindings';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isDesktopRuntimeAvailable } from '@/services/runtimeEnvironment';

/** Cache progress event payload */
interface CacheProgressPayload {
  sequenceId: string;
  completedSegments: number;
  totalSegments: number;
  percent: number;
}

/** Return type for the useRenderCache hook */
interface UseRenderCacheReturn {
  /** Current cache status (null if not loaded) */
  status: RenderCacheStatus | null;
  /** Whether cache is currently being rendered */
  isRendering: boolean;
  /** Render progress percentage (0-100) */
  progress: number;
  /** Error message if any */
  error: string | null;
  /** Segment states for the cache indicator bar */
  segments: CacheSegmentStatusDto[];
  /** Trigger cache rendering for pending segments */
  renderCache: () => Promise<void>;
  /** Clear all cached segments */
  clearCache: () => Promise<void>;
  /** Refresh cache status from backend */
  refreshStatus: () => Promise<void>;
}

export function useRenderCache(): UseRenderCacheReturn {
  const [status, setStatus] = useState<RenderCacheStatus | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const unlistenRefs = useRef<UnlistenFn[]>([]);
  const backendAvailable = isDesktopRuntimeAvailable();

  const refreshStatus = useCallback(async () => {
    if (!backendAvailable) {
      setStatus(null);
      setError(null);
      return;
    }

    const result = await commands.getCacheStatus();
    if (result.status === 'ok') {
      setStatus(result.data);
      setError(null);
    } else {
      setStatus(null);
      const message = String(result.error);
      if (message.includes('No project open') || message.includes('No active sequence')) {
        setError(null);
        return;
      }

      setError(message);
    }
  }, [backendAvailable]);

  const renderCache = useCallback(async () => {
    if (!backendAvailable) {
      setError('Render cache is only available in the desktop app runtime.');
      return;
    }

    setIsRendering(true);
    setProgress(0);
    setError(null);

    try {
      const result = await commands.renderPreviewCache();
      if (result.status === 'ok') {
        if (result.data.status === 'already_cached') {
          setIsRendering(false);
          setProgress(100);
        }
      } else {
        setError(result.error);
        setIsRendering(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setIsRendering(false);
    }
  }, [backendAvailable]);

  const clearCache = useCallback(async () => {
    if (!backendAvailable) {
      setError('Render cache is only available in the desktop app runtime.');
      return;
    }

    try {
      const result = await commands.clearRenderCache();
      if (result.status === 'ok') {
        setStatus(null);
        setProgress(0);
        setIsRendering(false);
        await refreshStatus();
      } else {
        setError(result.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [backendAvailable, refreshStatus]);

  // Listen for cache progress and completion events
  useEffect(() => {
    if (!backendAvailable) {
      return;
    }

    let disposed = false;

    const setupListeners = async (): Promise<void> => {
      try {
        const progressUnlisten = await listen<CacheProgressPayload>(
          'render-cache-progress',
          (event) => {
            setProgress(event.payload.percent);
          },
        );

        const completeUnlisten = await listen<{ sequenceId: string }>(
          'render-cache-complete',
          async () => {
            setIsRendering(false);
            setProgress(100);
            await refreshStatus();
          },
        );

        const errorUnlisten = await listen<string>('render-cache-error', (event) => {
          // Per-segment errors do not stop the overall cache render.
          // isRendering is only cleared on render-cache-complete.
          setError(event.payload);
        });

        if (disposed) {
          progressUnlisten();
          completeUnlisten();
          errorUnlisten();
          return;
        }

        unlistenRefs.current = [progressUnlisten, completeUnlisten, errorUnlisten];
      } catch (listenerError) {
        if (!disposed) {
          setIsRendering(false);
          setError(listenerError instanceof Error ? listenerError.message : String(listenerError));
        }
      }
    };

    void setupListeners();

    return () => {
      disposed = true;
      for (const unlisten of unlistenRefs.current) {
        if (typeof unlisten === 'function') {
          unlisten();
        }
      }
      unlistenRefs.current = [];
    };
  }, [backendAvailable, refreshStatus]);

  // Load initial status
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  return {
    status,
    isRendering,
    progress,
    error,
    segments: status?.segmentStates ?? [],
    renderCache,
    clearCache,
    refreshStatus,
  };
}
