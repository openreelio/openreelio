/**
 * SetSequenceFormat payload builder
 *
 * The backend payload is flat — `sequenceId` beside the individual fields, with
 * no nested `format` object — and rejects unknown keys, so the shape is built
 * in one place rather than spelled out at every call site.
 */

import type { Ratio } from '@/types';

/**
 * The delivery-format fields `SetSequenceFormat` accepts.
 *
 * Every field is optional and at least one must be given; the omitted ones keep
 * their current value.
 */
export interface SequenceFormatChanges {
  /** New frame rate as an exact ratio, e.g. `{num: 30000, den: 1001}` */
  fps?: Ratio;
  /** New canvas width in pixels (even, 16..=16384) */
  width?: number;
  /** New canvas height in pixels (even, 16..=16384) */
  height?: number;
  /** New audio sample rate in Hz */
  audioSampleRate?: number;
  /** New audio channel count (1 or 2) */
  audioChannels?: number;
}

/**
 * Builds a `SetSequenceFormat` payload from the fields the user changed.
 *
 * Only the requested fields are sent: the backend keeps the rest as they are,
 * so a resolution change never restates a frame rate nobody touched.
 *
 * @param sequenceId Sequence to change
 * @param changes Fields the user asked to change
 * @returns The flat command payload
 */
export function buildSequenceFormatPayload(
  sequenceId: string,
  changes: SequenceFormatChanges,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { sequenceId };

  if (changes.fps !== undefined) {
    payload.fps = changes.fps;
  }
  if (changes.width !== undefined) {
    payload.width = changes.width;
  }
  if (changes.height !== undefined) {
    payload.height = changes.height;
  }
  if (changes.audioSampleRate !== undefined) {
    payload.audioSampleRate = changes.audioSampleRate;
  }
  if (changes.audioChannels !== undefined) {
    payload.audioChannels = changes.audioChannels;
  }

  return payload;
}
