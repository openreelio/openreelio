/**
 * CacheStatusBar — Render cache indicator displayed above the timeline tracks.
 *
 * Shows per-segment cache state as a colored bar:
 * - Green = cached (ready for instant playback)
 * - Yellow = stale (needs re-render)
 * - Blue = currently rendering
 * - Transparent = empty (not yet cached)
 * - Red = error
 */

import React, { useMemo } from 'react';
import type { CacheSegmentStatusDto, CacheSegmentState } from '@/bindings';

/** Props for the CacheStatusBar component */
interface CacheStatusBarProps {
  /** Per-segment cache status from backend */
  segments: CacheSegmentStatusDto[];
  /** Total timeline duration in seconds */
  duration: number;
  /** Current zoom level (pixels per second) */
  zoom: number;
  /** Horizontal scroll offset in pixels */
  scrollX: number;
}

/** Map segment state to a color */
function stateColor(state: CacheSegmentState): string {
  switch (state) {
    case 'cached':
      return 'rgba(34, 197, 94, 0.6)'; // green
    case 'stale':
      return 'rgba(234, 179, 8, 0.6)'; // yellow
    case 'rendering':
      return 'rgba(59, 130, 246, 0.6)'; // blue
    case 'error':
      return 'rgba(239, 68, 68, 0.6)'; // red
    default:
      return 'transparent'; // empty
  }
}

export const CacheStatusBar: React.FC<CacheStatusBarProps> = React.memo(
  ({ segments, duration, zoom, scrollX }) => {
    const totalWidth = duration * zoom;

    const bars = useMemo(() => {
      if (duration <= 0 || segments.length === 0) return null;

      return segments.map((seg) => {
        const left = seg.startSec * zoom;
        const width = (seg.endSec - seg.startSec) * zoom;
        const color = stateColor(seg.state);

        if (color === 'transparent') return null;

        return (
          <div
            key={`${seg.startSec}-${seg.endSec}`}
            className="absolute top-0 h-full"
            style={{
              left: `${left}px`,
              width: `${width}px`,
              backgroundColor: color,
            }}
            title={`${seg.state}: ${seg.startSec.toFixed(1)}s - ${seg.endSec.toFixed(1)}s`}
          />
        );
      });
    }, [segments, duration, zoom]);

    if (duration <= 0) return null;

    return (
      <div
        className="relative h-1.5 bg-neutral-800/50 border-b border-neutral-700/30 overflow-hidden"
        data-testid="cache-status-bar"
      >
        <div
          className="absolute top-0 h-full"
          style={{
            width: `${totalWidth}px`,
            transform: `translateX(-${scrollX}px)`,
          }}
        >
          {bars}
        </div>
      </div>
    );
  }
);

CacheStatusBar.displayName = 'CacheStatusBar';
