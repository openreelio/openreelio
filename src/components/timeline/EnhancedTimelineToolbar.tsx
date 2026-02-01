/**
 * Enhanced Timeline Toolbar Component
 *
 * Professional-grade timeline toolbar with tool selection, playback controls,
 * and editing mode toggles. Similar to OpenCut and Premiere Pro toolbars.
 *
 * @module components/timeline/EnhancedTimelineToolbar
 */

import { memo, useCallback, type KeyboardEvent } from 'react';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Magnet,
  Type,
  Scissors,
  Hand,
  MousePointer,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ChevronFirst,
  ChevronLast,
  Copy,
  Trash2,
  Layers,
  Focus,
} from 'lucide-react';
import { useTimelineStore } from '@/stores/timelineStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useEditorToolStore, TOOL_CONFIGS, type EditorTool } from '@/stores/editorToolStore';
import { formatTimecode } from '@/utils/formatters';

// =============================================================================
// Types
// =============================================================================

export interface EnhancedTimelineToolbarProps {
  /** Callback when fit to window is clicked */
  onFitToWindow?: () => void;
  /** Callback when add text is clicked */
  onAddText?: () => void;
  /** Callback when split is clicked */
  onSplit?: () => void;
  /** Callback when duplicate is clicked */
  onDuplicate?: () => void;
  /** Callback when delete is clicked */
  onDelete?: () => void;
  /** Whether there's an active sequence */
  hasActiveSequence?: boolean;
  /** Current FPS for timecode display */
  fps?: number;
  /** Total duration in seconds */
  duration?: number;
}

// =============================================================================
// Constants
// =============================================================================

const MIN_ZOOM = 10;
const MAX_ZOOM = 500;

// =============================================================================
// Sub-Components
// =============================================================================

interface ToolButtonProps {
  tool: EditorTool;
  activeTool: EditorTool;
  onClick: (tool: EditorTool) => void;
  disabled?: boolean;
}

const ToolButton = memo(function ToolButton({
  tool,
  activeTool,
  onClick,
  disabled = false,
}: ToolButtonProps) {
  const config = TOOL_CONFIGS[tool];
  const isActive = activeTool === tool;

  const getIcon = () => {
    switch (tool) {
      case 'select':
        return <MousePointer className="w-4 h-4" />;
      case 'razor':
        return <Scissors className="w-4 h-4" />;
      case 'hand':
        return <Hand className="w-4 h-4" />;
      case 'ripple':
      case 'slip':
      case 'slide':
      case 'roll':
        return <Layers className="w-4 h-4" />;
      default:
        return <MousePointer className="w-4 h-4" />;
    }
  };

  return (
    <button
      type="button"
      className={`
        p-1.5 rounded transition-colors
        ${isActive
          ? 'bg-primary-500/30 text-primary-400'
          : 'text-editor-text-muted hover:bg-editor-border hover:text-editor-text'
        }
        disabled:opacity-50 disabled:cursor-not-allowed
      `}
      onClick={() => onClick(tool)}
      disabled={disabled}
      title={`${config.label} (${config.shortcut})`}
    >
      {getIcon()}
    </button>
  );
});

// =============================================================================
// Main Component
// =============================================================================

