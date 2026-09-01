/**
 * CacheStatusBar — Render cache indicator displayed above the timeline tracks.
 *
 * Shows per-segment cache state as a colored bar:
 * - Green = cached (ready for instant playback)
 * - Yellow = stale (needs re-render)
 * - Blue = currently rendering
 * - Dim red = empty but flagged (the live preview cannot draw it faithfully)
 * - Transparent = empty and unflagged (nothing to gain from caching it)
 * - Fuchsia = error
 *
 * Red is reserved for "needs render" (the NLE red-bar convention) and errors
 * get their own hue: the bar is 6px tall, so two reds separated only by alpha
 * would be indistinguishable at that size.
 */

import React, { useMemo } from 'react';
import type { CacheSegmentStatusDto } from '@/bindings';
import { useRenderCacheStore } from '@/stores/renderCacheStore';

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

/** Fill for an uncached segment the live preview cannot draw faithfully */
const NEEDS_RENDER_COLOR = 'rgba(239, 68, 68, 0.35)';

/** Map a segment to a color */
function segmentColor(seg: CacheSegmentStatusDto): string {
  switch (seg.state) {
    case 'cached':
      return 'rgba(34, 197, 94, 0.6)'; // green
    case 'stale':
      return 'rgba(234, 179, 8, 0.6)'; // yellow
    case 'rendering':
      return 'rgba(59, 130, 246, 0.6)'; // blue
    case 'error':
      return 'rgba(217, 70, 239, 0.7)'; // fuchsia — distinct hue, not a dimmer red
    default:
      // Empty. A flagged stretch is one the preview is drawing wrong right now,
      // so it earns a "needs render" bar, following the red-bar convention of
      // other NLEs; an unflagged one draws nothing because caching it would buy
      // no accuracy.
      return seg.flagged ? NEEDS_RENDER_COLOR : 'transparent';
  }
}

/** Build the hover text for a segment */
function segmentTitle(seg: CacheSegmentStatusDto): string {
  const range = `${seg.startSec.toFixed(1)}s - ${seg.endSec.toFixed(1)}s`;
  if (!seg.flagged) {
    return `${seg.state}: ${range}`;
  }

  const reasons = seg.flagReasons.length > 0 ? ` (${seg.flagReasons.join(', ')})` : '';
  return `${seg.state}: ${range} — needs render${reasons}`;
}

export const CacheStatusBar: React.FC<CacheStatusBarProps> = React.memo(
  ({ segments, duration, zoom, scrollX }) => {
    const totalWidth = duration * zoom;
    // The only place a failed fill is visible: the error reaches no other UI.
    const cacheError = useRenderCacheStore((state) => state.error);

    const bars = useMemo(() => {
      if (duration <= 0 || segments.length === 0) return null;

      return segments.map((seg) => {
        const left = seg.startSec * zoom;
        const width = (seg.endSec - seg.startSec) * zoom;
        const color = segmentColor(seg);

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
            title={segmentTitle(seg)}
          />
        );
      });
    }, [segments, duration, zoom]);

    if (duration <= 0) return null;

    return (
      <div
        className="relative h-1.5 bg-neutral-800/50 border-b border-neutral-700/30 overflow-hidden"
        data-testid="cache-status-bar"
        title={cacheError !== null ? `Render cache error: ${cacheError}` : undefined}
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
