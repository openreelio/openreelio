/**
 * Effect Parameter Definitions Tests
 *
 * Tests for centralized effect parameter definitions.
 * TDD: RED phase - writing tests first
 */

import { describe, it, expect } from 'vitest';
import {
  getEffectParamDefs,
  AUDIO_EFFECT_PARAM_DEFS,
  VIDEO_EFFECT_PARAM_DEFS,
  TRANSITION_EFFECT_PARAM_DEFS,
} from './effectParamDefs';
import type { ParamDef } from '@/types';

// =============================================================================
// Helper Functions
// =============================================================================

function expectValidParamDef(param: ParamDef): void {
  expect(param.name).toBeDefined();
  expect(param.label).toBeDefined();
  expect(param.default).toBeDefined();
  expect(param.default.type).toBeDefined();
  expect(param.default.value).toBeDefined();
}

// =============================================================================
// Audio Effect Parameter Tests
// =============================================================================

describe('Audio Effect Parameters', () => {
  describe('volume', () => {
    it('should define level parameter', () => {
      const params = AUDIO_EFFECT_PARAM_DEFS.volume;
      expect(params).toBeDefined();
      expect(params).toHaveLength(1);

      const level = params.find((p) => p.name === 'level');
      expect(level).toBeDefined();
      expect(level!.default).toEqual({ type: 'float', value: 1.0 });
      expect(level!.min).toBe(0);
      expect(level!.max).toBe(2);
    });
  });

  describe('gain', () => {
    it('should define gain parameter', () => {
      const params = AUDIO_EFFECT_PARAM_DEFS.gain;
      expect(params).toBeDefined();

      const gain = params.find((p) => p.name === 'gain');
      expect(gain).toBeDefined();
      expect(gain!.default.type).toBe('float');
      expect(gain!.min).toBeDefined();
      expect(gain!.max).toBeDefined();
    });
  });

  describe('eq_band', () => {
    it('should define frequency, width, and gain parameters', () => {
      const params = AUDIO_EFFECT_PARAM_DEFS.eq_band;
      expect(params).toBeDefined();

      const frequency = params.find((p) => p.name === 'frequency');
      const width = params.find((p) => p.name === 'width');
      const gain = params.find((p) => p.name === 'gain');

      expect(frequency).toBeDefined();
      expect(width).toBeDefined();
      expect(gain).toBeDefined();
    });
  });

  describe('compressor', () => {
    it('should define threshold, ratio, attack, release parameters', () => {
      const params = AUDIO_EFFECT_PARAM_DEFS.compressor;
      expect(params).toBeDefined();

      expect(params.find((p) => p.name === 'threshold')).toBeDefined();
      expect(params.find((p) => p.name === 'ratio')).toBeDefined();
      expect(params.find((p) => p.name === 'attack')).toBeDefined();
      expect(params.find((p) => p.name === 'release')).toBeDefined();
    });
  });

  describe('limiter', () => {
    it('should define limit, attack, release parameters', () => {
      const params = AUDIO_EFFECT_PARAM_DEFS.limiter;
      expect(params).toBeDefined();

      expect(params.find((p) => p.name === 'limit')).toBeDefined();
      expect(params.find((p) => p.name === 'attack')).toBeDefined();
      expect(params.find((p) => p.name === 'release')).toBeDefined();
    });
  });

  describe('reverb', () => {
    it('should define delay and decay parameters', () => {
      const params = AUDIO_EFFECT_PARAM_DEFS.reverb;
      expect(params).toBeDefined();

      expect(params.find((p) => p.name === 'delay')).toBeDefined();
      expect(params.find((p) => p.name === 'decay')).toBeDefined();
    });
  });

  describe('delay', () => {
    it('should define delay parameter', () => {
      const params = AUDIO_EFFECT_PARAM_DEFS.delay;
      expect(params).toBeDefined();

      const delay = params.find((p) => p.name === 'delay');
      expect(delay).toBeDefined();
      expect(delay!.default.type).toBe('float');
    });
  });

  describe('noise_reduction', () => {
    it('should define strength parameter', () => {
      const params = AUDIO_EFFECT_PARAM_DEFS.noise_reduction;
      expect(params).toBeDefined();

      const strength = params.find((p) => p.name === 'strength');
      expect(strength).toBeDefined();
    });
  });
});

