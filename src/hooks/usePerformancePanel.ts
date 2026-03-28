/**
 * usePerformancePanel Hook
 *
 * Provides real-time system metrics (CPU, RAM, disk, GPU info) via backend IPC
 * and frontend-measured FPS + dropped frame tracking via requestAnimationFrame.
 *
 * @module hooks/usePerformancePanel
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { commands } from '@/bindings';
import type { SystemMetricsDto, GpuAccelerationStatus } from '@/bindings';
import { isDesktopRuntimeAvailable } from '@/services/runtimeEnvironment';

// =============================================================================
// Types
// =============================================================================

/** FPS metrics tracked on the frontend via requestAnimationFrame */
export interface FpsMetrics {
  /** Current FPS (rolling average over last second) */
  fps: number;
  /** Total dropped frames since monitoring started */
  droppedFrames: number;
}

/** Combined performance snapshot exposed to the panel */
export interface PerformanceSnapshot {
  /** System metrics from backend (CPU, RAM, disk) */
  system: SystemMetricsDto | null;
  /** FPS and dropped frame data from frontend */
  fpsMetrics: FpsMetrics;
  /** GPU device summary (name + VRAM) from backend */
  gpuName: string | null;
  /** Whether desktop-only performance metrics are supported */
  isSupported: boolean;
  /** Whether data is still loading on first fetch */
  isLoading: boolean;
  /** Last error message, if any */
  error: string | null;
}

// =============================================================================
// Constants
// =============================================================================

/** Default polling interval for backend metrics (ms) */
const POLL_INTERVAL_MS = 2000;

/** FPS below this threshold counts as a dropped frame */
const DROPPED_FRAME_THRESHOLD_MS = 33.34; // ~30fps threshold

// =============================================================================
// Hook
// =============================================================================

/**
 * Polls system metrics from the Rust backend and tracks FPS on the frontend.
 *
 * @param enabled - Whether monitoring is active (pauses polling when false)
 * @param intervalMs - Backend poll interval in milliseconds
 */
export function usePerformancePanel(
  enabled: boolean = true,
  intervalMs: number = POLL_INTERVAL_MS,
): PerformanceSnapshot & {
  /** Manually refresh system metrics */
  refresh: () => Promise<void>;
} {
  const [system, setSystem] = useState<SystemMetricsDto | null>(null);
  const [gpuName, setGpuName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fpsMetrics, setFpsMetrics] = useState<FpsMetrics>({ fps: 0, droppedFrames: 0 });
  const backendAvailable = isDesktopRuntimeAvailable();

  // Refs for FPS tracking across animation frames
  const frameTimesRef = useRef<number[]>([]);
  const lastFrameRef = useRef(0);
  const droppedRef = useRef(0);
  const rafIdRef = useRef(0);

  // ----- Backend system metrics polling -----
  const fetchSystemMetrics = useCallback(async () => {
    if (!enabled || !backendAvailable) {
      setSystem(null);
      setGpuName(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    const result = await commands.getSystemMetrics();
    if (result.status === 'ok') {
      setSystem(result.data);
      setError(null);
    } else {
      setError(result.error);
    }
    setIsLoading(false);
  }, [backendAvailable, enabled]);

  // Fetch GPU info once on mount
  useEffect(() => {
    if (!enabled || !backendAvailable) {
      setGpuName(null);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const result = await commands.detectGpuDevices();
        if (!cancelled && result.status === 'ok') {
          const status = result.data as GpuAccelerationStatus;
          const primary = status.devices?.find((d) => d.isPrimary) ?? status.devices?.[0];
          setGpuName(primary?.name ?? null);
        }
      } catch {
        // GPU detection is optional; ignore errors
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [backendAvailable, enabled]);

  // Poll system metrics on interval
  useEffect(() => {
    if (!enabled || !backendAvailable) {
      setSystem(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    void fetchSystemMetrics();
    const id = setInterval(fetchSystemMetrics, intervalMs);
    return () => clearInterval(id);
  }, [backendAvailable, enabled, intervalMs, fetchSystemMetrics]);

  // ----- Frontend FPS tracking via requestAnimationFrame -----
  useEffect(() => {
    if (!enabled || !backendAvailable) return;

    const frameTimes = frameTimesRef.current;
    lastFrameRef.current = performance.now();

    const tick = (now: number): void => {
      const delta = now - lastFrameRef.current;
      lastFrameRef.current = now;

      if (delta > 0) {
        frameTimes.push(delta);
        // Keep only the last ~1 second of frame times
        while (frameTimes.length > 120) frameTimes.shift();

        if (delta > DROPPED_FRAME_THRESHOLD_MS) {
          droppedRef.current += 1;
        }
      }

      rafIdRef.current = requestAnimationFrame(tick);
    };

    rafIdRef.current = requestAnimationFrame(tick);

    // Update FPS state every second (not every frame, to avoid excess renders)
    const fpsInterval = setInterval(() => {
      if (frameTimes.length < 2) {
        setFpsMetrics({ fps: 0, droppedFrames: droppedRef.current });
        return;
      }
      const total = frameTimes.reduce((a, b) => a + b, 0);
      const avgMs = total / frameTimes.length;
      const fps = avgMs > 0 ? 1000 / avgMs : 0;
      setFpsMetrics({ fps: Math.round(fps), droppedFrames: droppedRef.current });
    }, 1000);

    return () => {
      cancelAnimationFrame(rafIdRef.current);
      clearInterval(fpsInterval);
    };
  }, [backendAvailable, enabled]);

  return {
    system,
    fpsMetrics,
    gpuName,
    isSupported: backendAvailable,
    isLoading,
    error,
    refresh: fetchSystemMetrics,
  };
}
