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
  /** Target analysis updates per second (default: 10) */
  updateRate?: number;
  /** Sample rate for large frames (1 = every pixel, 2 = every other) */
  sampleRate?: number;
  /** Waveform/parade target width (default: 256) */
  waveformWidth?: number;
  /** Vectorscope grid size (default: 256) */
  vectorscopeSize?: number;
}

export interface UseVideoScopesResult {
  /** Current frame analysis data */
  analysis: FrameAnalysis;
  /** Whether analysis is currently running */
  isAnalyzing: boolean;
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
  options: UseVideoScopesOptions = {}
): UseVideoScopesResult {
  const {
    enabled = true,
    updateRate = DEFAULT_UPDATE_RATE,
    sampleRate = DEFAULT_SAMPLE_RATE,
    waveformWidth = DEFAULT_WAVEFORM_WIDTH,
    vectorscopeSize = DEFAULT_VECTORSCOPE_SIZE,
  } = options;

  // State
  const [analysis, setAnalysis] = useState<FrameAnalysis>(createEmptyAnalysis);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRunning, setIsRunning] = useState(enabled);

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
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    try {
      setIsAnalyzing(true);

      // Get image data from canvas
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // Skip empty frames
      if (imageData.width === 0 || imageData.height === 0) {
        setIsAnalyzing(false);
        return;
      }

      // Perform analysis
      const result = analyzeFrame(imageData, analysisOptionsRef.current);
      setAnalysis(result);
    } catch (error) {
      // Canvas may be tainted or in invalid state - ignore silently
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
    [isRunning, enabled, updateInterval, performAnalysis]
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
    if (enabled) {
      setIsRunning(true);
    } else {
      stop();
      setAnalysis(createEmptyAnalysis());
    }
  }, [enabled, stop]);

  return {
    analysis,
    isAnalyzing,
    analyze,
    start,
    stop,
  };
}

export default useVideoScopes;
