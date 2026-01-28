/**
 * PreviewToolbar Component
 *
 * Provides zoom controls for the preview canvas.
 * Includes zoom presets, fit/fill modes, and reset button.
 */

import { memo, useCallback, useState, useRef, useEffect } from 'react';
import { usePreviewStore, ZOOM_PRESETS, type ZoomMode } from '@/stores/previewStore';

// =============================================================================
// Types
// =============================================================================

export interface PreviewToolbarProps {
  /** Current zoom percentage string */
  zoomPercentage: string;
  /** Current zoom mode */
  zoomMode: ZoomMode;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Icons
// =============================================================================

function ZoomInIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v6m3-3H7"
      />
    </svg>
  );
}

function ZoomOutIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10H7"
      />
    </svg>
  );
}

function FitIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
      />
    </svg>
  );
}

function ResetIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </svg>
  );
}

function ChevronDownIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

// =============================================================================
// Component
// =============================================================================

export const PreviewToolbar = memo(function PreviewToolbar({
  zoomPercentage,
  zoomMode,
  className = '',
}: PreviewToolbarProps) {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentZoomLevel = usePreviewStore((state) => state.zoomLevel);
  const setZoomLevel = usePreviewStore((state) => state.setZoomLevel);
  const setZoomMode = usePreviewStore((state) => state.setZoomMode);
  const zoomIn = usePreviewStore((state) => state.zoomIn);
  const zoomOut = usePreviewStore((state) => state.zoomOut);
  const resetView = usePreviewStore((state) => state.resetView);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    };

    if (isDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isDropdownOpen]);

  const handleZoomPreset = useCallback(
    (value: number) => {
      setZoomLevel(value);
      setIsDropdownOpen(false);
    },
    [setZoomLevel],
  );

  const handleZoomModeSelect = useCallback(
    (mode: ZoomMode) => {
      setZoomMode(mode);
      setIsDropdownOpen(false);
    },
    [setZoomMode],
  );

  const getModeLabel = (mode: ZoomMode): string => {
    switch (mode) {
      case 'fit':
        return 'Fit';
      case 'fill':
        return 'Fill';
      case '100%':
        return '100%';
      case 'custom':
        return zoomPercentage;
    }
  };

  return (
    <div
      className={`flex items-center gap-1 bg-editor-bg border-t border-editor-border px-2 py-1 ${className}`}
      data-testid="preview-toolbar"
    >
      {/* Zoom Out Button */}
      <button
        type="button"
        className="p-1 hover:bg-editor-hover rounded text-editor-text-muted hover:text-editor-text transition-colors"
        onClick={zoomOut}
        title="Zoom Out"
        aria-label="Zoom out"
      >
        <ZoomOutIcon />
      </button>

      {/* Zoom Dropdown */}
      <div className="relative" ref={dropdownRef}>
        <button
          type="button"
          className="flex items-center gap-1 px-2 py-1 hover:bg-editor-hover rounded text-editor-text text-sm min-w-[80px] justify-between"
          onClick={() => setIsDropdownOpen(!isDropdownOpen)}
          aria-haspopup="listbox"
          aria-expanded={isDropdownOpen}
        >
          <span>{getModeLabel(zoomMode)}</span>
          <ChevronDownIcon className="w-3 h-3" />
        </button>

        {isDropdownOpen && (
          <div
            className="absolute bottom-full left-0 mb-1 bg-editor-bg border border-editor-border rounded shadow-lg py-1 min-w-[120px] z-50"
            role="listbox"
          >
            {/* Mode Options */}
            <div className="border-b border-editor-border pb-1 mb-1">
              <button
                type="button"
                className={`w-full text-left px-3 py-1 text-sm hover:bg-editor-hover ${
                  zoomMode === 'fit' ? 'text-accent-primary' : 'text-editor-text'
                }`}
                onClick={() => handleZoomModeSelect('fit')}
                role="option"
                aria-selected={zoomMode === 'fit'}
              >
                Fit
              </button>
              <button
                type="button"
                className={`w-full text-left px-3 py-1 text-sm hover:bg-editor-hover ${
                  zoomMode === 'fill' ? 'text-accent-primary' : 'text-editor-text'
                }`}
                onClick={() => handleZoomModeSelect('fill')}
                role="option"
                aria-selected={zoomMode === 'fill'}
              >
                Fill
              </button>
            </div>

            {/* Preset Options */}
            {ZOOM_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                className={`w-full text-left px-3 py-1 text-sm hover:bg-editor-hover ${
                  zoomMode === 'custom' && Math.abs(preset.value - currentZoomLevel) < 0.01
                    ? 'text-accent-primary'
                    : 'text-editor-text'
                }`}
                onClick={() => handleZoomPreset(preset.value)}
                role="option"
              >
                {preset.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Zoom In Button */}
      <button
        type="button"
        className="p-1 hover:bg-editor-hover rounded text-editor-text-muted hover:text-editor-text transition-colors"
        onClick={zoomIn}
        title="Zoom In"
        aria-label="Zoom in"
      >
        <ZoomInIcon />
      </button>

      {/* Separator */}
      <div className="w-px h-4 bg-editor-border mx-1" />

      {/* Fit Button */}
      <button
        type="button"
        className={`p-1 hover:bg-editor-hover rounded transition-colors ${
          zoomMode === 'fit'
            ? 'text-accent-primary'
            : 'text-editor-text-muted hover:text-editor-text'
        }`}
        onClick={() => setZoomMode('fit')}
        title="Fit to Window"
        aria-label="Fit to window"
      >
        <FitIcon />
      </button>

      {/* Reset Button */}
      <button
        type="button"
        className="p-1 hover:bg-editor-hover rounded text-editor-text-muted hover:text-editor-text transition-colors"
        onClick={resetView}
        title="Reset View"
        aria-label="Reset view"
      >
        <ResetIcon />
      </button>
    </div>
  );
});
