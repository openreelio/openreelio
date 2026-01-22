/**
 * Timeline Component
 *
 * Main timeline container that integrates all timeline elements.
 * Uses TimelineEngine for playback control and grid snapping for interactions.
 */

import { useState, useCallback, useRef, useMemo, useLayoutEffect, type MouseEvent } from 'react';
import { useTimelineStore } from '@/stores/timelineStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineEngine } from '@/hooks/useTimelineEngine';
import { useScrubbing } from '@/hooks/useScrubbing';
import { useTimelineCoordinates } from '@/hooks/useTimelineCoordinates';
import { useAssetDrop } from '@/hooks/useAssetDrop';
import { useTimelineKeyboard } from '@/hooks/useTimelineKeyboard';
import { useTimelineClipOperations } from '@/hooks/useTimelineClipOperations';
import { useTimelineNavigation } from '@/hooks/useTimelineNavigation';
import { useSelectionBox } from '@/hooks/useSelectionBox';
import { useCaption } from '@/hooks/useCaption';
import { TimeRuler } from './TimeRuler';
import { Track } from './Track';
import { CaptionTrack } from './CaptionTrack';
import { Playhead } from './Playhead';
import { TimelineToolbar } from './TimelineToolbar';
import { DragPreviewLayer } from './DragPreviewLayer';
import { SnapIndicator, type SnapPoint } from './SnapIndicator';
import { SelectionBox } from './SelectionBox';
import { CaptionEditor } from '@/components/features/captions';
import type { ClipWaveformConfig } from './Clip';
import type { TimelineProps } from './types';
import type { CaptionTrack as CaptionTrackType, Caption } from '@/types';
import {
  TRACK_HEADER_WIDTH,
  TRACK_HEIGHT,
  DEFAULT_TIMELINE_DURATION,
  DEFAULT_FPS,
} from './constants';

// Re-export types for backward compatibility
export type {
  AssetDropData,
  ClipMoveData,
  ClipTrimData,
  ClipSplitData,
  TrackControlData,
  CaptionUpdateData,
} from './types';
import type { Track as TrackType } from '@/types';

