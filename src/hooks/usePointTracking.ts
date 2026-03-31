/**
 * usePointTracking Hook
 *
 * Bridges the backend point tracking IPC command with the frontend
 * MotionTrackingControl UI. Handles progress events, result parsing,
 * and cleanup.
 *
 * @module hooks/usePointTracking
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { TrackKeyframe } from '@/utils/motionTracking';

// =============================================================================
// Types
// =============================================================================

interface TrackPointData {
  frame: number;
  x: number;
  y: number;
  confidence: number;
}

interface TrackPointResult {
  trackingData: string;
  pointsCount: number;
  averageConfidence: number;
}

export interface ClipContext {
  sequenceId: string;
  trackId: string;
  clipId: string;
}

export interface UsePointTrackingReturn {
  isTracking: boolean;
  progress: number;
  error: string | null;
  trackingResult: TrackKeyframe[] | null;
  startTracking: (
    startFrame: number,
    x: number,
    y: number,
    settings?: { templateSize?: number; searchAreaSize?: number; confidenceThreshold?: number }
  ) => Promise<void>;
  clearResult: () => void;
}

// =============================================================================
// Helpers
// =============================================================================

/** Convert frame-based TrackPointData to time-based TrackKeyframe */
function toKeyframes(points: TrackPointData[], fps: number): TrackKeyframe[] {
  return points.map((pt) => ({
    time: pt.frame / (fps || 30),
    x: pt.x,
    y: pt.y,
    confidence: pt.confidence,
  }));
}

// =============================================================================
// Hook
// =============================================================================

export function usePointTracking(
  clipContext?: ClipContext,
  fps: number = 30
): UsePointTrackingReturn {
  const [isTracking, setIsTracking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [trackingResult, setTrackingResult] = useState<TrackKeyframe[] | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Cleanup listener on unmount
  useEffect(() => {
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, []);

  const startTracking = useCallback(
    async (
      startFrame: number,
      x: number,
      y: number,
      settings?: { templateSize?: number; searchAreaSize?: number; confidenceThreshold?: number }
    ) => {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }

      setTrackingResult(null);

      if (!clipContext) {
        setError('No clip context available');
        return;
      }

      setIsTracking(true);
      setProgress(0);
      setError(null);

      try {
        // Listen for progress events
        unlistenRef.current = await listen<{
          clipId: string;
          progress: number;
          phase: string;
        }>('track-point-progress', (event) => {
          if (event.payload.clipId === clipContext.clipId) {
            setProgress(event.payload.progress);
          }
        });

        const result = await invoke<TrackPointResult>('track_point', {
          args: {
            sequenceId: clipContext.sequenceId,
            trackId: clipContext.trackId,
            clipId: clipContext.clipId,
            startFrame,
            x,
            y,
            templateSize: settings?.templateSize,
            searchAreaSize: settings?.searchAreaSize,
            confidenceThreshold: settings?.confidenceThreshold,
          },
        });

        // Parse tracking data and convert to keyframes
        const parsed: unknown = JSON.parse(result.trackingData);
        if (!Array.isArray(parsed)) {
          throw new Error('Invalid tracking data: expected an array');
        }
        const points: TrackPointData[] = (parsed as unknown[]).filter(
          (item): item is TrackPointData =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as TrackPointData).frame === 'number' &&
            typeof (item as TrackPointData).x === 'number' &&
            typeof (item as TrackPointData).y === 'number' &&
            typeof (item as TrackPointData).confidence === 'number'
        );
        const keyframes = toKeyframes(points, fps);
        setTrackingResult(keyframes);
        setProgress(100);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsTracking(false);
        if (unlistenRef.current) {
          unlistenRef.current();
          unlistenRef.current = null;
        }
      }
    },
    [clipContext, fps]
  );

  const clearResult = useCallback(() => {
    setTrackingResult(null);
    setProgress(0);
    setError(null);
  }, []);

  return { isTracking, progress, error, trackingResult, startTracking, clearResult };
}
