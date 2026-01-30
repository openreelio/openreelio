/**
 * useAudioEffectChain Hook Tests
 *
 * Basic tests for the audio effect chain hook.
 * Full integration testing is done in the application.
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAudioEffectChain } from './useAudioEffectChain';

describe('useAudioEffectChain', () => {
  describe('initialization', () => {
    it('should handle null audioContext gracefully', () => {
      const { result } = renderHook(() =>
        useAudioEffectChain({
          effects: [],
          audioContext: null,
        })
      );

      expect(result.current.effectNodes).toHaveLength(0);
      expect(result.current.chainInput).toBeNull();
      expect(result.current.chainOutput).toBeNull();
    });

    it('should provide effect support checking', () => {
      const { result } = renderHook(() =>
        useAudioEffectChain({
          effects: [],
          audioContext: null,
        })
      );

      // Supported effects
      expect(result.current.isEffectSupported('volume')).toBe(true);
      expect(result.current.isEffectSupported('gain')).toBe(true);
      expect(result.current.isEffectSupported('eq_band')).toBe(true);
      expect(result.current.isEffectSupported('compressor')).toBe(true);
      expect(result.current.isEffectSupported('limiter')).toBe(true);
      expect(result.current.isEffectSupported('delay')).toBe(true);
      expect(result.current.isEffectSupported('pan')).toBe(true);

      // Unsupported effects
      expect(result.current.isEffectSupported('reverb')).toBe(false);
      expect(result.current.isEffectSupported('noise_reduction')).toBe(false);
      expect(result.current.isEffectSupported('unknown')).toBe(false);
    });

    it('should provide updateEffect function', () => {
      const { result } = renderHook(() =>
        useAudioEffectChain({
          effects: [],
          audioContext: null,
        })
      );

      expect(typeof result.current.updateEffect).toBe('function');
    });

    it('should provide toggleEffect function', () => {
      const { result } = renderHook(() =>
        useAudioEffectChain({
          effects: [],
          audioContext: null,
        })
      );

      expect(typeof result.current.toggleEffect).toBe('function');
    });
  });
});
