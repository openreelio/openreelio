/**
 * Playhead Backend Sync
 *
 * Keeps backend runtime playback state aligned with frontend playhead updates.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type Event as TauriEvent, type UnlistenFn } from '@tauri-apps/api/event';
import { PLAYBACK_EVENTS, type PlaybackSeekEventDetail, usePlaybackStore } from '@/stores/playbackStore';
import { createLogger } from './logger';

const logger = createLogger('PlayheadBackendSync');

const PLAYHEAD_SYNC_COMMAND = 'set_playhead_position';
const PLAYBACK_CHANGED_EVENT = 'playback:changed';
const DEFAULT_SYNC_INTERVAL_MS = 120;
const MIN_SYNC_INTERVAL_MS = 16;
const POSITION_EPSILON_SEC = 1 / 240;
const LOCAL_SYNC_SOURCE_PREFIX = 'playhead-backend-sync:';
const BACKEND_SOURCE_PREFIXES = ['backend:', LOCAL_SYNC_SOURCE_PREFIX];
const BACKEND_APPLY_SOURCE = 'backend:playback-changed';

export interface PlayheadBackendSyncOptions {
  /** Resolve current active sequence ID at sync time */
  getSequenceId?: () => string | null | undefined;
  /** Minimum interval between playback tick sync calls */
  syncIntervalMs?: number;
}

interface SetPlayheadPositionPayload {
  positionSec: number;
  sequenceId: string | null;
  source: string;
  isPlaying: boolean;
  durationSec: number | null;
}

type SyncSnapshot = Omit<SetPlayheadPositionPayload, 'source'>;

interface PlayheadChangedEventPayload {
  positionSec?: number;
  sequenceId?: string | null;
  source?: string | null;
  isPlaying?: boolean;
  durationSec?: number | null;
  updatedAt?: string;
}

let activeStop: (() => void) | null = null;

function isTauriRuntime(): boolean {
  const isVitest =
    typeof process !== 'undefined' &&
    typeof process.env !== 'undefined' &&
    typeof process.env.VITEST !== 'undefined';

  if (isVitest) return true;

  return (
    typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'
  );
}

function sanitizeIntervalMs(value?: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_SYNC_INTERVAL_MS;
  }
  return Math.max(MIN_SYNC_INTERVAL_MS, Math.floor(value as number));
}

function normalizeOptionalSequenceId(sequenceId: string | null | undefined): string | null {
  if (typeof sequenceId !== 'string') return null;
  const trimmed = sequenceId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDuration(duration: number): number | null {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return duration;
}

function normalizeIncomingDuration(duration: unknown): number | null {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
    return null;
  }
  return duration;
}

function normalizePosition(time: number, duration: number | null): number {
  const normalized = Number.isFinite(time) ? Math.max(0, time) : 0;
  if (duration === null) return normalized;
  return Math.min(normalized, duration);
}

