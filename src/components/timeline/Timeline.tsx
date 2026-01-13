/**
 * Timeline Component
 *
 * Main timeline container that integrates all timeline elements.
 */

import { useState, useCallback, useRef, type KeyboardEvent, type MouseEvent, type DragEvent, type WheelEvent } from 'react';
import type { Sequence, Clip as ClipType } from '@/types';
import { useTimelineStore } from '@/stores/timelineStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { TimeRuler } from './TimeRuler';
import { Track } from './Track';
import { Playhead } from './Playhead';
import { TimelineToolbar } from './TimelineToolbar';
import type { ClipDragData } from './Clip';

// =============================================================================
// Types
// =============================================================================

export interface AssetDropData {
  assetId: string;
  trackId: string;
  timelinePosition: number;
}

export interface ClipMoveData {
  sequenceId: string;
  trackId: string;
  clipId: string;
  newTimelineIn: number;
  newTrackId?: string;
}

export interface ClipTrimData {
  sequenceId: string;
  trackId: string;
  clipId: string;
  newSourceIn?: number;
  newSourceOut?: number;
  newTimelineIn?: number;
}

export interface ClipSplitData {
  sequenceId: string;
  trackId: string;
  clipId: string;
  splitTime: number;
}

interface TimelineProps {
  /** Sequence to display */
  sequence: Sequence | null;
  /** Callback when clips should be deleted */
  onDeleteClips?: (clipIds: string[]) => void;
  /** Callback when asset is dropped on timeline */
  onAssetDrop?: (data: AssetDropData) => void;
  /** Callback when clip is moved */
  onClipMove?: (data: ClipMoveData) => void;
  /** Callback when clip is trimmed */
  onClipTrim?: (data: ClipTrimData) => void;
  /** Callback when clip is split */
  onClipSplit?: (data: ClipSplitData) => void;
}

// =============================================================================
// Constants
// =============================================================================

const TRACK_HEADER_WIDTH = 192; // w-48 = 12rem = 192px
const TRACK_HEIGHT = 64; // h-16 = 4rem = 64px

// =============================================================================
// Component
// =============================================================================

