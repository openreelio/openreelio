/**
 * Navigation for export preflight findings.
 *
 * A warning the user cannot act on is worse than no warning: it names a problem
 * and leaves them to search a timeline for it. Every finding that knows its clip
 * gets a row that puts the playhead on that clip and selects it.
 */

import { useCallback } from 'react';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';

/**
 * Fallback viewport width used to bring the playhead back into view.
 *
 * The dialog has no access to the timeline's measured width, and the keyboard
 * shortcut that scrolls to the playhead already assumes the same figure.
 */
const DEFAULT_TIMELINE_VIEWPORT_WIDTH_PX = 800;

/** Marks the seek so playback listeners can tell where it came from. */
const SEEK_SOURCE = 'export-preflight';

/** Moves the playhead to a clip and selects it. */
export type JumpToClipHandler = (clipId: string, sequenceId?: string | null) => void;

/**
 * Returns a handler that reveals a clip named by an export finding.
 */
export function useExportFindingNavigation(): JumpToClipHandler {
  return useCallback((clipId: string, sequenceId?: string | null) => {
    const projectState = useProjectStore.getState();
    const sequence = sequenceId
      ? (projectState.sequences.get(sequenceId) ?? projectState.getActiveSequence())
      : projectState.getActiveSequence();

    useTimelineStore.getState().selectClip(clipId);

    const clip = sequence?.tracks.flatMap((track) => track.clips).find((c) => c.id === clipId);
    if (!clip) {
      return;
    }

    usePlaybackStore.getState().seek(clip.place.timelineInSec, SEEK_SOURCE);
    useTimelineStore.getState().scrollToPlayhead(DEFAULT_TIMELINE_VIEWPORT_WIDTH_PX);
  }, []);
}
