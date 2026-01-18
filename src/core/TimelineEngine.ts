/**
 * TimelineEngine
 *
 * Core playback engine for timeline synchronization.
 * Uses requestAnimationFrame for smooth, accurate timing.
 *
 * Based on patterns from react-timeline-editor but adapted
 * for our architecture with Zustand store integration.
 */

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
  | 'playbackRateChange';

export interface TimelineEngineEvents {
  play: () => void;
  paused: () => void;
  ended: () => void;
  timeUpdate: (data: { time: number }) => void;
  beforeSetTime: (data: { time: number }) => void;
  afterSetTime: (data: { time: number }) => void;
  durationChange: (data: { duration: number }) => void;
  playbackRateChange: (data: { rate: number }) => void;
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
  private _lastTickTime: number = 0;

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
    this._lastTickTime = performance.now();
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
  // Animation Loop
  // ---------------------------------------------------------------------------

  private _startAnimationLoop(): void {
    const tick = (timestamp: number) => {
      if (!this._isPlaying) return;

      this._tick(timestamp);
      this._animationFrameId = requestAnimationFrame(tick);
    };

    this._animationFrameId = requestAnimationFrame(tick);
  }

  private _stopAnimationLoop(): void {
    if (this._animationFrameId !== null) {
      cancelAnimationFrame(this._animationFrameId);
      this._animationFrameId = null;
    }
  }

  /** Internal tick method - exposed for testing */
  _tick(timestamp: number): void {
    const elapsed = timestamp - this._lastTickTime;
    this._lastTickTime = timestamp;

    this._updateTime(elapsed);
  }

  /** Internal time update - exposed for testing */
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

    this._isDisposed = true;
    this._listeners.clear();
    this._syncedStore = null;
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  private _clampTime(time: number): number {
    return Math.max(0, Math.min(this._duration, time));
  }
}
