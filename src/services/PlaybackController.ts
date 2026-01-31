/**
 * PlaybackController Service
 *
 * Unified playback coordination service that manages:
 * - Video/audio synchronization with drift correction
 * - Scrubbing and playhead drag coordination
 * - Frame extraction timing
 * - Professional A/V sync with automatic correction
 *
 * This service acts as the single source of truth for playback operations,
 * replacing the fragmented state management between TimelineStore and PlaybackStore.
 *
 * @module services/PlaybackController
 */

import { usePlaybackStore } from '@/stores/playbackStore';
import { createLogger } from '@/services/logger';
import { PRECISION } from '@/constants/precision';

const logger = createLogger('PlaybackController');

// =============================================================================
// Types
// =============================================================================

/**
 * Sync state between video and audio.
 */
export interface SyncState {
  videoTime: number;
  audioTime: number;
  driftMs: number;
  isSynced: boolean;
  lastCorrectionTime: number;
}

/**
 * Drag operation type for mutual exclusion.
 */
export type DragOperation = 'none' | 'scrubbing' | 'playhead' | 'clip';

/**
 * Playback mode for different behaviors.
 */
export type PlaybackMode = 'normal' | 'scrubbing' | 'stepping';

/**
 * Listener for playback events.
 */
export type PlaybackEventListener = (event: PlaybackEvent) => void;

/**
 * Playback events.
 */
export interface PlaybackEvent {
  type: 'seek' | 'play' | 'pause' | 'sync' | 'dragStart' | 'dragEnd' | 'error';
  time?: number;
  source?: string;
  error?: Error;
}

/**
 * Controller configuration.
 */
export interface PlaybackControllerConfig {
  /** Frames per second for the project */
  fps: number;
  /** Enable A/V sync correction */
  enableSyncCorrection: boolean;
  /** Minimum drift threshold for correction (ms) */
  driftCorrectionThresholdMs: number;
  /** Maximum drift before forcing resync (ms) */
  maxDriftThresholdMs: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_CONFIG: PlaybackControllerConfig = {
  fps: 30,
  enableSyncCorrection: true,
  driftCorrectionThresholdMs: 50, // 50ms threshold for soft correction
  maxDriftThresholdMs: 500, // 500ms threshold for hard resync
};

/** Minimum interval between sync corrections (ms) */
const SYNC_CORRECTION_COOLDOWN_MS = 100;

/** Seek debounce time during scrubbing (ms) */
const SCRUB_SEEK_DEBOUNCE_MS = 16; // ~60fps

// =============================================================================
// PlaybackController Class
// =============================================================================

/**
 * Unified playback controller for timeline operations.
 *
 * Features:
 * - Centralized seek handling with deduplication
 * - A/V sync drift detection and correction
 * - Mutual exclusion for drag operations
 * - Frame-accurate seeking support
 * - Event-driven architecture for extensibility
 */
export class PlaybackController {
  private config: PlaybackControllerConfig;
  private currentDragOperation: DragOperation = 'none';
  private syncState: SyncState = {
    videoTime: 0,
    audioTime: 0,
    driftMs: 0,
    isSynced: true,
    lastCorrectionTime: 0,
  };
  private lastSeekTime: number = 0;
  private lastSeekValue: number = 0;
  private playbackMode: PlaybackMode = 'normal';
  private listeners: Set<PlaybackEventListener> = new Set();
  private isDisposed: boolean = false;

  // Performance tracking
  private seekCount: number = 0;
  private deduplicatedSeekCount: number = 0;