function normalizeSource(source: unknown, fallback: string): string {
  if (typeof source !== 'string') return fallback;
  const trimmed = source.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeUpdatedAtMs(updatedAt: unknown): number | null {
  if (typeof updatedAt !== 'string' || updatedAt.trim().length === 0) {
    return null;
  }
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isBackendSource(source: string): boolean {
  return BACKEND_SOURCE_PREFIXES.some((prefix) => source.startsWith(prefix));
}

function toOutboundSource(source: string): string {
  if (source.startsWith(LOCAL_SYNC_SOURCE_PREFIX)) {
    return source;
  }
  return `${LOCAL_SYNC_SOURCE_PREFIX}${source}`;
}

function isLocalSyncEchoSource(source: string): boolean {
  return source.startsWith(LOCAL_SYNC_SOURCE_PREFIX);
}

function equalOptionalNumber(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= POSITION_EPSILON_SEC;
}

function equalSnapshot(a: SyncSnapshot | null, b: SyncSnapshot): boolean {
  if (a === null) return false;
  return (
    Math.abs(a.positionSec - b.positionSec) <= POSITION_EPSILON_SEC &&
    a.sequenceId === b.sequenceId &&
    a.isPlaying === b.isPlaying &&
    equalOptionalNumber(a.durationSec, b.durationSec)
  );
}

function buildSnapshot(getSequenceId?: () => string | null | undefined): SyncSnapshot {
  const playback = usePlaybackStore.getState();
  const durationSec = normalizeDuration(playback.duration);
  const sequenceId = normalizeOptionalSequenceId(getSequenceId?.());

  return {
    positionSec: normalizePosition(playback.currentTime, durationSec),
    sequenceId,
    isPlaying: playback.isPlaying,
    durationSec,
  };
}

export function stopPlayheadBackendSync(): void {
  activeStop?.();
}

export function startPlayheadBackendSync(options: PlayheadBackendSyncOptions = {}): () => void {
  stopPlayheadBackendSync();

  if (!isTauriRuntime()) {
    activeStop = null;
    return () => {};
  }

  const syncIntervalMs = sanitizeIntervalMs(options.syncIntervalMs);
  const getSequenceId = options.getSequenceId;

  let disposed = false;
  let inFlight = false;
  let pending: { source: string; force: boolean } | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSentAtMs = 0;
  let lastSnapshot: SyncSnapshot | null = null;
  let lastInboundUpdatedAtMs = 0;
  let isApplyingBackendPatch = false;
  let remoteUnlisten: UnlistenFn | null = null;

  const clearPendingTimer = (): void => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };

  const flush = async (source: string, force: boolean): Promise<void> => {
    if (disposed) return;

    if (inFlight) {
      pending = { source, force: force || pending?.force || false };
      return;
    }

    const snapshot = buildSnapshot(getSequenceId);
    if (!force && equalSnapshot(lastSnapshot, snapshot)) {
      return;
    }

    inFlight = true;
    try {
      const payload: SetPlayheadPositionPayload = {
        ...snapshot,
        source: toOutboundSource(source),
      };
      await invoke(PLAYHEAD_SYNC_COMMAND, { payload });
      lastSnapshot = snapshot;
      lastSentAtMs = Date.now();
    } catch (error) {
      logger.warn('Failed to sync playhead state to backend', { error, source });
    } finally {
      inFlight = false;
      if (pending !== null) {
        const next = pending;
        pending = null;
        await flush(next.source, next.force);
      }
    }
  };

  const schedule = (source: string, force = false): void => {
    if (disposed) return;

    if (force) {
      clearPendingTimer();
      void flush(source, true);
      return;
    }

    const elapsed = Date.now() - lastSentAtMs;
    if (lastSentAtMs === 0 || elapsed >= syncIntervalMs) {
      void flush(source, false);
      return;
    }

    if (pendingTimer !== null) {
      return;
    }

    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void flush(source, false);
    }, syncIntervalMs - elapsed);
  };

  const handleSeek = (event: Event): void => {
    const detail = (event as CustomEvent<PlaybackSeekEventDetail>).detail;
    const source = normalizeSource(detail?.source, 'playback-seek');
    if (isBackendSource(source)) {
      return;
    }
    schedule(source, true);
  };

  const applyBackendPayload = (payload: PlayheadChangedEventPayload): void => {
    if (disposed) return;

    const durationRaw = normalizeIncomingDuration(payload.durationSec);
    const durationSec = durationRaw !== null && durationRaw > 0 ? durationRaw : null;
    const positionSec = normalizePosition(
      payload.positionSec ?? 0,
      durationSec ?? normalizeDuration(usePlaybackStore.getState().duration),
    );
    const sequenceId = normalizeOptionalSequenceId(payload.sequenceId ?? null);
    const source = normalizeSource(payload.source, BACKEND_APPLY_SOURCE);

    // Ignore echoes of our own outbound sync writes.
    if (isLocalSyncEchoSource(source)) {
      return;
    }
    const updatedAtMs = normalizeUpdatedAtMs(payload.updatedAt);

    // Guard against stale out-of-order backend events.
    if (updatedAtMs !== null && updatedAtMs < lastInboundUpdatedAtMs) {
      return;
    }
    if (updatedAtMs !== null) {
      lastInboundUpdatedAtMs = updatedAtMs;
    }

    const activeSequenceId = normalizeOptionalSequenceId(getSequenceId?.());
    if (activeSequenceId && sequenceId && activeSequenceId !== sequenceId) {
      return;
    }

    const localSnapshot = buildSnapshot(getSequenceId);
    const targetSnapshot: SyncSnapshot = {
      positionSec: normalizePosition(positionSec, durationSec),
      sequenceId,
      isPlaying:
        typeof payload.isPlaying === 'boolean'
          ? payload.isPlaying
          : usePlaybackStore.getState().isPlaying,
      durationSec,
    };

    if (equalSnapshot(localSnapshot, targetSnapshot)) {
      return;
    }

    isApplyingBackendPatch = true;
    try {
      const storeBefore = usePlaybackStore.getState();

      if (durationRaw !== null && Math.abs(storeBefore.duration - durationRaw) > POSITION_EPSILON_SEC) {
        storeBefore.setDuration(durationRaw);
      }

      const storeAfterDuration = usePlaybackStore.getState();
      const clampedPosition = normalizePosition(
        targetSnapshot.positionSec,
        normalizeDuration(storeAfterDuration.duration),
      );

      if (Math.abs(storeAfterDuration.currentTime - clampedPosition) > POSITION_EPSILON_SEC) {
        storeAfterDuration.setCurrentTime(clampedPosition, source);
      }

      const storeAfterTime = usePlaybackStore.getState();
      if (typeof payload.isPlaying === 'boolean' && storeAfterTime.isPlaying !== payload.isPlaying) {
        storeAfterTime.setIsPlaying(payload.isPlaying, source);
      }
    } finally {
      isApplyingBackendPatch = false;
    }
  };

  const unsubscribe = usePlaybackStore.subscribe((state, previousState) => {
    if (disposed || isApplyingBackendPatch) return;

    const timeChanged = Math.abs(state.currentTime - previousState.currentTime) > POSITION_EPSILON_SEC;
    const durationChanged = Math.abs(state.duration - previousState.duration) > POSITION_EPSILON_SEC;
    const isPlayingChanged = state.isPlaying !== previousState.isPlaying;

    if (durationChanged || isPlayingChanged) {
      schedule('playback-state-change', true);
      return;
    }

    if (timeChanged) {
      schedule(state.isPlaying ? 'playback-tick' : 'playback-time-change', false);
    }
  });

  window.addEventListener(PLAYBACK_EVENTS.SEEK, handleSeek);
  void listen<PlayheadChangedEventPayload>(
    PLAYBACK_CHANGED_EVENT,
    (event: TauriEvent<PlayheadChangedEventPayload>) => {
      applyBackendPayload(event.payload ?? {});
    },
  )
    .then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }
      remoteUnlisten = unlisten;
    })
    .catch((error) => {
      logger.warn('Failed to subscribe to backend playback:changed event', { error });
    });

  schedule('playhead-sync-start', true);

  const stop = (): void => {
    if (disposed) return;
    disposed = true;

    clearPendingTimer();
    unsubscribe();
    window.removeEventListener(PLAYBACK_EVENTS.SEEK, handleSeek);
    remoteUnlisten?.();
    remoteUnlisten = null;

    if (activeStop === stop) {
      activeStop = null;
    }
  };

  activeStop = stop;
  return stop;
}

export function _resetPlayheadBackendSyncForTesting(): void {
  stopPlayheadBackendSync();
}
