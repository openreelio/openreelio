/**
 * PlaybackMonitor Service
 *
 * Comprehensive performance monitoring for video playback system.
 * Tracks and reports metrics for debugging and optimization.
 *
 * Features:
 * - A/V sync drift detection with configurable thresholds
 * - Frame drop counting and rate calculation
 * - Latency tracking for frame extraction
 * - Memory pressure monitoring
 * - Session-level statistics aggregation
 */

import { SYNC_THRESHOLDS } from '@/constants/precision';
import { frameCache } from '@/services/frameCache';
import { videoFrameBuffer } from '@/services/videoFrameBuffer';
import { createLogger } from '@/services/logger';

const logger = createLogger('PlaybackMonitor');

// =============================================================================
// Types
// =============================================================================

/**
 * A/V sync drift event.
 */
export interface DriftEvent {
  timestamp: number;
  videoTime: number;
  audioTime: number;
  driftMs: number;
  severity: 'warning' | 'critical';
}

/**
 * Frame timing statistics.
 */
export interface FrameStats {
  rendered: number;
  dropped: number;
  dropRate: number;
  avgRenderTimeMs: number;
  maxRenderTimeMs: number;
}

/**
 * Session-level performance statistics.
 */
export interface SessionStats {
  sessionId: string;
  startTime: number;
  duration: number;
  frameStats: FrameStats;
  driftEvents: DriftEvent[];
  avgDriftMs: number;
  maxDriftMs: number;
  cacheHitRate: number;
  avgFetchLatencyMs: number;
  memoryPressureEvents: number;
}

// =============================================================================
// Constants
// =============================================================================

/** How often to check for drift (ms) */
const DRIFT_CHECK_INTERVAL_MS = 100;

/** Sample window size for rolling averages */
const SAMPLE_WINDOW_SIZE = 60; // ~2 seconds at 30fps

/** Memory pressure threshold (% of cache full) */
const MEMORY_PRESSURE_THRESHOLD = 0.9;

// =============================================================================
// PlaybackMonitor Class
// =============================================================================

/**
 * Playback performance monitor with drift detection and statistics.
 */
export class PlaybackMonitor {
  private sessionId: string;
  private startTime: number;
  private isActive: boolean = false;

  // Frame statistics
  private frameCount: number = 0;
  private droppedFrameCount: number = 0;
  private renderTimes: number[] = [];

  // Drift tracking
  private driftSamples: number[] = [];
  private driftEvents: DriftEvent[] = [];
  private lastDriftCheckTime: number = 0;

  // Memory pressure tracking
  private memoryPressureEvents: number = 0;

