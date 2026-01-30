/**
 * AudioEffectFactory Service Tests
 *
 * Tests for the factory that creates Web Audio API nodes from effect definitions.
 * TDD: RED phase - writing tests first
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createAudioEffectNode,
  updateAudioEffectNode,
  getEffectNodeType,
  convertDbToLinear,
  convertLinearToDb,
  type EffectNodeConfig,
} from './audioEffectFactory';

// =============================================================================
// Mock Web Audio API
// =============================================================================

class MockGainNode {
  gain = { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockBiquadFilterNode {
  type: BiquadFilterType = 'peaking';
  frequency = { value: 1000, setValueAtTime: vi.fn() };
  Q = { value: 1, setValueAtTime: vi.fn() };
  gain = { value: 0, setValueAtTime: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockDynamicsCompressorNode {
  threshold = { value: -24, setValueAtTime: vi.fn() };
  knee = { value: 30, setValueAtTime: vi.fn() };
  ratio = { value: 12, setValueAtTime: vi.fn() };
  attack = { value: 0.003, setValueAtTime: vi.fn() };
  release = { value: 0.25, setValueAtTime: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockDelayNode {
  delayTime = { value: 0, setValueAtTime: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockStereoPannerNode {
  pan = { value: 0, setValueAtTime: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockAudioContext {
  currentTime = 0;
  createGain = vi.fn(() => new MockGainNode());
  createBiquadFilter = vi.fn(() => new MockBiquadFilterNode());
  createDynamicsCompressor = vi.fn(() => new MockDynamicsCompressorNode());
  createDelay = vi.fn(() => new MockDelayNode());
  createStereoPanner = vi.fn(() => new MockStereoPannerNode());
}

// =============================================================================
// Unit Conversion Tests
// =============================================================================

describe('audioEffectFactory', () => {
  describe('unit conversions', () => {
    it('should convert dB to linear (0 dB = 1.0)', () => {
      expect(convertDbToLinear(0)).toBeCloseTo(1.0, 5);
    });

    it('should convert dB to linear (-6 dB ≈ 0.5)', () => {
      expect(convertDbToLinear(-6)).toBeCloseTo(0.5012, 3);
    });

    it('should convert dB to linear (+6 dB ≈ 2.0)', () => {
      expect(convertDbToLinear(6)).toBeCloseTo(1.9953, 3);
    });

    it('should convert dB to linear (-20 dB = 0.1)', () => {
      expect(convertDbToLinear(-20)).toBeCloseTo(0.1, 5);
    });

    it('should convert linear to dB (1.0 = 0 dB)', () => {
      expect(convertLinearToDb(1.0)).toBeCloseTo(0, 5);
    });

    it('should convert linear to dB (0.5 ≈ -6 dB)', () => {
      expect(convertLinearToDb(0.5)).toBeCloseTo(-6.02, 1);
    });

    it('should convert linear to dB (2.0 ≈ +6 dB)', () => {
      expect(convertLinearToDb(2.0)).toBeCloseTo(6.02, 1);
    });

    it('should handle linear 0 (returns -Infinity)', () => {
      expect(convertLinearToDb(0)).toBe(-Infinity);
    });
  });

  // ===========================================================================
  // Node Type Detection Tests
  // ===========================================================================

  describe('getEffectNodeType', () => {
    it('should return "gain" for volume effect', () => {
      expect(getEffectNodeType('volume')).toBe('gain');
    });

    it('should return "gain" for gain effect', () => {
      expect(getEffectNodeType('gain')).toBe('gain');
    });

    it('should return "biquad" for eq_band effect', () => {
      expect(getEffectNodeType('eq_band')).toBe('biquad');
    });

    it('should return "compressor" for compressor effect', () => {
      expect(getEffectNodeType('compressor')).toBe('compressor');
    });

    it('should return "compressor" for limiter effect', () => {
      expect(getEffectNodeType('limiter')).toBe('compressor');
    });

    it('should return "delay" for delay effect', () => {
      expect(getEffectNodeType('delay')).toBe('delay');
    });

    it('should return "panner" for pan effect', () => {
      expect(getEffectNodeType('pan')).toBe('panner');
    });

    it('should return null for unsupported effect types', () => {
      expect(getEffectNodeType('noise_reduction')).toBeNull();
      expect(getEffectNodeType('reverb')).toBeNull();
      expect(getEffectNodeType('unknown_effect')).toBeNull();
    });
  });

  // ===========================================================================
  // Node Creation Tests
  // ===========================================================================

  describe('createAudioEffectNode', () => {
    let mockContext: MockAudioContext;

    beforeEach(() => {
      mockContext = new MockAudioContext();
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should create a GainNode for volume effect', () => {
      const config: EffectNodeConfig = {
        effectType: 'volume',
        params: { level: 0.8 },
        enabled: true,
      };

      const result = createAudioEffectNode(mockContext as unknown as AudioContext, config);

      expect(result).not.toBeNull();
      expect(mockContext.createGain).toHaveBeenCalled();
      expect(result!.node).toBeInstanceOf(MockGainNode);
      expect(result!.effectType).toBe('volume');
    });

    it('should set gain value for volume effect', () => {
      const config: EffectNodeConfig = {
        effectType: 'volume',
        params: { level: 0.5 },
        enabled: true,
      };

      const result = createAudioEffectNode(mockContext as unknown as AudioContext, config);

      expect((result!.node as unknown as MockGainNode).gain.value).toBe(0.5);
    });

    it('should create a GainNode for gain effect with dB conversion', () => {
      const config: EffectNodeConfig = {
        effectType: 'gain',
        params: { gain: 6 }, // +6 dB
        enabled: true,
      };

      const result = createAudioEffectNode(mockContext as unknown as AudioContext, config);

      expect(result).not.toBeNull();
      expect(mockContext.createGain).toHaveBeenCalled();
      // +6 dB ≈ 2.0 linear
      expect((result!.node as unknown as MockGainNode).gain.value).toBeCloseTo(1.9953, 2);
    });

    it('should create a BiquadFilterNode for eq_band effect', () => {
      const config: EffectNodeConfig = {
        effectType: 'eq_band',
        params: { frequency: 1000, width: 1.5, gain: 3 },
        enabled: true,
      };

      const result = createAudioEffectNode(mockContext as unknown as AudioContext, config);

      expect(result).not.toBeNull();
      expect(mockContext.createBiquadFilter).toHaveBeenCalled();
      expect(result!.node).toBeInstanceOf(MockBiquadFilterNode);

      const node = result!.node as unknown as MockBiquadFilterNode;
      expect(node.type).toBe('peaking');
      expect(node.frequency.value).toBe(1000);
      expect(node.Q.value).toBe(1.5);
      expect(node.gain.value).toBe(3);
    });

    it('should create a DynamicsCompressorNode for compressor effect', () => {
      const config: EffectNodeConfig = {
        effectType: 'compressor',
        params: { threshold: 0.5, ratio: 4, attack: 10, release: 100 },
        enabled: true,
      };

      const result = createAudioEffectNode(mockContext as unknown as AudioContext, config);

      expect(result).not.toBeNull();
      expect(mockContext.createDynamicsCompressor).toHaveBeenCalled();
      expect(result!.node).toBeInstanceOf(MockDynamicsCompressorNode);
    });

    it('should create a DynamicsCompressorNode for limiter effect', () => {
      const config: EffectNodeConfig = {
        effectType: 'limiter',
        params: { limit: 0.9, attack: 5, release: 50 },
        enabled: true,
      };

      const result = createAudioEffectNode(mockContext as unknown as AudioContext, config);

      expect(result).not.toBeNull();
      expect(mockContext.createDynamicsCompressor).toHaveBeenCalled();
    });

    it('should create a DelayNode for delay effect', () => {
      const config: EffectNodeConfig = {
        effectType: 'delay',
        params: { delay: 500 }, // 500ms
        enabled: true,
      };

      const result = createAudioEffectNode(mockContext as unknown as AudioContext, config);

      expect(result).not.toBeNull();
      expect(mockContext.createDelay).toHaveBeenCalled();
      expect(result!.node).toBeInstanceOf(MockDelayNode);
      // 500ms = 0.5 seconds
      expect((result!.node as unknown as MockDelayNode).delayTime.value).toBe(0.5);
    });

    it('should create a StereoPannerNode for pan effect', () => {
      const config: EffectNodeConfig = {
        effectType: 'pan',
        params: { pan: -0.5 }, // Left
        enabled: true,
      };

      const result = createAudioEffectNode(mockContext as unknown as AudioContext, config);

      expect(result).not.toBeNull();
      expect(mockContext.createStereoPanner).toHaveBeenCalled();
      expect(result!.node).toBeInstanceOf(MockStereoPannerNode);
      expect((result!.node as unknown as MockStereoPannerNode).pan.value).toBe(-0.5);
    });

    it('should return null for unsupported effect types', () => {
      const config: EffectNodeConfig = {
        effectType: 'reverb',
        params: {},
        enabled: true,
      };

      const result = createAudioEffectNode(mockContext as unknown as AudioContext, config);

      expect(result).toBeNull();
    });

    it('should return bypass node when effect is disabled', () => {
      const config: EffectNodeConfig = {
        effectType: 'gain',
        params: { gain: 12 },
        enabled: false,
      };

      const result = createAudioEffectNode(mockContext as unknown as AudioContext, config);

      expect(result).not.toBeNull();
      expect(result!.bypassed).toBe(true);
      // Bypass node should be unity gain
      expect((result!.node as unknown as MockGainNode).gain.value).toBe(1);
    });
  });

  // ===========================================================================
  // Node Update Tests
  // ===========================================================================

  describe('updateAudioEffectNode', () => {
    let mockContext: MockAudioContext;

    beforeEach(() => {
      mockContext = new MockAudioContext();
    });

    it('should update gain node value', () => {
      const config: EffectNodeConfig = {
        effectType: 'volume',
        params: { level: 1.0 },
        enabled: true,
      };

      const effectNode = createAudioEffectNode(mockContext as unknown as AudioContext, config)!;

      updateAudioEffectNode(effectNode, { level: 0.5 });

      expect((effectNode.node as unknown as MockGainNode).gain.value).toBe(0.5);
    });

    it('should update eq_band parameters', () => {
      const config: EffectNodeConfig = {
        effectType: 'eq_band',
        params: { frequency: 1000, width: 1.0, gain: 0 },
        enabled: true,
      };

      const effectNode = createAudioEffectNode(mockContext as unknown as AudioContext, config)!;

      updateAudioEffectNode(effectNode, { frequency: 2000, width: 2.0, gain: 6 });

      const node = effectNode.node as unknown as MockBiquadFilterNode;
      expect(node.frequency.value).toBe(2000);
      expect(node.Q.value).toBe(2.0);
      expect(node.gain.value).toBe(6);
    });

    it('should update delay time', () => {
      const config: EffectNodeConfig = {
        effectType: 'delay',
        params: { delay: 500 },
        enabled: true,
      };

      const effectNode = createAudioEffectNode(mockContext as unknown as AudioContext, config)!;

      updateAudioEffectNode(effectNode, { delay: 1000 });

      expect((effectNode.node as unknown as MockDelayNode).delayTime.value).toBe(1.0);
    });

    it('should update pan value', () => {
      const config: EffectNodeConfig = {
        effectType: 'pan',
        params: { pan: 0 },
        enabled: true,
      };

      const effectNode = createAudioEffectNode(mockContext as unknown as AudioContext, config)!;

      updateAudioEffectNode(effectNode, { pan: 1.0 });

      expect((effectNode.node as unknown as MockStereoPannerNode).pan.value).toBe(1.0);
    });

    it('should not update bypassed node', () => {
      const config: EffectNodeConfig = {
        effectType: 'volume',
        params: { level: 1.0 },
        enabled: false,
      };

      const effectNode = createAudioEffectNode(mockContext as unknown as AudioContext, config)!;
      const originalValue = (effectNode.node as unknown as MockGainNode).gain.value;

      updateAudioEffectNode(effectNode, { level: 0.5 });

      // Value should remain unchanged (unity gain for bypass)
      expect((effectNode.node as unknown as MockGainNode).gain.value).toBe(originalValue);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    let mockContext: MockAudioContext;

    beforeEach(() => {
      mockContext = new MockAudioContext();
    });

    it('should handle missing params gracefully with defaults', () => {
      const config: EffectNodeConfig = {
        effectType: 'volume',
        params: {},
        enabled: true,
      };

      const result = createAudioEffectNode(mockContext as unknown as AudioContext, config);

      expect(result).not.toBeNull();
      // Default volume should be 1.0
      expect((result!.node as unknown as MockGainNode).gain.value).toBe(1.0);
    });

    it('should clamp gain values to safe range', () => {
      const config: EffectNodeConfig = {
        effectType: 'gain',
        params: { gain: 100 }, // Excessive gain
        enabled: true,
      };

      const result = createAudioEffectNode(mockContext as unknown as AudioContext, config);

      // Should be clamped to max safe value (e.g., +24 dB)
      expect((result!.node as unknown as MockGainNode).gain.value).toBeLessThanOrEqual(convertDbToLinear(24));
    });

    it('should clamp frequency to valid range', () => {
      const config: EffectNodeConfig = {
        effectType: 'eq_band',
        params: { frequency: 50000, width: 1.0, gain: 0 }, // Above Nyquist
        enabled: true,
      };

      const result = createAudioEffectNode(mockContext as unknown as AudioContext, config);

      // Should be clamped to max frequency (20000 Hz)
      expect((result!.node as unknown as MockBiquadFilterNode).frequency.value).toBeLessThanOrEqual(20000);
    });

    it('should handle negative delay gracefully', () => {
      const config: EffectNodeConfig = {
        effectType: 'delay',
        params: { delay: -100 },
        enabled: true,
      };

      const result = createAudioEffectNode(mockContext as unknown as AudioContext, config);

      // Should be clamped to 0
      expect((result!.node as unknown as MockDelayNode).delayTime.value).toBe(0);
    });

    it('should clamp pan to -1 to 1 range', () => {
      const config: EffectNodeConfig = {
        effectType: 'pan',
        params: { pan: 5 },
        enabled: true,
      };

      const result = createAudioEffectNode(mockContext as unknown as AudioContext, config);

      expect((result!.node as unknown as MockStereoPannerNode).pan.value).toBe(1);
    });
  });
});
