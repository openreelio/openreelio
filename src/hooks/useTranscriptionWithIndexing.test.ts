/**
 * useTranscriptionWithIndexing Hook Tests
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTranscriptionWithIndexing } from './useTranscriptionWithIndexing';
import { useTranscription } from './useTranscription';
import { useSearch } from './useSearch';

// Mock the hooks
vi.mock('./useTranscription');
vi.mock('./useSearch');

// Mock logger
vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('useTranscriptionWithIndexing', () => {
  const mockTranscribeAsset = vi.fn();
  const mockSubmitTranscriptionJob = vi.fn();
  const mockIsTranscriptionAvailable = vi.fn();
  const mockGetCachedTranscription = vi.fn();
  const mockIndexTranscripts = vi.fn();
  const mockIsSearchAvailable = vi.fn();

  const mockTranscriptionResult = {
    language: 'en',
    segments: [
      { startTime: 0, endTime: 2, text: 'Hello world' },
      { startTime: 2, endTime: 4, text: 'Test segment' },
    ],
    duration: 4,
    fullText: 'Hello world Test segment',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    (useTranscription as Mock).mockReturnValue({
      transcribeAsset: mockTranscribeAsset,
      submitTranscriptionJob: mockSubmitTranscriptionJob,
      isTranscriptionAvailable: mockIsTranscriptionAvailable,
      getCachedTranscription: mockGetCachedTranscription,
      clearCache: vi.fn(),
      state: {
        isTranscribing: false,
        progress: 0,
        error: null,
        result: null,
      },
      cacheSize: 0,
    });

    (useSearch as Mock).mockReturnValue({
      search: vi.fn(),
      searchAssets: vi.fn(),
      clearResults: vi.fn(),
      clearCache: vi.fn(),
      isSearchAvailable: mockIsSearchAvailable,
      indexAsset: vi.fn(),
      indexTranscripts: mockIndexTranscripts,
      removeAssetFromSearch: vi.fn(),
      state: {
        isSearching: false,
        query: '',
        results: null,
        error: null,
      },
    });
  });

  it('should transcribe and index by default', async () => {
    mockTranscribeAsset.mockResolvedValue(mockTranscriptionResult);
    mockIsSearchAvailable.mockResolvedValue(true);
    mockIndexTranscripts.mockResolvedValue(undefined);

    const { result } = renderHook(() => useTranscriptionWithIndexing());

    let transcriptionResult: typeof mockTranscriptionResult | null = null;

    await act(async () => {
      transcriptionResult = await result.current.transcribeAndIndex('asset-1');
    });

    expect(mockTranscribeAsset).toHaveBeenCalledWith('asset-1', {});
    expect(mockIsSearchAvailable).toHaveBeenCalled();
    expect(mockIndexTranscripts).toHaveBeenCalledWith(
      'asset-1',
      expect.arrayContaining([
        { startTime: 0, endTime: 2, text: 'Hello world' },
        { startTime: 2, endTime: 4, text: 'Test segment' },
      ]),
      'en'
    );
    expect(transcriptionResult).toEqual(mockTranscriptionResult);
  });

  it('should skip indexing when skipIndexing option is true', async () => {
    mockTranscribeAsset.mockResolvedValue(mockTranscriptionResult);

    const { result } = renderHook(() => useTranscriptionWithIndexing());

    await act(async () => {
      await result.current.transcribeAndIndex('asset-1', { skipIndexing: true });
    });

    expect(mockTranscribeAsset).toHaveBeenCalled();
    expect(mockIsSearchAvailable).not.toHaveBeenCalled();
    expect(mockIndexTranscripts).not.toHaveBeenCalled();
  });

  it('should skip indexing when autoIndex is false', async () => {
    mockTranscribeAsset.mockResolvedValue(mockTranscriptionResult);

    const { result } = renderHook(() =>
      useTranscriptionWithIndexing({ autoIndex: false })
    );

    await act(async () => {
      await result.current.transcribeAndIndex('asset-1');
    });

    expect(mockTranscribeAsset).toHaveBeenCalled();
    expect(mockIsSearchAvailable).not.toHaveBeenCalled();
    expect(mockIndexTranscripts).not.toHaveBeenCalled();
  });

  it('should skip indexing when search is not available', async () => {
    mockTranscribeAsset.mockResolvedValue(mockTranscriptionResult);
    mockIsSearchAvailable.mockResolvedValue(false);

    const { result } = renderHook(() => useTranscriptionWithIndexing());

    await act(async () => {
      await result.current.transcribeAndIndex('asset-1');
    });

    expect(mockTranscribeAsset).toHaveBeenCalled();
    expect(mockIsSearchAvailable).toHaveBeenCalled();
    expect(mockIndexTranscripts).not.toHaveBeenCalled();
  });

  it('should not throw when indexing fails', async () => {
    mockTranscribeAsset.mockResolvedValue(mockTranscriptionResult);
    mockIsSearchAvailable.mockResolvedValue(true);
    mockIndexTranscripts.mockRejectedValue(new Error('Indexing failed'));

    const { result } = renderHook(() => useTranscriptionWithIndexing());

    let transcriptionResult: typeof mockTranscriptionResult | null = null;

    await act(async () => {
      transcriptionResult = await result.current.transcribeAndIndex('asset-1');
    });

    // Should still return transcription result even if indexing fails
    expect(transcriptionResult).toEqual(mockTranscriptionResult);
  });

  it('should not index when transcription fails', async () => {
    mockTranscribeAsset.mockResolvedValue(null);

    const { result } = renderHook(() => useTranscriptionWithIndexing());

    await act(async () => {
      await result.current.transcribeAndIndex('asset-1');
    });

    expect(mockTranscribeAsset).toHaveBeenCalled();
    expect(mockIsSearchAvailable).not.toHaveBeenCalled();
    expect(mockIndexTranscripts).not.toHaveBeenCalled();
  });

  it('should not index empty segments', async () => {
    mockTranscribeAsset.mockResolvedValue({
      ...mockTranscriptionResult,
      segments: [],
    });
    mockIsSearchAvailable.mockResolvedValue(true);

    const { result } = renderHook(() => useTranscriptionWithIndexing());

    await act(async () => {
      await result.current.transcribeAndIndex('asset-1');
    });

    // indexTranscription is called, but it returns early due to empty segments
    expect(mockIndexTranscripts).not.toHaveBeenCalled();
  });

  it('should expose indexTranscription for manual indexing', async () => {
    mockIndexTranscripts.mockResolvedValue(undefined);

    const { result } = renderHook(() => useTranscriptionWithIndexing());

    await act(async () => {
      await result.current.indexTranscription('asset-1', mockTranscriptionResult);
    });

    expect(mockIndexTranscripts).toHaveBeenCalledWith(
      'asset-1',
      expect.any(Array),
      'en'
    );
  });

  it('should pass through transcription options', async () => {
    mockTranscribeAsset.mockResolvedValue(mockTranscriptionResult);
    mockIsSearchAvailable.mockResolvedValue(true);
    mockIndexTranscripts.mockResolvedValue(undefined);

    const { result } = renderHook(() => useTranscriptionWithIndexing());

    await act(async () => {
      await result.current.transcribeAndIndex('asset-1', {
        language: 'ko',
        model: 'large',
        translate: true,
      });
    });

    expect(mockTranscribeAsset).toHaveBeenCalledWith('asset-1', {
      language: 'ko',
      model: 'large',
      translate: true,
    });
  });

  it('should expose isTranscriptionAvailable', async () => {
    mockIsTranscriptionAvailable.mockResolvedValue(true);

    const { result } = renderHook(() => useTranscriptionWithIndexing());

    let available = false;
    await act(async () => {
      available = await result.current.isTranscriptionAvailable();
    });

    expect(available).toBe(true);
  });

  it('should expose isSearchAvailable', async () => {
    mockIsSearchAvailable.mockResolvedValue(true);

    const { result } = renderHook(() => useTranscriptionWithIndexing());

    let available = false;
    await act(async () => {
      available = await result.current.isSearchAvailable();
    });

    expect(available).toBe(true);
  });

  it('should expose getCachedTranscription', () => {
    mockGetCachedTranscription.mockReturnValue(mockTranscriptionResult);

    const { result } = renderHook(() => useTranscriptionWithIndexing());

    const cached = result.current.getCachedTranscription('asset-1');

    expect(mockGetCachedTranscription).toHaveBeenCalledWith('asset-1');
    expect(cached).toEqual(mockTranscriptionResult);
  });

  it('should expose transcriptionState', () => {
    const { result } = renderHook(() => useTranscriptionWithIndexing());

    expect(result.current.transcriptionState).toEqual({
      isTranscribing: false,
      progress: 0,
      error: null,
      result: null,
    });
  });

  it('should expose submitTranscriptionJob', async () => {
    mockSubmitTranscriptionJob.mockResolvedValue('job-123');

    const { result } = renderHook(() => useTranscriptionWithIndexing());

    let jobId: string = '';
    await act(async () => {
      jobId = await result.current.submitTranscriptionJob('asset-1', {
        language: 'en',
      });
    });

    expect(mockSubmitTranscriptionJob).toHaveBeenCalledWith('asset-1', {
      language: 'en',
    });
    expect(jobId).toBe('job-123');
  });
});
