/**
 * Cache Frame Source
 *
 * Pure lookup rules for serving a preview frame out of the render cache instead
 * of re-compositing it live.
 *
 * ## Why cache-first applies to every fresh segment, flagged or not
 *
 * A cached segment file is produced by the export pipeline, so a frame decoded
 * from it *is* the export composite for that instant — not an approximation of
 * it. That makes it strictly better than the live canvas guess even where the
 * live guess is believed faithful: identical picture, no per-clip decode fan-out,
 * one read from an all-keyframe intra file. The `flagged` bit therefore has no
 * say in whether the cache may be used; it only says how wrong the *live*
 * fallback would be when the cache has nothing to offer, which is what drives
 * the DRAFT badge.
 *
 * Freshness is carried by the segment fingerprint rather than by the file path:
 * a re-rendered segment keeps its path but changes its fingerprint, so frame
 * addressing that embeds the fingerprint retires stale entries automatically.
 */

import type { CacheSegmentStatusDto, RenderCacheStatus } from '@/bindings';

/**
 * Slack subtracted from a segment's end when the frame rate is unusable.
 *
 * Only a fallback: with a real frame rate the end clamp is the segment's final
 * stored frame (see {@link cacheFrameOffsetSec}), because the decoder addresses
 * by nearest frame and errors out of range rather than saturating. Without a
 * frame rate there is no frame count to clamp to, so a sliver of a second is
 * taken off the segment's wall-clock length instead.
 */
export const CACHE_SEGMENT_END_EPSILON_SEC = 0.001;

/**
 * The segments of a cache snapshot, but only if it describes `sequenceId`.
 *
 * The status snapshot is refreshed asynchronously, so right after a sequence
 * switch it still describes the sequence that was open a moment ago — and its
 * segment paths point into that sequence's cache directory. Serving a frame
 * from one would put another sequence's picture on screen labelled as the exact
 * composite, which is worse than any live approximation. Every consumer of a
 * snapshot must therefore go through this gate.
 *
 * @param status - Latest cache snapshot, or `null` when none has arrived
 * @param sequenceId - Sequence the caller is drawing, or `null` when there is none
 * @returns The snapshot's segments, or an empty list when it describes something else
 */
export function cacheSegmentsForSequence(
  status: RenderCacheStatus | null,
  sequenceId: string | null,
): readonly CacheSegmentStatusDto[] {
  if (!status || sequenceId === null || status.sequenceId !== sequenceId) {
    return [];
  }

  return status.segmentStates;
}

/**
 * Finds the segment covering `timeSec`, regardless of what it holds.
 *
 * Segments tile the sequence as half-open ranges `[startSec, endSec)`. The one
 * exception is the very end of the timeline: the playhead can park exactly on
 * the final segment's `endSec`, and there is no later segment to own that
 * instant, so it is clamped back into the last segment.
 *
 * @param segments - Per-segment cache status, in any order
 * @param timeSec - Timeline time in seconds
 * @returns The covering segment, or `null` when the time falls outside every segment
 */
export function findSegmentForTime(
  segments: readonly CacheSegmentStatusDto[],
  timeSec: number,
): CacheSegmentStatusDto | null {
  if (!Number.isFinite(timeSec) || segments.length === 0) {
    return null;
  }

  let lastSegment: CacheSegmentStatusDto | null = null;

  for (const segment of segments) {
    if (timeSec >= segment.startSec && timeSec < segment.endSec) {
      return segment;
    }

    if (lastSegment === null || segment.endSec > lastSegment.endSec) {
      lastSegment = segment;
    }
  }

  if (lastSegment !== null && timeSec === lastSegment.endSec) {
    return lastSegment;
  }

  return null;
}

/**
 * Finds the segment covering `timeSec` whose cached file may be drawn from.
 *
 * Only a `cached` segment with an allowlisted path qualifies, and only while no
 * consumer has reported that file unplayable since the last status refresh.
 *
 * @param segments - Per-segment cache status, in any order
 * @param timeSec - Timeline time in seconds
 * @param deadPaths - Cached files a consumer already found unplayable
 * @returns The segment to decode from, or `null` to fall back to the live composite
 */
