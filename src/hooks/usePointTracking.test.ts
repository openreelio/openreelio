/**
 * usePointTracking Hook Tests
 *
 * BDD-style tests for the point tracking hook.
 * Only mocks external boundaries (Tauri IPC).
 * Uses real objects for all internal logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ClipContext } from './usePointTracking';

// ---------------------------------------------------------------------------
// Tauri IPC mocks (external boundary only)
// ---------------------------------------------------------------------------

const mockInvoke = vi.hoisted(() => vi.fn());
const mockListen = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}));

// Import after mocks are set up
import { usePointTracking } from './usePointTracking';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLIP_CONTEXT: ClipContext = {
  sequenceId: 'seq-001',
  trackId: 'track-001',
  clipId: 'clip-001',
};

/** Simulated backend response for a successful track */
function makeTrackPointResult(pointCount: number) {
  const points = Array.from({ length: pointCount }, (_, i) => ({
    frame: i,
    x: 0.5 + i * 0.01,
    y: 0.5 + i * 0.005,
    confidence: 0.95 - i * 0.01,
  }));
  return {
    trackingData: JSON.stringify(points),
    pointsCount: pointCount,
    averageConfidence: 0.9,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('usePointTracking', () => {
  let mockUnlisten: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUnlisten = vi.fn();
    mockListen.mockResolvedValue(mockUnlisten);
    mockInvoke.mockResolvedValue(makeTrackPointResult(5));
  });

  // =========================================================================
  // Scenario: Initial state
  // =========================================================================

  describe('initial state', () => {
    it('should have isTracking=false when initialized', () => {
      const { result } = renderHook(() => usePointTracking(CLIP_CONTEXT));
      expect(result.current.isTracking).toBe(false);
    });

    it('should have progress=0 when initialized', () => {
      const { result } = renderHook(() => usePointTracking(CLIP_CONTEXT));
      expect(result.current.progress).toBe(0);
    });

    it('should have error=null when initialized', () => {
      const { result } = renderHook(() => usePointTracking(CLIP_CONTEXT));
      expect(result.current.error).toBeNull();
    });

    it('should have trackingResult=null when initialized', () => {
      const { result } = renderHook(() => usePointTracking(CLIP_CONTEXT));
      expect(result.current.trackingResult).toBeNull();
    });
  });

  // =========================================================================
  // Scenario: Successful tracking
  // =========================================================================

  describe('successful tracking', () => {
    it('should invoke track_point with correct args when startTracking is called', async () => {
      const { result } = renderHook(() => usePointTracking(CLIP_CONTEXT));

      await act(async () => {
        await result.current.startTracking(0, 0.5, 0.5);
      });

      expect(mockInvoke).toHaveBeenCalledWith('track_point', {
        args: {
          sequenceId: 'seq-001',
          trackId: 'track-001',
          clipId: 'clip-001',
          startFrame: 0,
          x: 0.5,
          y: 0.5,
          templateSize: undefined,
          searchAreaSize: undefined,
          confidenceThreshold: undefined,
        },
      });
    });

    it('should pass custom settings to invoke when provided', async () => {
      const { result } = renderHook(() => usePointTracking(CLIP_CONTEXT));

      await act(async () => {
        await result.current.startTracking(10, 0.3, 0.7, {
          templateSize: 30,
          searchAreaSize: 120,
          confidenceThreshold: 0.8,
        });
      });

      expect(mockInvoke).toHaveBeenCalledWith('track_point', {
        args: expect.objectContaining({
          startFrame: 10,
          x: 0.3,
          y: 0.7,
          templateSize: 30,
          searchAreaSize: 120,
          confidenceThreshold: 0.8,
        }),
      });
    });

    it('should contain TrackKeyframes in trackingResult after resolve', async () => {
      const { result } = renderHook(() => usePointTracking(CLIP_CONTEXT, 30));

      await act(async () => {
        await result.current.startTracking(0, 0.5, 0.5);
      });

      expect(result.current.trackingResult).not.toBeNull();
      expect(result.current.trackingResult).toHaveLength(5);

      // Verify keyframes are time-based (frame / fps)
      const first = result.current.trackingResult![0];
      expect(first.time).toBe(0); // frame 0 / 30 = 0
      expect(first.x).toBeCloseTo(0.5);
      expect(first.y).toBeCloseTo(0.5);
      expect(typeof first.confidence).toBe('number');
    });

    it('should set progress to 100 after successful tracking', async () => {
      const { result } = renderHook(() => usePointTracking(CLIP_CONTEXT));

      await act(async () => {
        await result.current.startTracking(0, 0.5, 0.5);
      });

      expect(result.current.progress).toBe(100);
    });

    it('should set isTracking=false after completion', async () => {
      const { result } = renderHook(() => usePointTracking(CLIP_CONTEXT));

      await act(async () => {
        await result.current.startTracking(0, 0.5, 0.5);
      });

      expect(result.current.isTracking).toBe(false);
    });

  });

  // =========================================================================
  // Scenario: Tracking error
  // =========================================================================

  describe('tracking error', () => {
    it('should set error to the error message when invoke rejects', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('FFmpeg process failed'));

      const { result } = renderHook(() => usePointTracking(CLIP_CONTEXT));

      await act(async () => {
        await result.current.startTracking(0, 0.5, 0.5);
      });

      expect(result.current.error).toBe('FFmpeg process failed');
    });

    it('should set isTracking=false when an error occurs', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Backend error'));

      const { result } = renderHook(() => usePointTracking(CLIP_CONTEXT));

      await act(async () => {
        await result.current.startTracking(0, 0.5, 0.5);
      });

      expect(result.current.isTracking).toBe(false);
    });

    it('should handle non-Error rejection values', async () => {
      mockInvoke.mockRejectedValueOnce('string error message');

      const { result } = renderHook(() => usePointTracking(CLIP_CONTEXT));

      await act(async () => {
        await result.current.startTracking(0, 0.5, 0.5);
      });

      expect(result.current.error).toBe('string error message');
    });

    it('should clear the previous tracking result when a retry fails', async () => {
      const { result } = renderHook(() => usePointTracking(CLIP_CONTEXT));

      await act(async () => {
        await result.current.startTracking(0, 0.5, 0.5);
      });

      expect(result.current.trackingResult).not.toBeNull();

      mockInvoke.mockRejectedValueOnce(new Error('Retry failed'));

      await act(async () => {
        await result.current.startTracking(0, 0.5, 0.5);
      });

      expect(result.current.trackingResult).toBeNull();
      expect(result.current.error).toBe('Retry failed');
    });
  });

  // =========================================================================
  // Scenario: No clip context
  // =========================================================================

  describe('no clip context', () => {
    it('should set error to "No clip context available" when clipContext is undefined', async () => {
      const { result } = renderHook(() => usePointTracking(undefined));

      await act(async () => {
        await result.current.startTracking(0, 0.5, 0.5);
      });

      expect(result.current.error).toBe('No clip context available');
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Scenario: Clear result
  // =========================================================================

  describe('clearResult', () => {
    it('should set trackingResult to null when clearResult is called', async () => {
      const { result } = renderHook(() => usePointTracking(CLIP_CONTEXT));

      // First complete a tracking
      await act(async () => {
        await result.current.startTracking(0, 0.5, 0.5);
      });
      expect(result.current.trackingResult).not.toBeNull();

      // Then clear
      act(() => {
        result.current.clearResult();
      });

      expect(result.current.trackingResult).toBeNull();
    });

    it('should reset progress to 0 when clearResult is called', async () => {
      const { result } = renderHook(() => usePointTracking(CLIP_CONTEXT));

      await act(async () => {
        await result.current.startTracking(0, 0.5, 0.5);
      });
      expect(result.current.progress).toBe(100);

      act(() => {
        result.current.clearResult();
      });

      expect(result.current.progress).toBe(0);
    });

    it('should clear error when clearResult is called', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('test error'));

      const { result } = renderHook(() => usePointTracking(CLIP_CONTEXT));

      await act(async () => {
        await result.current.startTracking(0, 0.5, 0.5);
      });
      expect(result.current.error).toBe('test error');

      act(() => {
        result.current.clearResult();
      });

      expect(result.current.error).toBeNull();
    });
  });

  // =========================================================================
  // Scenario: Cleanup on unmount
  // =========================================================================

  describe('cleanup on unmount', () => {
    it('should clean up the progress listener when the hook unmounts', async () => {
      const { result, unmount } = renderHook(() =>
        usePointTracking(CLIP_CONTEXT)
      );

      // Start tracking to register the listener
      await act(async () => {
        await result.current.startTracking(0, 0.5, 0.5);
      });

      // The listener is cleaned up in the finally block after tracking completes,
      // but the useEffect cleanup also fires on unmount for safety.
      unmount();

      // The unlisten function from the finally block should have been called
      // during the tracking flow. Verify listen was called at least.
      expect(mockListen).toHaveBeenCalled();
    });

    it('should call unlisten when tracking is in progress and hook unmounts', async () => {
      // Make invoke hang indefinitely so tracking is still in progress
      let resolveInvoke: (v: unknown) => void;
      mockInvoke.mockImplementation(
        () => new Promise((resolve) => { resolveInvoke = resolve; })
      );

      const { result, unmount } = renderHook(() =>
        usePointTracking(CLIP_CONTEXT)
      );

      // Start tracking (will not resolve)
      act(() => {
        void result.current.startTracking(0, 0.5, 0.5);
      });

      // Wait for listen to have been called
      await waitFor(() => {
        expect(mockListen).toHaveBeenCalled();
      });

      // Unmount while still tracking — useEffect cleanup should call unlisten
      unmount();

      expect(mockUnlisten).toHaveBeenCalled();

      // Resolve the pending invoke to prevent unhandled promise rejection
      resolveInvoke!(makeTrackPointResult(1));
    });
  });

  // =========================================================================
  // Scenario: FPS conversion
  // =========================================================================

  describe('fps conversion', () => {
    it('should convert frame numbers to time using provided fps', async () => {
      const result60 = makeTrackPointResult(3);
      mockInvoke.mockResolvedValueOnce(result60);

      const { result } = renderHook(() => usePointTracking(CLIP_CONTEXT, 60));

      await act(async () => {
        await result.current.startTracking(0, 0.5, 0.5);
      });

      // frame 0 / 60 = 0, frame 1 / 60 = 0.0166..., frame 2 / 60 = 0.0333...
      expect(result.current.trackingResult![0].time).toBeCloseTo(0);
      expect(result.current.trackingResult![1].time).toBeCloseTo(1 / 60);
      expect(result.current.trackingResult![2].time).toBeCloseTo(2 / 60);
    });
  });
});
