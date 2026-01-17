/**
 * useFrameExtractor Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFrameExtractor } from './useFrameExtractor';

// Mock FFmpeg utilities
vi.mock('@/utils/ffmpeg', () => ({
  extractFrame: vi.fn(),
  probeMedia: vi.fn(),
}));

import { extractFrame, probeMedia } from '@/utils/ffmpeg';

const mockExtractFrame = vi.mocked(extractFrame);
const mockProbeMedia = vi.mocked(probeMedia);

describe('useFrameExtractor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
