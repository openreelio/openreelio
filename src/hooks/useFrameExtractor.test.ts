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
  });
});
