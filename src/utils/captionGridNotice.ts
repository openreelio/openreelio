/**
 * Caption frame-grid notices.
 *
 * Importing generated captions snaps every cue onto the sequence's frame grid
 * by default, and drops the few cues the grid cannot keep in order without
 * dragging them off their own time. Both rewrite what the caller supplied, so
 * the backend reports them instead of doing them silently; these helpers turn
 * that report into the line a user reads.
 */

/**
 * Tauri event the backend emits after an import moved cues onto the frame grid.
 *
 * Keep in sync with the emit in `src-tauri/src/ipc/events.rs`.
 */
export const CAPTION_SNAPPED_TO_FRAME_GRID_EVENT = 'caption:snapped-to-frame-grid';

/** What an import's frame-grid pass did to the cues it was handed. */
export interface CaptionGridNotice {
  /** How many cues were moved onto a different pair of frames. */
  count: number;
  /** How many cues were dropped rather than pushed off their own time. */
  dropped: number;
}

function readCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.trunc(value);
}

/**
 * Reads a `caption:snapped-to-frame-grid` payload.
 *
 * Returns `null` for anything that is not a pair of non-negative counts, and
 * for a notice that reports nothing happened — there is nothing to tell the
 * user then. `dropped` is optional so a backend that predates it still reports.
 */
export function parseCaptionGridNotice(payload: unknown): CaptionGridNotice | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const count = readCount(record.count);
  if (count === null) {
    return null;
  }

  const dropped = record.dropped === undefined ? 0 : readCount(record.dropped);
  if (dropped === null) {
    return null;
  }

  if (count === 0 && dropped === 0) {
    return null;
  }

  return { count, dropped };
}

function cues(count: number): string {
  return count === 1 ? '1 caption' : `${count} captions`;
}

/** The sentence a user sees for a frame-grid notice. */
export function formatCaptionGridNotice(notice: CaptionGridNotice): string {
  const moved = `${cues(notice.count)} moved onto the sequence frame grid`;
  if (notice.dropped === 0) {
    return `${moved}.`;
  }

  const dropped = `${cues(notice.dropped)} dropped: the frame grid could not keep them in order`;
  if (notice.count === 0) {
    return `${dropped}.`;
  }

  return `${moved}; ${dropped}.`;
}
