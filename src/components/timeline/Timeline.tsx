/**
 * Timeline Component
 *
 * Main timeline container that integrates all timeline elements.
 * Uses TimelineEngine for playback control and grid snapping for interactions.
 */

import {
  useState,
  useCallback,
  useRef,
  useMemo,
  type KeyboardEvent,
  type MouseEvent,
  type DragEvent,
  type WheelEvent,
} from 'react';
import type { Sequence, Clip as ClipType } from '@/types';
import { useTimelineStore } from '@/stores/timelineStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineEngine } from '@/hooks/useTimelineEngine';
import { getGridIntervalForZoom } from '@/utils/timeline';
import { getSnapPoints, snapToNearestPoint, calculateSnapThreshold } from '@/utils/gridSnapping';
import { TimeRuler } from './TimeRuler';
import { Track } from './Track';
import { Playhead } from './Playhead';
import { TimelineToolbar } from './TimelineToolbar';
import type { ClipDragData, DragPreviewPosition, ClipWaveformConfig } from './Clip';

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

export interface TrackControlData {
  sequenceId: string;
  trackId: string;
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
  /** Callback when track mute is toggled */
  onTrackMuteToggle?: (data: TrackControlData) => void;
  /** Callback when track lock is toggled */
  onTrackLockToggle?: (data: TrackControlData) => void;
  /** Callback when track visibility is toggled */
  onTrackVisibilityToggle?: (data: TrackControlData) => void;
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
  onTrackMuteToggle,
  onTrackLockToggle,
  onTrackVisibilityToggle,
}: TimelineProps) {
  // Get timeline UI state from timeline store
  const {
    zoom,
    scrollX,
    scrollY,
    selectedClipIds,
    setScrollX,
    selectClip,
    selectClips,
    clearClipSelection,
    zoomIn,
    zoomOut,
    fitToWindow,
    snapEnabled,
  } = useTimelineStore();

  // Get assets from project store for waveform generation
  const { assets } = useProjectStore();

  // Calculate total duration from sequence (needed before TimelineEngine)
  const duration = useMemo(() => {
    if (!sequence) return 60;

    const clipEndTimes = sequence.tracks.flatMap((track) =>
      track.clips.map(
        (clip) =>
          clip.place.timelineInSec +
          (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed,
      ),
    );

    // Return minimum 60 seconds, or max of all clip end times
    return clipEndTimes.length > 0 ? Math.max(60, ...clipEndTimes) : 60;
  }, [sequence]);

  // Use TimelineEngine for playback control
  const {
    currentTime: playhead,
    isPlaying,
    togglePlayback,
    seek: setPlayhead,
    stepForward,
    stepBackward,
  } = useTimelineEngine({ duration, fps: 30 });

  // Calculate grid interval based on zoom
  const gridInterval = useMemo(() => getGridIntervalForZoom(zoom), [zoom]);

  // Calculate snap points for all clips
  const snapPoints = useMemo(() => {
    if (!sequence || !snapEnabled) return [];

    const clips = sequence.tracks.flatMap((track) =>
      track.clips.map((clip) => ({
        id: clip.id,
        startTime: clip.place.timelineInSec,
        endTime:
          clip.place.timelineInSec +
          (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed,
      })),
    );

    return getSnapPoints({
      clips,
      playheadTime: playhead,
      excludeClipId: null,
      gridInterval,
      timelineStart: 0,
      timelineEnd: duration,
    });
  }, [sequence, snapEnabled, playhead, gridInterval, duration]);

  // Calculate snap threshold based on zoom
  const snapThreshold = useMemo(() => calculateSnapThreshold(zoom), [zoom]);

  // Drag and drop state
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [dragPreview, setDragPreview] = useState<{
    clipId: string;
    left: number;
    width: number;
    trackIndex: number;
  } | null>(null);
  const [activeSnapPoint, setActiveSnapPoint] = useState<{
    time: number;
    type: string;
  } | null>(null);
  const tracksAreaRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef(0);

  // Playhead scrubbing state
  const [isScrubbing, setIsScrubbing] = useState(false);
  const scrubStartRef = useRef<{ wasPlaying: boolean } | null>(null);

  // Get all clips from all tracks
  const getTrackClips = useCallback(
    (trackId: string): ClipType[] => {
      if (!sequence) return [];
      const track = sequence.tracks.find((t) => t.id === trackId);
      return track?.clips || [];
    },
    [sequence],
  );

  // Find clip by ID across all tracks
  const findClip = useCallback(
    (clipId: string): { clip: ClipType; trackId: string } | null => {
      if (!sequence) return null;
      for (const track of sequence.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          return { clip, trackId: track.id };
        }
      }
      return null;
    },
    [sequence],
  );

  // Get waveform configuration for audio/video clips
  const getClipWaveformConfig = useCallback(
    (_clipId: string, assetId: string): ClipWaveformConfig | undefined => {
      const asset = assets.get(assetId);
      if (!asset) return undefined;

      // Only show waveform for audio assets or video assets with audio
      const hasAudio = asset.kind === 'audio' || (asset.kind === 'video' && asset.audio);
      if (!hasAudio) return undefined;

      return {
        assetId: asset.id,
        inputPath: asset.proxyUrl || asset.uri,
        totalDurationSec: asset.durationSec ?? 0,
        enabled: true,
      };
    },
    [assets],
  );

  // Handle ruler seek
  const handleSeek = useCallback(
    (time: number) => {
      setPlayhead(time);
    },
    [setPlayhead],
  );

  // ===========================================================================
  // Playhead Scrubbing Handlers
  // ===========================================================================

  const calculateTimeFromMouseEvent = useCallback(
    (e: globalThis.MouseEvent | MouseEvent, applySnapping: boolean = false) => {
      if (!tracksAreaRef.current) return null;
      const rect = tracksAreaRef.current.getBoundingClientRect();
      const relativeX = e.clientX - rect.left - TRACK_HEADER_WIDTH + scrollX;
      let time = Math.max(0, Math.min(duration, relativeX / zoom));

      // Apply snapping if enabled
      if (applySnapping && snapEnabled && snapPoints.length > 0) {
        const snapResult = snapToNearestPoint(time, snapPoints, snapThreshold);
        if (snapResult.snapped) {
          time = snapResult.time;
          setActiveSnapPoint({
            time: snapResult.time,
            type: snapResult.snapPoint?.type || 'grid',
          });
        } else {
          setActiveSnapPoint(null);
        }
      }

      return time;
    },
    [scrollX, zoom, duration, snapEnabled, snapPoints, snapThreshold],
  );

  const handleScrubStart = useCallback(
    (e: MouseEvent) => {
      // Only start scrubbing if clicking on the tracks area background (not on clips)
      const target = e.target as HTMLElement;
      if (
        target.getAttribute('data-testid') !== 'timeline-tracks-area' &&
        target.getAttribute('data-testid') !== 'track-content' &&
        !target.closest('[data-testid="track-content"]')
      ) {
        return;
      }

      e.preventDefault();
      setIsScrubbing(true);

      // Pause playback during scrubbing and remember state
      scrubStartRef.current = { wasPlaying: isPlaying };
      if (isPlaying) {
        togglePlayback();
      }

      // Set initial position (with snapping)
      const time = calculateTimeFromMouseEvent(e, true);
      if (time !== null) {
        setPlayhead(time);
      }

      // Add document-level listeners for mouse move and up
      const handleMouseMove = (moveEvent: globalThis.MouseEvent) => {
        const newTime = calculateTimeFromMouseEvent(moveEvent, true);
        if (newTime !== null) {
          setPlayhead(newTime);
        }
      };

      const handleMouseUp = () => {
        setIsScrubbing(false);
        setActiveSnapPoint(null);

        // Resume playback if it was playing before scrubbing
        if (scrubStartRef.current?.wasPlaying) {
          togglePlayback();
        }
        scrubStartRef.current = null;

        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [isPlaying, togglePlayback, calculateTimeFromMouseEvent, setPlayhead],
  );

  // Handle clip click with multi-select support
  const handleClipClick = useCallback(
    (clipId: string, modifiers: { ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }) => {
      // Ctrl/Cmd+click: toggle selection (add or remove from selection)
      if (modifiers.ctrlKey || modifiers.metaKey) {
        if (selectedClipIds.includes(clipId)) {
          // Remove from selection if already selected
          const newSelection = selectedClipIds.filter((id) => id !== clipId);
          selectClips(newSelection);
        } else {
          // Add to selection
          selectClip(clipId, true);
        }
      } else {
        // Normal click: single selection
        selectClip(clipId, false);
      }
    },
    [selectClip, selectClips, selectedClipIds],
  );

  // Handle clicking empty area
  const handleTracksAreaClick = useCallback(
    (e: MouseEvent) => {
      // Only clear if clicking directly on the tracks area, not on a clip
      if ((e.target as HTMLElement).getAttribute('data-testid') === 'timeline-tracks-area') {
        clearClipSelection();
      }
    },
    [clearClipSelection],
  );

  // ===========================================================================
  // Clip Drag Handlers
  // ===========================================================================

  const handleClipDragStart = useCallback(
    (trackId: string, data: ClipDragData) => {
      // Select the clip being dragged
      selectClip(data.clipId);

      // Find track index for drag preview positioning
      if (sequence) {
        const trackIndex = sequence.tracks.findIndex((t) => t.id === trackId);
        const clipInfo = findClip(data.clipId);
        if (clipInfo && trackIndex >= 0) {
          const clipDuration =
            (data.originalSourceOut - data.originalSourceIn) / clipInfo.clip.speed;
          setDragPreview({
            clipId: data.clipId,
            left: data.originalTimelineIn * zoom,
            width: clipDuration * zoom,
            trackIndex,
          });
        }
      }
    },
    [selectClip, sequence, zoom, findClip],
  );

  const handleClipDrag = useCallback(
    (trackId: string, data: ClipDragData, previewPosition: DragPreviewPosition) => {
      if (!sequence) return;

      const trackIndex = sequence.tracks.findIndex((t) => t.id === trackId);

      // Use the authoritative preview position from useClipDrag hook directly
      // This avoids redundant calculations and potential inconsistencies
      setDragPreview({
        clipId: data.clipId,
        left: previewPosition.timelineIn * zoom,
        width: previewPosition.duration * zoom,
        trackIndex,
      });
    },
    [sequence, zoom],
  );

  const handleClipDragEnd = useCallback(
    (trackId: string, data: ClipDragData, finalPosition: DragPreviewPosition) => {
      if (!sequence) {
        setDragPreview(null);
        return;
      }

      // Use finalPosition from the drag hook instead of dragPreview for accuracy
      if (data.type === 'move' && onClipMove) {
        onClipMove({
          sequenceId: sequence.id,
          trackId,
          clipId: data.clipId,
          newTimelineIn: Math.max(0, finalPosition.timelineIn),
        });
      } else if ((data.type === 'trim-left' || data.type === 'trim-right') && onClipTrim) {
        if (data.type === 'trim-left') {
          onClipTrim({
            sequenceId: sequence.id,
            trackId,
            clipId: data.clipId,
            newSourceIn: Math.max(0, finalPosition.sourceIn),
            newTimelineIn: Math.max(0, finalPosition.timelineIn),
          });
        } else {
          onClipTrim({
            sequenceId: sequence.id,
            trackId,
            clipId: data.clipId,
            newSourceOut: finalPosition.sourceOut,
          });
        }
      }

      setDragPreview(null);
    },
    [sequence, onClipMove, onClipTrim],
  );

  // ===========================================================================
  // Track Control Handlers
  // ===========================================================================

  const handleTrackMuteToggle = useCallback(
    (trackId: string) => {
      if (!sequence || !onTrackMuteToggle) return;
      onTrackMuteToggle({ sequenceId: sequence.id, trackId });
    },
    [sequence, onTrackMuteToggle],
  );

  const handleTrackLockToggle = useCallback(
    (trackId: string) => {
      if (!sequence || !onTrackLockToggle) return;
      onTrackLockToggle({ sequenceId: sequence.id, trackId });
    },
    [sequence, onTrackLockToggle],
  );

  const handleTrackVisibilityToggle = useCallback(
    (trackId: string) => {
      if (!sequence || !onTrackVisibilityToggle) return;
      onTrackVisibilityToggle({ sequenceId: sequence.id, trackId });
    },
    [sequence, onTrackVisibilityToggle],
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
        case 'ArrowLeft':
          e.preventDefault();
          stepBackward();
          break;
        case 'ArrowRight':
          e.preventDefault();
          stepForward();
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
              const clipEnd =
                clip.place.timelineInSec +
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
        case 'a':
        case 'A':
          // Ctrl+A: Select all clips
          if ((e.ctrlKey || e.metaKey) && sequence) {
            e.preventDefault();
            const allClipIds = sequence.tracks.flatMap((track) =>
              track.clips.map((clip) => clip.id),
            );
            selectClips(allClipIds);
          }
          break;
      }
    },
    [
      togglePlayback,
      stepBackward,
      stepForward,
      selectedClipIds,
      onDeleteClips,
      clearClipSelection,
      sequence,
      onClipSplit,
      findClip,
      playhead,
      selectClips,
    ],
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
    [zoomIn, zoomOut, setScrollX, scrollX],
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
    if (
      e.dataTransfer.types.includes('application/json') ||
      e.dataTransfer.types.includes('text/plain')
    ) {
      setIsDraggingOver(true);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (
      e.dataTransfer.types.includes('application/json') ||
      e.dataTransfer.types.includes('text/plain')
    ) {
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

      if (!sequence || !onAssetDrop) {
        return;
      }

      // Try to get data from different formats
      let jsonData = e.dataTransfer.getData('application/json');
      const textData = e.dataTransfer.getData('text/plain');

      if (!jsonData && textData) {
        // If only text/plain available (asset ID), construct minimal object
        jsonData = JSON.stringify({ id: textData });
      }

      if (!jsonData) {
        return;
      }

      try {
        const assetData = JSON.parse(jsonData);
        if (!assetData.id) return;

        // Calculate timeline position from X coordinate
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
        if (!track || track.locked) {
          return;
        }

        onAssetDrop({
          assetId: assetData.id,
          trackId: track.id,
          timelinePosition,
        });
      } catch {
        // Invalid JSON data - silently ignore
      }
    },
    [sequence, onAssetDrop, scrollX, scrollY, zoom],
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
            <TimeRuler duration={duration} zoom={zoom} scrollX={scrollX} onSeek={handleSeek} />
          </div>
        </div>
      </div>

      {/* Tracks Area */}
      <div
        ref={tracksAreaRef}
        data-testid="timeline-tracks-area"
        className={`flex-1 overflow-hidden relative ${isScrubbing ? 'cursor-ew-resize' : ''}`}
        onClick={handleTracksAreaClick}
        onMouseDown={handleScrubStart}
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
              scrollX={scrollX}
              duration={duration}
              selectedClipIds={selectedClipIds}
              getClipWaveformConfig={getClipWaveformConfig}
              onClipClick={handleClipClick}
              onClipDragStart={handleClipDragStart}
              onClipDrag={handleClipDrag}
              onClipDragEnd={handleClipDragEnd}
              onMuteToggle={handleTrackMuteToggle}
              onLockToggle={handleTrackLockToggle}
              onVisibilityToggle={handleTrackVisibilityToggle}
            />
          ))}
        </div>

        {/* Drag Preview Ghost */}
        {dragPreview && (
          <div
            className="absolute bg-primary-500/30 border-2 border-primary-500 border-dashed rounded pointer-events-none z-20"
            style={{
              left: `${TRACK_HEADER_WIDTH + dragPreview.left - scrollX}px`,
              top: `${dragPreview.trackIndex * TRACK_HEIGHT}px`,
              width: `${dragPreview.width}px`,
              height: `${TRACK_HEIGHT}px`,
            }}
          />
        )}

        {/* Snap Line Indicator */}
        {activeSnapPoint && isScrubbing && (
          <div
            data-testid="snap-indicator"
            className="absolute top-0 bottom-0 w-px bg-yellow-400 pointer-events-none z-30"
            style={{
              left: `${TRACK_HEADER_WIDTH + activeSnapPoint.time * zoom - scrollX}px`,
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
            <div className="text-primary-400 text-sm font-medium">Drop asset here</div>
          </div>
        )}
      </div>
    </div>
  );
}
