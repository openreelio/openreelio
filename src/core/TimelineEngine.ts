/**
 * TimelineEngine
 *
 * Core playback engine for timeline synchronization.
 * Uses requestAnimationFrame for smooth, accurate timing with automatic
 * fallback to setTimeout when tab is backgrounded.
 *
 * Based on patterns from react-timeline-editor and Remotion's use-playback.ts.
 *
 * Key Features:
 * - Absolute time tracking to prevent floating-point drift
 * - Background tab handling (RAF throttles to ~1fps when backgrounded)
 * - Frame-rate independent timing via delta time
 * - Zustand store integration
 */

import { createLogger } from '@/services/logger';

const logger = createLogger('TimelineEngine');

// =============================================================================
// Types
// =============================================================================

export type TimelineEventType =
  | 'play'
  | 'paused'
  | 'ended'
  | 'timeUpdate'
  | 'beforeSetTime'
  | 'afterSetTime'
  | 'durationChange'
  | 'playbackRateChange'
  | 'visibilityChange';

export interface TimelineEngineEvents {
  play: () => void;
  paused: () => void;
  ended: () => void;
  timeUpdate: (data: { time: number }) => void;
  beforeSetTime: (data: { time: number }) => void;
  afterSetTime: (data: { time: number }) => void;
  durationChange: (data: { duration: number }) => void;
  playbackRateChange: (data: { rate: number }) => void;
  visibilityChange: (data: { isBackgrounded: boolean }) => void;
}

export interface TimelineEngineConfig {
  /** Initial duration in seconds */
  duration?: number;
  /** Initial playback rate */
  playbackRate?: number;
  /** Whether to loop playback */
  loop?: boolean;
}

export interface PlaybackStore {
  setCurrentTime: (time: number) => void;
  setIsPlaying: (isPlaying: boolean) => void;
  setDuration: (duration: number) => void;
}

type TimelineEngineListener = TimelineEngineEvents[TimelineEventType];

type TimelineEventWithPayload = {
  [K in TimelineEventType]: Parameters<TimelineEngineEvents[K]> extends []
    ? never
    : K;
}[TimelineEventType];

type TimelineEventWithoutPayload = Exclude<
  TimelineEventType,
  TimelineEventWithPayload
>;

// =============================================================================
// Constants
// =============================================================================

const MIN_PLAYBACK_RATE = 0.25;
const MAX_PLAYBACK_RATE = 4;

// =============================================================================
// TimelineEngine Class
// =============================================================================

export class TimelineEngine {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  private _isPlaying: boolean = false;
  private _currentTime: number = 0;
  private _duration: number = 0;
  private _playbackRate: number = 1;
  private _loop: boolean = false;

  // ---------------------------------------------------------------------------
  // Animation Frame
  // ---------------------------------------------------------------------------

  private _animationFrameId: number | null = null;
  /** setTimeout ID for background tab fallback */
  private _timeoutId: ReturnType<typeof setTimeout> | null = null;

  // ---------------------------------------------------------------------------
  // Absolute Time Tracking (prevents floating-point drift)
  // ---------------------------------------------------------------------------

  /** Timestamp (performance.now) when playback started */
  private _playStartTime: number = 0;
  /** Timeline position when playback started */
  private _playStartPosition: number = 0;

  // ---------------------------------------------------------------------------
  // Background Tab Handling
  // ---------------------------------------------------------------------------

  /** Whether the tab is currently backgrounded */
  private _isBackgrounded: boolean = false;
  /** Bound visibility change handler for cleanup */
  private _visibilityHandler: (() => void) | null = null;
  /** Target frame time for background setTimeout (ms) */
  private readonly _backgroundFrameTimeMs: number = 1000 / 60;

  // ---------------------------------------------------------------------------
  // Event System
  // ---------------------------------------------------------------------------

  private _listeners: Map<TimelineEventType, Set<TimelineEngineListener>> =
    new Map();

