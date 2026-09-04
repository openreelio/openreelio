/**
 * useSequenceFps
 *
 * The single place the UI turns a sequence's stored frame-rate ratio into the
 * number every frame-based control needs. Timeline stepping, playhead snapping
 * and timecode all have to agree with what the renderer will quantise to, so
 * they read the active sequence's `format.fps` rather than a fixed constant.
 */

import { useCallback } from 'react';
import { useProjectStore } from '@/stores/projectStore';
import { DEFAULT_FPS } from '@/constants/precision';
import type { Ratio, Sequence } from '@/types';

/**
 * Lowest rate the editor will follow.
 *
 * `SetSequenceFormat` accepts any rate in `(0, 1000]`, but a grid coarser than
 * one frame per second makes stepping and snapping unusable, so the UI treats
 * such a snapshot as broken rather than rendering a timeline nobody can drive.
 */
const MIN_SEQUENCE_FPS = 1;

/**
 * Highest rate the editor will follow, matching the backend's own bound
 * (`MAX_SEQUENCE_FPS` in `src-tauri/src/core/timeline/models.rs`).
 */
const MAX_SEQUENCE_FPS = 1000;

/**
 * Converts a stored frame-rate ratio into frames per second.
 *
 * @param fps Sequence frame rate as `{num, den}`, if the sequence declares one
 * @returns The rate in frames per second, or {@link DEFAULT_FPS} when the ratio
 *   is missing or not a usable positive rate (a zero denominator, a snapshot
 *   written with a broken timebase, or a rate outside the
 *   `[MIN_SEQUENCE_FPS, MAX_SEQUENCE_FPS]` range the backend would accept)
 */
export function resolveSequenceFps(fps: Ratio | null | undefined): number {
  if (!fps) {
    return DEFAULT_FPS;
  }

  const { num, den } = fps;
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) {
    return DEFAULT_FPS;
  }

  const rate = num / den;
  if (rate < MIN_SEQUENCE_FPS || rate > MAX_SEQUENCE_FPS) {
    return DEFAULT_FPS;
  }

  return rate;
}

/**
 * Reads the frame rate the active sequence declares, as a plain number.
 *
 * The selector returns a number rather than the ratio object, so a store update
 * that leaves the rate alone never re-renders the consumer.
 */
function selectActiveSequenceFps(state: ReturnType<typeof useProjectStore.getState>): number {
  const { activeSequenceId } = state;
  if (!activeSequenceId) {
    return DEFAULT_FPS;
  }

  return resolveSequenceFps(state.sequences.get(activeSequenceId)?.format.fps);
}

/**
 * Frames per second the frame-based timeline controls should use.
 *
 * @param sequence Sequence to read instead of the active one. Components that
 *   already receive the sequence they are editing pass it, so the fps never
 *   lags the props they render from; omitting it falls back to the project's
 *   active sequence.
 * @returns The sequence frame rate, or {@link DEFAULT_FPS} when there is no
 *   sequence or its ratio is unusable
 *
 * @remarks
 * The selector is gated on `sequence` rather than always reading the active
 * one: a caller that supplies its own sequence should not re-render because a
 * different sequence became active.
 */
export function useSequenceFps(sequence?: Sequence | null): number {
  const selectFps = useCallback(
    (state: ReturnType<typeof useProjectStore.getState>): number =>
      sequence ? resolveSequenceFps(sequence.format.fps) : selectActiveSequenceFps(state),
    [sequence],
  );

  return useProjectStore(selectFps);
}
