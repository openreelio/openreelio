/**
 * Hook for source monitor state management.
 *
 * Wraps IPC commands for the source monitor backend and manages
 * local playback state. Listens for backend events to stay in sync
 * when other components modify the source monitor state.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { commands } from '@/bindings';
import type { SourceMonitorStateDto } from '@/bindings';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { createLogger } from '@/services/logger';

const logger = createLogger('useSourceMonitor');
const BACKEND_PLAYHEAD_EPSILON_SEC = 0.01;

const EMPTY_STATE: SourceMonitorStateDto = {
  assetId: null,
  inPoint: null,
  outPoint: null,
  playheadSec: 0,
  markedDuration: null,
};

export interface UseSourceMonitorReturn {
  /** Currently loaded asset ID */
  assetId: string | null;
  /** In point in seconds */
  inPoint: number | null;
  /** Out point in seconds */
  outPoint: number | null;
  /** Computed duration between In and Out points */
  markedDuration: number | null;
  /** Current playback position in seconds (local, from video element) */
  currentTime: number;
  /** Whether playback is active */
  isPlaying: boolean;
  /** Total duration of loaded asset */
  duration: number;
  /** Load an asset into the source monitor */
  loadAsset: (assetId: string) => Promise<void>;
  /** Clear the source monitor */
  clearAsset: () => Promise<void>;
  /** Set In point at current playback time */
  setInPoint: () => Promise<void>;
  /** Set Out point at current playback time */
  setOutPoint: () => Promise<void>;
  /** Clear both In and Out points */
  clearInOut: () => Promise<void>;
  /** Seek to a specific time */
  seek: (time: number) => void;
  /** Toggle play/pause */
  togglePlayback: () => void;
  /** Update current playback time (from video element) */
  setCurrentTime: (time: number) => void;
  /** Update total duration (from video element) */
  setDuration: (duration: number) => void;
  /** Update play state (from video element) */
  setIsPlaying: (playing: boolean) => void;
}

export function useSourceMonitor(): UseSourceMonitorReturn {
  const [monitorState, setMonitorState] = useState<SourceMonitorStateDto>(EMPTY_STATE);
  const backendPlayheadRef = useRef(EMPTY_STATE.playheadSec);
  const latestRequestedPlayheadRef = useRef<number | null>(null);

  // Local playback state (not persisted to backend)
  const [currentTime, setCurrentTimeState] = useState(0);
  const [isPlaying, setIsPlayingState] = useState(false);
  const [duration, setDurationState] = useState(0);

  // Listen for backend state changes and fetch initial state
  useEffect(() => {
    let cancelled = false;
    let unlistenFn: UnlistenFn | null = null;

    const setup = async (): Promise<void> => {
      try {
        const nextUnlisten = await listen<SourceMonitorStateDto>(
          'source_monitor:changed',
          (event) => {
            if (!cancelled) setMonitorState(event.payload);
          },
        );
        if (cancelled) {
          nextUnlisten();
          return;
        }
        unlistenFn = nextUnlisten;

        const result = await commands.getSourceState();
        if (!cancelled && result.status === 'ok') {
          setMonitorState(result.data);
        }
      } catch {
        // Initialization failure is non-fatal; component will retry on remount.
      }
    };

    void setup();
    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, []);

  // Reset local playback state when asset changes
  useEffect(() => {
    setCurrentTimeState(0);
    setIsPlayingState(false);
    setDurationState(0);
  }, [monitorState.assetId]);

  useEffect(() => {
    backendPlayheadRef.current = monitorState.playheadSec;
    setCurrentTimeState(monitorState.playheadSec);
  }, [monitorState.playheadSec]);

  const syncPlayhead = useCallback(
    async (time: number): Promise<void> => {
      if (monitorState.assetId === null) {
        return;
      }

      if (Math.abs(backendPlayheadRef.current - time) <= BACKEND_PLAYHEAD_EPSILON_SEC) {
        return;
      }

      latestRequestedPlayheadRef.current = time;
      const result = await commands.setSourcePlayhead({ timeSec: time });
      if (result.status === 'error') {
        logger.warn('Failed to sync source playhead', { error: result.error, time });
        return;
      }

      // Drop stale responses — a newer seek may have been issued while awaiting.
      if (latestRequestedPlayheadRef.current !== time) {
        return;
      }

      backendPlayheadRef.current = result.data.playheadSec;
      setMonitorState(result.data);
    },
    [monitorState.assetId],
  );

  const loadAsset = useCallback(async (assetId: string): Promise<void> => {
    const result = await commands.setSourceAsset({ assetId });
    if (result.status === 'error') {
      logger.error('Failed to load source asset', { error: result.error });
      return;
    }
    setMonitorState(result.data);
  }, []);

  const clearAsset = useCallback(async (): Promise<void> => {
    const result = await commands.setSourceAsset({ assetId: null });
    if (result.status === 'error') {
      logger.error('Failed to clear source monitor', { error: result.error });
      return;
    }
    setMonitorState(result.data);
  }, []);

  const setInPoint = useCallback(async (): Promise<void> => {
    const result = await commands.setSourceIn({ timeSec: currentTime });
    if (result.status === 'error') {
      logger.warn('Failed to set In point', { error: result.error });
      return;
    }
    setMonitorState(result.data);
  }, [currentTime]);

  const setOutPoint = useCallback(async (): Promise<void> => {
    const result = await commands.setSourceOut({ timeSec: currentTime });
    if (result.status === 'error') {
      logger.warn('Failed to set Out point', { error: result.error });
      return;
    }
    setMonitorState(result.data);
  }, [currentTime]);

  const clearInOut = useCallback(async (): Promise<void> => {
    const result = await commands.clearSourceInOut();
    if (result.status === 'error') {
      logger.warn('Failed to clear In/Out points', { error: result.error });
      return;
    }
    setMonitorState(result.data);
  }, []);

  const seek = useCallback((time: number): void => {
    setCurrentTimeState(time);
    void syncPlayhead(time);
  }, [syncPlayhead]);

  const togglePlayback = useCallback((): void => {
    setIsPlayingState((prev) => !prev);
  }, []);

  const setCurrentTime = useCallback(
    (time: number): void => {
      setCurrentTimeState(time);
      void syncPlayhead(time);
    },
    [syncPlayhead],
  );

  const setDuration = useCallback((nextDuration: number): void => {
    setDurationState(nextDuration);
  }, []);

  const setIsPlaying = useCallback((playing: boolean): void => {
    setIsPlayingState(playing);
  }, []);

  return {
    assetId: monitorState.assetId,
    inPoint: monitorState.inPoint,
    outPoint: monitorState.outPoint,
    markedDuration: monitorState.markedDuration,
    currentTime,
    isPlaying,
    duration,
    loadAsset,
    clearAsset,
    setInPoint,
    setOutPoint,
    clearInOut,
    seek,
    togglePlayback,
    setCurrentTime,
    setDuration,
    setIsPlaying,
  };
}
