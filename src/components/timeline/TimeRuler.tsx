/**
 * TimeRuler Component
 *
 * Displays time markers and allows seeking by clicking.
 */

import { useMemo, useCallback, useRef, useState, useEffect, type MouseEvent } from 'react';

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

  // Track dragging state for scrubbing
  const [isDragging, setIsDragging] = useState(false);

  // Calculate time from mouse event
  const getTimeFromEvent = useCallback(
    (e: globalThis.MouseEvent | MouseEvent<HTMLDivElement>) => {
      if (!rulerRef.current) return null;
      const rect = rulerRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left + scrollX;
      return Math.max(0, Math.min(duration, clickX / zoom));
    },
    [zoom, scrollX, duration]
  );

  // Handle mouse down to start scrubbing
  const handleMouseDown = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (!onSeek) return;
      e.preventDefault();

      const time = getTimeFromEvent(e);
      if (time !== null) {
        onSeek(time);
        setIsDragging(true);
      }
    },
    [onSeek, getTimeFromEvent]
  );

  // Handle drag scrubbing
  useEffect(() => {
    if (!isDragging || !onSeek) return;

    const handleMouseMove = (e: globalThis.MouseEvent) => {
      const time = getTimeFromEvent(e);
      if (time !== null) {
        onSeek(time);
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, onSeek, getTimeFromEvent]);

  return (
    <div
      ref={rulerRef}
      data-testid="time-ruler"
      className={`h-6 bg-editor-sidebar border-b border-editor-border relative cursor-pointer select-none ${isDragging ? 'cursor-ew-resize' : ''}`}
      style={{ width: `${width}px` }}
      onMouseDown={handleMouseDown}
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
