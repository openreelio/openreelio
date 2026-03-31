/**
 * PointTrackingPanel Component
 *
 * Inspector panel for ObjectTracking effects. Bridges the MotionTrackingControl
 * UI with the backend point tracking IPC command.
 */

import { useState, useCallback, useEffect } from 'react';
import { MotionTrackingControl } from './MotionTrackingControl';
import { usePointTracking, type ClipContext } from '@/hooks/usePointTracking';
import type { MotionTrack, TrackKeyframe } from '@/utils/motionTracking';
import {
  createMotionTrack,
  createTrackPoint,
  DEFAULT_TRACKING_SETTINGS,
} from '@/utils/motionTracking';
import type { SimpleParamValue } from '@/types';

// =============================================================================
// Types
// =============================================================================

/** Props for the PointTrackingPanel component */
export interface PointTrackingPanelProps {
  /** Effect parameter values for the ObjectTracking effect */
  params: Record<string, SimpleParamValue>;
  /** Callback invoked when a parameter value changes */
  onChange: (paramName: string, value: SimpleParamValue) => void;
  /** When true, the panel is read-only and tracking cannot be started */
  readOnly?: boolean;
  /** Clip context required for invoking the backend tracking command */
  clipContext?: ClipContext;
  /** Current playhead time in seconds, used to highlight the active tracking point */
  currentTime?: number;
}

// =============================================================================
// Helpers
// =============================================================================

/** Default FPS assumption when the actual frame rate is not available */
const DEFAULT_FPS = 30;

/** Parse tracking data from effect params */
function parseTrackingData(data: string, fps?: number): TrackKeyframe[] {
  if (!data) return [];
  const effectiveFps = fps && fps > 0 ? fps : DEFAULT_FPS;
  try {
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(
      (p: { frame?: number; time?: number; x: number; y: number; confidence: number }) => ({
        time: p.time ?? (p.frame ?? 0) / effectiveFps,
        x: p.x,
        y: p.y,
        confidence: p.confidence,
      }),
    );
  } catch {
    return [];
  }
}

