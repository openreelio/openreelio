/**
 * ColorComparisonOverlay
 *
 * Before/After color comparison overlay for the preview player.
 * Renders on top of the preview area with split view (vertical divider),
 * wipe (horizontal line), or side-by-side comparison modes.
 * The divider is draggable in split and wipe modes.
 */

import { useCallback, useRef, type MouseEvent } from 'react';
import type { ComparisonMode } from '@/hooks/useColorComparison';

// =============================================================================
// Types
// =============================================================================

export interface ColorComparisonOverlayProps {
  /** Whether the overlay is active */
  isEnabled: boolean;
  /** Current comparison mode */
  mode: ComparisonMode;
  /** Divider position as percentage (5-95) */
  dividerPosition: number;
  /** Callback to update divider position */
  onDividerChange: (position: number) => void;
  /** Callback to change comparison mode */
  onModeChange: (mode: ComparisonMode) => void;
  /** Read-only mode (hides interactive controls) */
  readOnly?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const MODE_LABELS: Record<ComparisonMode, string> = {
  split: 'Split',
  wipe: 'Wipe',
  'side-by-side': 'Side by Side',
};

const MODES: ComparisonMode[] = ['split', 'wipe', 'side-by-side'];

// =============================================================================
// Component
// =============================================================================

export function ColorComparisonOverlay({
  isEnabled,
  mode,
  dividerPosition,
  onDividerChange,
  onModeChange,
  readOnly = false,
}: ColorComparisonOverlayProps): React.ReactElement | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  const handleDividerMouseDown = useCallback(
    (e: MouseEvent) => {
      if (readOnly) return;
      e.preventDefault();
      e.stopPropagation();
      isDraggingRef.current = true;

      const handleMouseMove = (moveEvent: globalThis.MouseEvent): void => {
        if (!isDraggingRef.current || !containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const isVertical = mode === 'split';
        const position = isVertical
          ? ((moveEvent.clientX - rect.left) / rect.width) * 100
          : ((moveEvent.clientY - rect.top) / rect.height) * 100;
        onDividerChange(position);
      };

      const handleMouseUp = (): void => {
        isDraggingRef.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [mode, onDividerChange, readOnly],
  );

  if (!isEnabled) return null;

  const isVerticalDivider = mode === 'split';
  const isHorizontalDivider = mode === 'wipe';

  return (
    <div
      ref={containerRef}
      data-testid="color-comparison-overlay"
      className="absolute inset-0 pointer-events-none z-10"
    >
      {/* Split: vertical divider */}
      {isVerticalDivider && (
        <div
          data-testid="comparison-divider-split"
          className="absolute top-0 bottom-0 w-1 bg-white/80 cursor-col-resize pointer-events-auto z-20 hover:bg-white"
          style={{ left: `${dividerPosition}%`, transform: 'translateX(-50%)' }}
          onMouseDown={handleDividerMouseDown}
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={dividerPosition}
          aria-label="Split view divider"
        >
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-10 bg-white/90 rounded-md flex items-center justify-center shadow-lg">
            <div className="flex gap-0.5">
              <div className="w-0.5 h-4 bg-gray-500 rounded" />
              <div className="w-0.5 h-4 bg-gray-500 rounded" />
            </div>
          </div>
        </div>
      )}

      {/* Wipe: horizontal divider */}
      {isHorizontalDivider && (
        <div
          data-testid="comparison-divider-wipe"
          className="absolute left-0 right-0 h-1 bg-white/80 cursor-row-resize pointer-events-auto z-20 hover:bg-white"
          style={{ top: `${dividerPosition}%`, transform: 'translateY(-50%)' }}
          onMouseDown={handleDividerMouseDown}
          role="separator"
          aria-orientation="horizontal"
          aria-valuenow={dividerPosition}
          aria-label="Wipe view divider"
        >
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-6 w-10 bg-white/90 rounded-md flex items-center justify-center shadow-lg">
            <div className="flex flex-col gap-0.5">
              <div className="h-0.5 w-4 bg-gray-500 rounded" />
              <div className="h-0.5 w-4 bg-gray-500 rounded" />
            </div>
          </div>
        </div>
      )}

      {/* Before label */}
      <div
        data-testid="label-before"
        className={`absolute px-2 py-0.5 bg-black/60 text-white text-xs rounded ${
          mode === 'wipe' ? 'top-2 left-2' : 'top-2 left-2'
        }`}
      >
        Before
      </div>

      {/* After label */}
      <div
        data-testid="label-after"
        className={`absolute px-2 py-0.5 bg-black/60 text-white text-xs rounded ${
          mode === 'wipe' ? 'bottom-2 left-2' : 'top-2 right-2'
        }`}
      >
        After
      </div>

      {/* Side-by-side center divider (non-interactive) */}
      {mode === 'side-by-side' && (
        <div
          data-testid="comparison-divider-center"
          className="absolute top-0 bottom-0 w-px bg-white/40"
          style={{ left: '50%' }}
        />
      )}

      {/* Mode selector */}
      {!readOnly && (
        <div
          data-testid="comparison-mode-selector"
          className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1 bg-black/70 rounded-md p-1 pointer-events-auto z-20"
        >
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`mode-btn-${m}`}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${
                mode === m
                  ? 'bg-blue-500 text-white'
                  : 'text-white/70 hover:bg-white/20 hover:text-white'
              }`}
              onClick={() => onModeChange(m)}
              aria-pressed={mode === m}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