  // ---------------------------------------------------------------------------
  // Store Sync
  // ---------------------------------------------------------------------------

  private _syncedStore: PlaybackStore | null = null;
  private _isDisposed: boolean = false;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor(config?: TimelineEngineConfig) {
    if (config?.duration !== undefined) {
      this._duration = config.duration;
    }
    if (config?.playbackRate !== undefined) {
      this._playbackRate = this._clampPlaybackRate(config.playbackRate);
    }
    if (config?.loop !== undefined) {
      this._loop = config.loop;
    }

    // Initialize background tab handling
    this._setupVisibilityHandling();
  }

  // ---------------------------------------------------------------------------
  // Background Tab Handling Setup
  // ---------------------------------------------------------------------------

  /**
   * Sets up visibility change detection for background tab handling.
   * When tab is backgrounded, requestAnimationFrame is throttled to ~1fps,
   * so we switch to setTimeout for consistent playback timing.
   */
  private _setupVisibilityHandling(): void {
    if (typeof document === 'undefined') return;

    this._isBackgrounded = document.hidden;

    this._visibilityHandler = () => {
      const wasBackgrounded = this._isBackgrounded;
      this._isBackgrounded = document.hidden;

      // Only act on change
      if (wasBackgrounded !== this._isBackgrounded) {
        logger.debug('Visibility changed', { isBackgrounded: this._isBackgrounded });
        this._emit('visibilityChange', { isBackgrounded: this._isBackgrounded });

        // Restart playback loop with appropriate scheduler if playing
        if (this._isPlaying) {
          this._stopAnimationLoop();

          // Reset start time to prevent time jumps
          this._playStartTime = performance.now();
          this._playStartPosition = this._currentTime;

          this._startAnimationLoop();
        }
      }
    };

    document.addEventListener('visibilitychange', this._visibilityHandler);
  }

  // ---------------------------------------------------------------------------
  // Getters
  // ---------------------------------------------------------------------------

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  get currentTime(): number {
    return this._currentTime;
  }

  get duration(): number {
    return this._duration;
  }

  get playbackRate(): number {
    return this._playbackRate;
  }

  get loop(): boolean {
    return this._loop;
  }

  // ---------------------------------------------------------------------------
  // Play/Pause
  // ---------------------------------------------------------------------------

  play(): void {
    if (this._isDisposed) return;
    if (this._isPlaying) return;
    if (this._duration <= 0) return;
    if (this._currentTime >= this._duration) return;

    this._isPlaying = true;
    // Record playback start point for absolute time calculation
    this._playStartTime = performance.now();
    this._playStartPosition = this._currentTime;
    this._startAnimationLoop();
    this._emit('play');
    this._syncedStore?.setIsPlaying(true);
  }

  pause(): void {
    if (this._isDisposed) return;
    if (!this._isPlaying) return;

    this._isPlaying = false;
    this._stopAnimationLoop();
    this._emit('paused');
    this._syncedStore?.setIsPlaying(false);
  }