// Adapter to convert Track (with clips) to CaptionTrack (with captions)
function adaptTrackToCaptionTrack(track: TrackType): CaptionTrackType {
  const captions: Caption[] = track.clips.map((clip) => ({
    id: clip.id,
    startSec: clip.place.timelineInSec,
    endSec:
      clip.place.timelineInSec + (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed,
    text: clip.label || '',
    speaker: undefined,
    styleOverride: undefined,
    positionOverride: undefined,
    metadata: {},
  }));

  return {
    id: track.id,
    name: track.name,
    language: 'en',
    visible: track.visible,
    locked: track.locked,
    captions,
    defaultStyle: {
      fontFamily: 'Arial',
      fontSize: 48,
      fontWeight: 'normal',
      color: { r: 255, g: 255, b: 255, a: 255 },
      outlineColor: { r: 0, g: 0, b: 0, a: 255 },
      outlineWidth: 2,
      shadowColor: { r: 0, g: 0, b: 0, a: 128 },
      shadowOffset: 2,
      alignment: 'center',
      italic: false,
      underline: false,
    },
    defaultPosition: {
      type: 'preset',
      vertical: 'bottom',
      marginPercent: 5,
    },
  };
}

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
  // ===========================================================================
  // Store State
  // ===========================================================================
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

  const { assets } = useProjectStore();

  // ===========================================================================
  // Refs and Local State
  // ===========================================================================
  const tracksAreaRef = useRef<HTMLDivElement>(null);
  const [activeSnapPoint, setActiveSnapPoint] = useState<SnapPoint | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);

  // Caption editing state
  const [editingCaption, setEditingCaption] = useState<{
    caption: Caption;
    trackId: string;
  } | null>(null);

  // ===========================================================================
  // Caption Hook
  // ===========================================================================
  const { updateCaption, deleteCaption } = useCaption();

  // ===========================================================================
  // Viewport Width Measurement (for clip virtualization)
  // ===========================================================================
  useLayoutEffect(() => {
    const element = tracksAreaRef.current;
    if (!element) return;

    // Initial measurement
    setViewportWidth(element.clientWidth - TRACK_HEADER_WIDTH);

    // Observe resize changes
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width - TRACK_HEADER_WIDTH;
        setViewportWidth(Math.max(0, width));
      }
    });

    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  // ===========================================================================
  // Derived Values
  // ===========================================================================
  const duration = useMemo(() => {
    if (!sequence) return DEFAULT_TIMELINE_DURATION;
    const clipEndTimes = sequence.tracks.flatMap((track) =>
      track.clips.map(
        (clip) =>
          clip.place.timelineInSec +
          (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed,
      ),
    );
    return clipEndTimes.length > 0
      ? Math.max(DEFAULT_TIMELINE_DURATION, ...clipEndTimes)
      : DEFAULT_TIMELINE_DURATION;
  }, [sequence]);

  // ===========================================================================
  // Playback Engine
  // ===========================================================================
  const {
    currentTime: playhead,
    isPlaying,
    togglePlayback,
    seek: setPlayhead,
    stepForward,
    stepBackward,
  } = useTimelineEngine({ duration, fps: DEFAULT_FPS });

  // ===========================================================================
  // Coordinate System
  // ===========================================================================
  const { calculateTimeFromMouseEvent } = useTimelineCoordinates({
    tracksAreaRef,
    sequence,
    zoom,
    scrollX,
    duration,
    snapEnabled,
    playhead,
    trackHeaderWidth: TRACK_HEADER_WIDTH,
  });

  // ===========================================================================
  // Scrubbing
  // ===========================================================================
  const { isScrubbing, handleScrubStart } = useScrubbing({
    isPlaying,
    togglePlayback,
    seek: setPlayhead,
    calculateTimeFromMouseEvent,
    onSnapChange: setActiveSnapPoint,
  });

  // ===========================================================================
  // Keyboard Shortcuts
  // ===========================================================================
  const { handleKeyDown } = useTimelineKeyboard({
    sequence,
    selectedClipIds,
    playhead,
    togglePlayback,
    stepForward,
    stepBackward,
    clearClipSelection,
    selectClips,
    onDeleteClips,
    onClipSplit,
  });

  // ===========================================================================
  // Clip Operations Hook
  // ===========================================================================
  const { dragPreview, getTrackClips, handleClipDragStart, handleClipDrag, handleClipDragEnd } =
    useTimelineClipOperations({
      sequence,
      zoom,
      onClipMove,
      onClipTrim,
      selectClip,
    });

  // ===========================================================================
  // Navigation Hook
  // ===========================================================================
  const { handleWheel, handleFitToWindow } = useTimelineNavigation({
    scrollX,
    duration,
    zoomIn,
    zoomOut,
    setScrollX,
    fitToWindow,
    trackHeaderWidth: TRACK_HEADER_WIDTH,
    tracksAreaRef,
  });

  // ===========================================================================
  // Asset Drop
  // ===========================================================================
  const { isDraggingOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } =
    useAssetDrop({
      sequence,
      zoom,
      scrollX,
      scrollY,
      trackHeaderWidth: TRACK_HEADER_WIDTH,
      trackHeight: TRACK_HEIGHT,
      onAssetDrop,
    });

  // ===========================================================================
  // Selection Box (drag-to-select)
  // ===========================================================================
  const {
    isSelecting,
    selectionRect,
    handleMouseDown: handleSelectionMouseDown,
  } = useSelectionBox({
    containerRef: tracksAreaRef,
    trackHeaderWidth: TRACK_HEADER_WIDTH,
    trackHeight: TRACK_HEIGHT,
    zoom,
    scrollX,
    scrollY,
    tracks: sequence?.tracks ?? [],
    onSelectClips: selectClips,
    currentSelection: selectedClipIds,
    enabled: !isScrubbing && !dragPreview,
  });

  // ===========================================================================
  // Utility Functions
  // ===========================================================================
  const getClipWaveformConfig = useCallback(
    (_clipId: string, assetId: string): ClipWaveformConfig | undefined => {
      const asset = assets.get(assetId);
      if (!asset) return undefined;
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

  const handleSeek = useCallback((time: number) => setPlayhead(time), [setPlayhead]);

  const handleClipClick = useCallback(
    (clipId: string, modifiers: { ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }) => {
      if (modifiers.ctrlKey || modifiers.metaKey) {
        if (selectedClipIds.includes(clipId)) {
          selectClips(selectedClipIds.filter((id) => id !== clipId));
        } else {
          selectClip(clipId, true);
        }
      } else {
        selectClip(clipId, false);
      }
    },
    [selectClip, selectClips, selectedClipIds],
  );

  const handleTracksAreaClick = useCallback(
    (e: MouseEvent) => {
      // Don't clear selection if we were doing a selection box drag
      if (isSelecting) return;

      if ((e.target as HTMLElement).getAttribute('data-testid') === 'timeline-tracks-area') {
        clearClipSelection();
      }
    },
    [clearClipSelection, isSelecting],
  );

  /**
   * Combined mouse down handler for scrubbing and selection box
   */
  const handleTracksAreaMouseDown = useCallback(
    (e: MouseEvent) => {
      // Try selection box first (only activates on empty area)
      // handleSelectionMouseDown returns true if it started a selection
      const selectionStarted = handleSelectionMouseDown(e);

      // If selection didn't start, try scrubbing
      if (!selectionStarted) {
        handleScrubStart(e);
      }
    },
    [handleSelectionMouseDown, handleScrubStart],
  );

  const createTrackHandler = useCallback(
    (callback?: (data: { sequenceId: string; trackId: string }) => void) => (trackId: string) => {
      if (sequence && callback) callback({ sequenceId: sequence.id, trackId });
    },
    [sequence],
  );

  // ===========================================================================
  // Caption Editing Handlers
  // ===========================================================================

  /**
   * Handler for caption double-click to open the editor
   */
  const handleCaptionDoubleClick = useCallback(
    (captionId: string, trackId: string) => {
      // Find the caption in the track
      const track = sequence?.tracks.find((t) => t.id === trackId);
      if (!track || track.kind !== 'caption') return;

      const clip = track.clips.find((c) => c.id === captionId);
      if (!clip) return;

      // Convert clip to Caption format
      const caption: Caption = {
        id: clip.id,
        startSec: clip.place.timelineInSec,
        endSec:
          clip.place.timelineInSec +
          (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed,
        text: clip.label || '',
        speaker: undefined,
      };

      setEditingCaption({ caption, trackId });
    },
    [sequence],
  );

  /**
   * Handler for saving caption edits
   */
  const handleCaptionSave = useCallback(
    async (updatedCaption: Caption) => {
      if (!editingCaption) return;

      await updateCaption(editingCaption.trackId, updatedCaption);
      setEditingCaption(null);
    },
    [editingCaption, updateCaption],
  );

  /**
   * Handler for cancelling caption edit
   */
  const handleCaptionEditCancel = useCallback(() => {
    setEditingCaption(null);
  }, []);

  /**
   * Handler for deleting a caption
   */
  const handleCaptionDelete = useCallback(
    async (captionId: string) => {
      if (!editingCaption) return;

      await deleteCaption(editingCaption.trackId, captionId);
      setEditingCaption(null);
    },
    [editingCaption, deleteCaption],
  );

  /**
   * Create a caption double-click handler for a specific track
   */
  const createCaptionDoubleClickHandler = useCallback(
    (trackId: string) => (captionId: string) => {
      handleCaptionDoubleClick(captionId, trackId);
    },
    [handleCaptionDoubleClick],
  );

  // ===========================================================================
  // Render
  // ===========================================================================
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
      <TimelineToolbar onFitToWindow={handleFitToWindow} />
      <div className="flex border-b border-editor-border">
        <div className="w-48 flex-shrink-0 bg-editor-sidebar border-r border-editor-border" />
        <div className="flex-1 overflow-hidden">
          <div style={{ transform: `translateX(-${scrollX}px)` }}>
            <TimeRuler duration={duration} zoom={zoom} scrollX={scrollX} onSeek={handleSeek} />
          </div>
        </div>
      </div>
      <div
        ref={tracksAreaRef}
        data-testid="timeline-tracks-area"
        className={`flex-1 overflow-hidden relative ${isScrubbing ? 'cursor-ew-resize' : ''} ${isSelecting ? 'cursor-crosshair' : ''}`}
        onClick={handleTracksAreaClick}
        onMouseDown={handleTracksAreaMouseDown}
        onWheel={handleWheel}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div style={{ transform: `translateY(-${scrollY}px)` }}>
          {sequence.tracks.map((track) => {
            if (track.kind === 'caption') {
              const captionTrack = adaptTrackToCaptionTrack(track);
              return (
                <CaptionTrack
                  key={track.id}
                  track={captionTrack}
                  zoom={zoom}
                  scrollX={scrollX}
                  duration={duration}
                  viewportWidth={viewportWidth}
                  selectedCaptionIds={selectedClipIds} // Re-using selectedClipIds as caption IDs share the same space
                  onLockToggle={createTrackHandler(onTrackLockToggle)}
                  onVisibilityToggle={createTrackHandler(onTrackVisibilityToggle)}
                  onCaptionClick={handleClipClick} // Use same handler as clips
                  onCaptionDoubleClick={createCaptionDoubleClickHandler(track.id)}
                />
              );
            }

            return (
              <Track
                key={track.id}
                track={track}
                clips={getTrackClips(track.id)}
                zoom={zoom}
                scrollX={scrollX}
                duration={duration}
                viewportWidth={viewportWidth}
                selectedClipIds={selectedClipIds}
                getClipWaveformConfig={getClipWaveformConfig}
                onClipClick={handleClipClick}
                onClipDragStart={handleClipDragStart}
                onClipDrag={handleClipDrag}
                onClipDragEnd={handleClipDragEnd}
                onMuteToggle={createTrackHandler(onTrackMuteToggle)}
                onLockToggle={createTrackHandler(onTrackLockToggle)}
                onVisibilityToggle={createTrackHandler(onTrackVisibilityToggle)}
              />
            );
          })}
        </div>
        <DragPreviewLayer
          dragPreview={dragPreview}
          trackHeaderWidth={TRACK_HEADER_WIDTH}
          trackHeight={TRACK_HEIGHT}
          scrollX={scrollX}
        />
        <SnapIndicator
          snapPoint={activeSnapPoint}
          isActive={isScrubbing}
          zoom={zoom}
          trackHeaderWidth={TRACK_HEADER_WIDTH}
          scrollX={scrollX}
        />
        <div
          className="absolute top-0 left-48 right-0 h-full pointer-events-none"
          style={{ transform: `translateX(-${scrollX}px)` }}
        >
          <Playhead position={playhead} zoom={zoom} isPlaying={isPlaying} />
        </div>
        {isDraggingOver && (
          <div
            data-testid="drop-indicator"
            className="absolute inset-0 bg-primary-500/10 border-2 border-dashed border-primary-500 pointer-events-none flex items-center justify-center"
          >
            <div className="text-primary-400 text-sm font-medium">Drop asset here</div>
          </div>
        )}
        <SelectionBox rect={selectionRect} isActive={isSelecting} />
      </div>

      {/* Caption Editor Modal */}
      {editingCaption && (
        <CaptionEditor
          caption={editingCaption.caption}
          isOpen={true}
          onSave={handleCaptionSave}
          onCancel={handleCaptionEditCancel}
          onDelete={handleCaptionDelete}
        />
      )}
    </div>
  );
}
