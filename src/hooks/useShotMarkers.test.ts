/**
 * useShotMarkers Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useShotMarkers } from './useShotMarkers';
import type { Shot } from './useShotDetection';

// Mock useShotDetection
const mockDetectShots = vi.fn().mockResolvedValue(undefined);
const mockGetAssetShots = vi.fn().mockResolvedValue(undefined);
const mockClearShots = vi.fn();
const mockClearError = vi.fn();

vi.mock('./useShotDetection', () => ({
  useShotDetection: () => ({
    shots: mockShots,
    isDetecting: false,
    isLoading: false,
    error: null,
    detectShots: mockDetectShots,
    getAssetShots: mockGetAssetShots,
    deleteAssetShots: vi.fn(),
    isAvailable: vi.fn(),
    clearError: mockClearError,
    clearShots: mockClearShots,
  }),
}));

// Test data
let mockShots: Shot[] = [];

const testShots: Shot[] = [
  {
    id: 'shot-1',
    assetId: 'asset-001',
    startSec: 0.0,
    endSec: 5.0,
    keyframePath: null,
    qualityScore: null,
    tags: [],
  },
  {
    id: 'shot-2',
    assetId: 'asset-001',
    startSec: 5.0,
    endSec: 12.5,
    keyframePath: null,
    qualityScore: null,
    tags: [],
  },
  {
    id: 'shot-3',
    assetId: 'asset-001',
    startSec: 12.5,
    endSec: 20.0,
    keyframePath: null,
    qualityScore: null,
    tags: [],
  },
];

describe('useShotMarkers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShots = [];
    // Re-apply mock return values after clearAllMocks (which clears them)
    mockDetectShots.mockResolvedValue(undefined);
    mockGetAssetShots.mockResolvedValue(undefined);
  });

  // ---------------------------------------------------------------------------
  // Basic Functionality
  // ---------------------------------------------------------------------------

  it('should initialize with empty shots', () => {
    const { result } = renderHook(() =>
      useShotMarkers({
        assetId: null,
        videoPath: null,
      })
    );

    expect(result.current.shots).toEqual([]);
    expect(result.current.isDetecting).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should auto-load shots when assetId changes', async () => {
    const { rerender } = renderHook(
      ({ assetId }) =>
        useShotMarkers({
          assetId,
          videoPath: '/path/to/video.mp4',
          autoLoad: true,
        }),
      { initialProps: { assetId: null as string | null } }
    );

    // No shots loaded initially
    expect(mockGetAssetShots).not.toHaveBeenCalled();

    // Change asset ID
    rerender({ assetId: 'asset-001' });

    expect(mockGetAssetShots).toHaveBeenCalledWith('asset-001');
  });

  it('should not auto-load when autoLoad is false', () => {
    renderHook(() =>
      useShotMarkers({
        assetId: 'asset-001',
        videoPath: '/path/to/video.mp4',
        autoLoad: false,
      })
    );

    expect(mockGetAssetShots).not.toHaveBeenCalled();
  });

  it('should clear shots when assetId becomes null', () => {
    const { rerender } = renderHook(
      ({ assetId }) =>
        useShotMarkers({
          assetId,
          videoPath: '/path/to/video.mp4',
        }),
      { initialProps: { assetId: 'asset-001' as string | null } }
    );

    // Clear mock calls from initial render
    mockClearShots.mockClear();

    // Set assetId to null
    rerender({ assetId: null });

    expect(mockClearShots).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Detection
  // ---------------------------------------------------------------------------

  it('should call detectShots with assetId and videoPath', async () => {
    const { result } = renderHook(() =>
      useShotMarkers({
        assetId: 'asset-001',
        videoPath: '/path/to/video.mp4',
      })
    );

    await act(async () => {
      await result.current.detectShots({ threshold: 0.5 });
    });

    expect(mockDetectShots).toHaveBeenCalledWith(
      'asset-001',
      '/path/to/video.mp4',
      { threshold: 0.5 }
    );
  });

  it('should not call detectShots when assetId is null', async () => {
    const { result } = renderHook(() =>
      useShotMarkers({
        assetId: null,
        videoPath: '/path/to/video.mp4',
      })
    );

    await act(async () => {
      await result.current.detectShots();
    });

    expect(mockDetectShots).not.toHaveBeenCalled();
  });

  it('should not call detectShots when videoPath is null', async () => {
    const { result } = renderHook(() =>
      useShotMarkers({
        assetId: 'asset-001',
        videoPath: null,
      })
    );

    await act(async () => {
      await result.current.detectShots();
    });

    expect(mockDetectShots).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  it('should call onSeek when navigating to shot', () => {
    const onSeek = vi.fn();
    mockShots = testShots;

    const { result } = renderHook(() =>
      useShotMarkers({
        assetId: 'asset-001',
        videoPath: '/path/to/video.mp4',
        onSeek,
      })
    );

    act(() => {
      result.current.navigateToShot(testShots[1]);
    });

    expect(onSeek).toHaveBeenCalledWith(5.0);
  });

  it('should get shot at specific time', () => {
    mockShots = testShots;

    const { result } = renderHook(() =>
      useShotMarkers({
        assetId: 'asset-001',
        videoPath: '/path/to/video.mp4',
      })
    );

    const shot = result.current.getShotAtTime(7.5);

    expect(shot).toEqual(testShots[1]); // Shot 2 (5.0 - 12.5)
  });

  it('should return null when no shot at time', () => {
    mockShots = [
      { id: 's1', assetId: 'a', startSec: 0, endSec: 5, keyframePath: null, qualityScore: null, tags: [] },
      { id: 's2', assetId: 'a', startSec: 10, endSec: 15, keyframePath: null, qualityScore: null, tags: [] },
    ];

    const { result } = renderHook(() =>
      useShotMarkers({
        assetId: 'asset-001',
        videoPath: '/path/to/video.mp4',
      })
    );

    const shot = result.current.getShotAtTime(7.5); // Gap between shots

    expect(shot).toBeNull();
  });

  it('should navigate to next shot', () => {
    const onSeek = vi.fn();
    mockShots = testShots;

    const { result } = renderHook(() =>
      useShotMarkers({
        assetId: 'asset-001',
        videoPath: '/path/to/video.mp4',
        onSeek,
      })
    );

    const nextShot = result.current.nextShot(7.5); // In shot 2

    expect(nextShot).toEqual(testShots[2]); // Should return shot 3
    expect(onSeek).toHaveBeenCalledWith(12.5);
  });

  it('should return null when no next shot', () => {
    mockShots = testShots;

    const { result } = renderHook(() =>
      useShotMarkers({
        assetId: 'asset-001',
        videoPath: '/path/to/video.mp4',
      })
    );

    const nextShot = result.current.nextShot(15.0); // In last shot

    expect(nextShot).toBeNull();
  });

  it('should navigate to previous shot', () => {
    const onSeek = vi.fn();
    mockShots = testShots;

    const { result } = renderHook(() =>
      useShotMarkers({
        assetId: 'asset-001',
        videoPath: '/path/to/video.mp4',
        onSeek,
      })
    );

    const prevShot = result.current.previousShot(15.0); // In shot 3

    expect(prevShot).toEqual(testShots[2]); // Start of shot 3 since we're past 0.5s
    expect(onSeek).toHaveBeenCalledWith(12.5);
  });

  it('should go to start of current shot if past 0.5s', () => {
    const onSeek = vi.fn();
    mockShots = testShots;

    const { result } = renderHook(() =>
      useShotMarkers({
        assetId: 'asset-001',
        videoPath: '/path/to/video.mp4',
        onSeek,
      })
    );

    const prevShot = result.current.previousShot(7.5); // 2.5s into shot 2

    expect(prevShot).toEqual(testShots[1]); // Start of shot 2
    expect(onSeek).toHaveBeenCalledWith(5.0);
  });

  it('should go to previous shot if at start of current shot', () => {
    const onSeek = vi.fn();
    mockShots = testShots;

    const { result } = renderHook(() =>
      useShotMarkers({
        assetId: 'asset-001',
        videoPath: '/path/to/video.mp4',
        onSeek,
      })
    );

    const prevShot = result.current.previousShot(5.2); // Just 0.2s into shot 2

    expect(prevShot).toEqual(testShots[0]); // Shot 1
    expect(onSeek).toHaveBeenCalledWith(0.0);
  });

  // ---------------------------------------------------------------------------
  // Clear
  // ---------------------------------------------------------------------------

  it('should clear shots and error', () => {
    const { result } = renderHook(() =>
      useShotMarkers({
        assetId: 'asset-001',
        videoPath: '/path/to/video.mp4',
      })
    );

    act(() => {
      result.current.clear();
    });

    expect(mockClearShots).toHaveBeenCalled();
    expect(mockClearError).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Edge Cases
  // ---------------------------------------------------------------------------

  it('should handle empty shots array', () => {
    mockShots = [];

    const { result } = renderHook(() =>
      useShotMarkers({
        assetId: 'asset-001',
        videoPath: '/path/to/video.mp4',
      })
    );

    expect(result.current.getShotAtTime(5.0)).toBeNull();
    expect(result.current.nextShot(0)).toBeNull();
    expect(result.current.previousShot(0)).toBeNull();
  });

  it('should not reload shots for same asset', () => {
    const { rerender } = renderHook(
      ({ assetId }) =>
        useShotMarkers({
          assetId,
          videoPath: '/path/to/video.mp4',
        }),
      { initialProps: { assetId: 'asset-001' } }
    );

    // Initial load
    expect(mockGetAssetShots).toHaveBeenCalledTimes(1);

    // Rerender with same asset ID
    rerender({ assetId: 'asset-001' });

    // Should not call again
    expect(mockGetAssetShots).toHaveBeenCalledTimes(1);
  });

  it('should reload shots when asset changes', () => {
    const { rerender } = renderHook(
      ({ assetId }) =>
        useShotMarkers({
          assetId,
          videoPath: '/path/to/video.mp4',
        }),
      { initialProps: { assetId: 'asset-001' } }
    );

    // Initial load
    expect(mockGetAssetShots).toHaveBeenCalledTimes(1);

    // Rerender with different asset ID
    rerender({ assetId: 'asset-002' });

    // Should call for new asset
    expect(mockGetAssetShots).toHaveBeenCalledTimes(2);
    expect(mockGetAssetShots).toHaveBeenLastCalledWith('asset-002');
  });
});
