/**
 * TimeRuler Component
 *
 * Canvas-based time ruler for efficient rendering of timeline markers.
 * Uses Canvas API instead of DOM elements for better performance with
 * many markers during zoom and scroll operations.
 */

import {
  useCallback,
  useRef,
  useState,
  useEffect,
  type MouseEvent,
} from 'react';

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
  /** Visible viewport width */
  viewportWidth?: number;
  /** Callback when user clicks to seek */
  onSeek?: (time: number) => void;
}

// =============================================================================
// Constants
// =============================================================================

const RULER_HEIGHT = 24; // h-6 = 24px
const MAIN_MARKER_HEIGHT = 12;
const SUB_MARKER_HEIGHT = 8;
const FONT_SIZE = 10;
const FONT = `${FONT_SIZE}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;

// Colors matching Tailwind classes
const COLORS = {
  background: '#1e1e2e', // editor-sidebar
  border: '#313244', // editor-border
  mainMarker: '#a6adc8', // editor-text-muted
  subMarker: '#45475a', // editor-border
  text: '#a6adc8', // editor-text-muted
};

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

export function TimeRuler({
  duration,
  zoom,
  scrollX,
  viewportWidth = 1000,
  onSeek,
}: TimeRulerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const width = duration * zoom;
  const interval = getMarkerInterval(zoom);
  const mainInterval = interval >= 1 ? interval : 1;

  // Calculate time from mouse event
  const getTimeFromEvent = useCallback(
    (e: globalThis.MouseEvent | MouseEvent<HTMLDivElement>) => {
      if (!containerRef.current) return null;
      const rect = containerRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left + scrollX;
      return Math.max(0, Math.min(duration, clickX / zoom));
    },
    [zoom, scrollX, duration]
  );

  // Draw the ruler using Canvas API
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size with device pixel ratio for crisp rendering
    const dpr = window.devicePixelRatio || 1;
    const displayWidth = Math.min(width, viewportWidth + 200); // Extra buffer
    canvas.width = displayWidth * dpr;
    canvas.height = RULER_HEIGHT * dpr;
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${RULER_HEIGHT}px`;
    ctx.scale(dpr, dpr);

    // Clear canvas
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, displayWidth, RULER_HEIGHT);

    // Draw bottom border
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_HEIGHT - 0.5);
    ctx.lineTo(displayWidth, RULER_HEIGHT - 0.5);
    ctx.stroke();

    // Calculate visible range with buffer
    const bufferTime = 50 / zoom; // 50px buffer
    const startTime = Math.max(0, Math.floor((scrollX / zoom - bufferTime) / interval) * interval);
    const endTime = Math.min(duration, (scrollX + viewportWidth) / zoom + bufferTime);

    // Set up text rendering
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    // Draw markers
    for (let t = startTime; t <= endTime; t += interval) {
      // Use rounded time to avoid floating point precision issues
      const roundedTime = Math.round(t * 1000) / 1000;
      const x = roundedTime * zoom - scrollX;

      // Skip if outside visible area
      if (x < -50 || x > displayWidth + 50) continue;

      const isMain = Math.abs(roundedTime % mainInterval) < 0.001 || interval < 1;

      // Draw marker line
      ctx.beginPath();
      ctx.strokeStyle = isMain ? COLORS.mainMarker : COLORS.subMarker;
      ctx.lineWidth = 1;
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, isMain ? MAIN_MARKER_HEIGHT : SUB_MARKER_HEIGHT);
      ctx.stroke();

      // Draw time label for main markers
      if (isMain) {
        ctx.fillStyle = COLORS.text;
        ctx.fillText(formatTime(roundedTime), x, MAIN_MARKER_HEIGHT + 2);
      }
    }
  }, [duration, zoom, scrollX, viewportWidth, interval, mainInterval, width]);

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
      ref={containerRef}
      data-testid="time-ruler"
      className={`h-6 relative cursor-pointer select-none ${isDragging ? 'cursor-ew-resize' : ''}`}
      style={{ width: `${width}px` }}
      onMouseDown={handleMouseDown}
    >
      <canvas
        ref={canvasRef}
        className="absolute top-0 left-0 pointer-events-none"
        style={{
          transform: `translateX(${scrollX}px)`,
          willChange: 'transform',
        }}
      />
    </div>
  );
}