  constructor(config: Partial<PlaybackControllerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * Update controller configuration.
   */
  setConfig(config: Partial<PlaybackControllerConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('Config updated', { config: this.config });
  }

  /**
   * Get current FPS setting.
   */
  get fps(): number {
    return this.config.fps;
  }

  /**
   * Get frame duration in seconds.
   * Returns 1/30 (default fps) if fps is invalid.
   */
  get frameDuration(): number {
    const fps = this.config.fps;
    if (!Number.isFinite(fps) || fps <= 0) {
      return 1 / DEFAULT_CONFIG.fps;
    }
    return 1 / fps;
  }

  // ===========================================================================
  // Drag Operation Coordination
  // ===========================================================================

  /**
   * Attempt to start a drag operation.
   * Returns true if the operation was acquired, false if another drag is in progress.
   */
  acquireDragLock(operation: DragOperation): boolean {
    if (this.isDisposed) return false;

    if (this.currentDragOperation !== 'none') {
      logger.debug('Drag lock denied', {
        requested: operation,
        current: this.currentDragOperation,
      });
      return false;
    }

    this.currentDragOperation = operation;
    this.playbackMode = operation === 'scrubbing' ? 'scrubbing' : 'normal';
    this.emit({ type: 'dragStart', source: operation });

    logger.debug('Drag lock acquired', { operation });
    return true;
  }

  /**
   * Release the current drag operation lock.
   */
  releaseDragLock(operation: DragOperation): void {
    if (this.currentDragOperation === operation) {
      this.currentDragOperation = 'none';
      this.playbackMode = 'normal';
      this.emit({ type: 'dragEnd', source: operation });

      logger.debug('Drag lock released', { operation });
    }
  }

  /**
   * Check if a drag operation is currently active.
   */
  isDragActive(): boolean {
    return this.currentDragOperation !== 'none';
  }

  /**
   * Get the current drag operation type.
   */
  getCurrentDragOperation(): DragOperation {
    return this.currentDragOperation;
  }

  // ===========================================================================
  // Seeking
  // ===========================================================================

  /**
   * Seek to a specific time with deduplication.
   *
   * @param time - Target time in seconds
   * @param options - Seek options
   * @returns true if seek was performed, false if deduplicated
   */
  seek(
    time: number,
    options: {
      source?: string;
      forceUpdate?: boolean;
      frameAccurate?: boolean;
    } = {}
  ): boolean {
    if (this.isDisposed) return false;

    const { source = 'unknown', forceUpdate = false, frameAccurate = false } = options;

    this.seekCount++;

    // Apply frame-accurate rounding if requested
    let targetTime = time;
    if (frameAccurate) {
      targetTime = this.snapToFrame(time);
    }

    // Clamp to valid range
    const store = usePlaybackStore.getState();
    targetTime = Math.max(0, Math.min(store.duration, targetTime));

    // Deduplication check
    const now = performance.now();
    const timeSinceLastSeek = now - this.lastSeekTime;
    const timeDifference = Math.abs(targetTime - this.lastSeekValue);

    // Skip if:
    // - Recent seek to same position (within epsilon)
    // - During scrubbing with recent seek (debounce)
    const isDeduplicable =
      !forceUpdate &&
      timeDifference < PRECISION.FRAME_EPSILON &&
      timeSinceLastSeek < SCRUB_SEEK_DEBOUNCE_MS;

    if (isDeduplicable) {
      this.deduplicatedSeekCount++;
      return false;
    }

    // Perform seek
    this.lastSeekTime = now;
    this.lastSeekValue = targetTime;
    store.setCurrentTime(targetTime);

    // Update sync state
    this.syncState.videoTime = targetTime;

    // Emit event
    this.emit({ type: 'seek', time: targetTime, source });

    logger.debug('Seek performed', {
      time: targetTime.toFixed(3),
      source,
      frameAccurate,
    });

    return true;
  }

  /**
   * Step forward by one frame.
   */
  stepForward(): void {
    this.playbackMode = 'stepping';
    const store = usePlaybackStore.getState();
    const newTime = Math.min(store.duration, store.currentTime + this.frameDuration);
    this.seek(newTime, { source: 'step', frameAccurate: true });
    this.playbackMode = 'normal';
  }

  /**
   * Step backward by one frame.
   */
  stepBackward(): void {
    this.playbackMode = 'stepping';
    const store = usePlaybackStore.getState();
    const newTime = Math.max(0, store.currentTime - this.frameDuration);
    this.seek(newTime, { source: 'step', frameAccurate: true });
    this.playbackMode = 'normal';
  }

  /**
   * Snap time to nearest frame boundary.
   * Returns 0 if time is invalid.
   */
  snapToFrame(time: number): number {
    // Validate input
    if (!Number.isFinite(time)) {
      return 0;
    }
    const fps = this.config.fps;
    if (!Number.isFinite(fps) || fps <= 0) {
      return Math.max(0, time);
    }
    const frameNumber = Math.round(time * fps);
    return frameNumber / fps;
  }

  // ===========================================================================
  // A/V Synchronization
  // ===========================================================================

  /**
   * Report audio playback time for sync tracking.
   */
  reportAudioTime(audioTime: number): void {
    if (this.isDisposed) return;

    this.syncState.audioTime = audioTime;
    this.checkAndCorrectSync();
  }

  /**
   * Report video playback time for sync tracking.
   */
  reportVideoTime(videoTime: number): void {
    if (this.isDisposed) return;

    this.syncState.videoTime = videoTime;
    this.checkAndCorrectSync();
  }

  /**
   * Check A/V sync and apply correction if needed.
   */
  private checkAndCorrectSync(): void {
    if (!this.config.enableSyncCorrection) return;
    if (this.currentDragOperation !== 'none') return; // Don't correct during drag

    const store = usePlaybackStore.getState();
    if (!store.isPlaying) return;

    const driftMs = Math.abs(this.syncState.videoTime - this.syncState.audioTime) * 1000;
    this.syncState.driftMs = driftMs;

    const now = performance.now();
    const timeSinceLastCorrection = now - this.syncState.lastCorrectionTime;

    // Cooldown period to prevent oscillation
    if (timeSinceLastCorrection < SYNC_CORRECTION_COOLDOWN_MS) return;

    // Check if correction is needed
    if (driftMs > this.config.maxDriftThresholdMs) {
      // Critical drift - force hard resync to audio
      this.syncState.lastCorrectionTime = now;
      this.syncState.isSynced = false;

      logger.warn('Critical A/V drift - forcing resync', {
        driftMs: driftMs.toFixed(1),
        videoTime: this.syncState.videoTime.toFixed(3),
        audioTime: this.syncState.audioTime.toFixed(3),
      });

      // Sync video to audio (audio is the master)
      this.seek(this.syncState.audioTime, { source: 'sync', forceUpdate: true });
      this.emit({ type: 'sync', time: this.syncState.audioTime });
    } else if (driftMs > this.config.driftCorrectionThresholdMs) {
      // Moderate drift - apply soft correction
      this.syncState.lastCorrectionTime = now;

      // Gradual correction: move video time slightly toward audio time
      const correctionFactor = 0.1; // Correct 10% of the drift per check
      const correction = (this.syncState.audioTime - this.syncState.videoTime) * correctionFactor;

      logger.debug('Applying soft A/V sync correction', {
        driftMs: driftMs.toFixed(1),
        correction: (correction * 1000).toFixed(1) + 'ms',
      });

      // Update internal video time (next frame will use this)
      this.syncState.videoTime += correction;
    } else {
      this.syncState.isSynced = true;
    }
  }

  /**
   * Get current sync state.
   */
  getSyncState(): Readonly<SyncState> {
    return { ...this.syncState };
  }

  // ===========================================================================
  // Event System
  // ===========================================================================

  /**
   * Subscribe to playback events.
   */
  subscribe(listener: PlaybackEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Emit an event to all listeners.
   */
  private emit(event: PlaybackEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.error('Event listener error', { error, event });
      }
    }
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Get performance statistics.
   */
  getStats(): {
    seekCount: number;
    deduplicatedSeekCount: number;
    deduplicationRate: number;
    currentDragOperation: DragOperation;
    playbackMode: PlaybackMode;
    syncState: SyncState;
  } {
    return {
      seekCount: this.seekCount,
      deduplicatedSeekCount: this.deduplicatedSeekCount,
      deduplicationRate:
        this.seekCount > 0 ? this.deduplicatedSeekCount / this.seekCount : 0,
      currentDragOperation: this.currentDragOperation,
      playbackMode: this.playbackMode,
      syncState: { ...this.syncState },
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.seekCount = 0;
    this.deduplicatedSeekCount = 0;
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  /**
   * Dispose the controller and clean up resources.
   */
  dispose(): void {
    this.isDisposed = true;
    this.listeners.clear();
    this.currentDragOperation = 'none';

    logger.info('PlaybackController disposed', {
      totalSeeks: this.seekCount,
      deduplicated: this.deduplicatedSeekCount,
    });
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

/**
 * Global playback controller instance.
 */
export const playbackController = new PlaybackController();

// =============================================================================
// React Hook for Controller Access
// =============================================================================

import { useEffect, useCallback, useState } from 'react';

/**
 * Hook to access and configure the playback controller.
 *
 * @param config - Optional configuration overrides
 * @returns Controller methods and state
 *
 * @example
 * ```tsx
 * const { seek, acquireDragLock, releaseDragLock, syncState } = usePlaybackController({
 *   fps: 24,
 *   enableSyncCorrection: true,
 * });
 * ```
 */
export function usePlaybackController(config?: Partial<PlaybackControllerConfig>): {
  seek: PlaybackController['seek'];
  stepForward: PlaybackController['stepForward'];
  stepBackward: PlaybackController['stepBackward'];
  snapToFrame: PlaybackController['snapToFrame'];
  acquireDragLock: PlaybackController['acquireDragLock'];
  releaseDragLock: PlaybackController['releaseDragLock'];
  isDragActive: PlaybackController['isDragActive'];
  reportAudioTime: PlaybackController['reportAudioTime'];
  reportVideoTime: PlaybackController['reportVideoTime'];
  syncState: SyncState;
  stats: ReturnType<PlaybackController['getStats']>;
} {
  const [syncState, setSyncState] = useState<SyncState>(playbackController.getSyncState());
  const [stats, setStats] = useState(() => playbackController.getStats());

  // Update config when it changes - check individual properties to avoid unnecessary updates
  useEffect(() => {
    if (config !== undefined) {
      playbackController.setConfig(config);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally depend on specific properties only
  }, [
    config?.fps,
    config?.enableSyncCorrection,
    config?.driftCorrectionThresholdMs,
    config?.maxDriftThresholdMs,
  ]);

  // Subscribe to events and update state reactively
  useEffect(() => {
    const unsubscribe = playbackController.subscribe((event) => {
      if (event.type === 'sync' || event.type === 'seek') {
        setSyncState(playbackController.getSyncState());
        setStats(playbackController.getStats());
      } else if (event.type === 'dragStart' || event.type === 'dragEnd') {
        setStats(playbackController.getStats());
      }
    });

    return unsubscribe;
  }, []);

  return {
    seek: useCallback(
      (time: number, options?: Parameters<PlaybackController['seek']>[1]) =>
        playbackController.seek(time, options),
      []
    ),
    stepForward: useCallback(() => playbackController.stepForward(), []),
    stepBackward: useCallback(() => playbackController.stepBackward(), []),
    snapToFrame: useCallback((time: number) => playbackController.snapToFrame(time), []),
    acquireDragLock: useCallback(
      (operation: DragOperation) => playbackController.acquireDragLock(operation),
      []
    ),
    releaseDragLock: useCallback(
      (operation: DragOperation) => playbackController.releaseDragLock(operation),
      []
    ),
    isDragActive: useCallback(() => playbackController.isDragActive(), []),
    reportAudioTime: useCallback(
      (time: number) => playbackController.reportAudioTime(time),
      []
    ),
    reportVideoTime: useCallback(
      (time: number) => playbackController.reportVideoTime(time),
      []
    ),
    syncState,
    stats,
  };
}
