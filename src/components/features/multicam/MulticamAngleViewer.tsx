/**
 * MulticamAngleViewer Component
 *
 * Displays multiple camera angles in a grid layout for multicam editing.
 * Features:
 * - 2x2 or custom grid layouts
 * - Click to switch angles
 * - Keyboard shortcuts (1-9)
 * - Recording mode indicator
 * - Hover preview
 *
 * @module components/features/multicam/MulticamAngleViewer
 */

import { useCallback, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Circle } from 'lucide-react';
import type { MulticamGroup, MulticamAngle } from '@/utils/multicam';

// =============================================================================
// Types
// =============================================================================

export interface GridLayout {
  rows: number;
  cols: number;
}

export interface MulticamAngleViewerProps {
  /** The multicam group to display */
  group: MulticamGroup | null;
  /** Current playback time in seconds */
  currentTimeSec: number;
  /** Called when user switches to a different angle */
  onAngleSwitch: (angleIndex: number) => void;
  /** Grid layout (default: 2x2) */
  gridLayout?: GridLayout;
  /** Whether the viewer is disabled */
  disabled?: boolean;
  /** Whether recording mode is active */
  isRecording?: boolean;
  /** Custom thumbnail renderer */
  renderThumbnail?: (angle: MulticamAngle, index: number) => ReactNode;
  /** Additional CSS class */
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

export function MulticamAngleViewer({
  group,
  // currentTimeSec is received for future thumbnail frame selection
  currentTimeSec: _currentTimeSec = 0,
  onAngleSwitch,
  gridLayout = { rows: 2, cols: 2 },
  disabled = false,
  isRecording = false,
  renderThumbnail,
  className = '',
}: MulticamAngleViewerProps) {
  // Suppress unused variable warning - will be used for frame-accurate thumbnails
  void _currentTimeSec;
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // Handle angle click
  const handleAngleClick = useCallback(
    (index: number) => {
      if (disabled) return;
      if (!group) return;
      if (index === group.activeAngleIndex) return;
      onAngleSwitch(index);
    },
    [disabled, group, onAngleSwitch]
  );

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (disabled) return;
      if (!group) return;

      const num = parseInt(e.key, 10);
      if (!isNaN(num) && num >= 1 && num <= 9) {
        const angleIndex = num - 1;
        if (angleIndex < group.angles.length && angleIndex !== group.activeAngleIndex) {
          onAngleSwitch(angleIndex);
        }
      }
    },
    [disabled, group, onAngleSwitch]
  );

  // Empty states
  if (!group) {
    return (
      <div
        data-testid="multicam-viewer"
        className={`flex items-center justify-center h-full bg-zinc-900 text-zinc-500 ${className}`}
        role="grid"
        aria-label="Multicam angle viewer"
      >
        <p>No multicam group selected</p>
      </div>
    );
  }

  if (group.angles.length === 0) {
    return (
      <div
        data-testid="multicam-viewer"
        className={`flex items-center justify-center h-full bg-zinc-900 text-zinc-500 ${className}`}
        role="grid"
        aria-label="Multicam angle viewer"
      >
        <p>No angles in this multicam group</p>
      </div>
    );
  }

  const safeRows = Math.max(1, gridLayout.rows);
  const safeCols = Math.max(1, gridLayout.cols);
  const maxAngles = safeRows * safeCols;
  const visibleAngles = group.angles.slice(0, maxAngles);

  return (
    <div
      data-testid="multicam-viewer"
      className={`relative ${disabled ? 'opacity-50 pointer-events-none' : ''} ${className}`}
      role="grid"
      aria-label="Multicam angle viewer"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Recording indicator */}
      {isRecording && (
        <div
          data-testid="recording-indicator"
          className="absolute top-2 right-2 z-10 flex items-center gap-1 px-2 py-1 bg-red-600 text-white text-xs rounded-full animate-pulse"
        >
          <Circle className="w-2 h-2 fill-current" />
          <span>REC</span>
        </div>
      )}

      {/* Angle grid */}
      <div
        data-testid="multicam-grid"
        className="grid gap-1 h-full"
        style={{
          gridTemplateColumns: `repeat(${safeCols}, 1fr)`,
          gridTemplateRows: `repeat(${safeRows}, 1fr)`,
        }}
      >
        {visibleAngles.map((angle, index) => {
          const isActive = index === group.activeAngleIndex;
          const isHovered = index === hoveredIndex;

          return (
            <div
              key={angle.id}
              data-testid={`angle-panel-${index}`}
              className={`
                relative cursor-pointer bg-zinc-800 overflow-hidden
                transition-all duration-150
                ${isActive ? 'ring-2 ring-yellow-400' : ''}
                ${isHovered && !isActive ? 'ring-2 ring-blue-400' : ''}
                ${!isActive && !isHovered ? 'ring-1 ring-zinc-700' : ''}
              `}
              role="gridcell"
              aria-selected={isActive}
              onClick={() => handleAngleClick(index)}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
            >
              {/* Thumbnail area */}
              <div
                data-testid={`angle-thumbnail-${index}`}
                className="absolute inset-0 flex items-center justify-center bg-zinc-900"
              >
                {renderThumbnail ? (
                  renderThumbnail(angle, index)
                ) : (
                  <div className="text-zinc-600 text-4xl font-bold">
                    {index + 1}
                  </div>
                )}
              </div>

              {/* Label overlay */}
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-white truncate">
                    {angle.label || `Angle ${index + 1}`}
                  </span>
                  {isActive && (
                    <span className="text-xs text-yellow-400 font-medium">
                      LIVE
                    </span>
                  )}
                </div>
              </div>

              {/* Keyboard hint */}
              <div className="absolute top-1 left-1 w-5 h-5 flex items-center justify-center bg-black/60 rounded text-xs text-white font-mono">
                {index + 1}
              </div>
            </div>
          );
        })}
      </div>

      {/* Keyboard instructions */}
      <div className="absolute bottom-0 left-0 right-0 text-center py-1 bg-black/60 text-zinc-400 text-xs">
        Press 1-{Math.min(group.angles.length, 9)} to switch angles
      </div>
    </div>
  );
}

export default MulticamAngleViewer;
