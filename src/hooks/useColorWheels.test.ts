/**
 * useColorWheels Hook Tests
 *
 * Tests for the color wheel state management hook.
 * Following TDD methodology.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useColorWheels } from './useColorWheels';
import type { LiftGammaGain } from '@/utils/colorWheel';

describe('useColorWheels', () => {
  describe('initialization', () => {
    it('should initialize with neutral values', () => {
      const { result } = renderHook(() => useColorWheels());

      expect(result.current.lgg.lift).toEqual({ r: 0, g: 0, b: 0 });
      expect(result.current.lgg.gamma).toEqual({ r: 0, g: 0, b: 0 });
      expect(result.current.lgg.gain).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('should initialize with provided values', () => {
      const initialValue: LiftGammaGain = {
        lift: { r: 0.1, g: 0, b: -0.1 },
        gamma: { r: 0, g: 0.2, b: 0 },
        gain: { r: -0.1, g: 0, b: 0.1 },
      };

      const { result } = renderHook(() =>
        useColorWheels({ initialValue })
      );

      expect(result.current.lgg).toEqual(initialValue);
    });

    it('should initialize luminance to zero', () => {
      const { result } = renderHook(() => useColorWheels());

      expect(result.current.luminance).toEqual({
        lift: 0,
        gamma: 0,
        gain: 0,
      });
    });
  });

  describe('updating values', () => {
    it('should update lift offset', () => {
      const { result } = renderHook(() => useColorWheels());

      act(() => {
        result.current.setLift({ r: 0.2, g: -0.1, b: 0 });
      });

      expect(result.current.lgg.lift).toEqual({ r: 0.2, g: -0.1, b: 0 });
      expect(result.current.lgg.gamma).toEqual({ r: 0, g: 0, b: 0 }); // Unchanged
    });

    it('should update gamma offset', () => {
      const { result } = renderHook(() => useColorWheels());

      act(() => {
        result.current.setGamma({ r: 0, g: 0.3, b: -0.2 });
      });

      expect(result.current.lgg.gamma).toEqual({ r: 0, g: 0.3, b: -0.2 });
    });

    it('should update gain offset', () => {
      const { result } = renderHook(() => useColorWheels());

      act(() => {
        result.current.setGain({ r: -0.15, g: 0.1, b: 0.05 });
      });

      expect(result.current.lgg.gain).toEqual({ r: -0.15, g: 0.1, b: 0.05 });
    });

    it('should update entire LGG at once', () => {
      const { result } = renderHook(() => useColorWheels());

      const newValue: LiftGammaGain = {
        lift: { r: 0.1, g: 0.1, b: 0.1 },
        gamma: { r: 0.2, g: 0.2, b: 0.2 },
        gain: { r: 0.3, g: 0.3, b: 0.3 },
      };

      act(() => {
        result.current.setLGG(newValue);
      });

      expect(result.current.lgg).toEqual(newValue);
    });
  });

  describe('luminance updates', () => {
    it('should update lift luminance', () => {
      const { result } = renderHook(() => useColorWheels());

      act(() => {
        result.current.setLiftLuminance(0.25);
      });

      expect(result.current.luminance.lift).toBe(0.25);
    });

    it('should update gamma luminance', () => {
      const { result } = renderHook(() => useColorWheels());

      act(() => {
        result.current.setGammaLuminance(-0.15);
      });

      expect(result.current.luminance.gamma).toBe(-0.15);
    });

    it('should update gain luminance', () => {
      const { result } = renderHook(() => useColorWheels());

      act(() => {
        result.current.setGainLuminance(0.5);
      });

      expect(result.current.luminance.gain).toBe(0.5);
    });

    it('should update all luminance values at once', () => {
      const { result } = renderHook(() => useColorWheels());

      act(() => {
        result.current.setAllLuminance({ lift: 0.1, gamma: 0.2, gain: 0.3 });
      });

      expect(result.current.luminance).toEqual({
        lift: 0.1,
        gamma: 0.2,
        gain: 0.3,
      });
    });
  });

  describe('reset functionality', () => {
    it('should reset all values to neutral', () => {
      const { result } = renderHook(() => useColorWheels());

      // Set some values first
      act(() => {
        result.current.setLGG({
          lift: { r: 0.1, g: 0.1, b: 0.1 },
          gamma: { r: 0.2, g: 0.2, b: 0.2 },
          gain: { r: 0.3, g: 0.3, b: 0.3 },
        });
        result.current.setAllLuminance({ lift: 0.1, gamma: 0.2, gain: 0.3 });
      });

      // Reset
      act(() => {
        result.current.reset();
      });

      expect(result.current.lgg).toEqual({
        lift: { r: 0, g: 0, b: 0 },
        gamma: { r: 0, g: 0, b: 0 },
        gain: { r: 0, g: 0, b: 0 },
      });
      expect(result.current.luminance).toEqual({
        lift: 0,
        gamma: 0,
        gain: 0,
      });
    });

    it('should reset individual wheel', () => {
      const { result } = renderHook(() => useColorWheels());

      // Set values
      act(() => {
        result.current.setLift({ r: 0.1, g: 0.1, b: 0.1 });
        result.current.setGamma({ r: 0.2, g: 0.2, b: 0.2 });
        result.current.setLiftLuminance(0.5);
      });

      // Reset only lift
      act(() => {
        result.current.resetLift();
      });

      expect(result.current.lgg.lift).toEqual({ r: 0, g: 0, b: 0 });
      expect(result.current.lgg.gamma).toEqual({ r: 0.2, g: 0.2, b: 0.2 }); // Unchanged
      expect(result.current.luminance.lift).toBe(0);
    });
  });

  describe('change callbacks', () => {
    it('should call onChange when values change', () => {
      const onChange = vi.fn();
      const { result } = renderHook(() =>
        useColorWheels({ onChange })
      );

      act(() => {
        result.current.setLift({ r: 0.1, g: 0, b: 0 });
      });

      // onChange receives (lgg, luminance)
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          lift: { r: 0.1, g: 0, b: 0 },
        }),
        expect.objectContaining({
          lift: 0,
          gamma: 0,
          gain: 0,
        })
      );
    });

    it('should not call onChange for initial value', () => {
      const onChange = vi.fn();
      renderHook(() =>
        useColorWheels({
          initialValue: {
            lift: { r: 0.1, g: 0, b: 0 },
            gamma: { r: 0, g: 0, b: 0 },
            gain: { r: 0, g: 0, b: 0 },
          },
          onChange,
        })
      );

      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('isNeutral check', () => {
    it('should return true when all values are neutral', () => {
      const { result } = renderHook(() => useColorWheels());
      expect(result.current.isNeutral).toBe(true);
    });

    it('should return false when any offset is non-zero', () => {
      const { result } = renderHook(() => useColorWheels());

      act(() => {
        result.current.setLift({ r: 0.1, g: 0, b: 0 });
      });

      expect(result.current.isNeutral).toBe(false);
    });

    it('should return false when any luminance is non-zero', () => {
      const { result } = renderHook(() => useColorWheels());

      act(() => {
        result.current.setLiftLuminance(0.1);
      });

      expect(result.current.isNeutral).toBe(false);
    });
  });

  describe('FFmpeg filter generation', () => {
    it('should generate empty string for neutral values', () => {
      const { result } = renderHook(() => useColorWheels());
      expect(result.current.toFFmpegFilter()).toBe('');
    });

    it('should generate filter string for non-neutral values', () => {
      const { result } = renderHook(() => useColorWheels());

      act(() => {
        result.current.setLift({ r: 0.1, g: 0, b: 0 });
      });

      const filter = result.current.toFFmpegFilter();
      expect(filter).toContain('colorbalance');
      expect(filter).toContain('rs=');
    });
  });
});