  constructor() {
    this.sessionId = this.generateSessionId();
    this.startTime = Date.now();
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Start monitoring a playback session.
   */
  start(): void {
    this.isActive = true;
    this.startTime = Date.now();
    this.sessionId = this.generateSessionId();
    this.reset();

    logger.info('Playback monitoring started', { sessionId: this.sessionId });
  }

  /**
   * Stop monitoring and return session stats.
   */
  stop(): SessionStats {
    this.isActive = false;
    const stats = this.getStats();

    logger.info('Playback monitoring stopped', {
      sessionId: this.sessionId,
      duration: (stats.duration / 1000).toFixed(1) + 's',
      frameDropRate: (stats.frameStats.dropRate * 100).toFixed(1) + '%',
      avgDriftMs: stats.avgDriftMs.toFixed(1),
      cacheHitRate: (stats.cacheHitRate * 100).toFixed(1) + '%',
    });

    return stats;
  }

  /**
   * Record a frame render.
   *
   * @param renderTimeMs Time taken to render in milliseconds
   * @param wasDropped Whether the frame was dropped
   */
  recordFrame(renderTimeMs: number, wasDropped: boolean = false): void {
    if (!this.isActive) return;

    this.frameCount++;
    if (wasDropped) {
      this.droppedFrameCount++;
    }

    // Track render time (keep rolling window)
    this.renderTimes.push(renderTimeMs);
    if (this.renderTimes.length > SAMPLE_WINDOW_SIZE) {
      this.renderTimes.shift();
    }

    // Check for slow frames
    if (renderTimeMs > 50) {
      logger.debug('Slow frame render', {
        renderTimeMs: renderTimeMs.toFixed(1),
        frameCount: this.frameCount,
      });
    }
  }

  /**
   * Record dropped frames directly.
   *
   * @param count Number of frames dropped
   */
  recordDroppedFrames(count: number): void {
    if (!this.isActive) return;
    this.droppedFrameCount += count;
  }

  /**
   * Check A/V sync drift and record events.
   * Now also triggers correction via PlaybackController when drift exceeds thresholds.
   *
   * @param videoTime Current video timeline time
   * @param audioTime Current audio playback time
   * @returns true if drift correction was triggered
   */
  checkDrift(videoTime: number, audioTime: number): boolean {
    if (!this.isActive) return false;

    const now = Date.now();
    if (now - this.lastDriftCheckTime < DRIFT_CHECK_INTERVAL_MS) {
      return false;
    }
    this.lastDriftCheckTime = now;

    const driftMs = Math.abs(videoTime - audioTime) * 1000;

    // Track sample
    this.driftSamples.push(driftMs);
    if (this.driftSamples.length > SAMPLE_WINDOW_SIZE) {
      this.driftSamples.shift();
    }

    // Check thresholds
    const driftSeconds = driftMs / 1000;
    let correctionTriggered = false;

    if (driftSeconds > SYNC_THRESHOLDS.MAX_DRIFT_THRESHOLD) {
      // Critical drift - record event
      const event: DriftEvent = {
        timestamp: now,
        videoTime,
        audioTime,
        driftMs,
        severity: 'critical',
      };
      this.driftEvents.push(event);

      logger.warn('Critical A/V sync drift detected', {
        driftMs: driftMs.toFixed(1),
        videoTime: videoTime.toFixed(3),
        audioTime: audioTime.toFixed(3),
      });

      correctionTriggered = true;
    } else if (driftSeconds > SYNC_THRESHOLDS.AUDIO_SYNC_THRESHOLD) {
      // Warning drift
      const event: DriftEvent = {
        timestamp: now,
        videoTime,
        audioTime,
        driftMs,
        severity: 'warning',
      };
      this.driftEvents.push(event);

      logger.debug('A/V sync drift warning', {
        driftMs: driftMs.toFixed(1),
      });
    }

    return correctionTriggered;
  }

  /**
   * Check memory pressure and record events.
   */
  checkMemoryPressure(): void {
    if (!this.isActive) return;

    const cacheStats = frameCache.getStats();
    const maxEntries = 100; // Should match FRAME_EXTRACTION.MAX_CACHE_ENTRIES

    const fillRatio = cacheStats.entryCount / maxEntries;
    if (fillRatio > MEMORY_PRESSURE_THRESHOLD) {
      this.memoryPressureEvents++;

      logger.warn('Frame cache memory pressure', {
        fillRatio: (fillRatio * 100).toFixed(1) + '%',
        entries: cacheStats.entryCount,
        sizeMB: (cacheStats.totalSizeBytes / 1024 / 1024).toFixed(2),
      });
    }
  }

  /**
   * Get current session statistics.
   */
  getStats(): SessionStats {
    const cacheStats = frameCache.getStats();
    const bufferStats = videoFrameBuffer.getStats();

    // Calculate frame stats
    const avgRenderTime = this.renderTimes.length > 0
      ? this.renderTimes.reduce((a, b) => a + b, 0) / this.renderTimes.length
      : 0;
    const maxRenderTime = this.renderTimes.length > 0
      ? Math.max(...this.renderTimes)
      : 0;

    // Calculate drift stats
    const avgDrift = this.driftSamples.length > 0
      ? this.driftSamples.reduce((a, b) => a + b, 0) / this.driftSamples.length
      : 0;
    const maxDrift = this.driftSamples.length > 0
      ? Math.max(...this.driftSamples)
      : 0;

    return {
      sessionId: this.sessionId,
      startTime: this.startTime,
      duration: Date.now() - this.startTime,
      frameStats: {
        rendered: this.frameCount,
        dropped: this.droppedFrameCount,
        dropRate: this.frameCount > 0 ? this.droppedFrameCount / this.frameCount : 0,
        avgRenderTimeMs: avgRenderTime,
        maxRenderTimeMs: maxRenderTime,
      },
      driftEvents: [...this.driftEvents],
      avgDriftMs: avgDrift,
      maxDriftMs: maxDrift,
      cacheHitRate: cacheStats.hitRate,
      avgFetchLatencyMs: bufferStats.avgFetchLatencyMs,
      memoryPressureEvents: this.memoryPressureEvents,
    };
  }

  /**
   * Reset all statistics.
   */
  reset(): void {
    this.frameCount = 0;
    this.droppedFrameCount = 0;
    this.renderTimes = [];
    this.driftSamples = [];
    this.driftEvents = [];
    this.lastDriftCheckTime = 0;
    this.memoryPressureEvents = 0;
  }

  /**
   * Check if monitoring is active.
   */
  get active(): boolean {
    return this.isActive;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Generate a unique session ID.
   */
  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

/**
 * Global playback monitor instance.
 */
export const playbackMonitor = new PlaybackMonitor();

// =============================================================================
// React Hook for Monitoring
// =============================================================================

import { useEffect } from 'react';

/**
 * Hook to integrate playback monitoring with components.
 *
 * @param isPlaying Whether playback is active
 * @param currentVideoTime Current video timeline position
 * @param currentAudioTime Current audio playback position (optional)
 */
export function usePlaybackMonitor(
  isPlaying: boolean,
  currentVideoTime: number,
  currentAudioTime?: number,
): {
  recordFrame: (renderTimeMs: number, wasDropped?: boolean) => void;
  recordDroppedFrames: (count: number) => void;
  getStats: () => SessionStats;
} {

  // Start/stop monitoring based on playback state
  useEffect(() => {
    if (isPlaying) {
      playbackMonitor.start();
    } else {
      playbackMonitor.stop();
    }

    return () => {
      if (playbackMonitor.active) {
        playbackMonitor.stop();
      }
    };
  }, [isPlaying]);

  // Check drift periodically during playback
  useEffect(() => {
    if (!isPlaying || currentAudioTime === undefined) return;

    playbackMonitor.checkDrift(currentVideoTime, currentAudioTime);
  }, [isPlaying, currentVideoTime, currentAudioTime]);

  // Check memory pressure periodically
  useEffect(() => {
    if (!isPlaying) return;

    const intervalId = setInterval(() => {
      playbackMonitor.checkMemoryPressure();
    }, 5000); // Every 5 seconds

    return () => clearInterval(intervalId);
  }, [isPlaying]);

  return {
    recordFrame: (renderTimeMs: number, wasDropped?: boolean) => {
      playbackMonitor.recordFrame(renderTimeMs, wasDropped);
    },
    recordDroppedFrames: (count: number) => {
      playbackMonitor.recordDroppedFrames(count);
    },
    getStats: () => playbackMonitor.getStats(),
  };
}
