/**
 * Playback Trace Service
 *
 * Keeps a bounded in-memory history of playback time mutations so
 * timeline/preview desynchronization issues can be diagnosed quickly.
 */

// =============================================================================
// Types
// =============================================================================

export type PlaybackTraceKind = 'seek' | 'time-update' | 'play-state';

export interface PlaybackTraceEntry {
  /** Monotonic sequence number for ordering */
  seq: number;
  /** Event category */
  kind: PlaybackTraceKind;
  /** Source label provided by caller */
  source: string;
  /** Previous playback time (seconds) */
  prevTime: number;
  /** New playback time (seconds) */
  nextTime: number;
  /** Playback state at mutation time */
  isPlaying: boolean;
  /** Wall-clock timestamp (ms) */
  timestampMs: number;
}

// =============================================================================
// Constants
// =============================================================================

const TRACE_CAPACITY = 200;

// =============================================================================
// State
// =============================================================================

let sequence = 0;
const traceBuffer: PlaybackTraceEntry[] = [];

// =============================================================================
// API
// =============================================================================

export function recordPlaybackTrace(
  kind: PlaybackTraceKind,
  source: string,
  prevTime: number,
  nextTime: number,
  isPlaying: boolean,
): void {
  const entry: PlaybackTraceEntry = {
    seq: ++sequence,
    kind,
    source: source || 'unknown',
    prevTime,
    nextTime,
    isPlaying,
    timestampMs: Date.now(),
  };

  traceBuffer.push(entry);
  if (traceBuffer.length > TRACE_CAPACITY) {
    traceBuffer.shift();
  }
}

export function getPlaybackTrace(limit: number = TRACE_CAPACITY): PlaybackTraceEntry[] {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : TRACE_CAPACITY;
  if (safeLimit >= traceBuffer.length) {
    return [...traceBuffer];
  }
  return traceBuffer.slice(traceBuffer.length - safeLimit);
}

export function clearPlaybackTrace(): void {
  traceBuffer.length = 0;
}

/**
 * Testing helper for deterministic assertions.
 */
export function _resetPlaybackTraceForTesting(): void {
  traceBuffer.length = 0;
  sequence = 0;
}

declare global {
  interface Window {
    __OPENREELIO_PLAYBACK_TRACE__?: {
      get: (limit?: number) => PlaybackTraceEntry[];
      clear: () => void;
    };
  }
}

if (typeof window !== 'undefined' && !window.__OPENREELIO_PLAYBACK_TRACE__) {
  window.__OPENREELIO_PLAYBACK_TRACE__ = {
    get: getPlaybackTrace,
    clear: clearPlaybackTrace,
  };
}
