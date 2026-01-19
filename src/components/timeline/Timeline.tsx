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
import { TimeRuler } from './TimeRuler';
import { Track } from './Track';
import { Playhead } from './Playhead';
import { TimelineToolbar } from './TimelineToolbar';
import { DragPreviewLayer } from './DragPreviewLayer';
import { SnapIndicator, type SnapPoint } from './SnapIndicator';
import type { ClipWaveformConfig } from './Clip';
import type { TimelineProps } from './types';
import { TRACK_HEADER_WIDTH, TRACK_HEIGHT, DEFAULT_TIMELINE_DURATION, DEFAULT_FPS } from './constants';

// Re-export types for backward compatibility
export type {
  AssetDropData,
  ClipMoveData,
  ClipTrimData,
  ClipSplitData,
  TrackControlData,
} from './types';

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
          (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed
      )
    );
    return clipEndTimes.length > 0 ? Math.max(DEFAULT_TIMELINE_DURATION, ...clipEndTimes) : DEFAULT_TIMELINE_DURATION;
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
  const {
    dragPreview,
    getTrackClips,
    handleClipDragStart,
    handleClipDrag,
    handleClipDragEnd,
  } = useTimelineClipOperations({
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
    [assets]
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
    [selectClip, selectClips, selectedClipIds]
  );

  const handleTracksAreaClick = useCallback(
    (e: MouseEvent) => {
      if ((e.target as HTMLElement).getAttribute('data-testid') === 'timeline-tracks-area') {
        clearClipSelection();
      }
    },
    [clearClipSelection]
  );

  const createTrackHandler = useCallback(
    (callback?: (data: { sequenceId: string; trackId: string }) => void) =>
      (trackId: string) => {
        if (sequence && callback) callback({ sequenceId: sequence.id, trackId });
      },
    [sequence]
  );

  // ===========================================================================
  // Render
  // ===========================================================================
  if (!sequence) {
    return (
      <div data-testid="timeline" className="h-full flex items-center justify-center text-editor-text-muted">
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
          ))}
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
      </div>
    </div>
  );
}