export function resolveCachedSegmentForTime(
  segments: readonly CacheSegmentStatusDto[],
  timeSec: number,
  deadPaths: ReadonlySet<string>,
): CacheSegmentStatusDto | null {
  const segment = findSegmentForTime(segments, timeSec);
  if (!segment || segment.state !== 'cached') {
    return null;
  }

  const { cachedPath } = segment;
  if (cachedPath === null || deadPaths.has(cachedPath)) {
    return null;
  }

  return segment;
}

/**
 * Builds the frame-buffer asset id a cached segment's file is addressed under.
 *
 * The fingerprint is part of the id on purpose: the frame buffer and its
 * downstream frame cache key on the asset id, so a re-rendered segment (same
 * path, new fingerprint) becomes a different asset and cannot be served a frame
 * decoded from the picture it used to hold.
 *
 * @param sequenceId - Sequence the segment belongs to
 * @param segment - Cached segment being drawn from
 * @returns A frame-buffer asset id unique to this segment revision
 */
export function cacheFrameAssetId(sequenceId: string, segment: CacheSegmentStatusDto): string {
  return `__cache__${sequenceId}_${segment.index}_${segment.fingerprint}`;
}

/**
 * Converts a timeline time into an offset inside a cached segment's file.
 *
 * ## Why the offset goes through the frame grid
 *
 * A segment's declared bounds are wall-clock seconds, but the renderer snaps
 * its window to the frame grid (`round(t * fps)`) and rebases the written file's
 * timestamps to zero. At a non-integer rate — 29.97, 23.976, 59.94 — a bound
 * like 15.000s does not sit on a frame, so file frame 0 is up to half a frame
 * away from `startSec`. Subtracting seconds naively therefore lands on the
 * neighbouring frame for a large share of parked positions in later segments.
 * Differencing the two grid positions instead reproduces exactly the frame the
 * renderer wrote.
 *
 * ## Why the end clamp is the segment's final stored frame
 *
 * The decoder addresses by *nearest* frame and treats an out-of-range index as
 * an error rather than saturating at the last one, and a failed decode retires
 * the whole segment as unplayable. The file holds
 * `round(endSec * fps) - round(startSec * fps)` frames numbered from zero, so
 * the clamp is the offset of the last of them. Clamping to wall-clock seconds
 * instead — the segment's length less half a frame — lands past that frame
 * whenever the length is not a whole number of frames: a 0-5s segment at 25fps
 * holds its last frame at 4.96s, and the seconds clamp would ask for 4.98s.
 *
 * Mirrors `cache_frame_offset_sec` in
 * `src-tauri/src/core/render/frame_probe/timeline.rs`; the two surfaces must
 * agree about which frame of the file an instant addresses.
 *
 * @param segment - Segment covering `timeSec`
 * @param timeSec - Timeline time in seconds
 * @param fps - Sequence frame rate; a non-positive or non-finite value falls
 *   back to a continuous offset with a fixed millisecond of end slack
 * @returns Seconds from the start of the segment file, inside its own duration
 */
export function cacheFrameOffsetSec(
  segment: CacheSegmentStatusDto,
  timeSec: number,
  fps: number,
): number {
  if (!Number.isFinite(fps) || fps <= 0) {
    const durationSec = Math.max(0, segment.endSec - segment.startSec);
    const fallbackLastSec = Math.max(0, durationSec - CACHE_SEGMENT_END_EPSILON_SEC);
    return Math.min(Math.max(0, timeSec - segment.startSec), fallbackLastSec);
  }

  const frameSec = 1 / fps;
  const startFrame = Math.round(segment.startSec * fps);
  // What the renderer wrote: the same grid difference the offset itself is
  // built from, so a segment holding a single frame — or none at all — clamps
  // every request onto the start of the file.
  const storedFrames = Math.round(segment.endSec * fps) - startFrame;
  const lastAddressableSec = Math.max(0, storedFrames - 1) * frameSec;
  const gridOffsetFrames = Math.round(timeSec * fps) - startFrame;

  return Math.min(Math.max(0, gridOffsetFrames * frameSec), lastAddressableSec);
}
