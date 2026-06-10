import { describe, expect, it } from 'vitest';
import {
  clampCompressorThresholdDb,
  convertDbToLinear,
  createAudioEffectNode,
} from './audioEffectFactory';

function createMockAudioContext(): AudioContext {
  return {
    createDynamicsCompressor: () => ({
      threshold: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
    }),
    createGain: () => ({ gain: { value: 1 } }),
    createBiquadFilter: () => ({
      type: 'peaking',
      frequency: { value: 0 },
      Q: { value: 0 },
      gain: { value: 0 },
    }),
    createDelay: () => ({ delayTime: { value: 0 } }),
    createStereoPanner: () => ({ pan: { value: 0 } }),
  } as unknown as AudioContext;
}

describe('audioEffectFactory', () => {
  it('clamps compressor thresholds in dB', () => {
    expect(clampCompressorThresholdDb(-80)).toBe(-60);
    expect(clampCompressorThresholdDb(-18)).toBe(-18);
    expect(clampCompressorThresholdDb(6)).toBe(0);
  });

  it('creates compressor preview nodes with dB threshold semantics', () => {
    const node = createAudioEffectNode(createMockAudioContext(), {
      effectType: 'compressor',
      enabled: true,
      params: {
        threshold: -18,
        ratio: 3,
        attack: 10,
        release: 120,
      },
    });

    const compressor = node?.node as DynamicsCompressorNode;
    expect(node?.nodeType).toBe('compressor');
    expect(compressor.threshold.value).toBe(-18);
    expect(compressor.ratio.value).toBe(3);
    expect(compressor.attack.value).toBe(0.01);
    expect(compressor.release.value).toBe(0.12);
  });

  it('keeps gain conversion in dB for preview chains', () => {
    expect(convertDbToLinear(6)).toBeCloseTo(1.995, 3);
    expect(convertDbToLinear(-6)).toBeCloseTo(0.501, 3);
  });
});
