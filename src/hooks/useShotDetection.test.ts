/**
 * useShotDetection Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useShotDetection } from './useShotDetection';
import type { Shot, ShotDetectionResult } from './useShotDetection';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const mockShots: Shot[] = [
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
    keyframePath: '/path/to/keyframe.jpg',
    qualityScore: 0.85,
    tags: ['action'],
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

const mockDetectionResult: ShotDetectionResult = {
  shotCount: 3,
  shots: mockShots,
  totalDuration: 20.0,
};

describe('useShotDetection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with default state', () => {
    const { result } = renderHook(() => useShotDetection());

    expect(result.current.isDetecting).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.shots).toEqual([]);
  });

  it('should detect shots successfully', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockResolvedValue(mockDetectionResult);

    const { result } = renderHook(() => useShotDetection());

    let detectionResult: ShotDetectionResult | null = null;
    await act(async () => {
      detectionResult = await result.current.detectShots('asset-001', '/path/to/video.mp4');
    });

    expect(detectionResult).toEqual(mockDetectionResult);
    expect(result.current.shots).toEqual(mockShots);
    expect(result.current.isDetecting).toBe(false);
    expect(result.current.error).toBeNull();
    expect(invoke).toHaveBeenCalledWith('detect_shots', {
      assetId: 'asset-001',
      videoPath: '/path/to/video.mp4',
      config: null,
    });
  });

  it('should detect shots with custom config', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockResolvedValue(mockDetectionResult);

    const { result } = renderHook(() => useShotDetection());

    await act(async () => {
      await result.current.detectShots('asset-001', '/path/to/video.mp4', {
        threshold: 0.5,
        minShotDuration: 1.0,
      });
    });

    expect(invoke).toHaveBeenCalledWith('detect_shots', {
      assetId: 'asset-001',
      videoPath: '/path/to/video.mp4',
      config: {
        threshold: 0.5,
        minShotDuration: 1.0,
      },
    });
  });

  it('should return null for empty asset ID', async () => {
    const { result } = renderHook(() => useShotDetection());

    let detectionResult: ShotDetectionResult | null = null;
    await act(async () => {
      detectionResult = await result.current.detectShots('', '/path/to/video.mp4');
    });

    expect(detectionResult).toBeNull();
    expect(result.current.error).toBe('Asset ID and video path are required');
  });

  it('should handle detection errors', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockRejectedValue(new Error('FFmpeg not found'));

    const { result } = renderHook(() => useShotDetection());

    let detectionResult: ShotDetectionResult | null = null;
    await act(async () => {
      detectionResult = await result.current.detectShots('asset-001', '/path/to/video.mp4');
    });

    expect(detectionResult).toBeNull();
    expect(result.current.error).toBe('FFmpeg not found');
    expect(result.current.isDetecting).toBe(false);
  });

  it('should get asset shots', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockResolvedValue(mockShots);

    const { result } = renderHook(() => useShotDetection());

    let shots: Shot[] = [];
    await act(async () => {
      shots = await result.current.getAssetShots('asset-001');
    });

    expect(shots).toEqual(mockShots);
    expect(result.current.shots).toEqual(mockShots);
    expect(invoke).toHaveBeenCalledWith('get_asset_shots', { assetId: 'asset-001' });
  });

  it('should return empty array for empty asset ID when getting shots', async () => {
    const { result } = renderHook(() => useShotDetection());

    let shots: Shot[] = [];
    await act(async () => {
      shots = await result.current.getAssetShots('');
    });

    expect(shots).toEqual([]);
    expect(result.current.error).toBe('Asset ID is required');
  });

  it('should delete asset shots', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockResolvedValue(undefined);

    const { result } = renderHook(() => useShotDetection());

    // First, set some shots in state
    vi.mocked(invoke).mockResolvedValue(mockShots);
    await act(async () => {
      await result.current.getAssetShots('asset-001');
    });
    expect(result.current.shots.length).toBe(3);

    // Now delete
    vi.mocked(invoke).mockResolvedValue(undefined);
    let success = false;
    await act(async () => {
      success = await result.current.deleteAssetShots('asset-001');
    });

    expect(success).toBe(true);
    expect(result.current.shots).toEqual([]);
  });

  it('should check if shot detection is available', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockResolvedValue(true);

    const { result } = renderHook(() => useShotDetection());

    let available = false;
    await act(async () => {
      available = await result.current.isAvailable();
    });

    expect(available).toBe(true);
    expect(invoke).toHaveBeenCalledWith('is_shot_detection_available');
  });

  it('should return false when availability check fails', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockRejectedValue(new Error('Check failed'));

    const { result } = renderHook(() => useShotDetection());

    let available = true;
    await act(async () => {
      available = await result.current.isAvailable();
    });

    expect(available).toBe(false);
  });

  it('should clear error', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockRejectedValue(new Error('Some error'));

    const { result } = renderHook(() => useShotDetection());

    // Trigger an error
    await act(async () => {
      await result.current.detectShots('asset-001', '/path/to/video.mp4');
    });

    expect(result.current.error).toBe('Some error');

    // Clear the error
    act(() => {
      result.current.clearError();
    });

    expect(result.current.error).toBeNull();
  });

  it('should clear shots', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockResolvedValue(mockShots);

    const { result } = renderHook(() => useShotDetection());

    // Get shots
    await act(async () => {
      await result.current.getAssetShots('asset-001');
    });
    expect(result.current.shots.length).toBe(3);

    // Clear shots
    act(() => {
      result.current.clearShots();
    });

    expect(result.current.shots).toEqual([]);
  });

  it('should set isDetecting during detection', async () => {
    const { invoke } = await import('@tauri-apps/api/core');

    let resolveInvoke: (value: ShotDetectionResult) => void;
    const invokePromise = new Promise<ShotDetectionResult>((resolve) => {
      resolveInvoke = resolve;
    });

    vi.mocked(invoke).mockImplementation(() => invokePromise);

    const { result } = renderHook(() => useShotDetection());

    // Start detection
    let detectPromise: Promise<ShotDetectionResult | null>;
    act(() => {
      detectPromise = result.current.detectShots('asset-001', '/path/to/video.mp4');
    });

    // Should be detecting
    expect(result.current.isDetecting).toBe(true);

    // Complete detection
    await act(async () => {
      resolveInvoke!(mockDetectionResult);
      await detectPromise;
    });

    expect(result.current.isDetecting).toBe(false);
  });

  it('should calculate shot duration correctly', () => {
    // Test shot duration calculation
    const shot = mockShots[1];
    const duration = shot.endSec - shot.startSec;
    expect(duration).toBe(7.5);
  });

  // -------------------------------------------------------------------------
  // Edge Case and Robustness Tests
  // -------------------------------------------------------------------------

  it('should handle empty video path', async () => {
    const { result } = renderHook(() => useShotDetection());

    let detectionResult: ShotDetectionResult | null = null;
    await act(async () => {
      detectionResult = await result.current.detectShots('asset-001', '');
    });

    expect(detectionResult).toBeNull();
    expect(result.current.error).toBe('Asset ID and video path are required');
  });

  it('should handle both empty asset ID and video path', async () => {
    const { result } = renderHook(() => useShotDetection());

    let detectionResult: ShotDetectionResult | null = null;
    await act(async () => {
      detectionResult = await result.current.detectShots('', '');
    });

    expect(detectionResult).toBeNull();
    expect(result.current.error).toBe('Asset ID and video path are required');
  });

  it('should handle non-Error rejection', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockRejectedValue('String error message');

    const { result } = renderHook(() => useShotDetection());

    let detectionResult: ShotDetectionResult | null = null;
    await act(async () => {
      detectionResult = await result.current.detectShots('asset-001', '/path/to/video.mp4');
    });

    expect(detectionResult).toBeNull();
    expect(result.current.error).toBe('String error message');
  });

  it('should handle getAssetShots error gracefully', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockRejectedValue(new Error('Database error'));

    const { result } = renderHook(() => useShotDetection());

    let shots: Shot[] = [];
    await act(async () => {
      shots = await result.current.getAssetShots('asset-001');
    });

    expect(shots).toEqual([]);
    expect(result.current.error).toBe('Database error');
  });

  it('should handle deleteAssetShots error gracefully', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockRejectedValue(new Error('Delete failed'));

    const { result } = renderHook(() => useShotDetection());

    let success = true;
    await act(async () => {
      success = await result.current.deleteAssetShots('asset-001');
    });

    expect(success).toBe(false);
    expect(result.current.error).toBe('Delete failed');
  });

  it('should handle empty deleteAssetShots asset ID', async () => {
    const { result } = renderHook(() => useShotDetection());

    let success = true;
    await act(async () => {
      success = await result.current.deleteAssetShots('');
    });

    expect(success).toBe(false);
    expect(result.current.error).toBe('Asset ID is required');
  });

  it('should handle concurrent detectShots calls', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockResolvedValue(mockDetectionResult);

    const { result } = renderHook(() => useShotDetection());

    // Start two concurrent detection calls
    let results: (ShotDetectionResult | null)[] = [];
    await act(async () => {
      const promises = [
        result.current.detectShots('asset-001', '/path/video1.mp4'),
        result.current.detectShots('asset-002', '/path/video2.mp4'),
      ];
      results = await Promise.all(promises);
    });

    // Both should complete (last one wins for state)
    expect(results[0]).toEqual(mockDetectionResult);
    expect(results[1]).toEqual(mockDetectionResult);
  });

  it('should handle detection result with zero shots', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const emptyResult: ShotDetectionResult = {
      shotCount: 0,
      shots: [],
      totalDuration: 0,
    };
    vi.mocked(invoke).mockResolvedValue(emptyResult);

    const { result } = renderHook(() => useShotDetection());

    let detectionResult: ShotDetectionResult | null = null;
    await act(async () => {
      detectionResult = await result.current.detectShots('asset-001', '/path/to/video.mp4');
    });

    expect(detectionResult).toEqual(emptyResult);
    expect(result.current.shots).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('should preserve shots when deleting unrelated asset', async () => {
    const { invoke } = await import('@tauri-apps/api/core');

    const { result } = renderHook(() => useShotDetection());

    // First, load shots for asset-001
    vi.mocked(invoke).mockResolvedValue(mockShots);
    await act(async () => {
      await result.current.getAssetShots('asset-001');
    });
    expect(result.current.shots.length).toBe(3);

    // Delete shots for asset-002 (different asset)
    vi.mocked(invoke).mockResolvedValue(undefined);
    await act(async () => {
      await result.current.deleteAssetShots('asset-002');
    });

    // Shots for asset-001 should still be there
    expect(result.current.shots.length).toBe(3);
  });

  it('should handle shots with null optional fields', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const shotsWithNulls: Shot[] = [
      {
        id: 'shot-null',
        assetId: 'asset-001',
        startSec: 0.0,
        endSec: 5.0,
        keyframePath: null,
        qualityScore: null,
        tags: [],
      },
    ];
    vi.mocked(invoke).mockResolvedValue(shotsWithNulls);

    const { result } = renderHook(() => useShotDetection());

    await act(async () => {
      await result.current.getAssetShots('asset-001');
    });

    expect(result.current.shots[0].keyframePath).toBeNull();
    expect(result.current.shots[0].qualityScore).toBeNull();
  });

  it('should handle special characters in video path', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockResolvedValue(mockDetectionResult);

    const { result } = renderHook(() => useShotDetection());

    await act(async () => {
      await result.current.detectShots('asset-001', '/path/with spaces/video (1).mp4');
    });

    expect(invoke).toHaveBeenCalledWith('detect_shots', {
      assetId: 'asset-001',
      videoPath: '/path/with spaces/video (1).mp4',
      config: null,
    });
  });

  it('should handle partial config options', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockResolvedValue(mockDetectionResult);

    const { result } = renderHook(() => useShotDetection());

    // Only threshold provided
    await act(async () => {
      await result.current.detectShots('asset-001', '/path/to/video.mp4', {
        threshold: 0.5,
      });
    });

    expect(invoke).toHaveBeenCalledWith('detect_shots', {
      assetId: 'asset-001',
      videoPath: '/path/to/video.mp4',
      config: {
        threshold: 0.5,
        minShotDuration: undefined,
      },
    });
  });
});
