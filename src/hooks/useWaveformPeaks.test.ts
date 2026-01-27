/**
 * useWaveformPeaks Hook Tests
 *
 * Tests for the JSON-based waveform peak data hook.
 * Uses Tauri IPC to fetch and generate waveform data.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useWaveformPeaks } from './useWaveformPeaks';
import type { WaveformData } from '@/types';

// =============================================================================
// Mocks
// =============================================================================

const mockInvoke = vi.fn();
const mockListen = vi.fn();
const mockUnlisten = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

// =============================================================================
// Test Data
// =============================================================================

const mockWaveformData: WaveformData = {
  samplesPerSecond: 100,
  peaks: Array(500).fill(0).map((_, i) => Math.sin(i * 0.1) * 0.5 + 0.5),
  durationSec: 5.0,
  channels: 2,
};

// =============================================================================
// Tests
// =============================================================================

describe('useWaveformPeaks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListen.mockImplementation(() => Promise.resolve(mockUnlisten));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should return null data initially', async () => {
      mockInvoke.mockResolvedValue(null);

      const { result } = renderHook(() => useWaveformPeaks('asset-123'));

      expect(result.current.data).toBeNull();
      expect(result.current.isLoading).toBe(true);
      expect(result.current.error).toBeNull();

      // Flush the initial async effect to avoid act() warnings.
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
      expect(result.current.data).toBeNull();
    });
  });

  describe('fetching waveform', () => {
    it('should fetch waveform data on mount', async () => {
      mockInvoke.mockResolvedValue(mockWaveformData);

      const { result } = renderHook(() => useWaveformPeaks('asset-123'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockInvoke).toHaveBeenCalledWith('get_waveform_data', {
        assetId: 'asset-123',
      });
      expect(result.current.data).toEqual(mockWaveformData);
    });

    it('should return null if waveform not generated yet', async () => {
      mockInvoke.mockResolvedValue(null);

      const { result } = renderHook(() => useWaveformPeaks('asset-456'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.data).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it('should handle fetch errors gracefully', async () => {
      mockInvoke.mockRejectedValue(new Error('Failed to read waveform'));

      const { result } = renderHook(() => useWaveformPeaks('asset-789'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.data).toBeNull();
      expect(result.current.error).toBe('Failed to read waveform');
    });
  });

  describe('generating waveform', () => {
    it('should generate waveform when requested', async () => {
      // First fetch returns null (not generated)
      mockInvoke
        .mockResolvedValueOnce(null) // get_waveform_data
        .mockResolvedValueOnce(mockWaveformData); // generate_waveform_for_asset

      const { result } = renderHook(() =>
        useWaveformPeaks('asset-new', { inputPath: '/path/to/video.mp4' })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Trigger generation
      await act(async () => {
        await result.current.generate();
      });

      expect(mockInvoke).toHaveBeenCalledWith('generate_waveform_for_asset', {
        assetId: 'asset-new',
        samplesPerSecond: 100,
      });
    });

    it('should track generating state', async () => {
      mockInvoke
        .mockResolvedValueOnce(null)
        .mockImplementation(
          () =>
            new Promise((resolve) => setTimeout(() => resolve(mockWaveformData), 100))
        );

      const { result } = renderHook(() =>
        useWaveformPeaks('asset-gen', { inputPath: '/path/to/audio.mp3' })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Start generation
      act(() => {
        result.current.generate();
      });

      expect(result.current.isGenerating).toBe(true);

      await waitFor(() => {
        expect(result.current.isGenerating).toBe(false);
      });
    });
  });

  describe('caching', () => {
    it('should use cached data on subsequent renders', async () => {
      mockInvoke.mockResolvedValue(mockWaveformData);

      const { result, rerender } = renderHook(
        ({ assetId }) => useWaveformPeaks(assetId),
        { initialProps: { assetId: 'asset-cached' } }
      );

      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      // Rerender with same asset
      rerender({ assetId: 'asset-cached' });

      // Should not trigger another fetch (data already loaded)
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('should refetch when asset ID changes', async () => {
      mockInvoke.mockResolvedValue(mockWaveformData);

      const { result, rerender } = renderHook(
        ({ assetId }) => useWaveformPeaks(assetId),
        { initialProps: { assetId: 'asset-1' } }
      );

      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      // Change asset ID
      rerender({ assetId: 'asset-2' });

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('utility methods', () => {
    it('should provide peakAtTime helper', async () => {
      mockInvoke.mockResolvedValue(mockWaveformData);

      const { result } = renderHook(() => useWaveformPeaks('asset-util'));

      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      // Peak at 1.0 second (index 100)
      const peak = result.current.peakAtTime(1.0);
      expect(peak).toBeGreaterThanOrEqual(0);
      expect(peak).toBeLessThanOrEqual(1);
    });

    it('should provide peaksInRange helper', async () => {
      mockInvoke.mockResolvedValue(mockWaveformData);

      const { result } = renderHook(() => useWaveformPeaks('asset-range'));

      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      // Peaks from 1.0s to 2.0s (100 samples at 100 samples/sec)
      const peaks = result.current.peaksInRange(1.0, 2.0);
      expect(peaks.length).toBe(100);
    });

    it('should handle out-of-range values gracefully', async () => {
      mockInvoke.mockResolvedValue(mockWaveformData);

      const { result } = renderHook(() => useWaveformPeaks('asset-bounds'));

      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      // Out of range
      expect(result.current.peakAtTime(-1)).toBe(0);
      expect(result.current.peakAtTime(100)).toBe(0);
      expect(result.current.peaksInRange(10, 20).length).toBe(0);
    });
  });

  describe('disabled state', () => {
    it('should not fetch when disabled', async () => {
      mockInvoke.mockResolvedValue(mockWaveformData);

      const { result } = renderHook(() =>
        useWaveformPeaks('asset-disabled', { enabled: false })
      );

      // Wait a bit to ensure no fetch happens
      await new Promise((r) => setTimeout(r, 50));

      expect(mockInvoke).not.toHaveBeenCalled();
      expect(result.current.data).toBeNull();
      expect(result.current.isLoading).toBe(false);
    });
  });
});
