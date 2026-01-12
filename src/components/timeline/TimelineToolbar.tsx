/**
 * TimelineToolbar Component
 *
 * Toolbar for timeline with zoom controls, snap toggle, and fit to window.
 */

import { useCallback, type KeyboardEvent } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Magnet } from 'lucide-react';
import { useTimelineStore } from '@/stores/timelineStore';

// =============================================================================
// Types
// =============================================================================

export interface TimelineToolbarProps {
  /** Callback when fit to window is clicked */
  onFitToWindow?: () => void;
}

// =============================================================================
// Constants
// =============================================================================

const MIN_ZOOM = 10;
const MAX_ZOOM = 500;

// =============================================================================
// Component
// =============================================================================

export function TimelineToolbar({ onFitToWindow }: TimelineToolbarProps) {
  const { zoom, snapEnabled, setZoom, zoomIn, zoomOut, toggleSnap } = useTimelineStore();

  // ===========================================================================
  // Handlers
  // ===========================================================================

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

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div
      data-testid="timeline-toolbar"
      className="flex items-center gap-2 px-2 py-1 bg-editor-sidebar border-b border-editor-border"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Snap Toggle */}
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
        title={snapEnabled ? 'Disable snap' : 'Enable snap'}
      >
        <Magnet className="w-4 h-4" />
      </button>

      {/* Divider */}
      <div className="w-px h-4 bg-editor-border" />

      {/* Zoom Controls */}
      <div className="flex items-center gap-1">
        {/* Zoom Out */}
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

        {/* Zoom Slider */}
        <input
          data-testid="zoom-slider"
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          value={zoom}
          onChange={handleZoomSliderChange}
          className="w-24 h-1 bg-editor-border rounded-full appearance-none cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
            [&::-webkit-slider-thumb]:bg-primary-500 [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:hover:bg-primary-400"
          title="Zoom level"
        />

        {/* Zoom In */}
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

        {/* Zoom Display */}
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
  );
}