function clampNormalized(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Build MotionTrack from effect params */
function buildTrackFromParams(
  params: Record<string, SimpleParamValue>,
  clipId: string,
): MotionTrack {
  const track = createMotionTrack(clipId);

  track.settings = {
    ...DEFAULT_TRACKING_SETTINGS,
    patternSize: Number(params.template_size) || 25,
    searchAreaSize: Number(params.search_area_size) || 100,
    confidenceThreshold: Number(params.confidence_threshold) || 0.75,
  };

  const originX = Number(params.origin_x);
  const originY = Number(params.origin_y);
  if (originX >= 0 && originY >= 0) {
    const point = createTrackPoint(originX, originY, { name: 'Track 1' });
    const existingKeyframes = parseTrackingData(String(params.tracking_data ?? ''));
    point.keyframes = existingKeyframes;
    track.points = [point];
  }

  return track;
}

// =============================================================================
// Component
// =============================================================================

export function PointTrackingPanel({
  params,
  onChange,
  readOnly = false,
  clipContext,
  currentTime = 0,
}: PointTrackingPanelProps): React.JSX.Element {
  const clipId = clipContext?.clipId ?? '';
  const [track, setTrack] = useState<MotionTrack>(() => buildTrackFromParams(params, clipId));

  const { isTracking, progress, error, trackingResult, startTracking, clearResult } =
    usePointTracking(clipContext);

  // Sync params -> track when params change externally.
  // Use functional update to preserve stable track ID across re-renders.
  useEffect(() => {
    setTrack((prev) => {
      const originX = Number(params.origin_x);
      const originY = Number(params.origin_y);
      const keyframes = parseTrackingData(String(params.tracking_data ?? ''));

      const points =
        originX >= 0 && originY >= 0
          ? [
              {
                ...(prev.points[0] ?? createTrackPoint(originX, originY, { name: 'Track 1' })),
                x: originX,
                y: originY,
                keyframes,
              },
            ]
          : [];

      return {
        ...prev,
        settings: {
          ...DEFAULT_TRACKING_SETTINGS,
          patternSize: Number(params.template_size) || 25,
          searchAreaSize: Number(params.search_area_size) || 100,
          confidenceThreshold: Number(params.confidence_threshold) || 0.75,
        },
        points,
      };
    });
  }, [params, clipId]);

  // When tracking completes, store result in effect params
  useEffect(() => {
    if (trackingResult && trackingResult.length > 0) {
      onChange('tracking_data', JSON.stringify(trackingResult));
      setTrack((prev) => {
        if (prev.points.length === 0) return prev;
        const updated = { ...prev };
        updated.points = [{ ...updated.points[0], keyframes: trackingResult }];
        return updated;
      });
    }
  }, [trackingResult, onChange]);

  const handleTrackChange = useCallback(
    (updated: MotionTrack) => {
      setTrack(updated);
      onChange('template_size', updated.settings.patternSize);
      onChange('search_area_size', updated.settings.searchAreaSize);
      onChange('confidence_threshold', updated.settings.confidenceThreshold);
    },
    [onChange],
  );

  const handleAddPoint = useCallback(() => {
    onChange('origin_x', 0.5);
    onChange('origin_y', 0.5);
    setTrack((prev) => {
      if (prev.points.length > 0) return prev;
      const point = createTrackPoint(0.5, 0.5, { name: 'Track 1' });
      return { ...prev, points: [point] };
    });
  }, [onChange]);

  const handleRemovePoint = useCallback(
    () => {
      onChange('origin_x', -1);
      onChange('origin_y', -1);
      onChange('tracking_data', '');
      clearResult();
      setTrack((prev) => ({ ...prev, points: [] }));
    },
    [onChange, clearResult],
  );

  const handlePointCoordinateChange = useCallback(
    (axis: 'x' | 'y', rawValue: string) => {
      const parsed = Number(rawValue);
      if (!Number.isFinite(parsed)) {
        return;
      }

      const nextValue = clampNormalized(parsed);

      setTrack((prev) => {
        if (prev.points.length === 0) {
          return prev;
        }

        const point = prev.points[0];
        const updatedPoint = axis === 'x' ? { ...point, x: nextValue } : { ...point, y: nextValue };

        return { ...prev, points: [updatedPoint] };
      });

      onChange(axis === 'x' ? 'origin_x' : 'origin_y', nextValue);
    },
    [onChange],
  );

  const handleStartTracking = useCallback(async () => {
    const point = track.points[0];
    if (!point) return;

    await startTracking(Number(params.start_frame) || 0, point.x, point.y, {
      templateSize: track.settings.patternSize,
      searchAreaSize: track.settings.searchAreaSize,
      confidenceThreshold: track.settings.confidenceThreshold,
    });
  }, [track, params.start_frame, startTracking]);

  return (
    <div data-testid="point-tracking-panel">
      <MotionTrackingControl
        track={track}
        currentTime={currentTime}
        onTrackChange={handleTrackChange}
        onAddPoint={handleAddPoint}
        onRemovePoint={handleRemovePoint}
        onStartTracking={handleStartTracking}
        isTracking={isTracking}
        trackingProgress={Math.min(1, Math.max(0, progress / 100))}
        disabled={readOnly}
      />
      {track.points.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="space-y-1 text-xs text-zinc-400">
            <span>Point X</span>
            <input
              type="number"
              min="0"
              max="1"
              step="0.001"
              value={track.points[0].x}
              onChange={(event) => handlePointCoordinateChange('x', event.target.value)}
              disabled={readOnly || isTracking}
              aria-label="Point X"
              data-testid="tracking-point-x"
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200 disabled:opacity-50"
            />
          </label>
          <label className="space-y-1 text-xs text-zinc-400">
            <span>Point Y</span>
            <input
              type="number"
              min="0"
              max="1"
              step="0.001"
              value={track.points[0].y}
              onChange={(event) => handlePointCoordinateChange('y', event.target.value)}
              disabled={readOnly || isTracking}
              aria-label="Point Y"
              data-testid="tracking-point-y"
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200 disabled:opacity-50"
            />
          </label>
        </div>
      )}
      {error && (
        <div
          data-testid="tracking-error"
          className="mt-2 px-3 py-2 bg-red-900/50 rounded text-xs text-red-300"
        >
          {error}
        </div>
      )}
      {trackingResult && trackingResult.length > 0 && !isTracking && (
        <div
          data-testid="tracking-result"
          className="mt-2 px-3 py-2 bg-green-900/30 rounded text-xs text-green-300"
        >
          Tracked {trackingResult.length} frames (avg confidence:{' '}
          {Math.round(
            (trackingResult.reduce((s, k) => s + k.confidence, 0) / trackingResult.length) * 100,
          )}
          %)
        </div>
      )}
    </div>
  );
}
