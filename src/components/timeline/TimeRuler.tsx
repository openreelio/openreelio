/**
 * TimeRuler Component
 *
 * Displays time markers and allows seeking by clicking.
 */

import { useMemo, useCallback, useRef, type MouseEvent } from 'react';

// =============================================================================
// Types
// =============================================================================

interface TimeRulerProps {
  /** Total duration in seconds */
  duration: number;
  /** Zoom level (pixels per second) */
  zoom: number;
  /** Horizontal scroll offset */
  scrollX: number;
  /** Callback when user clicks to seek */
  onSeek?: (time: number) => void;
}

// =============================================================================
// Utilities
// =============================================================================

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getMarkerInterval(zoom: number): number {
  // Adjust marker density based on zoom
  if (zoom >= 200) return 0.5;
  if (zoom >= 100) return 1;
  if (zoom >= 50) return 2;
  if (zoom >= 25) return 5;
  return 10;
}

// =============================================================================
// Component
// =============================================================================

export function TimeRuler({ duration, zoom, scrollX, onSeek }: TimeRulerProps) {
  const rulerRef = useRef<HTMLDivElement>(null);
  const width = duration * zoom;
  const interval = getMarkerInterval(zoom);

  // Generate time markers
  const markers = useMemo(() => {
    const result: { time: number; isMain: boolean; index: number }[] = [];
    const mainInterval = interval >= 1 ? interval : 1;

    let index = 0;
    for (let t = 0; t <= duration; t += interval) {
      // Use rounded time to avoid floating point precision issues
      const roundedTime = Math.round(t * 1000) / 1000;
      const isMain = Math.abs(roundedTime % mainInterval) < 0.001 || interval < 1;
      result.push({ time: roundedTime, isMain, index: index++ });
    }

    return result;
  }, [duration, interval]);

  // Handle click to seek
  const handleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (!rulerRef.current || !onSeek) return;

      const rect = rulerRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left + scrollX;
      const time = clickX / zoom;

      onSeek(Math.max(0, Math.min(duration, time)));
    },
    [zoom, scrollX, duration, onSeek]
  );

  return (
    <div
      ref={rulerRef}
      data-testid="time-ruler"
      className="h-6 bg-editor-sidebar border-b border-editor-border relative cursor-pointer select-none"
      style={{ width: `${width}px` }}
      onClick={handleClick}
    >
      {/* Time markers */}
      {markers.map(({ time, isMain, index }) => (
        <div
          key={index}
          className="absolute top-0 h-full flex flex-col items-center"
          style={{ left: `${time * zoom}px` }}
        >
          {/* Marker line */}
          <div
            className={`w-px ${isMain ? 'h-3 bg-editor-text-muted' : 'h-2 bg-editor-border'}`}
          />
          {/* Time label (only for main markers) */}
          {isMain && (
            <span className="text-[10px] text-editor-text-muted mt-0.5">
              {formatTime(time)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
