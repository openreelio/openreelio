/**
 * TrackingOverlay Component
 *
 * SVG overlay on the video preview for:
 * - Selecting a tracking point by clicking
 * - Visualizing the tracked path across frames
 * - Highlighting the current position at playhead time
 */

import type React from 'react';
import { useCallback, useMemo } from 'react';
import type { TrackKeyframe } from '@/utils/motionTracking';
import { interpolateTrackData } from '@/utils/motionTracking';

// =============================================================================
// Types
// =============================================================================

export interface TrackingOverlayProps {
  /** Whether point selection mode is active */
  isSelectingPoint: boolean;
  /** Callback when user clicks to select a tracking point */
  onPointSelected?: (normalizedX: number, normalizedY: number) => void;
  /** Tracking path keyframes to visualize */
  trackingPath: TrackKeyframe[] | null;
  /** Current playhead time for highlighting current position */
  currentTime: number;
  /** Container width in pixels */
  width: number;
  /** Container height in pixels */
  height: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Point marker radius */
const POINT_RADIUS = 4;
/** Current position marker radius */
const CURRENT_RADIUS = 8;

// =============================================================================
// Component
// =============================================================================

export function TrackingOverlay({
  isSelectingPoint,
  onPointSelected,
  trackingPath,
  currentTime,
  width,
  height,
}: TrackingOverlayProps): React.JSX.Element | null {
  // Handle click for point selection
  const handleClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!isSelectingPoint || !onPointSelected) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const normalizedX = (e.clientX - rect.left) / rect.width;
      const normalizedY = (e.clientY - rect.top) / rect.height;
      onPointSelected(
        Math.max(0, Math.min(1, normalizedX)),
        Math.max(0, Math.min(1, normalizedY))
      );
    },
    [isSelectingPoint, onPointSelected]
  );

  // Convert normalized keyframes to pixel coordinates
  const pixelPoints = useMemo(() => {
    if (!trackingPath || trackingPath.length === 0) return [];
    return trackingPath.map((kf) => ({
      px: kf.x * width,
      py: kf.y * height,
      confidence: kf.confidence,
      time: kf.time,
    }));
  }, [trackingPath, width, height]);

  // Current interpolated position
  const currentPos = useMemo(() => {
    if (!trackingPath || trackingPath.length === 0) return null;
    const data = interpolateTrackData(trackingPath, currentTime);
    if (!data) return null;
    return { px: data.x * width, py: data.y * height, confidence: data.confidence };
  }, [trackingPath, currentTime, width, height]);

  // Build path string for the tracking trajectory
  const pathD = useMemo(() => {
    if (pixelPoints.length < 2) return '';
    return pixelPoints
      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.px.toFixed(1)} ${pt.py.toFixed(1)}`)
      .join(' ');
  }, [pixelPoints]);

  const hasContent = isSelectingPoint || pixelPoints.length > 0;
  if (!hasContent) return null;

  return (
    <svg
      data-testid="tracking-overlay"
      className={`absolute inset-0 z-10 ${
        isSelectingPoint ? 'cursor-crosshair pointer-events-auto' : 'pointer-events-none'
      }`}
      width={width}
      height={height}
      onClick={handleClick}
    >
      {/* Tracking path line */}
      {pathD && (
        <path
          d={pathD}
          fill="none"
          stroke="#4ECDC4"
          strokeWidth={1.5}
          strokeOpacity={0.7}
          strokeDasharray="4 2"
        />
      )}

      {/* Individual tracked points */}
      {pixelPoints.map((pt) => (
        <circle
          key={pt.time}
          cx={pt.px}
          cy={pt.py}
          r={POINT_RADIUS}
          fill="#4ECDC4"
          fillOpacity={pt.confidence * 0.8}
          stroke="none"
        />
      ))}

      {/* Current position marker */}
      {currentPos && (
        <>
          <circle
            data-testid="current-position"
            cx={currentPos.px}
            cy={currentPos.py}
            r={CURRENT_RADIUS}
            fill="none"
            stroke="#FF6B6B"
            strokeWidth={2}
          />
          <circle
            cx={currentPos.px}
            cy={currentPos.py}
            r={3}
            fill="#FF6B6B"
          />
        </>
      )}

      {/* Crosshair guide when selecting */}
      {isSelectingPoint && (
        <text
          x={width / 2}
          y={20}
          textAnchor="middle"
          fill="white"
          fontSize={12}
          fontFamily="monospace"
          opacity={0.8}
        >
          Click to set tracking point
        </text>
      )}
    </svg>
  );
}
