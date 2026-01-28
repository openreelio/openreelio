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
import { usePlayheadDrag } from '@/hooks/usePlayheadDrag';
import { useAssetDrop } from '@/hooks/useAssetDrop';
import { useTimelineKeyboard } from '@/hooks/useTimelineKeyboard';
import { useTimelineClipOperations } from '@/hooks/useTimelineClipOperations';
import { useTimelineNavigation } from '@/hooks/useTimelineNavigation';
import { useSelectionBox } from '@/hooks/useSelectionBox';
import { useCaption } from '@/hooks/useCaption';
import { useShotMarkers } from '@/hooks/useShotMarkers';
import { TimeRuler } from './TimeRuler';
import { Track } from './Track';
import { CaptionTrack } from './CaptionTrack';
import { Playhead } from './Playhead';
import { TimelineToolbar } from './TimelineToolbar';
import { DragPreviewLayer } from './DragPreviewLayer';
import { SnapIndicator, type SnapPoint } from './SnapIndicator';
import { SelectionBox } from './SelectionBox';
import { ShotMarkers } from './ShotMarkers';
import { CaptionEditor } from '@/components/features/captions';
import { CaptionExportDialog } from '@/components/features/export/CaptionExportDialog';
import type { ClipWaveformConfig, ClipThumbnailConfig } from './Clip';
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

  // Caption export state
  const [exportCaptions, setExportCaptions] = useState<{
    captions: Caption[];
    trackName: string;
  } | null>(null);

  // ===========================================================================
  // Caption Hook
  // ===========================================================================
  const { updateCaption, deleteCaption } = useCaption();

  // ===========================================================================
  // Shot Markers Hook
  // ===========================================================================
  // Find selected clip's asset for shot markers display
  const selectedAssetInfo = useMemo(() => {
    if (selectedClipIds.length !== 1 || !sequence) return null;

    // Find the selected clip in any track
    for (const track of sequence.tracks) {
      const clip = track.clips.find((c) => c.id === selectedClipIds[0]);
      if (clip) {
        const asset = assets.get(clip.assetId);
        if (asset && asset.kind === 'video') {
          return {
            assetId: asset.id,
            videoPath: asset.uri,
          };
        }
      }
    }
    return null;
  }, [selectedClipIds, sequence, assets]);

  // ===========================================================================
  // Viewport Width Measurement (for clip virtualization)
  // ===========================================================================
  useLayoutEffect(() => {
    const element = tracksAreaRef.current;
    if (!element) return;

    // Initial measurement
    setViewportWidth(Math.max(0, element.clientWidth - TRACK_HEADER_WIDTH));

    // Observe resize changes with error handling
    let resizeObserver: ResizeObserver | null = null;
    let isObserving = false;

    try {
      resizeObserver = new ResizeObserver((entries) => {
        // Guard against callbacks after disconnect
        if (!isObserving) return;

        for (const entry of entries) {
          const width = entry.contentRect.width - TRACK_HEADER_WIDTH;
          setViewportWidth(Math.max(0, width));
        }
      });

      resizeObserver.observe(element);
      isObserving = true;
    } catch {
      // ResizeObserver may fail in certain environments (e.g., headless browsers)
      // Fall back to window resize events
      const handleWindowResize = () => {
        if (tracksAreaRef.current) {
          const width = tracksAreaRef.current.clientWidth - TRACK_HEADER_WIDTH;
          setViewportWidth(Math.max(0, width));
        }
      };
      window.addEventListener('resize', handleWindowResize);
      return () => {
        window.removeEventListener('resize', handleWindowResize);
      };
    }

    return () => {
      isObserving = false;
      if (resizeObserver) {
        try {
          resizeObserver.disconnect();
        } catch {
          // Ignore disconnect errors (element may already be removed)
        }
      }
    };
  }, []);

  // ===========================================================================
  // Derived Values
  // ===========================================================================
  // Calculate timeline duration based on actual clip content
  // Add padding for easier editing (20% extra or minimum 5 seconds after last clip)
  const duration = useMemo(() => {
    if (!sequence) return DEFAULT_TIMELINE_DURATION;

    const clipEndTimes = sequence.tracks.flatMap((track) =>
      track.clips.map(
        (clip) =>
          clip.place.timelineInSec +
          (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed,
      ),
    );

    if (clipEndTimes.length === 0) {
      // Empty timeline: show 10 seconds minimum
      return 10;
    }

    const maxEndTime = Math.max(...clipEndTimes);
    // Add 20% padding or minimum 5 seconds for easier editing
    const padding = Math.max(maxEndTime * 0.2, 5);
    return maxEndTime + padding;
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
  // Shot Markers
  // ===========================================================================
  const { shots: shotMarkers } = useShotMarkers({
    assetId: selectedAssetInfo?.assetId ?? null,
    videoPath: selectedAssetInfo?.videoPath ?? null,
    autoLoad: true,
    onSeek: setPlayhead,
  });

  // ===========================================================================
  // Coordinate System
  // ===========================================================================
  const { calculateTimeFromMouseEvent, snapPoints, snapThreshold } = useTimelineCoordinates({
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
  // Playhead Dragging
  // ===========================================================================
  const {
    isDragging: isDraggingPlayhead,
    handleDragStart: handlePlayheadDragStart,
    handlePointerDown: handlePlayheadPointerDown,
  } = usePlayheadDrag({
    containerRef: tracksAreaRef,
    zoom,
    scrollX,
    duration,
    trackHeaderWidth: TRACK_HEADER_WIDTH,
    isPlaying,
    togglePlayback,
    seek: setPlayhead,
    snapEnabled,
    snapPoints,
    snapThreshold,
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
    enabled: !isScrubbing && !dragPreview && !isDraggingPlayhead,
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

  const getClipThumbnailConfig = useCallback(
    (_clipId: string, assetId: string): ClipThumbnailConfig | undefined => {
      const asset = assets.get(assetId);
      if (!asset) return undefined;
      // Enable thumbnails for video and image assets
      const isVisual = asset.kind === 'video' || asset.kind === 'image';
      if (!isVisual) return undefined;
      return {
        asset,
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
   * Both can coexist: scrubbing sets playhead position immediately,
   * while selection box handles drag-to-select.
   */
  const handleTracksAreaMouseDown = useCallback(
    (e: MouseEvent) => {
      // Check if clicking on empty area (not on clips, buttons, or headers)
      const target = e.target as HTMLElement;
      const isEmptyAreaClick =
        !target.closest('[data-testid^="clip-"]') &&
        !target.closest('[data-testid="track-header"]') &&
        !target.closest('button');

      // Always try to set playhead position first (scrubbing)
      // This ensures clicking anywhere on empty area moves the playhead
      if (isEmptyAreaClick) {
        handleScrubStart(e);
      }

      // Selection box will also activate on empty area for drag-to-select
      // but scrubbing already handled the initial click
      handleSelectionMouseDown(e);
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

  /**
   * Handler for caption export button click
   */
  const handleCaptionExportClick = useCallback(
    (trackId: string, captions: Caption[]) => {
      // Find the track name for the default filename
      const track = sequence?.tracks.find((t) => t.id === trackId);
      const trackName = track?.name || 'captions';
      setExportCaptions({ captions, trackName });
    },
    [sequence],
  );

  /**
   * Handler for closing the export dialog
   */
  const handleExportDialogClose = useCallback(() => {
    setExportCaptions(null);
  }, []);

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

  // Calculate playhead pixel position for rendering
  const playheadPixelPosition = playhead * zoom + TRACK_HEADER_WIDTH - scrollX;

  return (
    <div
      data-testid="timeline"
      className="h-full flex flex-col bg-editor-panel overflow-hidden focus:outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <TimelineToolbar onFitToWindow={handleFitToWindow} />

      {/* Main timeline area with ruler and tracks - relative container for playhead */}
      {/* isolation: isolate creates a stacking context so playhead z-index doesn't escape to overlap modals */}
      <div className="flex-1 flex flex-col relative isolate">
        {/* Ruler row */}
        <div className="flex border-b border-editor-border flex-shrink-0">
          <div className="w-48 flex-shrink-0 bg-editor-sidebar border-r border-editor-border" />
          <div className="flex-1 overflow-hidden">
            <div style={{ transform: `translateX(-${scrollX}px)` }}>
              <TimeRuler duration={duration} zoom={zoom} scrollX={scrollX} onSeek={handleSeek} />
            </div>
          </div>
        </div>

        {/* Tracks area */}
        <div
          ref={tracksAreaRef}
          data-testid="timeline-tracks-area"
          className={`flex-1 overflow-hidden relative ${isScrubbing || isDraggingPlayhead ? 'cursor-ew-resize' : ''} ${isSelecting ? 'cursor-crosshair' : ''}`}
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
                    selectedCaptionIds={selectedClipIds}
                    onLockToggle={createTrackHandler(onTrackLockToggle)}
                    onVisibilityToggle={createTrackHandler(onTrackVisibilityToggle)}
                    onCaptionClick={handleClipClick}
                    onCaptionDoubleClick={createCaptionDoubleClickHandler(track.id)}
                    onExportClick={handleCaptionExportClick}
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
                  getClipThumbnailConfig={getClipThumbnailConfig}
                  snapPoints={snapEnabled ? snapPoints : []}
                  snapThreshold={snapEnabled ? snapThreshold : 0}
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
            isActive={isScrubbing || isDraggingPlayhead}
            zoom={zoom}
            trackHeaderWidth={TRACK_HEADER_WIDTH}
            scrollX={scrollX}
          />
          {/* Shot Markers - show detected shot boundaries for selected video clip */}
          {shotMarkers.length > 0 && (
            <ShotMarkers
              shots={shotMarkers}
              zoom={zoom}
              scrollX={scrollX}
              viewportWidth={viewportWidth}
              duration={duration}
              trackHeaderWidth={TRACK_HEADER_WIDTH}
              onSeek={setPlayhead}
            />
          )}
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

        {/* Playhead - spans ruler and tracks, positioned outside overflow-hidden areas */}
        {playheadPixelPosition >= TRACK_HEADER_WIDTH - 20 && (
          <Playhead
            position={playhead}
            zoom={zoom}
            scrollX={scrollX}
            trackHeaderWidth={TRACK_HEADER_WIDTH}
            isPlaying={isPlaying}
            isDragging={isDraggingPlayhead}
            onDragStart={handlePlayheadDragStart}
            onPointerDown={handlePlayheadPointerDown}
          />
        )}
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

      {/* Caption Export Dialog */}
      <CaptionExportDialog
        isOpen={exportCaptions !== null}
        onClose={handleExportDialogClose}
        captions={exportCaptions?.captions ?? []}
        defaultName={exportCaptions?.trackName}
      />
    </div>
  );
}
