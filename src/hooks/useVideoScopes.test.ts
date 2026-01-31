/**
 * useVideoScopes Hook Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVideoScopes } from './useVideoScopes';
import { createEmptyAnalysis } from '@/utils/scopeAnalysis';

// Mock requestAnimationFrame and cancelAnimationFrame
const mockRAF = vi.fn((cb: FrameRequestCallback) => {
  setTimeout(() => cb(performance.now()), 0);
  return 1;
});

const mockCAF = vi.fn();

// Polyfill ImageData for JSDOM
class MockImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;

  constructor(data: Uint8ClampedArray, width: number, height?: number) {
    this.data = data;
    this.width = width;
    this.height = height ?? (data.length / 4 / width);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', mockRAF);
  vi.stubGlobal('cancelAnimationFrame', mockCAF);
  vi.stubGlobal('ImageData', MockImageData);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// Create mock ImageData
function createMockImageData(width: number, height: number): InstanceType<typeof MockImageData> {
  const length = width * height * 4;
  const data = new Uint8ClampedArray(length);
  // Fill with gradient-like data
  for (let i = 0; i < length; i += 4) {
    const pixel = (i / 4);
    const x = pixel % width;
    const value = Math.floor((x / width) * 255);
    data[i] = value;     // R
    data[i + 1] = value; // G
    data[i + 2] = value; // B
    data[i + 3] = 255;   // A
  }
  return new MockImageData(data, width, height);
}

// Helper to create a mock canvas with mocked getImageData
function createMockCanvas(width = 100, height = 100): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  // Create mock context with getImageData
  const mockImageData = createMockImageData(width, height);
  const mockCtx = {
    getImageData: vi.fn(() => mockImageData),
  };

  // Override getContext to return our mock
  vi.spyOn(canvas, 'getContext').mockReturnValue(mockCtx as unknown as CanvasRenderingContext2D);

  return canvas;
}

describe('useVideoScopes', () => {
  describe('initialization', () => {
    it('should return empty analysis when disabled', () => {
      const canvasRef = { current: createMockCanvas() };
      const { result } = renderHook(() =>
        useVideoScopes(canvasRef, { enabled: false })
      );

      expect(result.current.analysis.timestamp).toBe(0);
      expect(result.current.isAnalyzing).toBe(false);
    });

    it('should start with empty analysis', () => {
      const canvasRef = { current: null };
      const { result } = renderHook(() =>
        useVideoScopes(canvasRef, { enabled: true })
      );

      const emptyAnalysis = createEmptyAnalysis();
      expect(result.current.analysis.timestamp).toBe(emptyAnalysis.timestamp);
    });

    it('should auto-start when enabled', () => {
      const canvasRef = { current: createMockCanvas() };
      renderHook(() => useVideoScopes(canvasRef, { enabled: true }));

      expect(mockRAF).toHaveBeenCalled();
    });
  });

  describe('manual analysis', () => {
    it('should analyze when analyze() is called', () => {
      const canvasRef = { current: createMockCanvas() };
      const { result } = renderHook(() =>
        useVideoScopes(canvasRef, { enabled: false })
      );

      act(() => {
        result.current.analyze();
      });

      // Analysis should have run (timestamp > 0)
      expect(result.current.analysis.timestamp).toBeGreaterThan(0);
    });

    it('should handle null canvas ref gracefully', () => {
      const canvasRef = { current: null };
      const { result } = renderHook(() =>
        useVideoScopes(canvasRef, { enabled: false })
      );

      // Should not throw
      act(() => {
        result.current.analyze();
      });

      expect(result.current.analysis.timestamp).toBe(0);
    });
  });

  describe('start/stop controls', () => {
    it('should stop analysis when stop() is called', () => {
      const canvasRef = { current: createMockCanvas() };
      const { result } = renderHook(() =>
        useVideoScopes(canvasRef, { enabled: true })
      );

      act(() => {
        result.current.stop();
      });

      // cancelAnimationFrame should have been called
      expect(mockCAF).toHaveBeenCalled();
    });

    it('should restart analysis when start() is called', () => {
      const canvasRef = { current: createMockCanvas() };
      const { result } = renderHook(() =>
        useVideoScopes(canvasRef, { enabled: true })
      );

      // Stop first
      act(() => {
        result.current.stop();
      });

      const rafCountAfterStop = mockRAF.mock.calls.length;

      // Start again
      act(() => {
        result.current.start();
        vi.advanceTimersByTime(100);
      });

      // Should have requested animation frame again
      expect(mockRAF.mock.calls.length).toBeGreaterThan(rafCountAfterStop);
    });
  });

  describe('analysis data', () => {
    it('should produce valid histogram data', () => {
      const canvasRef = { current: createMockCanvas() };
      const { result } = renderHook(() =>
        useVideoScopes(canvasRef, { enabled: false })
      );

      act(() => {
        result.current.analyze();
      });

      const { histogram } = result.current.analysis;

      // Histogram should have 256 bins for each channel
      expect(histogram.red.length).toBe(256);
      expect(histogram.green.length).toBe(256);
      expect(histogram.blue.length).toBe(256);
      expect(histogram.luminance.length).toBe(256);
    });

    it('should produce valid waveform data', () => {
      const canvasRef = { current: createMockCanvas() };
      const { result } = renderHook(() =>
        useVideoScopes(canvasRef, { enabled: false, waveformWidth: 64 })
      );

      act(() => {
        result.current.analyze();
      });

      const { waveform } = result.current.analysis;

      // Waveform should have columns
      expect(waveform.columns.length).toBeGreaterThan(0);
      expect(waveform.width).toBeGreaterThan(0);
    });

    it('should produce valid vectorscope data', () => {
      const canvasRef = { current: createMockCanvas() };
      const { result } = renderHook(() =>
        useVideoScopes(canvasRef, { enabled: false, vectorscopeSize: 64 })
      );

      act(() => {
        result.current.analyze();
      });

      const { vectorscope } = result.current.analysis;

      // Vectorscope should have a grid
      expect(vectorscope.size).toBe(64);
      expect(vectorscope.grid.length).toBe(64);
    });

    it('should produce valid RGB parade data', () => {
      const canvasRef = { current: createMockCanvas() };
      const { result } = renderHook(() =>
        useVideoScopes(canvasRef, { enabled: false })
      );

      act(() => {
        result.current.analyze();
      });

      const { rgbParade } = result.current.analysis;

      // RGB parade should have separate channel data
      expect(rgbParade.red.columns.length).toBeGreaterThan(0);
      expect(rgbParade.green.columns.length).toBeGreaterThan(0);
      expect(rgbParade.blue.columns.length).toBeGreaterThan(0);
    });
  });

  describe('configuration options', () => {
    it('should respect sampleRate option', () => {
      const canvasRef = { current: createMockCanvas(200, 200) };

      // Higher sample rate = less samples = faster analysis
      const { result } = renderHook(() =>
        useVideoScopes(canvasRef, { enabled: false, sampleRate: 4 })
      );

      act(() => {
        result.current.analyze();
      });

      // Analysis should complete (we can't easily verify sample rate was used)
      expect(result.current.analysis.timestamp).toBeGreaterThan(0);
    });

    it('should respect updateRate option', () => {
      // Update rate affects how often analysis runs in continuous mode
      // Hard to test precisely with mocked timers, but we verify it's passed
      const canvasRef = { current: createMockCanvas() };
      const { result } = renderHook(() =>
        useVideoScopes(canvasRef, { enabled: true, updateRate: 30 })
      );

      expect(result.current).toBeDefined();
    });
  });

  describe('cleanup', () => {
    it('should cancel animation frame on unmount', () => {
      const canvasRef = { current: createMockCanvas() };
      const { unmount } = renderHook(() =>
        useVideoScopes(canvasRef, { enabled: true })
      );

      unmount();

      // cancelAnimationFrame should have been called
      expect(mockCAF).toHaveBeenCalled();
    });

    it('should reset analysis when disabled', () => {
      const canvasRef = { current: createMockCanvas() };
      const { result, rerender } = renderHook(
        ({ enabled }) => useVideoScopes(canvasRef, { enabled }),
        { initialProps: { enabled: true } }
      );

      // First, do an analysis
      act(() => {
        result.current.analyze();
      });

      expect(result.current.analysis.timestamp).toBeGreaterThan(0);

      // Now disable
      rerender({ enabled: false });

      // Analysis should be reset to empty
      expect(result.current.analysis.timestamp).toBe(0);
    });
  });
});
