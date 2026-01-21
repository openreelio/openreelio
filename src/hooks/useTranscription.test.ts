/**
 * useTranscription Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTranscription } from './useTranscription';

// =============================================================================
// Mocks
// =============================================================================

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { invoke } from '@tauri-apps/api/core';

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

// =============================================================================
// Test Data
// =============================================================================

const mockTranscriptionResult = {
  language: 'en',
  segments: [
    { startTime: 0.0, endTime: 1.5, text: 'Hello' },
    { startTime: 1.5, endTime: 3.0, text: 'World' },
  ],
  duration: 3.0,
  fullText: 'Hello World',
};

// =============================================================================
// Tests
// =============================================================================

describe('useTranscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Initialization Tests
  // ===========================================================================

  describe('initialization', () => {
    it('should initialize with default state', () => {
      const { result } = renderHook(() => useTranscription());

      expect(result.current.state.isTranscribing).toBe(false);
      expect(result.current.state.progress).toBe(0);
      expect(result.current.state.error).toBeNull();
      expect(result.current.state.result).toBeNull();
      expect(result.current.cacheSize).toBe(0);
    });

    it('should provide all required functions', () => {
      const { result } = renderHook(() => useTranscription());

      expect(typeof result.current.transcribeAsset).toBe('function');
      expect(typeof result.current.submitTranscriptionJob).toBe('function');
      expect(typeof result.current.isTranscriptionAvailable).toBe('function');
      expect(typeof result.current.getCachedTranscription).toBe('function');
      expect(typeof result.current.clearCache).toBe('function');
    });
  });

  // ===========================================================================
  // Availability Check Tests
  // ===========================================================================

  describe('isTranscriptionAvailable', () => {
    it('should return true when transcription is available', async () => {
      mockInvoke.mockResolvedValueOnce(true);

      const { result } = renderHook(() => useTranscription());

      let available: boolean;
      await act(async () => {
        available = await result.current.isTranscriptionAvailable();
      });

      expect(available!).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('is_transcription_available');
    });

    it('should return false when transcription is not available', async () => {
      mockInvoke.mockResolvedValueOnce(false);

      const { result } = renderHook(() => useTranscription());

      let available: boolean;
      await act(async () => {
        available = await result.current.isTranscriptionAvailable();
      });

      expect(available!).toBe(false);
    });

    it('should return false on error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('API error'));

      const { result } = renderHook(() => useTranscription());

      let available: boolean;
      await act(async () => {
        available = await result.current.isTranscriptionAvailable();
      });

      expect(available!).toBe(false);
    });
  });

  // ===========================================================================
  // Transcription Tests
  // ===========================================================================

  describe('transcribeAsset', () => {
    it('should transcribe an asset successfully', async () => {
      mockInvoke.mockResolvedValueOnce(mockTranscriptionResult);

      const { result } = renderHook(() => useTranscription());

      let transcriptionResult: Awaited<ReturnType<typeof result.current.transcribeAsset>> = null;

      await act(async () => {
        transcriptionResult = await result.current.transcribeAsset('asset_001');
      });

      expect(transcriptionResult).toEqual(mockTranscriptionResult);
      expect(result.current.state.result).toEqual(mockTranscriptionResult);
      expect(result.current.state.isTranscribing).toBe(false);
      expect(result.current.state.error).toBeNull();
      expect(mockInvoke).toHaveBeenCalledWith('transcribe_asset', {
        assetId: 'asset_001',
        options: null,
      });
    });

    it('should pass transcription options', async () => {
      mockInvoke.mockResolvedValueOnce(mockTranscriptionResult);

      const { result } = renderHook(() => useTranscription());

      await act(async () => {
        await result.current.transcribeAsset('asset_001', {
          language: 'ko',
          model: 'small',
        });
      });

      expect(mockInvoke).toHaveBeenCalledWith('transcribe_asset', {
        assetId: 'asset_001',
        options: { language: 'ko', model: 'small' },
      });
    });

    it('should handle transcription errors', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Transcription failed'));

      const { result } = renderHook(() => useTranscription());

      let transcriptionResult: Awaited<
        ReturnType<typeof result.current.transcribeAsset>
      >;

      await act(async () => {
        transcriptionResult = await result.current.transcribeAsset('asset_001');
      });

      expect(transcriptionResult!).toBeNull();
      expect(result.current.state.result).toBeNull();
      expect(result.current.state.isTranscribing).toBe(false);
      expect(result.current.state.error).toBe('Transcription failed');
    });

    it('should set isTranscribing during transcription', async () => {
      // Create a delayed promise
      let resolveInvoke: (value: typeof mockTranscriptionResult) => void;
      const delayedPromise = new Promise<typeof mockTranscriptionResult>(
        (resolve) => {
          resolveInvoke = resolve;
        }
      );
      mockInvoke.mockReturnValueOnce(delayedPromise);

      const { result } = renderHook(() => useTranscription());

      // Start transcription
      act(() => {
        void result.current.transcribeAsset('asset_001');
      });

      // Should be transcribing
      expect(result.current.state.isTranscribing).toBe(true);

      // Complete the transcription
      await act(async () => {
        resolveInvoke!(mockTranscriptionResult);
        await delayedPromise;
      });

      expect(result.current.state.isTranscribing).toBe(false);
    });
  });

  // ===========================================================================
  // Cache Tests
  // ===========================================================================

  describe('caching', () => {
    it('should cache transcription results', async () => {
      mockInvoke.mockResolvedValueOnce(mockTranscriptionResult);

      const { result } = renderHook(() => useTranscription());

      await act(async () => {
        await result.current.transcribeAsset('asset_001');
      });

      expect(result.current.cacheSize).toBe(1);
      expect(result.current.getCachedTranscription('asset_001')).toEqual(
        mockTranscriptionResult
      );
    });

    it('should return cached result on second call', async () => {
      mockInvoke.mockResolvedValueOnce(mockTranscriptionResult);

      const { result } = renderHook(() => useTranscription());

      // First call
      await act(async () => {
        await result.current.transcribeAsset('asset_001');
      });

      // Second call should not invoke API
      await act(async () => {
        await result.current.transcribeAsset('asset_001');
      });

      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('should not cache when cacheResults is false', async () => {
      mockInvoke.mockResolvedValue(mockTranscriptionResult);

      const { result } = renderHook(() =>
        useTranscription({ cacheResults: false })
      );

      await act(async () => {
        await result.current.transcribeAsset('asset_001');
      });

      expect(result.current.cacheSize).toBe(0);

      // Second call should invoke API again
      await act(async () => {
        await result.current.transcribeAsset('asset_001');
      });

      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });

    it('should clear cache', async () => {
      mockInvoke.mockResolvedValueOnce(mockTranscriptionResult);

      const { result } = renderHook(() => useTranscription());

      await act(async () => {
        await result.current.transcribeAsset('asset_001');
      });

      expect(result.current.cacheSize).toBe(1);

      act(() => {
        result.current.clearCache();
      });

      expect(result.current.cacheSize).toBe(0);
      expect(result.current.getCachedTranscription('asset_001')).toBeNull();
    });

    it('should evict oldest entries when cache is full', async () => {
      const { result } = renderHook(() =>
        useTranscription({ maxCacheSize: 2 })
      );

      // Add 3 entries to a cache with max size 2
      for (let i = 0; i < 3; i++) {
        mockInvoke.mockResolvedValueOnce({
          ...mockTranscriptionResult,
          fullText: `Text ${i}`,
        });

        await act(async () => {
          await result.current.transcribeAsset(`asset_00${i}`);
        });
      }

      expect(result.current.cacheSize).toBe(2);
      // First entry should be evicted
      expect(result.current.getCachedTranscription('asset_000')).toBeNull();
      // Later entries should still exist
      expect(result.current.getCachedTranscription('asset_001')).not.toBeNull();
      expect(result.current.getCachedTranscription('asset_002')).not.toBeNull();
    });
  });

  // ===========================================================================
  // Job Submission Tests
  // ===========================================================================

  describe('submitTranscriptionJob', () => {
    it('should submit a transcription job', async () => {
      mockInvoke.mockResolvedValueOnce('job_123');

      const { result } = renderHook(() => useTranscription());

      let jobId: string;
      await act(async () => {
        jobId = await result.current.submitTranscriptionJob('asset_001');
      });

      expect(jobId!).toBe('job_123');
      expect(mockInvoke).toHaveBeenCalledWith('submit_transcription_job', {
        assetId: 'asset_001',
        options: null,
      });
    });

    it('should pass options to job submission', async () => {
      mockInvoke.mockResolvedValueOnce('job_123');

      const { result } = renderHook(() => useTranscription());

      await act(async () => {
        await result.current.submitTranscriptionJob('asset_001', {
          language: 'en',
          translate: true,
        });
      });

      expect(mockInvoke).toHaveBeenCalledWith('submit_transcription_job', {
        assetId: 'asset_001',
        options: { language: 'en', translate: true },
      });
    });

    it('should throw on job submission failure', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Job queue full'));

      const { result } = renderHook(() => useTranscription());

      await expect(
        act(async () => {
          await result.current.submitTranscriptionJob('asset_001');
        })
      ).rejects.toThrow('Job queue full');
    });
  });
});
