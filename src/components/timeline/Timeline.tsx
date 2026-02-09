/**
 * Timeline Component
 *
 * Main timeline container that integrates all timeline elements.
 * Uses TimelineEngine for playback control and grid snapping for interactions.
 */

import { useState, useCallback, useRef, useMemo, useLayoutEffect, type MouseEvent } from 'react';
import type { PlayheadHandle } from './Playhead';
import { useTimelineStore } from '@/stores/timelineStore';
import { useProjectStore } from '@/stores/projectStore';
import { useEditorToolStore } from '@/stores/editorToolStore';
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
import { useAutoFollow } from '@/hooks/useAutoFollow';
import { useRazorTool } from '@/hooks/useRazorTool';
import { useClipboard } from '@/hooks/useClipboard';
import { useRippleEdit } from '@/hooks/useRippleEdit';
import { useSlipEdit } from '@/hooks/useSlipEdit';
import { useSlideEdit } from '@/hooks/useSlideEdit';
import { useRollEdit } from '@/hooks/useRollEdit';
import { useEdgeAutoScroll } from '@/hooks/useEdgeAutoScroll';
import { useTimelinePan } from '@/hooks/useTimelinePan';
import { TimeRuler } from './TimeRuler';
import { Track } from './Track';
import { CaptionTrack } from './CaptionTrack';
import { Playhead } from './Playhead';
import { EnhancedTimelineToolbar } from './EnhancedTimelineToolbar';
import { DragPreviewLayer } from './DragPreviewLayer';
import { SnapIndicator, type SnapPoint } from './SnapIndicator';
import { SelectionBox } from './SelectionBox';
import { ShotMarkers } from './ShotMarkers';
import { CaptionEditor } from '@/components/features/captions';
import { CaptionExportDialog } from '@/components/features/export/CaptionExportDialog';
import {
  TimelineOperationsProvider,
  type TimelineOperations,
} from './TimelineOperationsContext';
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
  ClipDuplicateData,
  ClipPasteData,
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
  onClipDuplicate,
  onClipPaste,
  onTrackMuteToggle,
  onTrackLockToggle,
  onTrackVisibilityToggle,
  onAddText,
}: TimelineProps) {
  // ===========================================================================
  // Store State - Using targeted selectors to minimize re-renders
  // ===========================================================================
  // State values - only subscribe to what's needed for render
  const zoom = useTimelineStore((state) => state.zoom);
  const scrollX = useTimelineStore((state) => state.scrollX);
  const scrollY = useTimelineStore((state) => state.scrollY);
  const selectedClipIds = useTimelineStore((state) => state.selectedClipIds);
  const snapEnabled = useTimelineStore((state) => state.snapEnabled);

  // Actions - stable references, don't cause re-renders
  const setScrollX = useTimelineStore((state) => state.setScrollX);
  const setZoom = useTimelineStore((state) => state.setZoom);
  const selectClip = useTimelineStore((state) => state.selectClip);
  const selectClips = useTimelineStore((state) => state.selectClips);
  const clearClipSelection = useTimelineStore((state) => state.clearClipSelection);
  const zoomIn = useTimelineStore((state) => state.zoomIn);
  const zoomOut = useTimelineStore((state) => state.zoomOut);
  const fitToWindow = useTimelineStore((state) => state.fitToWindow);

  const assets = useProjectStore((state) => state.assets);

  // Editor tool store - for tool switching
  const setActiveTool = useEditorToolStore((state) => state.setActiveTool);
  const activeTool = useEditorToolStore((state) => state.activeTool);


  // ===========================================================================
  // Refs and Local State
  // ===========================================================================
  const tracksAreaRef = useRef<HTMLDivElement>(null);
  const playheadViewportRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<PlayheadHandle>(null);
  const clipDragMouseXRef = useRef<number>(0);
  const [activeSnapPoint, setActiveSnapPoint] = useState<SnapPoint | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [isClipDragging, setIsClipDragging] = useState(false);

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
  // Find selected clips' assets for shot markers display
  // Shows markers for all selected video clips (not just single selection)
  const selectedAssetInfos = useMemo(() => {
    if (selectedClipIds.length === 0 || !sequence) return [];

    const results: Array<{ assetId: string; videoPath: string }> = [];
    const seenAssetIds = new Set<string>();

    // Find all selected clips in any track
    for (const track of sequence.tracks) {
      for (const clip of track.clips) {
        if (selectedClipIds.includes(clip.id)) {
          const asset = assets.get(clip.assetId);
          if (asset && asset.kind === 'video' && !seenAssetIds.has(asset.id)) {
            seenAssetIds.add(asset.id);
            results.push({
              assetId: asset.id,
              videoPath: asset.uri,
            });
          }
        }
      }
    }
    return results;
  }, [selectedClipIds, sequence, assets]);

  // For backward compatibility, provide single asset info (first selected)
  const selectedAssetInfo = selectedAssetInfos.length > 0 ? selectedAssetInfos[0] : null;

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

  const seekFromTimelineClick = useCallback(
    (time: number) => setPlayhead(time, 'timeline-click-capture'),
    [setPlayhead],
  );

  const seekFromTimelineScrub = useCallback(
    (time: number) => setPlayhead(time, 'timeline-scrub'),
    [setPlayhead],
  );

  const seekFromPlayheadDrag = useCallback(
    (time: number) => setPlayhead(time, 'timeline-playhead-drag'),
    [setPlayhead],
  );

  const seekFromTimeRuler = useCallback(
    (time: number) => setPlayhead(time, 'timeline-ruler'),
    [setPlayhead],
  );

  // ===========================================================================
  // Shot Markers
  // ===========================================================================
  const { shots: shotMarkers } = useShotMarkers({
    assetId: selectedAssetInfo?.assetId ?? null,
    videoPath: selectedAssetInfo?.videoPath ?? null,
    autoLoad: true,
    onSeek: (time) => setPlayhead(time, 'timeline-shot-marker'),
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
    seek: seekFromTimelineScrub,
    calculateTimeFromMouseEvent,
    onSnapChange: setActiveSnapPoint,
    playheadRef,
    zoom,
    scrollX,
    trackHeaderWidth: TRACK_HEADER_WIDTH,
    playheadTrackHeaderWidth: 0, // Playhead is rendered inside a clipped container offset by the header
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
    playheadRef,
    zoom,
    scrollX,
    duration,
    trackHeaderWidth: TRACK_HEADER_WIDTH,
    playheadTrackHeaderWidth: 0, // Playhead is rendered inside a clipped container offset by the header
    isPlaying,
    togglePlayback,
    seek: seekFromPlayheadDrag,
    snapEnabled,
    snapPoints,
    snapThreshold,
    onSnapChange: setActiveSnapPoint,
    scrollContainerRef: playheadViewportRef,
    onScrollChange: setScrollX,
  });

  // ===========================================================================
  // Auto-Follow (scroll to playhead during playback)
  // ===========================================================================
  // Auto-follow hook handles auto-scrolling during playback
  useAutoFollow({
    viewportWidth,
    trackHeaderWidth: TRACK_HEADER_WIDTH,
    isScrubbing,
    isDraggingPlayhead,
  });

  // ===========================================================================
  // Timeline Panning (Hand Tool / Middle Mouse)
  // ===========================================================================
  const maxScrollX = Math.max(0, duration * zoom - viewportWidth + TRACK_HEADER_WIDTH);
  const maxScrollY = Math.max(0, (sequence?.tracks.length ?? 0) * TRACK_HEIGHT - 300);
  const isHandToolActive = activeTool === 'hand';

  const { isPanning, handleMouseDown: handlePanMouseDown } = useTimelinePan({
    scrollX,
    scrollY,
    setScrollX,
    setScrollY: useTimelineStore.getState().setScrollY,
    maxScrollX,
    maxScrollY,
    isHandToolActive,
    enabled: true,
  });

  // ===========================================================================
  // Razor Tool
  // ===========================================================================
  const {
    isActive: isRazorActive,
    getCursorStyle: getToolCursorStyle,
    handleTimelineClick: handleRazorClick,
  } = useRazorTool({
    sequence,
    zoom,
    scrollX,
    trackHeaderWidth: TRACK_HEADER_WIDTH,
    trackHeight: TRACK_HEIGHT,
    onSplit: onClipSplit,
  });

  // ===========================================================================
  // Ripple Edit Mode (must be before delete handler)
  // ===========================================================================
  const { isRippleEnabled, calculateDeleteRipple, toggleRipple } = useRippleEdit({
    sequence,
  });

  // ===========================================================================
  // Advanced Edit Mode Hooks (Slip, Slide, Roll)
  // ===========================================================================
  const { isSlipToolActive } = useSlipEdit({
    onSlipEnd: (clipId, sourceIn, sourceOut) => {
      // Find clip and track, then apply trim
      if (!sequence || !onClipTrim) return;
      for (const track of sequence.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          onClipTrim({
            sequenceId: sequence.id,
            trackId: track.id,
            clipId,
            newSourceIn: sourceIn,
            newSourceOut: sourceOut,
          });
          break;
        }
      }
    },
  });

  const { isSlideToolActive } = useSlideEdit({
    onSlideEnd: (result) => {
      if (!sequence || !onClipMove || !onClipTrim) return;
      // Apply changes to previous clip (find correct track)
      if (result.previousClipChange) {
        for (const track of sequence.tracks) {
          if (track.clips.some((c) => c.id === result.previousClipChange!.clipId)) {
            onClipTrim({
              sequenceId: sequence.id,
              trackId: track.id,
              clipId: result.previousClipChange.clipId,
              newSourceOut: result.previousClipChange.sourceOut,
            });
            break;
          }
        }
      }
      // Apply changes to next clip (find correct track)
      if (result.nextClipChange) {
        for (const track of sequence.tracks) {
          if (track.clips.some((c) => c.id === result.nextClipChange!.clipId)) {
            onClipTrim({
              sequenceId: sequence.id,
              trackId: track.id,
              clipId: result.nextClipChange.clipId,
              newSourceIn: result.nextClipChange.sourceIn,
            });
            break;
          }
        }
      }
    },
  });

  const { isRollToolActive } = useRollEdit({
    onRollEnd: (result) => {
      if (!sequence || !onClipTrim) return;
      // Apply roll changes to both clips
      for (const track of sequence.tracks) {
        if (track.clips.some((c) => c.id === result.outgoingClipChange.clipId || c.id === result.incomingClipChange.clipId)) {
          // Update outgoing clip
          onClipTrim({
            sequenceId: sequence.id,
            trackId: track.id,
            clipId: result.outgoingClipChange.clipId,
            newSourceOut: result.outgoingClipChange.sourceOut,
          });
          // Update incoming clip
          onClipTrim({
            sequenceId: sequence.id,
            trackId: track.id,
            clipId: result.incomingClipChange.clipId,
            newSourceIn: result.incomingClipChange.sourceIn,
          });
          break;
        }
      }
    },
  });

  // ===========================================================================
  // Clipboard Operations
  // ===========================================================================
  const {
    copy,
    cut,
    paste,
    duplicate,
    canCopy,
    canPaste,
  } = useClipboard({
    sequence,
    selectedClipIds,
    onDuplicate: onClipDuplicate
      ? (clipIds: string[], targetTime: number) => {
          if (sequence) {
            // Duplicate each clip
            for (const clipId of clipIds) {
              for (const track of sequence.tracks) {
                const clip = track.clips.find((c) => c.id === clipId);
                if (clip) {
                  onClipDuplicate({
                    sequenceId: sequence.id,
                    trackId: track.id,
                    clipId,
                    newTimelineIn: targetTime,
                  });
                  break;
                }
              }
            }
          }
        }
      : undefined,
    onPaste: onClipPaste
      ? (clips, targetTime, targetTrackId) => {
          if (sequence && clips.length > 0) {
            // Paste all items
            for (const item of clips) {
              onClipPaste({
                sequenceId: sequence.id,
                trackId: targetTrackId ?? item.trackId,
                clipData: item.clipData,
                pasteTime: targetTime,
              });
            }
          }
        }
      : undefined,
    onDelete: onDeleteClips,
  });

  // ===========================================================================
  // Ripple-Aware Delete Handler (must be before keyboard shortcuts)
  // ===========================================================================
  const handleRippleDelete = useCallback(
    (clipIdsToDelete: string[]) => {
      if (clipIdsToDelete.length === 0 || !onDeleteClips) return;

      // If ripple mode is enabled, apply ripple adjustments after delete
      if (isRippleEnabled && sequence && onClipMove) {
        // Calculate ripple adjustments before deleting
        const rippleResult = calculateDeleteRipple(clipIdsToDelete);

        // Delete the selected clips
        onDeleteClips(clipIdsToDelete);

        // Apply ripple adjustments to shift remaining clips
        for (const adjustment of rippleResult.affectedClips) {
          onClipMove({
            sequenceId: sequence.id,
            trackId: adjustment.trackId,
            clipId: adjustment.clipId,
            newTimelineIn: adjustment.newTime,
          });
        }
      } else {
        // Normal delete without ripple
        onDeleteClips(clipIdsToDelete);
      }
    },
    [onDeleteClips, isRippleEnabled, sequence, onClipMove, calculateDeleteRipple],
  );

  // ===========================================================================
  // Keyboard Shortcuts
  // ===========================================================================
  const { handleKeyDown: baseHandleKeyDown } = useTimelineKeyboard({
    sequence,
    selectedClipIds,
    playhead,
    togglePlayback,
    stepForward,
    stepBackward,
    clearClipSelection,
    selectClips,
    onDeleteClips: handleRippleDelete, // Use ripple-aware delete
    onClipSplit,
  });

  // Enhanced keyboard handler with clipboard operations and tool switching
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Clipboard shortcuts (Ctrl/Cmd + key)
      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'c':
            if (canCopy) {
              copy();
              e.preventDefault();
              return;
            }
            break;
          case 'x':
            if (canCopy) {
              cut();
              e.preventDefault();
              return;
            }
            break;
          case 'v':
            if (canPaste) {
              paste();
              e.preventDefault();
              return;
            }
            break;
          case 'd':
            if (canCopy) {
              duplicate();
              e.preventDefault();
              return;
            }
            break;
        }
      }

      // Tool switching shortcuts (no modifiers)
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        switch (e.key.toLowerCase()) {
          case 'v':
            setActiveTool('select');
            e.preventDefault();
            return;
          case 'c':
            setActiveTool('razor');
            e.preventDefault();
            return;
          case 'b':
            setActiveTool('razor');
            e.preventDefault();
            return;
          case 'y':
            setActiveTool('slip');
            e.preventDefault();
            return;
          case 'u':
            setActiveTool('slide');
            e.preventDefault();
            return;
          case 'n':
            setActiveTool('roll');
            e.preventDefault();
            return;
          case 'h':
            setActiveTool('hand');
            e.preventDefault();
            return;
          case 'r':
            // Toggle ripple mode
            toggleRipple();
            e.preventDefault();
            return;
          case 't':
            // Add text clip
            if (onAddText) {
              onAddText();
              e.preventDefault();
              return;
            }
            break;
        }
      }

      // Delegate to base keyboard handler
      baseHandleKeyDown(e);
    },
    [baseHandleKeyDown, canCopy, canPaste, copy, cut, paste, duplicate, setActiveTool, toggleRipple, onAddText],
  );

  // ===========================================================================
  // Clip Operations Hook
  // ===========================================================================
  const {
    dragPreview,
    getTrackClips,
    handleClipDragStart: baseHandleClipDragStart,
    handleClipDrag: baseHandleClipDrag,
    handleClipDragEnd: baseHandleClipDragEnd,
  } = useTimelineClipOperations({
    sequence,
    zoom,
    onClipMove,
    onClipTrim,
    selectClip,
  });

  // Wrapped clip drag handlers to track mouse position for edge auto-scroll
  const handleClipDragStart: typeof baseHandleClipDragStart = useCallback(
    (trackId, data) => {
      setIsClipDragging(true);
      clipDragMouseXRef.current = data.startX;
      baseHandleClipDragStart(trackId, data);
    },
    [baseHandleClipDragStart],
  );

  const handleClipDrag: typeof baseHandleClipDrag = useCallback(
    (trackId, data, previewPosition, targetTrackIndex) => {
      // The clip drag hook doesn't expose current mouse position in callbacks,
      // so we track it via a global mousemove listener when dragging (added below)
      baseHandleClipDrag(trackId, data, previewPosition, targetTrackIndex);
    },
    [baseHandleClipDrag],
  );

  const handleClipDragEnd: typeof baseHandleClipDragEnd = useCallback(
    (trackId, data, finalPosition, targetTrackIndex) => {
      setIsClipDragging(false);
      baseHandleClipDragEnd(trackId, data, finalPosition, targetTrackIndex);
    },
    [baseHandleClipDragEnd],
  );

  // Track mouse position during clip drag for edge auto-scroll
  useLayoutEffect(() => {
    if (!isClipDragging) return;

    const handleMouseMove = (e: globalThis.MouseEvent) => {
      clipDragMouseXRef.current = e.clientX;
    };

    document.addEventListener('mousemove', handleMouseMove);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
    };
  }, [isClipDragging]);

  // Edge auto-scroll during clip drag
  useEdgeAutoScroll({
    isActive: isClipDragging && dragPreview !== null,
    getMouseClientX: () => clipDragMouseXRef.current,
    scrollContainerRef: tracksAreaRef,
    contentWidth: duration * zoom + TRACK_HEADER_WIDTH,
    // Timeline uses virtual scrolling via Zustand (`scrollX`) + transforms (not native scrollLeft).
    getScrollLeft: () => useTimelineStore.getState().scrollX,
    setScrollLeft: setScrollX,
  });

  // ===========================================================================
  // Navigation Hook
  // ===========================================================================
  const { handleWheel, handleFitToWindow } = useTimelineNavigation({
    scrollX,
    zoom,
    duration,
    zoomIn,
    zoomOut,
    setZoom,
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

  const handleSeek = useCallback((time: number) => seekFromTimeRuler(time), [seekFromTimeRuler]);

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
      // Handle razor tool click - split clip at click position
      if (isRazorActive && tracksAreaRef.current) {
        const containerRect = tracksAreaRef.current.getBoundingClientRect();
        const handled = handleRazorClick(e.clientX, e.clientY, containerRect);
        if (handled) {
          // Razor tool handled the click, don't process further
          return;
        }
      }

      // Don't clear selection if we were doing a selection box drag
      if (isSelecting) return;

      if ((e.target as HTMLElement).getAttribute('data-testid') === 'timeline-tracks-area') {
        clearClipSelection();
      }
    },
    [clearClipSelection, isSelecting, isRazorActive, handleRazorClick],
  );

  /**
   * Ensure primary clicks anywhere in the editable tracks content
   * immediately move the playhead, even when the target clip consumes
   * bubbling mouse events for drag/trim interactions.
   */
  const handleTracksAreaMouseDownCapture = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0 || isRazorActive) return;

      const target = e.target as HTMLElement;

      // Keep interactive controls and trim handles untouched.
      // Trim handles must initiate their own resize interaction.
      if (
        target.closest('button') ||
        target.closest('[data-testid$="-trim-left"]') ||
        target.closest('[data-testid$="-trim-right"]')
      ) {
        return;
      }

      const { time } = calculateTimeFromMouseEvent(e, true);
      if (time !== null) {
        seekFromTimelineClick(time);
      }
    },
    [calculateTimeFromMouseEvent, isRazorActive, seekFromTimelineClick],
  );

  /**
   * Combined mouse down handler for scrubbing and selection box
   * Both can coexist: scrubbing sets playhead position immediately,
   * while selection box handles drag-to-select.
   */
  const handleTracksAreaMouseDown = useCallback(
    (e: MouseEvent) => {
      // If razor tool is active, don't start scrubbing or selection
      if (isRazorActive) {
        return;
      }

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
    [handleSelectionMouseDown, handleScrubStart, isRazorActive],
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
  // Toolbar Action Handlers (must be before conditional return for hook rules)
  // ===========================================================================

  const handleToolbarSplit = useCallback(() => {
    if (selectedClipIds.length > 0 && sequence && onClipSplit) {
      for (const clipId of selectedClipIds) {
        for (const track of sequence.tracks) {
          const clip = track.clips.find((c) => c.id === clipId);
          if (clip) {
            const clipEnd =
              clip.place.timelineInSec +
              (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
            if (playhead > clip.place.timelineInSec && playhead < clipEnd) {
              onClipSplit({
                sequenceId: sequence.id,
                trackId: track.id,
                clipId,
                splitTime: playhead,
              });
            }
            break;
          }
        }
      }
    }
  }, [selectedClipIds, sequence, playhead, onClipSplit]);

  const handleToolbarDuplicate = useCallback(() => {
    if (selectedClipIds.length > 0 && sequence && onClipDuplicate) {
      for (const clipId of selectedClipIds) {
        for (const track of sequence.tracks) {
          const clip = track.clips.find((c) => c.id === clipId);
          if (clip) {
            const clipDuration =
              (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
            onClipDuplicate({
              sequenceId: sequence.id,
              trackId: track.id,
              clipId,
              newTimelineIn: clip.place.timelineInSec + clipDuration,
            });
            break;
          }
        }
      }
    }
  }, [selectedClipIds, sequence, onClipDuplicate]);

  const handleToolbarDelete = useCallback(() => {
    handleRippleDelete(selectedClipIds);
  }, [selectedClipIds, handleRippleDelete]);

  // ===========================================================================
  // Combined Mouse Down Handler
  // ===========================================================================
  // Must be defined before early return to satisfy React hooks rules
  const handleTracksAreaMouseDownCombined = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      // Try panning first (middle mouse or hand tool)
      handlePanMouseDown(e);
      // Then fall through to existing handler if not handled
      if (!isPanning && !isHandToolActive) {
        handleTracksAreaMouseDown(e);
      }
    },
    [handlePanMouseDown, isPanning, isHandToolActive, handleTracksAreaMouseDown]
  );

  // ===========================================================================
  // Timeline Operations Context
  // ===========================================================================
  // Memoize operations object to prevent unnecessary re-renders of context consumers
  const timelineOperations = useMemo<TimelineOperations>(
    () => ({
      onDeleteClips,
      onAssetDrop,
      onClipMove,
      onClipTrim,
      onClipSplit,
      onClipDuplicate,
      onClipPaste,
      onTrackMuteToggle,
      onTrackLockToggle,
      onTrackVisibilityToggle,
      onAddText,
    }),
    [
      onDeleteClips,
      onAssetDrop,
      onClipMove,
      onClipTrim,
      onClipSplit,
      onClipDuplicate,
      onClipPaste,
      onTrackMuteToggle,
      onTrackLockToggle,
      onTrackVisibilityToggle,
      onAddText,
    ]
  );

  // ===========================================================================
  // Render
  // ===========================================================================
  if (!sequence) {
    return (
      <div
        data-testid="timeline"
        className="h-full flex flex-col items-center justify-center text-editor-text-muted bg-editor-panel"
      >
        <svg
          className="w-16 h-16 mb-4 text-editor-text-muted/50"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"
          />
        </svg>
        <p className="text-lg font-medium mb-1">No sequence loaded</p>
        <p className="text-sm text-editor-text-muted/70">
          Import media or create a new sequence to start editing
        </p>
      </div>
    );
  }

  // Determine cursor style based on active tool and interaction state
  const getTracksAreaCursor = (): string => {
    // Panning cursor takes priority
    if (isPanning) return 'cursor-grabbing';
    if (isHandToolActive) return 'cursor-grab';
    if (isScrubbing || isDraggingPlayhead) return 'cursor-ew-resize';
    if (isSelecting) return 'cursor-crosshair';
    // Advanced edit mode cursors
    if (isSlipToolActive) return 'cursor-ew-resize';
    if (isSlideToolActive) return 'cursor-move';
    if (isRollToolActive) return 'cursor-col-resize';
    // Tool-specific cursors from razor
    const toolCursor = getToolCursorStyle();
    if (toolCursor === 'crosshair') return 'cursor-crosshair';
    if (toolCursor === 'grab') return 'cursor-grab';
    if (toolCursor === 'ew-resize') return 'cursor-ew-resize';
    return '';
  };

  return (
    <TimelineOperationsProvider operations={timelineOperations}>
      <div
        data-testid="timeline"
        className="h-full flex flex-col bg-editor-panel overflow-hidden focus:outline-none"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <EnhancedTimelineToolbar
          onFitToWindow={handleFitToWindow}
          onAddText={onAddText}
          onSplit={handleToolbarSplit}
          onDuplicate={handleToolbarDuplicate}
          onDelete={handleToolbarDelete}
          hasActiveSequence={sequence !== null}
          fps={DEFAULT_FPS}
          duration={duration}
        />

        {/* Main timeline area with ruler and tracks - relative container for playhead */}
        {/* isolation: isolate creates a stacking context so playhead z-index doesn't escape to overlap modals */}
        <div className="flex-1 flex flex-col relative isolate">
          {/* Ruler row */}
          <div className="flex border-b border-editor-border flex-shrink-0">
            {/* Track header area label */}
            <div className="w-48 flex-shrink-0 bg-editor-sidebar border-r border-editor-border flex items-center justify-center">
              <span className="text-xs text-editor-text-muted font-medium uppercase tracking-wider select-none">
                Tracks
              </span>
            </div>
            <div className="flex-1 overflow-hidden" onWheel={handleWheel}>
              <div style={{ transform: `translateX(-${scrollX}px)` }}>
                <TimeRuler duration={duration} zoom={zoom} scrollX={scrollX} onSeek={handleSeek} />
              </div>
            </div>
          </div>

          {/* Tracks area */}
          <div
            ref={tracksAreaRef}
            data-testid="timeline-tracks-area"
            className={`flex-1 overflow-hidden relative ${getTracksAreaCursor()}`}
            onClick={handleTracksAreaClick}
            onMouseDownCapture={handleTracksAreaMouseDownCapture}
            onMouseDown={handleTracksAreaMouseDownCombined}
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
                    onSnapPointChange={setActiveSnapPoint}
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
              isActive={isScrubbing || isDraggingPlayhead || isClipDragging}
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

          {/* Playhead container - clips playhead to timeline area (not track header) */}
          <div
            ref={playheadViewportRef}
            className="absolute top-0 bottom-0 overflow-hidden pointer-events-none"
            style={{
              left: `${TRACK_HEADER_WIDTH}px`,
              right: 0,
            }}
          >
            {/* Playhead - repositioned relative to clipping container */}
            <Playhead
              ref={playheadRef}
              position={playhead}
              zoom={zoom}
              scrollX={scrollX}
              trackHeaderWidth={0} // No offset needed - container handles it
              isPlaying={isPlaying}
              isDragging={isDraggingPlayhead}
              onDragStart={handlePlayheadDragStart}
              onPointerDown={handlePlayheadPointerDown}
            />
          </div>
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
    </TimelineOperationsProvider>
  );
}