// =============================================================================
// Video Effect Parameter Tests
// =============================================================================

describe('Video Effect Parameters', () => {
  describe('brightness', () => {
    it('should define value parameter', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.brightness;
      expect(params).toBeDefined();

      const value = params.find((p) => p.name === 'value');
      expect(value).toBeDefined();
      expect(value!.min).toBe(-1);
      expect(value!.max).toBe(1);
    });
  });

  describe('contrast', () => {
    it('should define value parameter', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.contrast;
      expect(params).toBeDefined();

      const value = params.find((p) => p.name === 'value');
      expect(value).toBeDefined();
    });
  });

  describe('saturation', () => {
    it('should define value parameter', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.saturation;
      expect(params).toBeDefined();

      const value = params.find((p) => p.name === 'value');
      expect(value).toBeDefined();
    });
  });

  describe('gaussian_blur', () => {
    it('should define radius and sigma parameters', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.gaussian_blur;
      expect(params).toBeDefined();

      expect(params.find((p) => p.name === 'radius')).toBeDefined();
      expect(params.find((p) => p.name === 'sigma')).toBeDefined();
    });
  });

  describe('crop', () => {
    it('should define x, y, width, height parameters', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.crop;
      expect(params).toBeDefined();

      expect(params.find((p) => p.name === 'x')).toBeDefined();
      expect(params.find((p) => p.name === 'y')).toBeDefined();
      expect(params.find((p) => p.name === 'width')).toBeDefined();
      expect(params.find((p) => p.name === 'height')).toBeDefined();
    });
  });

  describe('rotate', () => {
    it('should define angle parameter', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.rotate;
      expect(params).toBeDefined();

      const angle = params.find((p) => p.name === 'angle');
      expect(angle).toBeDefined();
    });
  });

  // ===========================================================================
  // Keying Effects
  // ===========================================================================

  describe('chroma_key', () => {
    it('should define key_color, similarity, and blend parameters', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.chroma_key;
      expect(params).toBeDefined();
      expect(params).toHaveLength(3);

      expect(params.find((p) => p.name === 'key_color')).toBeDefined();
      expect(params.find((p) => p.name === 'similarity')).toBeDefined();
      expect(params.find((p) => p.name === 'blend')).toBeDefined();
    });

    it('should have color inputType for key_color', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.chroma_key;
      const keyColor = params.find((p) => p.name === 'key_color');

      expect(keyColor).toBeDefined();
      expect(keyColor!.inputType).toBe('color');
      expect(keyColor!.default.type).toBe('string');
      expect(keyColor!.default.value).toBe('#00FF00'); // Default green
    });

    it('should have proper ranges for similarity parameter', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.chroma_key;
      const similarity = params.find((p) => p.name === 'similarity');

      expect(similarity).toBeDefined();
      expect(similarity!.min).toBe(0);
      expect(similarity!.max).toBe(1);
      expect(similarity!.default.value).toBe(0.3);
    });

    it('should have proper ranges for blend parameter', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.chroma_key;
      const blend = params.find((p) => p.name === 'blend');

      expect(blend).toBeDefined();
      expect(blend!.min).toBe(0);
      expect(blend!.max).toBe(1);
      expect(blend!.default.value).toBe(0.1);
    });
  });

  describe('luma_key', () => {
    it('should define threshold and tolerance parameters', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.luma_key;
      expect(params).toBeDefined();
      expect(params).toHaveLength(2);

      expect(params.find((p) => p.name === 'threshold')).toBeDefined();
      expect(params.find((p) => p.name === 'tolerance')).toBeDefined();
    });

    it('should have proper ranges for threshold', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.luma_key;
      const threshold = params.find((p) => p.name === 'threshold');

      expect(threshold).toBeDefined();
      expect(threshold!.min).toBe(0);
      expect(threshold!.max).toBe(1);
      expect(threshold!.default.value).toBe(0.1);
    });

    it('should have proper ranges for tolerance', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.luma_key;
      const tolerance = params.find((p) => p.name === 'tolerance');

      expect(tolerance).toBeDefined();
      expect(tolerance!.min).toBe(0);
      expect(tolerance!.max).toBe(1);
      expect(tolerance!.default.value).toBe(0.1);
    });
  });
});

