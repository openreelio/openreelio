/**
 * Timeline Component
 *
 * Main timeline container that integrates all timeline elements.
 */

import { useCallback, type KeyboardEvent, type MouseEvent } from 'react';
import type { Sequence, Clip as ClipType } from '@/types';
import { useTimelineStore } from '@/stores/timelineStore';
import { TimeRuler } from './TimeRuler';
import { Track } from './Track';
import { Playhead } from './Playhead';

// =============================================================================
// Types
// =============================================================================

interface TimelineProps {
  /** Sequence to display */
  sequence: Sequence | null;
  /** Callback when clips should be deleted */
  onDeleteClips?: (clipIds: string[]) => void;
}

// =============================================================================
// Component
// =============================================================================

export function Timeline({ sequence, onDeleteClips }: TimelineProps) {
  // Get timeline state from store
  const {
    playhead,
    isPlaying,
    zoom,
    scrollX,
    scrollY,
    selectedClipIds,
    setPlayhead,
    selectClip,
    clearClipSelection,
    togglePlayback,
  } = useTimelineStore();

  // Calculate total duration from sequence
  const duration = (() => {
    if (!sequence) return 60;

    const clipEndTimes = sequence.tracks.flatMap((track) =>
      track.clips.map((clip) =>
        clip.place.timelineInSec + (clip.range.sourceOutSec - clip.range.sourceInSec)
      )
    );

    // Return minimum 60 seconds, or max of all clip end times
    return clipEndTimes.length > 0 ? Math.max(60, ...clipEndTimes) : 60;
  })();

  // Get all clips from all tracks
  const getTrackClips = useCallback(
    (trackId: string): ClipType[] => {
      if (!sequence) return [];
      const track = sequence.tracks.find((t) => t.id === trackId);
      return track?.clips || [];
    },
    [sequence]
  );

  // Handle ruler seek
  const handleSeek = useCallback(
    (time: number) => {
      setPlayhead(time);
    },
    [setPlayhead]
  );

  // Handle clip click
  const handleClipClick = useCallback(
    (clipId: string) => {
      selectClip(clipId);
    },
    [selectClip]
  );

  // Handle clicking empty area
  const handleTracksAreaClick = useCallback(
    (e: MouseEvent) => {
      // Only clear if clicking directly on the tracks area, not on a clip
      if ((e.target as HTMLElement).getAttribute('data-testid') === 'timeline-tracks-area') {
        clearClipSelection();
      }
    },
    [clearClipSelection]
  );

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlayback();
          break;
        case 'Delete':
        case 'Backspace':
          if (selectedClipIds.length > 0 && onDeleteClips) {
            e.preventDefault();
            onDeleteClips(selectedClipIds);
          }
          break;
        case 'Escape':
          clearClipSelection();
          break;
      }
    },
    [togglePlayback, selectedClipIds, onDeleteClips, clearClipSelection]
  );

  // Empty state
  if (!sequence) {
    return (
      <div
        data-testid="timeline"
        className="h-full flex items-center justify-center text-editor-text-muted"
      >
        No sequence loaded
      </div>
    );
  }

  return (
    <div
      data-testid="timeline"
      className="h-full flex flex-col bg-editor-panel overflow-hidden focus:outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Time Ruler Row */}
      <div className="flex border-b border-editor-border">
        {/* Track header placeholder */}
        <div className="w-48 flex-shrink-0 bg-editor-sidebar border-r border-editor-border" />
        {/* Ruler */}
        <div className="flex-1 overflow-hidden">
          <div style={{ transform: `translateX(-${scrollX}px)` }}>
            <TimeRuler
              duration={duration}
              zoom={zoom}
              scrollX={scrollX}
              onSeek={handleSeek}
            />
          </div>
        </div>
      </div>

      {/* Tracks Area */}
      <div
        data-testid="timeline-tracks-area"
        className="flex-1 overflow-auto relative"
        style={{ scrollBehavior: 'smooth' }}
        onClick={handleTracksAreaClick}
      >
        <div style={{ transform: `translateY(-${scrollY}px)` }}>
          {sequence.tracks.map((track) => (
            <Track
              key={track.id}
              track={track}
              clips={getTrackClips(track.id)}
              zoom={zoom}
              selectedClipIds={selectedClipIds}
              onClipClick={handleClipClick}
            />
          ))}
        </div>

        {/* Playhead (spans all tracks) */}
        <div
          className="absolute top-0 left-48 right-0 h-full pointer-events-none"
          style={{ transform: `translateX(-${scrollX}px)` }}
        >
          <Playhead position={playhead} zoom={zoom} isPlaying={isPlaying} />
        </div>
      </div>
    </div>
  );
}
