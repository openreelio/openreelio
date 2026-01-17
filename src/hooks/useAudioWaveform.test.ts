/**
 * useAudioWaveform Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAudioWaveform } from './useAudioWaveform';

// =============================================================================
// Mocks
// =============================================================================

const mockInvoke = vi.fn();
const mockConvertFileSrc = vi.fn((path: string) => `asset://${path}`);

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  convertFileSrc: (path: string) => mockConvertFileSrc(path),
}));

// =============================================================================
// Tests
// =============================================================================

describe('useAudioWaveform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(undefined);
  });

  describe('initialization', () => {
    it('should initialize with default values', () => {
      const { result } = renderHook(() => useAudioWaveform());

      expect(result.current.isGenerating).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.cacheSize).toBe(0);
    });
  });

  describe('getWaveform', () => {
    it('should generate waveform and return image URL', async () => {
      const { result } = renderHook(() => useAudioWaveform());

      let waveformUrl: string | null = null;
      await act(async () => {
        waveformUrl = await result.current.getWaveform(
          'asset_001',
          '/path/to/audio.mp3'
        );
      });

      expect(mockInvoke).toHaveBeenCalledWith('generate_waveform', {
        inputPath: '/path/to/audio.mp3',
        outputPath: expect.stringContaining('asset_001'),
        width: 1920,
        height: 100,
      });
      expect(waveformUrl).toContain('asset://');
    });

    it('should use custom dimensions when provided', async () => {
      const { result } = renderHook(() => useAudioWaveform());

      await act(async () => {
        await result.current.getWaveform(
          'asset_002',
          '/path/to/audio.mp3',
          800,
          50
        );
      });

      expect(mockInvoke).toHaveBeenCalledWith('generate_waveform', {
        inputPath: '/path/to/audio.mp3',
        outputPath: expect.stringContaining('800x50'),
        width: 800,
        height: 50,
      });
    });

    it('should cache waveform and return cached on subsequent calls', async () => {
      const { result } = renderHook(() => useAudioWaveform());

      // First call
      await act(async () => {
        await result.current.getWaveform('asset_003', '/path/to/audio.mp3');
      });

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(result.current.cacheSize).toBe(1);

      // Second call with same parameters
      await act(async () => {
        await result.current.getWaveform('asset_003', '/path/to/audio.mp3');
      });

      // Should not call invoke again
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('should handle file:// URI prefix', async () => {
      const { result } = renderHook(() => useAudioWaveform());

      await act(async () => {
        await result.current.getWaveform(
          'asset_004',
          'file:///C:/path/to/audio.mp3'
        );
      });

      expect(mockInvoke).toHaveBeenCalledWith('generate_waveform', {
        inputPath: '/C:/path/to/audio.mp3',
        outputPath: expect.any(String),
        width: 1920,
        height: 100,
      });
    });

    it('should set isGenerating during generation', async () => {
      let resolveGeneration: (value?: unknown) => void;
      mockInvoke.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveGeneration = resolve;
          })
      );

      const { result } = renderHook(() => useAudioWaveform());

      // Start generation (don't await)
      let generationPromise: Promise<string | null>;
      act(() => {
        generationPromise = result.current.getWaveform(
          'asset_005',
          '/path/to/audio.mp3'
        );
      });

      // Should be generating
      await waitFor(() => {
        expect(result.current.isGenerating).toBe(true);
      });

      // Complete generation
      await act(async () => {
        resolveGeneration!();
        await generationPromise;
      });

      // Should no longer be generating
      expect(result.current.isGenerating).toBe(false);
    });

    it('should deduplicate concurrent requests for same asset', async () => {
      const { result } = renderHook(() => useAudioWaveform());

      // Make multiple concurrent requests
      await act(async () => {
        await Promise.all([
          result.current.getWaveform('asset_006', '/path/to/audio.mp3'),
          result.current.getWaveform('asset_006', '/path/to/audio.mp3'),
          result.current.getWaveform('asset_006', '/path/to/audio.mp3'),
        ]);
      });

      // Should only call invoke once
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });
  });

  describe('hasWaveform', () => {
    it('should return false for non-cached assets', () => {
      const { result } = renderHook(() => useAudioWaveform());

      expect(result.current.hasWaveform('nonexistent')).toBe(false);
    });

    it('should return true for cached assets', async () => {
      const { result } = renderHook(() => useAudioWaveform());

      await act(async () => {
        await result.current.getWaveform('asset_007', '/path/to/audio.mp3');
      });

      expect(result.current.hasWaveform('asset_007')).toBe(true);
    });
  });

  describe('clearCache', () => {
    it('should clear all cached waveforms', async () => {
      const { result } = renderHook(() => useAudioWaveform());

      // Generate some waveforms
      await act(async () => {
        await result.current.getWaveform('asset_008', '/path/to/audio1.mp3');
        await result.current.getWaveform('asset_009', '/path/to/audio2.mp3');
      });

      expect(result.current.cacheSize).toBe(2);

      // Clear cache
      act(() => {
        result.current.clearCache();
      });

      expect(result.current.cacheSize).toBe(0);
      expect(result.current.hasWaveform('asset_008')).toBe(false);
      expect(result.current.hasWaveform('asset_009')).toBe(false);
    });

    it('should clear error state', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Generation failed'));

      const { result } = renderHook(() => useAudioWaveform());

      await act(async () => {
        await result.current.getWaveform('asset_010', '/path/to/audio.mp3');
      });

      expect(result.current.error).toBe('Generation failed');

      act(() => {
        result.current.clearCache();
      });

      expect(result.current.error).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should set error state on generation failure', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('FFmpeg not available'));

      const { result } = renderHook(() => useAudioWaveform());

      await act(async () => {
        await result.current.getWaveform('asset_011', '/path/to/audio.mp3');
      });

      expect(result.current.error).toBe('FFmpeg not available');
    });

    it('should return null on generation failure', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Failed'));

      const { result } = renderHook(() => useAudioWaveform());

      let waveformUrl: string | null = null;
      await act(async () => {
        waveformUrl = await result.current.getWaveform(
          'asset_012',
          '/path/to/audio.mp3'
        );
      });

      expect(waveformUrl).toBeNull();
    });
  });

  describe('cache eviction', () => {
    it('should evict oldest entries when cache is full', async () => {
      const { result } = renderHook(() =>
        useAudioWaveform({ maxCacheSize: 3 })
      );

      // Fill cache
      await act(async () => {
        await result.current.getWaveform('asset_a', '/path/to/a.mp3');
        // Small delay to ensure different timestamps
        await new Promise((r) => setTimeout(r, 10));
        await result.current.getWaveform('asset_b', '/path/to/b.mp3');
        await new Promise((r) => setTimeout(r, 10));
        await result.current.getWaveform('asset_c', '/path/to/c.mp3');
      });

      expect(result.current.cacheSize).toBe(3);

      // Add one more - should evict oldest (asset_a)
      await act(async () => {
        await result.current.getWaveform('asset_d', '/path/to/d.mp3');
      });

      expect(result.current.cacheSize).toBe(3);
      // asset_a should be evicted
      expect(result.current.hasWaveform('asset_a')).toBe(false);
      expect(result.current.hasWaveform('asset_b')).toBe(true);
      expect(result.current.hasWaveform('asset_c')).toBe(true);
      expect(result.current.hasWaveform('asset_d')).toBe(true);
    });
  });

  describe('options', () => {
    it('should use custom cache directory', async () => {
      const { result } = renderHook(() =>
        useAudioWaveform({ cacheDir: 'custom/waveforms' })
      );

      await act(async () => {
        await result.current.getWaveform('asset_013', '/path/to/audio.mp3');
      });

      expect(mockInvoke).toHaveBeenCalledWith('generate_waveform', {
        inputPath: '/path/to/audio.mp3',
        outputPath: expect.stringContaining('custom/waveforms'),
        width: 1920,
        height: 100,
      });
    });

    it('should use custom default dimensions', async () => {
      const { result } = renderHook(() =>
        useAudioWaveform({ defaultWidth: 1280, defaultHeight: 80 })
      );

      await act(async () => {
        await result.current.getWaveform('asset_014', '/path/to/audio.mp3');
      });

      expect(mockInvoke).toHaveBeenCalledWith('generate_waveform', {
        inputPath: '/path/to/audio.mp3',
        outputPath: expect.any(String),
        width: 1280,
        height: 80,
      });
    });
  });
});
