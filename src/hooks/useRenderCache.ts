/**
 * useRenderCache — Thin React adapter over the render cache store.
 *
 * The state, the backend calls and the Tauri event wiring all live in
 * `renderCacheStore`; this hook only subscribes a component to them and owns
 * the attach/detach lifecycle of the shared listeners. Keeping the surface
 * unchanged means existing consumers (the timeline indicator) need no edits.
 */

import { useCallback, useEffect } from 'react';
import type { RenderCacheStatus, CacheSegmentStatusDto } from '@/bindings';
import { isDesktopRuntimeAvailable } from '@/services/runtimeEnvironment';
import { useRenderCacheStore } from '@/stores/renderCacheStore';

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
  /** Trigger cache rendering for the whole timeline */
  renderCache: () => Promise<void>;
  /** Clear all cached segments */
  clearCache: () => Promise<void>;
  /** Refresh cache status from backend */
  refreshStatus: () => Promise<void>;
}

/**
 * Subscribes to render cache state and keeps the shared backend listeners alive
 * for as long as at least one consumer is mounted.
 */
export function useRenderCache(): UseRenderCacheReturn {
  const status = useRenderCacheStore((state) => state.status);
  const isRendering = useRenderCacheStore((state) => state.isRendering);
  const progress = useRenderCacheStore((state) => state.progress);
  const error = useRenderCacheStore((state) => state.error);
  const renderCacheScoped = useRenderCacheStore((state) => state.renderCache);
  const clearCache = useRenderCacheStore((state) => state.clearCache);
  const refreshStatus = useRenderCacheStore((state) => state.refreshStatus);

  useEffect(() => {
    if (!isDesktopRuntimeAvailable()) {
      return;
    }

    const { attachListeners, detachListeners } = useRenderCacheStore.getState();
    attachListeners();
    return () => {
      detachListeners();
    };
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // This hook keeps whole-timeline semantics; scoped fills go through the
  // store directly (see useIdleCacheFill).
  const renderCache = useCallback(async (): Promise<void> => {
    await renderCacheScoped(null);
  }, [renderCacheScoped]);

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