// =============================================================================
// Transition Effect Parameter Tests
// =============================================================================

describe('Transition Effect Parameters', () => {
  describe('cross_dissolve', () => {
    it('should define duration parameter', () => {
      const params = TRANSITION_EFFECT_PARAM_DEFS.cross_dissolve;
      expect(params).toBeDefined();

      const duration = params.find((p) => p.name === 'duration');
      expect(duration).toBeDefined();
      expect(duration!.min).toBeGreaterThan(0);
    });
  });

  describe('fade', () => {
    it('should define duration and fade_in parameters', () => {
      const params = TRANSITION_EFFECT_PARAM_DEFS.fade;
      expect(params).toBeDefined();

      expect(params.find((p) => p.name === 'duration')).toBeDefined();
      expect(params.find((p) => p.name === 'fade_in')).toBeDefined();
    });
  });

  describe('wipe', () => {
    it('should define duration and direction parameters', () => {
      const params = TRANSITION_EFFECT_PARAM_DEFS.wipe;
      expect(params).toBeDefined();

      expect(params.find((p) => p.name === 'duration')).toBeDefined();
      expect(params.find((p) => p.name === 'direction')).toBeDefined();
    });
  });

  describe('slide', () => {
    it('should define duration and direction parameters', () => {
      const params = TRANSITION_EFFECT_PARAM_DEFS.slide;
      expect(params).toBeDefined();

      expect(params.find((p) => p.name === 'duration')).toBeDefined();
      expect(params.find((p) => p.name === 'direction')).toBeDefined();
    });
  });

  describe('zoom', () => {
    it('should define duration and zoom_type parameters', () => {
      const params = TRANSITION_EFFECT_PARAM_DEFS.zoom;
      expect(params).toBeDefined();

      expect(params.find((p) => p.name === 'duration')).toBeDefined();
      expect(params.find((p) => p.name === 'zoom_type')).toBeDefined();
    });
  });
});

// =============================================================================
// getEffectParamDefs Tests
// =============================================================================

describe('getEffectParamDefs', () => {
  it('should return params for audio effects', () => {
    const params = getEffectParamDefs('volume');
    expect(params).toBeDefined();
    expect(params.length).toBeGreaterThan(0);
  });

  it('should return params for video effects', () => {
    const params = getEffectParamDefs('brightness');
    expect(params).toBeDefined();
    expect(params.length).toBeGreaterThan(0);
  });

  it('should return params for transition effects', () => {
    const params = getEffectParamDefs('cross_dissolve');
    expect(params).toBeDefined();
    expect(params.length).toBeGreaterThan(0);
  });

  it('should return empty array for unknown effect type', () => {
    const params = getEffectParamDefs('unknown_effect' as any);
    expect(params).toEqual([]);
  });

  it('should return params for custom effect type', () => {
    const params = getEffectParamDefs({ custom: 'my_effect' });
    expect(params).toEqual([]);
  });

  it('should have valid ParamDef structure for all params', () => {
    const allParams = [
      ...getEffectParamDefs('volume'),
      ...getEffectParamDefs('brightness'),
      ...getEffectParamDefs('cross_dissolve'),
    ];

    allParams.forEach(expectValidParamDef);
  });
});
