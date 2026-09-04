/**
 * useSequenceFps
 *
 * The single place the UI turns a sequence's stored frame-rate ratio into the
 * number every frame-based control needs. Timeline stepping, playhead snapping
 * and timecode all have to agree with what the renderer will quantise to, so
 * they read the active sequence's `format.fps` rather than a fixed constant.
 */

import { useProjectStore } from '@/stores/projectStore';
import { DEFAULT_FPS } from '@/constants/precision';
import type { Ratio, Sequence } from '@/types';

/**
 * Converts a stored frame-rate ratio into frames per second.
 *
 * @param fps Sequence frame rate as `{num, den}`, if the sequence declares one
 * @returns The rate in frames per second, or {@link DEFAULT_FPS} when the ratio
 *   is missing or not a usable positive rate (a zero denominator, a snapshot
 *   written with a broken timebase)
 */
export function resolveSequenceFps(fps: Ratio | null | undefined): number {
  if (!fps) {
    return DEFAULT_FPS;
  }

  const { num, den } = fps;
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) {
    return DEFAULT_FPS;
  }

  return num / den;
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

  return resolveSequenceFps(state.sequences.get(activeSequenceId)?.format?.fps);
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
 */
export function useSequenceFps(sequence?: Sequence | null): number {
  const activeFps = useProjectStore(selectActiveSequenceFps);
  return sequence ? resolveSequenceFps(sequence.format?.fps) : activeFps;
}