export function Timeline({
  sequence,
  onDeleteClips,
  onAssetDrop,
  onClipMove,
  onClipTrim,
  onClipSplit,
}: TimelineProps) {
  // Get playback state from playback store (single source of truth for playhead)
  const { currentTime: playhead, isPlaying, setCurrentTime: setPlayhead, togglePlayback } = usePlaybackStore();

  // Get timeline UI state from timeline store
  const {
    zoom,
    scrollX,
    scrollY,
    selectedClipIds,
    setScrollX,
    selectClip,
    clearClipSelection,
    zoomIn,
    zoomOut,
    fitToWindow,
  } = useTimelineStore();

  // Drag and drop state
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [dragPreview, setDragPreview] = useState<{ clipId: string; left: number; width: number } | null>(null);
  const tracksAreaRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef(0);

  // Calculate total duration from sequence
  const duration = (() => {
    if (!sequence) return 60;

    const clipEndTimes = sequence.tracks.flatMap((track) =>
      track.clips.map((clip) =>
        clip.place.timelineInSec + (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed
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

  // Find clip by ID across all tracks
  const findClip = useCallback(
    (clipId: string): { clip: ClipType; trackId: string } | null => {
      if (!sequence) return null;
      for (const track of sequence.tracks) {
        const clip = track.clips.find(c => c.id === clipId);
        if (clip) {
          return { clip, trackId: track.id };
        }
      }
      return null;
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

  // ===========================================================================
  // Clip Drag Handlers
  // ===========================================================================

  const handleClipDragStart = useCallback(
    (_trackId: string, data: ClipDragData) => {
      // Select the clip being dragged
      selectClip(data.clipId);
    },
    [selectClip]
  );

  const handleClipDrag = useCallback(
    (trackId: string, data: ClipDragData, deltaX: number) => {
      if (!sequence) return;

      const deltaTime = deltaX / zoom;

      if (data.type === 'move') {
        // Calculate new position
        const newTimelineIn = Math.max(0, data.originalTimelineIn + deltaTime);
        const clipInfo = findClip(data.clipId);
        if (clipInfo) {
          const clipDuration = (data.originalSourceOut - data.originalSourceIn) / clipInfo.clip.speed;
          setDragPreview({
            clipId: data.clipId,
            left: newTimelineIn * zoom,
            width: clipDuration * zoom,
          });
        }
      } else if (data.type === 'trim-left') {
        // Preview trim from left
        const maxDelta = data.originalSourceOut - data.originalSourceIn - 0.1; // Min 0.1s duration
        const clampedDelta = Math.max(-data.originalSourceIn, Math.min(maxDelta, deltaTime));
        const newSourceIn = data.originalSourceIn + clampedDelta;
        const newTimelineIn = data.originalTimelineIn + clampedDelta;
        const newDuration = data.originalSourceOut - newSourceIn;

        setDragPreview({
          clipId: data.clipId,
          left: newTimelineIn * zoom,
          width: newDuration * zoom,
        });
      } else if (data.type === 'trim-right') {
        // Preview trim from right
        const minDuration = 0.1;
        const clampedDelta = Math.max(minDuration - (data.originalSourceOut - data.originalSourceIn), deltaTime);
        const newSourceOut = data.originalSourceOut + clampedDelta;
        const newDuration = newSourceOut - data.originalSourceIn;

        setDragPreview({
          clipId: data.clipId,
          left: data.originalTimelineIn * zoom,
          width: newDuration * zoom,
        });
      }
    },
    [sequence, zoom, findClip]
  );

  const handleClipDragEnd = useCallback(
    (trackId: string, data: ClipDragData) => {
      if (!sequence || !dragPreview) {
        setDragPreview(null);
        return;
      }

      const deltaTime = (dragPreview.left / zoom) - data.originalTimelineIn;

      if (data.type === 'move' && onClipMove) {
        const newTimelineIn = Math.max(0, data.originalTimelineIn + deltaTime);
        onClipMove({
          sequenceId: sequence.id,
          trackId,
          clipId: data.clipId,
          newTimelineIn,
        });
      } else if ((data.type === 'trim-left' || data.type === 'trim-right') && onClipTrim) {
        if (data.type === 'trim-left') {
          const newSourceIn = data.originalSourceIn + deltaTime;
          const newTimelineIn = data.originalTimelineIn + deltaTime;
          onClipTrim({
            sequenceId: sequence.id,
            trackId,
            clipId: data.clipId,
            newSourceIn: Math.max(0, newSourceIn),
            newTimelineIn: Math.max(0, newTimelineIn),
          });
        } else {
          const newDuration = dragPreview.width / zoom;
          const newSourceOut = data.originalSourceIn + newDuration;
          onClipTrim({
            sequenceId: sequence.id,
            trackId,
            clipId: data.clipId,
            newSourceOut,
          });
        }
      }

      setDragPreview(null);
    },
    [sequence, dragPreview, zoom, onClipMove, onClipTrim]
  );

  // ===========================================================================
  // Keyboard Handlers
  // ===========================================================================

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
        case 's':
        case 'S':
          // Split at playhead
          if (sequence && selectedClipIds.length === 1 && onClipSplit) {
            e.preventDefault();
            const clipInfo = findClip(selectedClipIds[0]);
            if (clipInfo) {
              const { clip, trackId } = clipInfo;
              const clipEnd = clip.place.timelineInSec +
                (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;

              // Check if playhead is within the clip
              if (playhead > clip.place.timelineInSec && playhead < clipEnd) {
                onClipSplit({
                  sequenceId: sequence.id,
                  trackId,
                  clipId: clip.id,
                  splitTime: playhead,
                });
              }
            }
          }
          break;
      }
    },
    [togglePlayback, selectedClipIds, onDeleteClips, clearClipSelection, sequence, onClipSplit, findClip, playhead]
  );

  // ===========================================================================
  // Scroll and Zoom Handlers
  // ===========================================================================

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      // Ctrl + wheel = zoom
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) {
          zoomIn();
        } else {
          zoomOut();
        }
        return;
      }

      // Shift + wheel = horizontal scroll
      if (e.shiftKey) {
        e.preventDefault();
        setScrollX(scrollX + e.deltaX + e.deltaY);
      }
    },
    [zoomIn, zoomOut, setScrollX, scrollX]
  );

  const handleFitToWindow = useCallback(() => {
    if (tracksAreaRef.current) {
      const viewportWidth = tracksAreaRef.current.clientWidth - TRACK_HEADER_WIDTH;
      fitToWindow(duration, viewportWidth);
    }
  }, [duration, fitToWindow]);

  // ===========================================================================
  // Drag and Drop Handlers (Asset to Timeline)
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
      {/* Timeline Toolbar */}
      <TimelineToolbar onFitToWindow={handleFitToWindow} />

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
        onWheel={handleWheel}
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
              onClipDragStart={handleClipDragStart}
              onClipDrag={handleClipDrag}
              onClipDragEnd={handleClipDragEnd}
            />
          ))}
        </div>

        {/* Drag Preview Ghost */}
        {dragPreview && (
          <div
            className="absolute h-16 bg-primary-500/30 border-2 border-primary-500 border-dashed rounded pointer-events-none"
            style={{
              left: `${TRACK_HEADER_WIDTH + dragPreview.left - scrollX}px`,
              top: '0px',
              width: `${dragPreview.width}px`,
            }}
          />
        )}

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