  togglePlayback(): void {
    if (this._isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  // ---------------------------------------------------------------------------
  // Seeking
  // ---------------------------------------------------------------------------

  seek(time: number): void {
    if (this._isDisposed) return;

    const clampedTime = this._clampTime(time);
    this._emit('beforeSetTime', { time: clampedTime });

    this._currentTime = clampedTime;
    this._syncedStore?.setCurrentTime(clampedTime);

    // Reset start point if playing to maintain accurate absolute time tracking
    if (this._isPlaying) {
      this._playStartTime = performance.now();
      this._playStartPosition = clampedTime;
    }

    this._emit('afterSetTime', { time: clampedTime });

    // Stop if seeking to end
    if (clampedTime >= this._duration && this._isPlaying) {
      this.pause();
    }
  }

  seekForward(amount: number): void {
    this.seek(this._currentTime + amount);
  }

  seekBackward(amount: number): void {
    this.seek(this._currentTime - amount);
  }

  goToStart(): void {
    this.seek(0);
  }

  goToEnd(): void {
    this.seek(this._duration);
  }

  stepForward(fps: number): void {
    if (fps <= 0) return;
    const frameTime = 1 / fps;
    this.seek(this._currentTime + frameTime);
  }

  stepBackward(fps: number): void {
    if (fps <= 0) return;
    const frameTime = 1 / fps;
    this.seek(this._currentTime - frameTime);
  }

  // ---------------------------------------------------------------------------
  // Duration
  // ---------------------------------------------------------------------------

  setDuration(duration: number): void {
    if (this._isDisposed) return;

    this._duration = Math.max(0, duration);
    this._syncedStore?.setDuration(this._duration);
    this._emit('durationChange', { duration: this._duration });

    // Clamp current time if needed
    if (this._currentTime > this._duration) {
      this.seek(this._duration);
    }
  }

  // ---------------------------------------------------------------------------
  // Playback Rate
  // ---------------------------------------------------------------------------

  setPlaybackRate(rate: number): void {
    if (this._isDisposed) return;

    // Reset start point when rate changes to prevent time jump
    if (this._isPlaying) {
      this._playStartTime = performance.now();
      this._playStartPosition = this._currentTime;
    }

    this._playbackRate = this._clampPlaybackRate(rate);
    this._emit('playbackRateChange', { rate: this._playbackRate });
  }

  private _clampPlaybackRate(rate: number): number {
    return Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, rate));
  }

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------

  setLoop(loop: boolean): void {
    this._loop = loop;
  }

  toggleLoop(): void {
    this._loop = !this._loop;
  }

  // ---------------------------------------------------------------------------
  // Animation Loop with Background Tab Support
  // ---------------------------------------------------------------------------

  /**
   * Starts the playback animation loop.
   * Uses requestAnimationFrame for active tabs, setTimeout for background tabs.
   * This ensures consistent playback timing regardless of tab visibility.
   */
  private _startAnimationLoop(): void {
    if (this._isBackgrounded) {
      // Use setTimeout in background (RAF is throttled to ~1fps)
      this._startBackgroundLoop();
    } else {
      // Use RAF for smooth animation in foreground
      this._startForegroundLoop();
    }
  }

  /**
   * Foreground loop using requestAnimationFrame for smooth 60fps playback.
   */
  private _startForegroundLoop(): void {
    const tick = (timestamp: number) => {
      if (!this._isPlaying) return;

      this._tick(timestamp);

      // Check if we should continue with RAF or switch to setTimeout
      if (this._isBackgrounded) {
        this._animationFrameId = null;
        this._startBackgroundLoop();
      } else {
        this._animationFrameId = requestAnimationFrame(tick);
      }
    };

    this._animationFrameId = requestAnimationFrame(tick);
  }

  /**
   * Background loop using setTimeout for consistent timing when tab is hidden.
   * Browsers throttle RAF to ~1fps for hidden tabs, but setTimeout continues normally.
   */
  private _startBackgroundLoop(): void {
    const tick = () => {
      if (!this._isPlaying) return;

      this._tick(performance.now());

      // Check if we should continue with setTimeout or switch to RAF
      if (!this._isBackgrounded) {
        this._timeoutId = null;
        this._startForegroundLoop();
      } else {
        this._timeoutId = setTimeout(tick, this._backgroundFrameTimeMs);
      }
    };

    this._timeoutId = setTimeout(tick, this._backgroundFrameTimeMs);
  }

  /**
   * Stops both RAF and setTimeout loops.
   */
  private _stopAnimationLoop(): void {
    if (this._animationFrameId !== null) {
      cancelAnimationFrame(this._animationFrameId);
      this._animationFrameId = null;
    }

    if (this._timeoutId !== null) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
  }

