/**
 * Timeline Component
 *
 * Main timeline container that integrates all timeline elements.
 */

import { useState, useCallback, useRef, type KeyboardEvent, type MouseEvent, type DragEvent } from 'react';
import type { Sequence, Clip as ClipType } from '@/types';
import { useTimelineStore } from '@/stores/timelineStore';
import { TimeRuler } from './TimeRuler';
import { Track } from './Track';
import { Playhead } from './Playhead';

// =============================================================================
// Types
// =============================================================================

export interface AssetDropData {
  assetId: string;
  trackId: string;
  timelinePosition: number;
}

interface TimelineProps {
  /** Sequence to display */
  sequence: Sequence | null;
  /** Callback when clips should be deleted */
  onDeleteClips?: (clipIds: string[]) => void;
  /** Callback when asset is dropped on timeline */
  onAssetDrop?: (data: AssetDropData) => void;
}

// =============================================================================
// Constants
// =============================================================================

const TRACK_HEADER_WIDTH = 192; // w-48 = 12rem = 192px
const TRACK_HEIGHT = 64; // h-16 = 4rem = 64px

// =============================================================================
// Component
// =============================================================================

export function Timeline({ sequence, onDeleteClips, onAssetDrop }: TimelineProps) {
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

  // Drag and drop state
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const tracksAreaRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef(0);

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

  // ===========================================================================
  // Drag and Drop Handlers
  // ===========================================================================

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('application/json')) {
      setIsDraggingOver(true);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('application/json')) {
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDraggingOver(false);

      if (!sequence || !onAssetDrop) return;

      const jsonData = e.dataTransfer.getData('application/json');
      if (!jsonData) return;

      try {
        const assetData = JSON.parse(jsonData);
        if (!assetData.id) return;

        // Calculate timeline position from X coordinate
        // Use event target or ref for getBoundingClientRect
        const target = e.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        if (!rect || rect.width === 0) return;

        const relativeX = e.clientX - rect.left - TRACK_HEADER_WIDTH + scrollX;
        const timelinePosition = Math.max(0, relativeX / zoom);

        // Calculate which track based on Y coordinate
        const relativeY = e.clientY - rect.top + scrollY;
        const trackIndex = Math.floor(relativeY / TRACK_HEIGHT);
        const track = sequence.tracks[trackIndex];

        // Don't allow drop on locked tracks
        if (!track || track.locked) return;

        onAssetDrop({
          assetId: assetData.id,
          trackId: track.id,
          timelinePosition,
        });
      } catch {
        // Invalid JSON data
      }
    },
    [sequence, onAssetDrop, scrollX, scrollY, zoom]
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
        ref={tracksAreaRef}
        data-testid="timeline-tracks-area"
        className="flex-1 overflow-auto relative"
        style={{ scrollBehavior: 'smooth' }}
        onClick={handleTracksAreaClick}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
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

        {/* Drop Indicator */}
        {isDraggingOver && (
          <div
            data-testid="drop-indicator"
            className="absolute inset-0 bg-primary-500/10 border-2 border-dashed border-primary-500 pointer-events-none flex items-center justify-center"
          >
            <div className="text-primary-400 text-sm font-medium">
              Drop asset here
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