function EnhancedTimelineToolbarComponent({
  onFitToWindow,
  onAddText,
  onSplit,
  onDuplicate,
  onDelete,
  hasActiveSequence = false,
  fps = 30,
  duration = 0,
}: EnhancedTimelineToolbarProps) {
  // Store state
  const { zoom, snapEnabled, setZoom, zoomIn, zoomOut, toggleSnap } = useTimelineStore();
  const {
    isPlaying,
    currentTime,
    togglePlayback,
    goToStart,
    goToEnd,
    stepForward,
    stepBackward,
  } = usePlaybackStore();
  const {
    activeTool,
    setActiveTool,
    rippleEnabled,
    autoScrollEnabled,
    toggleRipple,
    toggleAutoScroll,
  } = useEditorToolStore();

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleToolChange = useCallback(
    (tool: EditorTool) => {
      setActiveTool(tool);
    },
    [setActiveTool]
  );

  const handleZoomIn = useCallback(() => {
    zoomIn();
  }, [zoomIn]);

  const handleZoomOut = useCallback(() => {
    zoomOut();
  }, [zoomOut]);

  const handleZoomSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setZoom(parseInt(e.target.value, 10));
    },
    [setZoom]
  );

  const handleFitToWindow = useCallback(() => {
    onFitToWindow?.();
  }, [onFitToWindow]);

  const handleSnapToggle = useCallback(() => {
    toggleSnap();
  }, [toggleSnap]);

  const handleRippleToggle = useCallback(() => {
    toggleRipple();
  }, [toggleRipple]);

  const handleAutoScrollToggle = useCallback(() => {
    toggleAutoScroll();
  }, [toggleAutoScroll]);

  const handleAddText = useCallback(() => {
    onAddText?.();
  }, [onAddText]);

  const handleSplit = useCallback(() => {
    onSplit?.();
  }, [onSplit]);

  const handleDuplicate = useCallback(() => {
    onDuplicate?.();
  }, [onDuplicate]);

  const handleDelete = useCallback(() => {
    onDelete?.();
  }, [onDelete]);

  const handlePlayPause = useCallback(() => {
    togglePlayback();
  }, [togglePlayback]);

  const handleGoToStart = useCallback(() => {
    goToStart();
  }, [goToStart]);

  const handleGoToEnd = useCallback(() => {
    goToEnd();
  }, [goToEnd]);

  const handleStepBackward = useCallback(() => {
    stepBackward(fps);
  }, [stepBackward, fps]);

  const handleStepForward = useCallback(() => {
    stepForward(fps);
  }, [stepForward, fps]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        switch (e.key) {
          case '+':
          case '=':
            e.preventDefault();
            zoomIn();
            break;
          case '-':
            e.preventDefault();
            zoomOut();
            break;
          case '0':
            e.preventDefault();
            onFitToWindow?.();
            break;
        }
      }
    },
    [zoomIn, zoomOut, onFitToWindow]
  );

  // ===========================================================================
  // Computed Values
  // ===========================================================================

  const isAtMaxZoom = zoom >= MAX_ZOOM;
  const isAtMinZoom = zoom <= MIN_ZOOM;
  const zoomPercentage = Math.round(zoom);
  const currentTimecode = formatTimecode(currentTime, fps);
  const durationTimecode = formatTimecode(duration, fps);

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div
      data-testid="enhanced-timeline-toolbar"
      className="flex items-center justify-between gap-2 px-2 py-1 bg-editor-sidebar border-b border-editor-border"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Left Section: Tools and Editing Actions */}
      <div className="flex items-center gap-1">
        {/* Tool Selection */}
        <div className="flex items-center gap-0.5 bg-editor-panel/50 rounded p-0.5">
          <ToolButton
            tool="select"
            activeTool={activeTool}
            onClick={handleToolChange}
          />
          <ToolButton
            tool="razor"
            activeTool={activeTool}
            onClick={handleToolChange}
          />
          <ToolButton
            tool="hand"
            activeTool={activeTool}
            onClick={handleToolChange}
          />
        </div>

        {/* Divider */}
        <div className="w-px h-4 bg-editor-border" />

        {/* Editing Actions */}
        <button
          type="button"
          className="p-1.5 rounded text-editor-text-muted hover:bg-editor-border hover:text-editor-text disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleSplit}
          disabled={!hasActiveSequence}
          title="Split at Playhead (S)"
        >
          <Scissors className="w-4 h-4" />
        </button>

        <button
          type="button"
          className="p-1.5 rounded text-editor-text-muted hover:bg-editor-border hover:text-editor-text disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleDuplicate}
          disabled={!hasActiveSequence}
          title="Duplicate (Ctrl+D)"
        >
          <Copy className="w-4 h-4" />
        </button>

        <button
          type="button"
          className="p-1.5 rounded text-editor-text-muted hover:bg-editor-border hover:text-editor-text disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleDelete}
          disabled={!hasActiveSequence}
          title="Delete (Delete)"
        >
          <Trash2 className="w-4 h-4" />
        </button>

        {/* Divider */}
        <div className="w-px h-4 bg-editor-border" />

        {/* Add Text Button */}
        <button
          data-testid="add-text-button"
          type="button"
          className="p-1.5 rounded text-teal-400 hover:bg-teal-600/20 hover:text-teal-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          onClick={handleAddText}
          disabled={!hasActiveSequence}
          title="Add text (T)"
        >
          <Type className="w-4 h-4" />
        </button>
      </div>

      {/* Center Section: Playback Controls and Timecode */}
      <div className="flex items-center gap-2">
        {/* Playback Controls */}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className="p-1.5 rounded text-editor-text-muted hover:bg-editor-border hover:text-editor-text"
            onClick={handleGoToStart}
            title="Go to Start (Home)"
          >
            <ChevronFirst className="w-4 h-4" />
          </button>

          <button
            type="button"
            className="p-1.5 rounded text-editor-text-muted hover:bg-editor-border hover:text-editor-text"
            onClick={handleStepBackward}
            title="Previous Frame (Left Arrow)"
          >
            <SkipBack className="w-4 h-4" />
          </button>

          <button
            type="button"
            className={`p-1.5 rounded transition-colors ${
              isPlaying
                ? 'bg-primary-500/30 text-primary-400'
                : 'text-editor-text-muted hover:bg-editor-border hover:text-editor-text'
            }`}
            onClick={handlePlayPause}
            title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>

          <button
            type="button"
            className="p-1.5 rounded text-editor-text-muted hover:bg-editor-border hover:text-editor-text"
            onClick={handleStepForward}
            title="Next Frame (Right Arrow)"
          >
            <SkipForward className="w-4 h-4" />
          </button>

          <button
            type="button"
            className="p-1.5 rounded text-editor-text-muted hover:bg-editor-border hover:text-editor-text"
            onClick={handleGoToEnd}
            title="Go to End (End)"
          >
            <ChevronLast className="w-4 h-4" />
          </button>
        </div>

        {/* Timecode Display */}
        <div className="flex items-center gap-1 px-2 py-0.5 bg-editor-panel rounded text-xs font-mono">
          <span className="text-editor-text">{currentTimecode}</span>
          <span className="text-editor-text-muted">/</span>
          <span className="text-editor-text-muted">{durationTimecode}</span>
        </div>
      </div>

      {/* Right Section: View Controls */}
      <div className="flex items-center gap-1">
        {/* Mode Toggles */}
        <button
          data-testid="snap-toggle-button"
          type="button"
          aria-pressed={snapEnabled}
          className={`p-1.5 rounded transition-colors ${
            snapEnabled
              ? 'bg-primary-500/20 text-primary-400'
              : 'text-editor-text-muted hover:bg-editor-border hover:text-editor-text'
          }`}
          onClick={handleSnapToggle}
          title={snapEnabled ? 'Disable Snap (N)' : 'Enable Snap (N)'}
        >
          <Magnet className="w-4 h-4" />
        </button>

        <button
          type="button"
          aria-pressed={rippleEnabled}
          className={`p-1.5 rounded transition-colors ${
            rippleEnabled
              ? 'bg-amber-500/20 text-amber-400'
              : 'text-editor-text-muted hover:bg-editor-border hover:text-editor-text'
          }`}
          onClick={handleRippleToggle}
          title={rippleEnabled ? 'Disable Ripple Edit (R)' : 'Enable Ripple Edit (R)'}
        >
          <Layers className="w-4 h-4" />
        </button>

        <button
          type="button"
          aria-pressed={autoScrollEnabled}
          className={`p-1.5 rounded transition-colors ${
            autoScrollEnabled
              ? 'bg-green-500/20 text-green-400'
              : 'text-editor-text-muted hover:bg-editor-border hover:text-editor-text'
          }`}
          onClick={handleAutoScrollToggle}
          title={autoScrollEnabled ? 'Disable Auto-Follow (Shift+F)' : 'Enable Auto-Follow (Shift+F)'}
        >
          <Focus className="w-4 h-4" />
        </button>

        {/* Divider */}
        <div className="w-px h-4 bg-editor-border" />

        {/* Zoom Controls */}
        <div className="flex items-center gap-1">
          <button
            data-testid="zoom-out-button"
            type="button"
            className="p-1.5 rounded text-editor-text-muted hover:bg-editor-border hover:text-editor-text disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleZoomOut}
            disabled={isAtMinZoom}
            title="Zoom out (Ctrl+-)"
          >
            <ZoomOut className="w-4 h-4" />
          </button>

          <input
            data-testid="zoom-slider"
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            value={zoom}
            onChange={handleZoomSliderChange}
            className="w-20 h-1 bg-editor-border rounded-full appearance-none cursor-pointer
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
              [&::-webkit-slider-thumb]:bg-primary-500 [&::-webkit-slider-thumb]:rounded-full
              [&::-webkit-slider-thumb]:hover:bg-primary-400"
            title="Zoom level"
          />

          <button
            data-testid="zoom-in-button"
            type="button"
            className="p-1.5 rounded text-editor-text-muted hover:bg-editor-border hover:text-editor-text disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleZoomIn}
            disabled={isAtMaxZoom}
            title="Zoom in (Ctrl++)"
          >
            <ZoomIn className="w-4 h-4" />
          </button>

          <span
            data-testid="zoom-display"
            className="text-xs text-editor-text-muted w-10 text-center"
          >
            {zoomPercentage}%
          </span>
        </div>

        {/* Divider */}
        <div className="w-px h-4 bg-editor-border" />

        {/* Fit to Window */}
        <button
          data-testid="fit-to-window-button"
          type="button"
          className="p-1.5 rounded text-editor-text-muted hover:bg-editor-border hover:text-editor-text"
          onClick={handleFitToWindow}
          title="Fit to window (Ctrl+0)"
        >
          <Maximize2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export const EnhancedTimelineToolbar = memo(EnhancedTimelineToolbarComponent);

export default EnhancedTimelineToolbar;
