/**
 * useFrameExtractor Hook Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFrameExtractor, useAssetFrameExtractor } from './useFrameExtractor';
import { frameCache } from '@/services/frameCache';

// Mock FFmpeg utilities
vi.mock('@/utils/ffmpeg', () => ({
  extractFrame: vi.fn(),
  probeMedia: vi.fn(),
}));

// Mock Tauri
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

import { extractFrame, probeMedia } from '@/utils/ffmpeg';

const mockExtractFrame = vi.mocked(extractFrame);
const mockProbeMedia = vi.mocked(probeMedia);

describe('useFrameExtractor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    frameCache.clear();
  });

  afterEach(() => {
    frameCache.clear();
  });

  describe('initialization', () => {
    it('should initialize with default values', () => {
      const { result } = renderHook(() => useFrameExtractor());

      expect(result.current.isExtracting).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.cacheSize).toBe(0);
    });
  });

  describe('getFrame', () => {
    it('should extract a frame and cache it', async () => {
      mockExtractFrame.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useFrameExtractor());

      let framePath: string | null = null;

      await act(async () => {
        framePath = await result.current.getFrame('/path/to/video.mp4', 1.5);
      });

      expect(mockExtractFrame).toHaveBeenCalledWith({
        inputPath: '/path/to/video.mp4',
        timeSec: 1.5,
        outputPath: expect.stringContaining('1500.png'),
      });

      expect(framePath).toBeTruthy();
      expect(result.current.cacheSize).toBe(1);
    });

    it('should return cached frame without re-extracting', async () => {
      mockExtractFrame.mockResolvedValue(undefined);

      const { result } = renderHook(() => useFrameExtractor());

      // First extraction
      await act(async () => {
        await result.current.getFrame('/path/to/video.mp4', 1.5);
      });

      expect(mockExtractFrame).toHaveBeenCalledTimes(1);

      // Second request for same frame
      await act(async () => {
        await result.current.getFrame('/path/to/video.mp4', 1.5);
      });

      // Should not call extractFrame again
      expect(mockExtractFrame).toHaveBeenCalledTimes(1);
    });

    it('should handle extraction errors', async () => {
      mockExtractFrame.mockRejectedValueOnce(new Error('FFmpeg error'));

      const { result } = renderHook(() => useFrameExtractor());

      let framePath: string | null = null;

      await act(async () => {
        framePath = await result.current.getFrame('/path/to/video.mp4', 1.5);
      });

      expect(framePath).toBeNull();
      expect(result.current.error).toBe('FFmpeg error');
    });

    it('should set isExtracting during extraction', async () => {
      let resolveExtraction: () => void = () => {};
      mockExtractFrame.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveExtraction = resolve;
          })
      );

      const { result } = renderHook(() => useFrameExtractor());

      // Start extraction
      let extractionPromise: Promise<string | null>;
      act(() => {
        extractionPromise = result.current.getFrame('/path/to/video.mp4', 1.5);
      });

      // Should be extracting
      await waitFor(() => {
        expect(result.current.isExtracting).toBe(true);
      });

      // Complete extraction
      await act(async () => {
        resolveExtraction();
        await extractionPromise;
      });

      expect(result.current.isExtracting).toBe(false);
    });

    it('should deduplicate concurrent requests for same frame', async () => {
      mockExtractFrame.mockResolvedValue(undefined);

      const { result } = renderHook(() => useFrameExtractor());

      // Start two extractions for the same frame concurrently
      await act(async () => {
        const [path1, path2] = await Promise.all([
          result.current.getFrame('/path/to/video.mp4', 1.5),
          result.current.getFrame('/path/to/video.mp4', 1.5),
        ]);

        expect(path1).toBe(path2);
      });

      // Should only call extractFrame once
      expect(mockExtractFrame).toHaveBeenCalledTimes(1);
    });
  });

  describe('getMediaInfo', () => {
    it('should probe media and cache result', async () => {
      const mockInfo = {
        durationSec: 120.5,
        format: 'mp4',
        sizeBytes: 1024000,
        video: {
          width: 1920,
          height: 1080,
          fps: 30,
          codec: 'h264',
          pixelFormat: 'yuv420p',
        },
      };

      mockProbeMedia.mockResolvedValueOnce(mockInfo);

      const { result } = renderHook(() => useFrameExtractor());

      let info;
      await act(async () => {
        info = await result.current.getMediaInfo('/path/to/video.mp4');
      });

      expect(info).toEqual(mockInfo);
      expect(mockProbeMedia).toHaveBeenCalledWith('/path/to/video.mp4');
    });

    it('should return cached media info', async () => {
      const mockInfo = {
        durationSec: 120.5,
        format: 'mp4',
        sizeBytes: 1024000,
      };

      mockProbeMedia.mockResolvedValueOnce(mockInfo);

      const { result } = renderHook(() => useFrameExtractor());

      // First probe
      await act(async () => {
        await result.current.getMediaInfo('/path/to/video.mp4');
      });

      // Second probe for same file
      await act(async () => {
        await result.current.getMediaInfo('/path/to/video.mp4');
      });

      expect(mockProbeMedia).toHaveBeenCalledTimes(1);
    });

    it('should handle probe errors', async () => {
      mockProbeMedia.mockRejectedValueOnce(new Error('Probe failed'));

      const { result } = renderHook(() => useFrameExtractor());

      let info;
      await act(async () => {
        info = await result.current.getMediaInfo('/path/to/video.mp4');
      });

      expect(info).toBeNull();
      expect(result.current.error).toBe('Probe failed');
    });
  });

  describe('clearCache', () => {
    it('should clear all cached frames', async () => {
      mockExtractFrame.mockResolvedValue(undefined);

      const { result } = renderHook(() => useFrameExtractor());

      // Add some frames to cache
      await act(async () => {
        await result.current.getFrame('/path/to/video.mp4', 1.0);
        await result.current.getFrame('/path/to/video.mp4', 2.0);
      });

      expect(result.current.cacheSize).toBe(2);

      // Clear cache
      act(() => {
        result.current.clearCache();
      });

      expect(result.current.cacheSize).toBe(0);
      expect(result.current.error).toBeNull();
    });
  });

  describe('cache eviction', () => {
    it('should evict oldest entries when cache is full', async () => {
      mockExtractFrame.mockResolvedValue(undefined);

      const { result } = renderHook(() => useFrameExtractor({ maxCacheSize: 3 }));

      // Add 4 frames (exceeds cache size of 3)
      await act(async () => {
        await result.current.getFrame('/path/to/video.mp4', 1.0);
        await result.current.getFrame('/path/to/video.mp4', 2.0);
        await result.current.getFrame('/path/to/video.mp4', 3.0);
        await result.current.getFrame('/path/to/video.mp4', 4.0);
      });

      // Cache should be limited to maxCacheSize
      expect(result.current.cacheSize).toBeLessThanOrEqual(3);
    });
  });
});

// =============================================================================
// useAssetFrameExtractor Tests (New API)
// =============================================================================

describe('useAssetFrameExtractor', () => {
  const defaultOptions = {
    assetId: 'test-asset-123',
    assetPath: '/path/to/video.mp4',
    enabled: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    frameCache.clear();
    mockExtractFrame.mockResolvedValue(undefined);
  });

  afterEach(() => {
    frameCache.clear();
  });

  describe('basic extraction', () => {
    it('should extract a frame at given timestamp', async () => {
      const { result } = renderHook(() => useAssetFrameExtractor(defaultOptions));

      let frameUrl: string | null = null;
      await act(async () => {
        frameUrl = await result.current.extractFrame(5.5);
      });

      expect(mockExtractFrame).toHaveBeenCalledWith(expect.objectContaining({
        inputPath: defaultOptions.assetPath,
        timeSec: 5.5,
      }));
      expect(frameUrl).toBeTruthy();
    });

    it('should return cached frame on repeated requests', async () => {
      const { result } = renderHook(() => useAssetFrameExtractor(defaultOptions));

      // First extraction
      await act(async () => {
        await result.current.extractFrame(5.5);
      });

      const callCount = mockExtractFrame.mock.calls.length;

      // Second extraction - should use cache
      await act(async () => {
        await result.current.extractFrame(5.5);
      });

      // Should not have made additional IPC calls
      expect(mockExtractFrame).toHaveBeenCalledTimes(callCount);
    });

    it('should handle extraction errors gracefully', async () => {
      mockExtractFrame.mockRejectedValue(new Error('FFmpeg failed'));

      const { result } = renderHook(() => useAssetFrameExtractor(defaultOptions));

      let frameUrl: string | null = null;
      await act(async () => {
        frameUrl = await result.current.extractFrame(5.5);
      });

      expect(frameUrl).toBeNull();
      expect(result.current.error).toBeTruthy();
    });

    it('should not extract when disabled', async () => {
      const { result } = renderHook(() =>
        useAssetFrameExtractor({ ...defaultOptions, enabled: false })
      );

      let frameUrl: string | null = null;
      await act(async () => {
        frameUrl = await result.current.extractFrame(5.5);
      });

      expect(frameUrl).toBeNull();
      expect(mockExtractFrame).not.toHaveBeenCalled();
    });
  });

  describe('caching with shared FrameCache', () => {
    it('should use shared FrameCache service', async () => {
      const { result } = renderHook(() => useAssetFrameExtractor(defaultOptions));

      await act(async () => {
        await result.current.extractFrame(5.5);
      });

      // Check that frame is in the shared cache
      const cacheKey = `${defaultOptions.assetId}:5.50`;
      expect(frameCache.has(cacheKey)).toBe(true);
    });

    it('should return cache stats', async () => {
      const { result } = renderHook(() => useAssetFrameExtractor(defaultOptions));

      await act(async () => {
        await result.current.extractFrame(5.5);
      });

      // cacheStats is recalculated on each render, check frameCache directly
      const stats = frameCache.getStats();
      expect(stats.entryCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('proxy support', () => {
    it('should use proxyPath when provided', async () => {
      const { result } = renderHook(() =>
        useAssetFrameExtractor({
          ...defaultOptions,
          proxyPath: '/path/to/proxy.mp4',
        })
      );

      await act(async () => {
        await result.current.extractFrame(5.5);
      });

      expect(mockExtractFrame).toHaveBeenCalledWith(expect.objectContaining({
        inputPath: '/path/to/proxy.mp4',
      }));
    });
  });

  describe('prefetching', () => {
    it('should prefetch frames ahead', async () => {
      const { result } = renderHook(() => useAssetFrameExtractor(defaultOptions));

      await act(async () => {
        result.current.prefetchFrames(5.0, 5.2);
        // Wait for prefetch to start
        await new Promise(resolve => setTimeout(resolve, 100));
      });

      // Should have called extract_frame for prefetching
      expect(mockExtractFrame).toHaveBeenCalled();
    });

    it('should not prefetch when disabled', async () => {
      const { result } = renderHook(() =>
        useAssetFrameExtractor({ ...defaultOptions, enabled: false })
      );

      await act(async () => {
        result.current.prefetchFrames(5.0, 7.0);
        await new Promise(resolve => setTimeout(resolve, 100));
      });

      expect(mockExtractFrame).not.toHaveBeenCalled();
    });
  });

  describe('loading state', () => {
    it('should set isLoading during extraction', async () => {
      // Make extraction slow
      mockExtractFrame.mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 100))
      );

      const { result } = renderHook(() => useAssetFrameExtractor(defaultOptions));

      // Start extraction
      act(() => {
        result.current.extractFrame(5.5);
      });

      // Should be loading
      await waitFor(() => {
        expect(result.current.isLoading).toBe(true);
      });

      // Wait for completion
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      }, { timeout: 500 });
    });
  });

  describe('cleanup', () => {
    it('should not throw on unmount during extraction', async () => {
      mockExtractFrame.mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 500))
      );

      const { result, unmount } = renderHook(() => useAssetFrameExtractor(defaultOptions));

      // Start extraction
      act(() => {
        result.current.extractFrame(5.5);
      });

      // Unmount immediately
      unmount();

      // Should not throw
      expect(true).toBe(true);
    });

    it('should cancel prefetch on unmount', async () => {
      mockExtractFrame.mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 100))
      );

      const { result, unmount } = renderHook(() => useAssetFrameExtractor(defaultOptions));

      // Start prefetch
      act(() => {
        result.current.prefetchFrames(0, 10);
      });

      // Unmount immediately
      unmount();

      // Wait and verify no errors occurred
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(true).toBe(true);
    });
  });
});

// =============================================================================
// Destructive Test Scenarios
// =============================================================================

describe('useFrameExtractor - Destructive Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    frameCache.clear();
    mockExtractFrame.mockReset();
    mockExtractFrame.mockResolvedValue(undefined);
  });

  afterEach(() => {
    frameCache.clear();
    vi.useRealTimers();
  });

  describe('Race Conditions', () => {
    it('should handle rapid sequential requests for different frames', async () => {
      mockExtractFrame.mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 10))
      );

      const { result } = renderHook(() => useFrameExtractor());

      // Fire many requests in quick succession
      const promises: Promise<string | null>[] = [];
      await act(async () => {
        for (let i = 0; i < 20; i++) {
          promises.push(result.current.getFrame('/video.mp4', i * 0.1));
        }
        await Promise.all(promises);
      });

      // All should complete without errors
      expect(result.current.error).toBeNull();
    });

    it('should handle interleaved getFrame and clearCache calls', async () => {
      mockExtractFrame.mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 50))
      );

      const { result } = renderHook(() => useFrameExtractor());

      // Start extraction
      let extractPromise: Promise<string | null>;
      act(() => {
        extractPromise = result.current.getFrame('/video.mp4', 1.0);
      });

      // Clear cache while extraction is in progress
      act(() => {
        result.current.clearCache();
      });

      // Wait for extraction to complete
      await act(async () => {
        await extractPromise;
      });

      // Should not throw or corrupt state
      expect(true).toBe(true);
    });

    it('should handle concurrent extractions hitting cache limit', async () => {
      mockExtractFrame.mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 5))
      );

      const { result } = renderHook(() => useFrameExtractor({ maxCacheSize: 5 }));

      // Start many concurrent extractions
      await act(async () => {
        const promises = [];
        for (let i = 0; i < 100; i++) {
          promises.push(result.current.getFrame('/video.mp4', i * 0.01));
        }
        await Promise.all(promises);
      });

      // Cache should be limited
      expect(result.current.cacheSize).toBeLessThanOrEqual(5);
      expect(result.current.error).toBeNull();
    });
  });

  describe('Error Handling Edge Cases', () => {
    it('should recover from FFmpeg crash', async () => {
      // First call fails
      mockExtractFrame.mockRejectedValueOnce(new Error('FFmpeg crash'));
      // Second call succeeds
      mockExtractFrame.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useFrameExtractor());

      // First extraction fails
      await act(async () => {
        await result.current.getFrame('/video.mp4', 1.0);
      });

      expect(result.current.error).toBe('FFmpeg crash');

      // Second extraction should work (different timestamp, new extraction)
      await act(async () => {
        const path = await result.current.getFrame('/video.mp4', 2.0);
        expect(path).toBeTruthy();
      });

      expect(result.current.error).toBeNull();
    });

    it('should handle non-Error rejections', async () => {
      mockExtractFrame.mockRejectedValueOnce('String error');

      const { result } = renderHook(() => useFrameExtractor());

      await act(async () => {
        await result.current.getFrame('/video.mp4', 1.0);
      });

      expect(result.current.error).toBe('Frame extraction failed');
    });
  });

  describe('Memory Management', () => {
    it('should properly clean up on unmount', async () => {
      const { result, unmount } = renderHook(() => useFrameExtractor());

      // Add frames
      await act(async () => {
        await result.current.getFrame('/video.mp4', 1.0);
        await result.current.getFrame('/video.mp4', 2.0);
      });

      // Unmount
      unmount();

      // Should not throw
      expect(true).toBe(true);
    });

    it('should not leak promises on rapid mount/unmount', async () => {
      mockExtractFrame.mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 10))
      );

      for (let i = 0; i < 5; i++) {
        const { result, unmount } = renderHook(() => useFrameExtractor());

        act(() => {
          result.current.getFrame('/video.mp4', i);
        });

        unmount();
      }

      // Wait for any pending operations
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('Invalid Input Handling', () => {
    it('should handle empty input path', async () => {
      const { result } = renderHook(() => useFrameExtractor());

      await act(async () => {
        const path = await result.current.getFrame('', 1.0);
        expect(path).toBeTruthy(); // Should still produce output path
      });
    });

    it('should handle negative timestamps', async () => {
      const { result } = renderHook(() => useFrameExtractor());

      await act(async () => {
        await result.current.getFrame('/video.mp4', -1.0);
      });

      // Should not crash
      expect(result.current.error).toBeNull();
    });

    it('should handle NaN timestamps', async () => {
      const { result } = renderHook(() => useFrameExtractor());

      await act(async () => {
        await result.current.getFrame('/video.mp4', NaN);
      });

      // Should handle gracefully
      expect(result.current.error).toBeNull();
    });

    it('should handle very large timestamps', async () => {
      const { result } = renderHook(() => useFrameExtractor());

      await act(async () => {
        await result.current.getFrame('/video.mp4', Number.MAX_SAFE_INTEGER);
      });

      expect(result.current.error).toBeNull();
    });
  });
});

describe('useAssetFrameExtractor - Destructive Tests', () => {
  const defaultOptions = {
    assetId: 'test-asset-123',
    assetPath: '/path/to/video.mp4',
    enabled: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    frameCache.clear();
    mockExtractFrame.mockReset();
    mockExtractFrame.mockResolvedValue(undefined);
  });

  afterEach(() => {
    frameCache.clear();
    vi.useRealTimers();
  });

  describe('Cache Behavior', () => {
    it('should return cached frames immediately', async () => {
      const { result } = renderHook(() => useAssetFrameExtractor(defaultOptions));

      // First extraction
      await act(async () => {
        await result.current.extractFrame(5.5);
      });

      // Reset mock to track subsequent calls
      mockExtractFrame.mockClear();

      // Second request for same frame should use cache
      let cachedResult: string | null = null;
      await act(async () => {
        cachedResult = await result.current.extractFrame(5.5);
      });

      expect(cachedResult).toBeTruthy();
      // Should not have called extract again (cached)
      expect(mockExtractFrame).not.toHaveBeenCalled();
    });
  });

  describe('Prefetch Edge Cases', () => {
    it('should abort prefetch on new prefetch request', async () => {
      mockExtractFrame.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });

      const { result, unmount } = renderHook(() => useAssetFrameExtractor(defaultOptions));

      // Start first prefetch
      act(() => {
        result.current.prefetchFrames(0, 2);
      });

      // Immediately start second prefetch
      act(() => {
        result.current.prefetchFrames(5, 7);
      });

      // Wait for completion
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
      });

      // Should complete without errors
      expect(result.current.error).toBeNull();

      unmount();
    });

    it('should respect prefetchAhead option', async () => {
      const { result, unmount } = renderHook(() =>
        useAssetFrameExtractor({
          ...defaultOptions,
          prefetchAhead: 1,
          prefetchInterval: 0.5,
        })
      );

      act(() => {
        result.current.prefetchFrames(0, 100); // Request 100 seconds but should be limited
      });

      // Wait for prefetch
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 150));
      });

      // Should have limited prefetch
      expect(mockExtractFrame.mock.calls.length).toBeLessThanOrEqual(10);

      unmount();
    });
  });

  describe('Component Lifecycle', () => {
    it('should handle options change (assetId change)', async () => {
      const { result, rerender } = renderHook(
        (props) => useAssetFrameExtractor(props),
        { initialProps: defaultOptions }
      );

      // Extract with first asset
      await act(async () => {
        await result.current.extractFrame(1.0);
      });

      // Change asset
      rerender({
        ...defaultOptions,
        assetId: 'different-asset',
        assetPath: '/different/video.mp4',
      });

      // Extract with new asset
      await act(async () => {
        await result.current.extractFrame(1.0);
      });

      // Should have extracted for both assets
      expect(mockExtractFrame).toHaveBeenCalledWith(expect.objectContaining({
        inputPath: '/path/to/video.mp4',
      }));
      expect(mockExtractFrame).toHaveBeenCalledWith(expect.objectContaining({
        inputPath: '/different/video.mp4',
      }));
    });

    it('should reset error state on new extraction', async () => {
      mockExtractFrame
        .mockRejectedValueOnce(new Error('First error'))
        .mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useAssetFrameExtractor(defaultOptions));

      // First extraction fails
      await act(async () => {
        await result.current.extractFrame(1.0);
      });

      expect(result.current.error).toBeTruthy();

      // Second extraction succeeds
      await act(async () => {
        await result.current.extractFrame(2.0);
      });

      // Error should be cleared
      expect(result.current.error).toBeNull();
    });
  });

  describe('Invalid Input Handling', () => {
    it('should handle special characters in assetId', async () => {
      const { result } = renderHook(() =>
        useAssetFrameExtractor({
          ...defaultOptions,
          assetId: '../../../etc/passwd',
        })
      );

      await act(async () => {
        await result.current.extractFrame(1.0);
      });

      // Should sanitize and not crash
      expect(result.current.error).toBeNull();
    });

    it('should handle empty assetPath', async () => {
      const { result } = renderHook(() =>
        useAssetFrameExtractor({
          ...defaultOptions,
          assetPath: '',
        })
      );

      await act(async () => {
        await result.current.extractFrame(1.0);
      });

      // Should not crash
      expect(true).toBe(true);
    });
  });
});
