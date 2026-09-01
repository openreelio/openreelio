/**
 * useIdleCacheFill — Fills the preview render cache while the editor is idle.
 *
 * ## What it does
 *
 * After an edit settles (no further project mutation for {@link IDLE_FILL_DELAY_MS}),
 * it asks the backend to render the *flagged* segments: the stretches the live
 * preview cannot draw faithfully, where what the user sees and what the export
 * produces disagree. Filling those replaces a guess with the real composite.
 *
 * ## Why it is not playhead-driven
 *
 * Scrubbing and `currentTime` are deliberately not inputs. Flag-driven caching
 * buys *accuracy*, not smoothness, and a segment is wrong wherever it sits on
 * the timeline — so the fill is playhead-independent. Subscribing to the
 * playhead would also restart the debounce on every animation frame.
 *
 * ## Playback gates, it does not cancel
 *
 * A fill that comes due during playback stays pending rather than being
 * dropped: rendering while frames are being served would compete for the same
 * decoder. It runs as soon as playback stops.
 *
 * ## Warm-up
 *
 * A sequence becoming active arms one fill per activation, through the same
 * timer and the same playback gate. Without it a user who opens a project and
 * only reviews it would never get a background fill — there is no manual fill
 * control in the UI — and its flagged stretches would stay red forever.
 * "Per activation" rather than per sequence: leaving a sequence and coming
 * back arms another warm-up, since the cache may have been evicted meanwhile.
 *
 * Mount this exactly once, at the editor root.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useProjectStore, usePlaybackStore, useSettingsStore } from '@/stores';
import { useRenderCacheStore } from '@/stores/renderCacheStore';
import { isDesktopRuntimeAvailable } from '@/services/runtimeEnvironment';

/** How long the project must stay unchanged before a fill is triggered. */
export const IDLE_FILL_DELAY_MS = 2000;

/**
 * Schedules a debounced, idle-time fill of the flagged preview cache segments.
 */
export function useIdleCacheFill(): void {
  const stateVersion = useProjectStore((state) => state.stateVersion);
  const activeSequenceId = useProjectStore((state) => state.activeSequenceId);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const enabled = useSettingsStore((state) => state.settings.performance.backgroundRenderCache);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A fill is owed but has not run yet. */
  const pendingRef = useRef(false);
  /** The debounce already elapsed; only playback is holding the fill back. */
  const elapsedRef = useRef(false);
  /**
   * The last project version this hook acted on.
   *
   * Seeded from the first render, so version churn alone never triggers a
   * fill — only a version the hook has not acted on yet does. The warm-up
   * below is what covers the "opened a project, made no edit" case.
   */
  const lastVersionRef = useRef<number>(stateVersion);
  /**
   * The sequence whose warm-up has already been armed.
   *
   * Compared against the active sequence rather than counted, so a rerender
   * that changes nothing re-arms nothing and each activation of a sequence
   * arms exactly one warm-up.
   */
  const warmedSequenceRef = useRef<string | null>(null);
  /**
   * The sequence whose last fill failed.
   *
   * A fill that keeps failing must not be retried on every idle window: the
   * error reaches no blocking UI, so an automatic retry loop would be
   * invisible and unbounded. Only a real edit (a new `stateVersion`) arms
   * another attempt.
   */
  const failedSequenceRef = useRef<string | null>(null);

  const cancelPending = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = false;
    elapsedRef.current = false;
    // The armed warm-up is being dropped, so let it arm again if the hook
    // becomes eligible once more (the toggle is switched back on, say).
    warmedSequenceRef.current = null;
  }, []);

  const runFill = useCallback((sequenceId: string): void => {
    pendingRef.current = false;
    elapsedRef.current = false;
    void useRenderCacheStore
      .getState()
      .renderCache('flagged')
      .then(() => {
        if (useRenderCacheStore.getState().error !== null) {
          failedSequenceRef.current = sequenceId;
        }
      });
  }, []);

  useEffect(() => {
    if (!isDesktopRuntimeAvailable() || !activeSequenceId || !enabled) {
      cancelPending();
      return;
    }

    const alreadyFailed = failedSequenceRef.current === activeSequenceId;
    const needsWarmUp = !alreadyFailed && warmedSequenceRef.current !== activeSequenceId;
    const wasEdited = lastVersionRef.current !== stateVersion;
    if (!needsWarmUp && !wasEdited) {
      return;
    }
    if (wasEdited) {
      failedSequenceRef.current = null;
    }
    warmedSequenceRef.current = activeSequenceId;
    lastVersionRef.current = stateVersion;

    // A warm-up goes through the same timer and the same playback gate as an
    // edit: there is no immediate-fire path to keep in sync.
    pendingRef.current = true;
    elapsedRef.current = false;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      elapsedRef.current = true;
      // Read playback live: the timer outlives the render that scheduled it.
      if (usePlaybackStore.getState().isPlaying) {
        return;
      }
      runFill(activeSequenceId);
    }, IDLE_FILL_DELAY_MS);
  }, [stateVersion, activeSequenceId, enabled, cancelPending, runFill]);

  useEffect(() => {
    if (isPlaying || !enabled || !activeSequenceId) {
      return;
    }
    if (!pendingRef.current || !elapsedRef.current) {
      return;
    }
    runFill(activeSequenceId);
  }, [isPlaying, enabled, activeSequenceId, runFill]);

  useEffect(() => {
    // Full cancel, not just a clearTimeout: leaving the armed-warm-up mark set
    // while dropping the timer would make a remount (React StrictMode does one
    // on every dev mount) see the warm-up as already handled and never re-arm
    // a timer for it.
    return cancelPending;
  }, [cancelPending]);
}
