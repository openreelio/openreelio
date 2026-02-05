/**
 * useQualifier Hook Tests
 *
 * TDD: RED phase - Writing tests first
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useQualifier } from './useQualifier';
import { DEFAULT_QUALIFIER_VALUES, QUALIFIER_PRESETS } from '@/types/qualifier';

// =============================================================================
// Mocks
// =============================================================================

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// =============================================================================
// Test Suite
// =============================================================================

describe('useQualifier', () => {
  const mockClipId = 'clip-123';
  const mockEffectId = 'effect-456';

  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Initialization Tests
  // ===========================================================================

  describe('initialization', () => {
    it('should initialize with default values when no effectId provided', () => {
      const { result } = renderHook(() => useQualifier({ clipId: mockClipId }));

      expect(result.current.values).toEqual(DEFAULT_QUALIFIER_VALUES);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('should fetch effect params when effectId is provided', async () => {
      const mockParams = {
        hue_center: 200,
        hue_width: 50,
        sat_min: 0.3,
        sat_max: 0.9,
        lum_min: 0.1,
        lum_max: 0.8,
        softness: 0.2,
        hue_shift: 10,
        sat_adjust: 0.1,
        lum_adjust: -0.1,
        invert: true,
      };

      mockInvoke.mockResolvedValueOnce(mockParams);

      const { result } = renderHook(() =>
        useQualifier({ clipId: mockClipId, effectId: mockEffectId })
      );

      await waitFor(() => {
        expect(result.current.values.hue_center).toBe(200);
      });

      expect(mockInvoke).toHaveBeenCalledWith('get_effect_params', {
        effectId: mockEffectId,
      });
    });

    it('should handle fetch error gracefully', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() =>
        useQualifier({ clipId: mockClipId, effectId: mockEffectId })
      );

      await waitFor(() => {
        expect(result.current.error).toBe('Network error');
      });

      // Should fall back to default values
      expect(result.current.values).toEqual(DEFAULT_QUALIFIER_VALUES);
    });
  });

  // ===========================================================================
  // Update Value Tests
  // ===========================================================================

  describe('updateValue', () => {
    it('should update a single value locally', () => {
      const { result } = renderHook(() => useQualifier({ clipId: mockClipId }));

      act(() => {
        result.current.updateValue('hue_center', 180);
      });

      expect(result.current.values.hue_center).toBe(180);
    });

    it('should clamp values within constraints', () => {
      const { result } = renderHook(() => useQualifier({ clipId: mockClipId }));

      act(() => {
        result.current.updateValue('hue_center', 500); // Max is 360
      });

      expect(result.current.values.hue_center).toBe(360);

      act(() => {
        result.current.updateValue('sat_min', -0.5); // Min is 0
      });

      expect(result.current.values.sat_min).toBe(0);
    });

    it('should enforce sat_min <= sat_max constraint', () => {
      const { result } = renderHook(() => useQualifier({ clipId: mockClipId }));

      // Set sat_max to a known value first
      act(() => {
        result.current.updateValue('sat_max', 0.5);
      });

      // Try to set sat_min higher than sat_max
      act(() => {
        result.current.updateValue('sat_min', 0.8);
      });

      // Should be clamped to sat_max
      expect(result.current.values.sat_min).toBe(0.5);
    });

    it('should enforce lum_min <= lum_max constraint', () => {
      const { result } = renderHook(() => useQualifier({ clipId: mockClipId }));

      // Set lum_max to a known value first
      act(() => {
        result.current.updateValue('lum_max', 0.6);
      });

      // Try to set lum_min higher than lum_max
      act(() => {
        result.current.updateValue('lum_min', 0.9);
      });

      // Should be clamped to lum_max
      expect(result.current.values.lum_min).toBe(0.6);
    });

    it('should debounce IPC calls when effectId exists', async () => {
      const { result } = renderHook(() =>
        useQualifier({ clipId: mockClipId, effectId: mockEffectId })
      );

      // Multiple rapid updates
      act(() => {
        result.current.updateValue('hue_center', 100);
        result.current.updateValue('hue_center', 150);
        result.current.updateValue('hue_center', 200);
      });

      // Should debounce and only call once
      await waitFor(
        () => {
          expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
            commandType: 'UpdateEffectParam',
            payload: expect.objectContaining({
              effectId: mockEffectId,
              paramName: 'hue_center',
              value: 200,
            }),
          });
        },
        { timeout: 500 }
      );
    });
  });

  // ===========================================================================
  // Preset Tests
  // ===========================================================================

  describe('applyPreset', () => {
    it('should apply skin_tones preset', () => {
      const { result } = renderHook(() => useQualifier({ clipId: mockClipId }));

      act(() => {
        result.current.applyPreset('skin_tones');
      });

      expect(result.current.values).toEqual(QUALIFIER_PRESETS.skin_tones);
    });

    it('should apply sky_blue preset', () => {
      const { result } = renderHook(() => useQualifier({ clipId: mockClipId }));

      act(() => {
        result.current.applyPreset('sky_blue');
      });

      expect(result.current.values).toEqual(QUALIFIER_PRESETS.sky_blue);
    });

    it('should apply foliage preset', () => {
      const { result } = renderHook(() => useQualifier({ clipId: mockClipId }));

      act(() => {
        result.current.applyPreset('foliage');
      });

      expect(result.current.values).toEqual(QUALIFIER_PRESETS.foliage);
    });

    it('should sync preset to backend when effectId exists', async () => {
      const { result } = renderHook(() =>
        useQualifier({ clipId: mockClipId, effectId: mockEffectId })
      );

      act(() => {
        result.current.applyPreset('skin_tones');
      });

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
          commandType: 'UpdateEffectParams',
          payload: expect.objectContaining({
            effectId: mockEffectId,
            params: QUALIFIER_PRESETS.skin_tones,
          }),
        });
      });
    });
  });

  // ===========================================================================
  // Reset Tests
  // ===========================================================================

  describe('reset', () => {
    it('should reset to default values', () => {
      const { result } = renderHook(() => useQualifier({ clipId: mockClipId }));

      // First modify values
      act(() => {
        result.current.updateValue('hue_center', 250);
        result.current.updateValue('sat_min', 0.5);
      });

      expect(result.current.values.hue_center).toBe(250);

      // Then reset
      act(() => {
        result.current.reset();
      });

      expect(result.current.values).toEqual(DEFAULT_QUALIFIER_VALUES);
    });

    it('should sync reset to backend when effectId exists', async () => {
      const { result } = renderHook(() =>
        useQualifier({ clipId: mockClipId, effectId: mockEffectId })
      );

      act(() => {
        result.current.reset();
      });

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
          commandType: 'UpdateEffectParams',
          payload: expect.objectContaining({
            effectId: mockEffectId,
            params: DEFAULT_QUALIFIER_VALUES,
          }),
        });
      });
    });
  });

  // ===========================================================================
  // Preview Mode Tests
  // ===========================================================================

  describe('preview mode', () => {
    it('should toggle preview mode', () => {
      const { result } = renderHook(() => useQualifier({ clipId: mockClipId }));

      expect(result.current.previewEnabled).toBe(false);

      act(() => {
        result.current.setPreviewEnabled(true);
      });

      expect(result.current.previewEnabled).toBe(true);
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('error handling', () => {
    it('should clear error', () => {
      const { result } = renderHook(() => useQualifier({ clipId: mockClipId }));

      // Manually set error for testing
      act(() => {
        result.current.updateValue('hue_center', 180);
      });

      act(() => {
        result.current.clearError();
      });

      expect(result.current.error).toBeNull();
    });

    it('should handle IPC error during update', async () => {
      // First call (get_effect_params) succeeds, second call (execute_command) fails
      mockInvoke
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('IPC failed'));

      const { result } = renderHook(() =>
        useQualifier({ clipId: mockClipId, effectId: mockEffectId })
      );

      // Wait for initial fetch to complete
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      act(() => {
        result.current.updateValue('hue_center', 200);
      });

      await waitFor(() => {
        expect(result.current.error).toBe('IPC failed');
      });
    });
  });

  // ===========================================================================
  // Dirty State Tests
  // ===========================================================================

  describe('dirty state', () => {
    it('should track dirty state when values change', () => {
      const { result } = renderHook(() => useQualifier({ clipId: mockClipId }));

      expect(result.current.isDirty).toBe(false);

      act(() => {
        result.current.updateValue('hue_center', 180);
      });

      expect(result.current.isDirty).toBe(true);
    });

    it('should reset dirty state after reset()', () => {
      const { result } = renderHook(() => useQualifier({ clipId: mockClipId }));

      act(() => {
        result.current.updateValue('hue_center', 180);
      });

      expect(result.current.isDirty).toBe(true);

      act(() => {
        result.current.reset();
      });

      expect(result.current.isDirty).toBe(false);
    });
  });

  // ===========================================================================
  // Edge Case & Destructive Tests
  // ===========================================================================

  describe('edge cases and destructive scenarios', () => {
    it('should handle rapid value changes without memory leaks', async () => {
      vi.useFakeTimers();

      const { result } = renderHook(() =>
        useQualifier({ clipId: mockClipId, effectId: mockEffectId })
      );

      // Rapid fire 100 updates
      for (let i = 0; i < 100; i++) {
        act(() => {
          result.current.updateValue('hue_center', i * 3.6);
        });
      }

      // Fast forward debounce
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      // Should only have made one backend update call (ignoring initial fetch)
      const executeCommandCalls = mockInvoke.mock.calls.filter(
        ([command]) => command === 'execute_command'
      );
      expect(executeCommandCalls).toHaveLength(1);

      vi.useRealTimers();
    });

    it('should handle boundary values correctly', () => {
      const { result } = renderHook(() => useQualifier({ clipId: mockClipId }));

      // Test all boundary values
      act(() => {
        result.current.updateValue('hue_center', 0);
      });
      expect(result.current.values.hue_center).toBe(0);

      act(() => {
        result.current.updateValue('hue_center', 360);
      });
      expect(result.current.values.hue_center).toBe(360);

      act(() => {
        result.current.updateValue('sat_min', 0);
      });
      expect(result.current.values.sat_min).toBe(0);

      act(() => {
        result.current.updateValue('sat_max', 1);
      });
      expect(result.current.values.sat_max).toBe(1);
    });

    it('should handle extreme values gracefully', () => {
      const { result } = renderHook(() => useQualifier({ clipId: mockClipId }));

      act(() => {
        result.current.updateValue('hue_center', Infinity);
      });
      expect(result.current.values.hue_center).toBe(360); // clamped to max

      act(() => {
        result.current.updateValue('sat_min', -Infinity);
      });
      expect(result.current.values.sat_min).toBe(0); // clamped to min
    });

    it('should handle preset application while debounce is pending', async () => {
      vi.useFakeTimers();

      const { result } = renderHook(() =>
        useQualifier({ clipId: mockClipId, effectId: mockEffectId })
      );

      // Start an update
      act(() => {
        result.current.updateValue('hue_center', 100);
      });

      // Apply preset before debounce fires
      act(() => {
        result.current.applyPreset('skin_tones');
      });

      // Fast forward debounce
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      // Should have skin_tones values
      expect(result.current.values.hue_center).toBe(QUALIFIER_PRESETS.skin_tones.hue_center);

      vi.useRealTimers();
    });

    it('should handle unmount during pending debounce', async () => {
      vi.useFakeTimers();

      const { result, unmount } = renderHook(() =>
        useQualifier({ clipId: mockClipId, effectId: mockEffectId })
      );

      // Start an update
      act(() => {
        result.current.updateValue('hue_center', 200);
      });

      // Unmount before debounce fires
      unmount();

      // Fast forward - should not throw
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      vi.useRealTimers();
    });

    it('should handle concurrent preset and reset operations', () => {
      const { result } = renderHook(() => useQualifier({ clipId: mockClipId }));

      act(() => {
        result.current.applyPreset('skin_tones');
        result.current.reset();
        result.current.applyPreset('sky_blue');
      });

      // Final state should be sky_blue
      expect(result.current.values).toEqual(QUALIFIER_PRESETS.sky_blue);
    });

    it('should handle boolean invert toggle correctly', () => {
      const { result } = renderHook(() => useQualifier({ clipId: mockClipId }));

      expect(result.current.values.invert).toBe(false);

      act(() => {
        result.current.updateValue('invert', true);
      });
      expect(result.current.values.invert).toBe(true);

      act(() => {
        result.current.updateValue('invert', false);
      });
      expect(result.current.values.invert).toBe(false);
    });

    it('should handle malformed fetch response', async () => {
      mockInvoke.mockResolvedValueOnce({
        // Completely malformed data
        invalid_key: 'not a number',
        another_key: null,
      });

      const { result } = renderHook(() =>
        useQualifier({ clipId: mockClipId, effectId: mockEffectId })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Should have default values (paramsToQualifierValues handles this)
      expect(result.current.values.hue_center).toBe(DEFAULT_QUALIFIER_VALUES.hue_center);
    });
  });
});