  /** Internal tick method - exposed for testing */
  _tick(timestamp: number): void {
    if (!this._isPlaying) return;

    // Use absolute time calculation to prevent floating-point drift.
    // Instead of accumulating elapsed time each frame (which causes drift),
    // we calculate time directly from the playback start point.
    const elapsedSinceStart = timestamp - this._playStartTime;
    const elapsedSeconds = (elapsedSinceStart / 1000) * this._playbackRate;
    let newTime = this._playStartPosition + elapsedSeconds;

    // Handle end of playback
    if (newTime >= this._duration) {
      if (this._loop) {
        // Reset start point for loop to prevent drift accumulation
        const loopedTime = newTime % this._duration;
        this._playStartTime = timestamp;
        this._playStartPosition = loopedTime;
        newTime = loopedTime;
      } else {
        // Stop at end
        newTime = this._duration;
        this._currentTime = newTime;
        this._syncedStore?.setCurrentTime(newTime);
        this._emit('timeUpdate', { time: newTime });
        this.pause();
        this._emit('ended');
        return;
      }
    }

    this._currentTime = newTime;
    this._syncedStore?.setCurrentTime(newTime);
    this._emit('timeUpdate', { time: newTime });
  }

  /** Internal time update - exposed for testing (legacy cumulative method) */
  _updateTime(elapsedMs: number): void {
    if (!this._isPlaying) return;

    const elapsedSeconds = (elapsedMs / 1000) * this._playbackRate;
    let newTime = this._currentTime + elapsedSeconds;

    // Handle end of playback
    if (newTime >= this._duration) {
      if (this._loop) {
        // Loop back
        newTime = newTime % this._duration;
      } else {
        // Stop at end
        newTime = this._duration;
        this._currentTime = newTime;
        this._syncedStore?.setCurrentTime(newTime);
        this._emit('timeUpdate', { time: newTime });
        this.pause();
        this._emit('ended');
        return;
      }
    }

    this._currentTime = newTime;
    this._syncedStore?.setCurrentTime(newTime);
    this._emit('timeUpdate', { time: newTime });
  }

  // ---------------------------------------------------------------------------
  // Event System
  // ---------------------------------------------------------------------------

  on<K extends TimelineEventType>(
    event: K,
    callback: TimelineEngineEvents[K]
  ): void {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set<TimelineEngineListener>());
    }
    this._listeners.get(event)!.add(callback);
  }

  off<K extends TimelineEventType>(
    event: K,
    callback: TimelineEngineEvents[K]
  ): void {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.delete(callback);
    }
  }

  private _emit<K extends TimelineEventWithoutPayload>(event: K): void;
  private _emit<K extends TimelineEventWithPayload>(
    event: K,
    data: Parameters<TimelineEngineEvents[K]>[0]
  ): void;
  private _emit(event: TimelineEventType, data?: unknown): void {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.forEach((callback) => {
        if (data === undefined) {
          (callback as () => void)();
          return;
        }

        (callback as (payload: unknown) => void)(data);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Store Synchronization
  // ---------------------------------------------------------------------------

  syncWithStore(store: PlaybackStore): void {
    this._syncedStore = store;

    // Only sync duration from engine to store
    // Current time and isPlaying are controlled by the store
    store.setDuration(this._duration);
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  dispose(): void {
    // Stop playback before setting disposed flag
    if (this._isPlaying) {
      this._isPlaying = false;
      this._stopAnimationLoop();
      this._emit('paused');
    }

    // Remove visibility change listener
    if (this._visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }

    this._isDisposed = true;
    this._listeners.clear();
    this._syncedStore = null;

    logger.debug('TimelineEngine disposed');
  }

  // ---------------------------------------------------------------------------
  // Getters for Background State
  // ---------------------------------------------------------------------------

  /**
   * Returns whether the tab is currently backgrounded.
   */
  get isBackgrounded(): boolean {
    return this._isBackgrounded;
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  private _clampTime(time: number): number {
    return Math.max(0, Math.min(this._duration, time));
  }
}
