/**
 * useEffectParamDefs Hook Tests
 *
 * Tests for the hook that provides parameter definitions for effects.
 * TDD: RED phase - writing tests first
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useEffectParamDefs } from './useEffectParamDefs';
import type { Effect, EffectType } from '@/types';

// =============================================================================
// Test Data
// =============================================================================

const createEffect = (effectType: Effect['effectType']): Effect => ({
  id: 'test_effect',
  effectType,
  enabled: true,
  params: {},
  keyframes: {},
  order: 0,
});

// =============================================================================
// Tests
// =============================================================================

describe('useEffectParamDefs', () => {
  describe('audio effects', () => {
    it('should return param defs for volume effect', () => {
      const effect = createEffect('volume');
      const { result } = renderHook(() => useEffectParamDefs(effect));

      expect(result.current).toBeDefined();
      expect(result.current.length).toBeGreaterThan(0);
      expect(result.current.find((p) => p.name === 'level')).toBeDefined();
    });

    it('should return param defs for compressor effect', () => {
      const effect = createEffect('compressor');
      const { result } = renderHook(() => useEffectParamDefs(effect));

      expect(result.current.find((p) => p.name === 'threshold')).toBeDefined();
      expect(result.current.find((p) => p.name === 'ratio')).toBeDefined();
    });

    it('should return param defs for eq_band effect', () => {
      const effect = createEffect('eq_band');
      const { result } = renderHook(() => useEffectParamDefs(effect));

      expect(result.current.find((p) => p.name === 'frequency')).toBeDefined();
      expect(result.current.find((p) => p.name === 'gain')).toBeDefined();
    });
  });

  describe('video effects', () => {
    it('should return param defs for brightness effect', () => {
      const effect = createEffect('brightness');
      const { result } = renderHook(() => useEffectParamDefs(effect));

      expect(result.current.find((p) => p.name === 'value')).toBeDefined();
    });

    it('should return param defs for gaussian_blur effect', () => {
      const effect = createEffect('gaussian_blur');
      const { result } = renderHook(() => useEffectParamDefs(effect));

      expect(result.current.find((p) => p.name === 'radius')).toBeDefined();
      expect(result.current.find((p) => p.name === 'sigma')).toBeDefined();
    });

    it('should return param defs for crop effect', () => {
      const effect = createEffect('crop');
      const { result } = renderHook(() => useEffectParamDefs(effect));

      expect(result.current.find((p) => p.name === 'x')).toBeDefined();
      expect(result.current.find((p) => p.name === 'y')).toBeDefined();
      expect(result.current.find((p) => p.name === 'width')).toBeDefined();
      expect(result.current.find((p) => p.name === 'height')).toBeDefined();
    });
  });

  describe('transition effects', () => {
    it('should return param defs for cross_dissolve effect', () => {
      const effect = createEffect('cross_dissolve');
      const { result } = renderHook(() => useEffectParamDefs(effect));

      expect(result.current.find((p) => p.name === 'duration')).toBeDefined();
    });

    it('should return param defs for wipe effect', () => {
      const effect = createEffect('wipe');
      const { result } = renderHook(() => useEffectParamDefs(effect));

      expect(result.current.find((p) => p.name === 'duration')).toBeDefined();
      expect(result.current.find((p) => p.name === 'direction')).toBeDefined();
    });
  });

  describe('null effect', () => {
    it('should return empty array for null effect', () => {
      const { result } = renderHook(() => useEffectParamDefs(null));

      expect(result.current).toEqual([]);
    });
  });

  describe('custom effect', () => {
    it('should return empty array for custom effect type', () => {
      const effect = createEffect({ custom: 'my_plugin_effect' });
      const { result } = renderHook(() => useEffectParamDefs(effect));

      expect(result.current).toEqual([]);
    });
  });

  describe('memoization', () => {
    it('should return stable reference for same effect type', () => {
      const effect = createEffect('brightness');
      const { result, rerender } = renderHook(() => useEffectParamDefs(effect));

      const firstResult = result.current;
      rerender();
      const secondResult = result.current;

      expect(firstResult).toBe(secondResult);
    });

    it('should return new reference when effect type changes', () => {
      const { result, rerender } = renderHook(
        ({ effectType }: { effectType: EffectType }) => useEffectParamDefs(createEffect(effectType)),
        { initialProps: { effectType: 'brightness' as EffectType } }
      );

      const firstResult = result.current;
      rerender({ effectType: 'contrast' as EffectType });
      const secondResult = result.current;

      expect(firstResult).not.toBe(secondResult);
    });
  });
});
