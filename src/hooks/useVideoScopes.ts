/**
 * useVideoScopes Hook
 *
 * Connects a preview canvas to video scopes analysis.
 * Extracts frame data from the canvas and runs real-time analysis
 * for Histogram, Waveform, Vectorscope, and RGB Parade displays.
 *
 * Performance optimizations:
 * - Configurable update rate (default: 10 fps)
 * - Sample rate for large frames
 * - Pauses when not visible
 */

import { useState, useEffect, useRef, useCallback, type RefObject } from 'react';
import {
  analyzeFrame,
  createEmptyAnalysis,
  type FrameAnalysis,
  type AnalysisOptions,
} from '@/utils/scopeAnalysis';

// =============================================================================
// Types
// =============================================================================

export interface UseVideoScopesOptions {
  /** Whether scope analysis is enabled */
  enabled?: boolean;
  /** Whether analysis should start automatically when enabled */
  autoStart?: boolean;
  /** Target analysis updates per second (default: 10) */
  updateRate?: number;
  /** Sample rate for large frames (1 = every pixel, 2 = every other) */
  sampleRate?: number;
  /** Waveform/parade target width (default: 256) */
  waveformWidth?: number;
  /** Vectorscope grid size (default: 256) */
  vectorscopeSize?: number;
}

export type VideoScopeSourceStatus = 'unavailable' | 'empty' | 'connected' | 'blocked';

export interface UseVideoScopesResult {
  /** Current frame analysis data */
  analysis: FrameAnalysis;
  /** Whether analysis is currently running */
  isAnalyzing: boolean;
  /** Whether a readable preview canvas is currently connected */
  sourceStatus: VideoScopeSourceStatus;
  /** Last readable source frame width */
  sourceWidth: number;
  /** Last readable source frame height */
  sourceHeight: number;
  /** Timestamp from the last successful analysis */
  lastAnalyzedAt: number | null;
  /** Last non-fatal analysis error */
  error: string | null;
  /** Manually trigger an analysis */
  analyze: () => void;
  /** Start continuous analysis */
  start: () => void;
  /** Stop continuous analysis */
  stop: () => void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_UPDATE_RATE = 10; // fps
const DEFAULT_SAMPLE_RATE = 2; // Sample every 2nd pixel for performance
const DEFAULT_WAVEFORM_WIDTH = 256;
const DEFAULT_VECTORSCOPE_SIZE = 256;

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook to connect a canvas element to video scope analysis.
 *
 * @param canvasRef - Ref to the canvas element to analyze
 * @param options - Analysis configuration options
 * @returns Scope analysis data and controls
 *
 * @example
 * ```tsx
 * const canvasRef = useRef<HTMLCanvasElement>(null);
 * const { analysis, isAnalyzing } = useVideoScopes(canvasRef, { enabled: true });
 *
 * return (
 *   <>
 *     <canvas ref={canvasRef} />
 *     <VideoScopesPanel analysis={analysis} isAnalyzing={isAnalyzing} />
 *   </>
 * );
 * ```
 */
export function useVideoScopes(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  options: UseVideoScopesOptions = {},
): UseVideoScopesResult {
  const {
    enabled = true,
    autoStart = true,
    updateRate = DEFAULT_UPDATE_RATE,
    sampleRate = DEFAULT_SAMPLE_RATE,
    waveformWidth = DEFAULT_WAVEFORM_WIDTH,
    vectorscopeSize = DEFAULT_VECTORSCOPE_SIZE,
  } = options;

  // State
  const [analysis, setAnalysis] = useState<FrameAnalysis>(createEmptyAnalysis);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRunning, setIsRunning] = useState(enabled && autoStart);
  const [sourceStatus, setSourceStatus] = useState<VideoScopeSourceStatus>('unavailable');
  const [sourceWidth, setSourceWidth] = useState(0);
  const [sourceHeight, setSourceHeight] = useState(0);
  const [lastAnalyzedAt, setLastAnalyzedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refs for animation loop
  const rafRef = useRef<number | null>(null);
  const lastAnalysisRef = useRef<number>(0);
  const analysisOptionsRef = useRef<AnalysisOptions>({
    sampleRate,
    waveformWidth,
    vectorscopeSize,
  });

  // Update analysis options ref when props change
  useEffect(() => {
    analysisOptionsRef.current = {
      sampleRate,
      waveformWidth,
      vectorscopeSize,
    };
  }, [sampleRate, waveformWidth, vectorscopeSize]);

  // Calculate interval from update rate
  const updateInterval = 1000 / updateRate;

  /**
   * Extract ImageData from canvas and run analysis.
   */
  const performAnalysis = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      setSourceStatus('unavailable');
      setSourceWidth(0);
      setSourceHeight(0);
      return;
    }

    setSourceWidth(canvas.width);
    setSourceHeight(canvas.height);

    if (canvas.width === 0 || canvas.height === 0) {
      setSourceStatus('empty');
      return;
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      setSourceStatus('unavailable');
      return;
    }

    try {
      setIsAnalyzing(true);

      // Get image data from canvas
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // Skip empty frames
      if (imageData.width === 0 || imageData.height === 0) {
        setSourceStatus('empty');
        setIsAnalyzing(false);
        return;
      }

      // Perform analysis
      const result = analyzeFrame(imageData, analysisOptionsRef.current);
      setAnalysis(result);
      setSourceStatus('connected');
      setSourceWidth(result.width);
      setSourceHeight(result.height);
      setLastAnalyzedAt(result.timestamp);
      setError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSourceStatus('blocked');
      setError(message);
      console.debug('[useVideoScopes] Analysis failed:', error);
    } finally {
      setIsAnalyzing(false);
    }
  }, [canvasRef]);

  /**
   * Animation loop for continuous analysis.
   */
  const tick = useCallback(
    (timestamp: number) => {
      if (!isRunning || !enabled) return;

      // Check if enough time has passed since last analysis
      if (timestamp - lastAnalysisRef.current >= updateInterval) {
        performAnalysis();
        lastAnalysisRef.current = timestamp;
      }

      // Schedule next frame
      rafRef.current = requestAnimationFrame(tick);
    },
    [isRunning, enabled, updateInterval, performAnalysis],
  );

  /**
   * Start continuous analysis.
   */
  const start = useCallback(() => {
    setIsRunning(true);
  }, []);

  /**
   * Stop continuous analysis.
   */
  const stop = useCallback(() => {
    setIsRunning(false);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  /**
   * Manually trigger a single analysis.
   */
  const analyze = useCallback(() => {
    performAnalysis();
  }, [performAnalysis]);

  // Start/stop analysis loop based on enabled and isRunning state
  useEffect(() => {
    if (enabled && isRunning) {
      rafRef.current = requestAnimationFrame(tick);
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [enabled, isRunning, tick]);

  // Auto-start when enabled changes
  useEffect(() => {
    if (enabled && autoStart) {
      setIsRunning(true);
    }
    if (!enabled) {
      stop();
      setAnalysis(createEmptyAnalysis());
      setSourceStatus('unavailable');
      setLastAnalyzedAt(null);
      setError(null);
    }
  }, [autoStart, enabled, stop]);

  return {
    analysis,
    isAnalyzing,
    sourceStatus,
    sourceWidth,
    sourceHeight,
    lastAnalyzedAt,
    error,
    analyze,
    start,
    stop,
  };
}

export default useVideoScopes;
