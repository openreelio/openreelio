/**
 * Effect Parameter Definitions Tests
 *
 * Tests for centralized effect parameter definitions.
 * TDD: RED phase - writing tests first
 */

import { describe, it, expect } from 'vitest';
import {
  getEffectParamDefs,
  getEffectDefaultParamValues,
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

function parseCurveDefault(param: ParamDef): Array<{ x: number; y: number }> {
  expect(param.default.type).toBe('string');
  return JSON.parse(param.default.value as string) as Array<{ x: number; y: number }>;
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
      expect(width!.label).toBe('Q');
      expect(width!.default).toEqual({ type: 'float', value: 1.0 });
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

      const threshold = params.find((p) => p.name === 'threshold');
      expect(threshold!.label).toBe('Threshold (dB)');
      expect(threshold!.default).toEqual({ type: 'float', value: -24 });
      expect(threshold!.min).toBe(-60);
      expect(threshold!.max).toBe(0);
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
    it('should define export parity parameters', () => {
      const params = AUDIO_EFFECT_PARAM_DEFS.noise_reduction;
      expect(params).toBeDefined();

      const algorithm = params.find((p) => p.name === 'algorithm');
      const strength = params.find((p) => p.name === 'strength');
      const patchSize = params.find((p) => p.name === 'patch_size');
      const researchSize = params.find((p) => p.name === 'research_size');
      const noiseFloor = params.find((p) => p.name === 'noise_floor');
      const modelPath = params.find((p) => p.name === 'model_path');

      expect(algorithm).toBeDefined();
      expect(algorithm!.inputType).toBe('select');
      expect(algorithm!.options).toEqual(['anlmdn', 'afftdn', 'arnndn']);
      expect(strength).toBeDefined();
      expect(strength!.default).toEqual({ type: 'float', value: 0.3 });
      expect(patchSize).toBeDefined();
      expect(researchSize).toBeDefined();
      expect(noiseFloor).toBeDefined();
      expect(modelPath).toBeDefined();
      expect(modelPath!.inputType).toBe('file');
    });
  });

  describe('loudness_normalize', () => {
    it('should define export parity loudnorm parameters', () => {
      const params = AUDIO_EFFECT_PARAM_DEFS.loudness_normalize;
      expect(params).toBeDefined();

      const targetLufs = params.find((p) => p.name === 'target_lufs');
      const targetLra = params.find((p) => p.name === 'target_lra');
      const targetTp = params.find((p) => p.name === 'target_tp');
      const printFormat = params.find((p) => p.name === 'print_format');

      expect(targetLufs!.default).toEqual({ type: 'float', value: -14 });
      expect(targetLufs!.min).toBe(-70);
      expect(targetLufs!.max).toBe(-5);
      expect(targetLra!.default).toEqual({ type: 'float', value: 11 });
      expect(targetTp!.default).toEqual({ type: 'float', value: -1 });
      expect(printFormat!.inputType).toBe('select');
      expect(printFormat!.options).toEqual(['summary', 'json', 'none']);
      expect(params.find((p) => p.name === 'true_peak')).toBeUndefined();
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

  describe('stabilize', () => {
    it('should define smoothing, crop_mode, and zoom parameters', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.stabilize;
      expect(params).toBeDefined();

      expect(params.find((p) => p.name === 'smoothing')).toBeDefined();
      expect(params.find((p) => p.name === 'crop_mode')).toBeDefined();
      expect(params.find((p) => p.name === 'zoom')).toBeDefined();
    });
  });

  describe('auto_reframe', () => {
    it('should define backend-aligned smart reframe parameters', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.auto_reframe;
      expect(params).toBeDefined();

      expect(params.find((p) => p.name === 'target_aspect')).toBeDefined();
      expect(params.find((p) => p.name === 'smoothing')).toBeDefined();
      expect(params.find((p) => p.name === 'zoom')).toBeDefined();
      expect(params.find((p) => p.name === 'detection_mode')).toBeDefined();
    });
  });

  describe('object_tracking', () => {
    it('should define backend-aligned point tracking parameters', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.object_tracking;
      expect(params).toBeDefined();

      expect(params.find((p) => p.name === 'template_size')).toBeDefined();
      expect(params.find((p) => p.name === 'search_area_size')).toBeDefined();
      expect(params.find((p) => p.name === 'confidence_threshold')).toBeDefined();
    });
  });

  describe('curves', () => {
    it('should define backend-aligned curve parameter names and defaults', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.curves;
      expect(params).toBeDefined();

      const names = params.map((p) => p.name);
      expect(names).toEqual([
        'master_curve',
        'red_curve',
        'green_curve',
        'blue_curve',
        'hue_vs_hue_curve',
        'hue_vs_sat_curve',
        'luma_vs_sat_curve',
      ]);

      const master = params.find((p) => p.name === 'master_curve')!;
      const hueVsHue = params.find((p) => p.name === 'hue_vs_hue_curve')!;
      expect(parseCurveDefault(master)).toEqual([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]);
      expect(parseCurveDefault(hueVsHue)).toEqual([
        { x: 0, y: 0.5 },
        { x: 1, y: 0.5 },
      ]);
    });
  });

  describe('lut', () => {
    it('should define export-backed LUT file, interpolation, and intensity parameters', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.lut;
      expect(params).toBeDefined();

      const file = params.find((p) => p.name === 'file');
      const interpolation = params.find((p) => p.name === 'interp');
      const intensity = params.find((p) => p.name === 'intensity');

      expect(file).toBeDefined();
      expect(file!.inputType).toBe('file');
      expect(file!.fileExtensions).toEqual(['cube', '3dl', 'lut']);
      expect(interpolation).toBeDefined();
      expect(interpolation!.inputType).toBe('select');
      expect(interpolation!.options).toEqual(['nearest', 'trilinear', 'tetrahedral']);
      expect(interpolation!.default).toEqual({ type: 'string', value: 'tetrahedral' });
      expect(intensity).toBeDefined();
      expect(intensity!.default).toEqual({ type: 'float', value: 1 });
      expect(intensity!.min).toBe(0);
      expect(intensity!.max).toBe(1);
    });
  });

  describe('hsl_qualifier', () => {
    it('should define backend-aligned secondary correction parameters', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.hsl_qualifier;
      expect(params).toBeDefined();

      const names = params.map((p) => p.name);
      expect(names).toEqual([
        'hue_center',
        'hue_width',
        'sat_min',
        'sat_max',
        'lum_min',
        'lum_max',
        'softness',
        'hue_shift',
        'sat_adjust',
        'lum_adjust',
        'invert',
      ]);

      expect(params.find((p) => p.name === 'sat_min')!.default).toEqual({
        type: 'float',
        value: 0.2,
      });
      expect(params.find((p) => p.name === 'softness')!.default).toEqual({
        type: 'float',
        value: 0.1,
      });
      expect(params.find((p) => p.name === 'invert')!.default).toEqual({
        type: 'bool',
        value: false,
      });
      expect(names).not.toContain('sat_low');
      expect(names).not.toContain('lum_low');
    });
  });

  // ===========================================================================
  // Keying Effects
  // ===========================================================================

  describe('chroma_key', () => {
    it('should define key_color, similarity, blend, spill_suppression, and edge_feather parameters', () => {
      const params = VIDEO_EFFECT_PARAM_DEFS.chroma_key;
      expect(params).toBeDefined();
      expect(params).toHaveLength(5);

      expect(params.find((p) => p.name === 'key_color')).toBeDefined();
      expect(params.find((p) => p.name === 'similarity')).toBeDefined();
      expect(params.find((p) => p.name === 'blend')).toBeDefined();
      expect(params.find((p) => p.name === 'spill_suppression')).toBeDefined();
      expect(params.find((p) => p.name === 'edge_feather')).toBeDefined();
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

describe('getEffectDefaultParamValues', () => {
  it('should include internal stabilize analysis state when resetting', () => {
    expect(getEffectDefaultParamValues('stabilize')).toEqual({
      smoothing: 10,
      crop_mode: 'crop',
      zoom: 0,
      analysis_path: '',
    });
  });

  it('should include internal smart reframe analysis state when resetting', () => {
    expect(getEffectDefaultParamValues('auto_reframe')).toEqual({
      target_aspect: '9:16',
      smoothing: 30,
      zoom: 0,
      detection_mode: 'center',
      analysis_data: '',
    });
  });

  it('should include internal point tracking state when resetting', () => {
    expect(getEffectDefaultParamValues('object_tracking')).toEqual({
      template_size: 25,
      search_area_size: 100,
      confidence_threshold: 0.75,
      origin_x: -1,
      origin_y: -1,
      start_frame: 0,
      tracking_data: '',
    });
  });

  it('should return backend-aligned curve defaults when resetting', () => {
    const defaults = getEffectDefaultParamValues('curves');

    expect(defaults).toHaveProperty('master_curve');
    expect(defaults).toHaveProperty('red_curve');
    expect(defaults).toHaveProperty('green_curve');
    expect(defaults).toHaveProperty('blue_curve');
    expect(defaults).toHaveProperty('hue_vs_hue_curve');
    expect(defaults).not.toHaveProperty('master');
  });

  it('should return LUT defaults when resetting', () => {
    expect(getEffectDefaultParamValues('lut')).toEqual({
      file: '',
      interp: 'tetrahedral',
      intensity: 1,
    });
  });

  it('should return backend-aligned HSL qualifier defaults when resetting', () => {
    expect(getEffectDefaultParamValues('hsl_qualifier')).toEqual({
      hue_center: 120,
      hue_width: 30,
      sat_min: 0.2,
      sat_max: 1,
      lum_min: 0,
      lum_max: 1,
      softness: 0.1,
      hue_shift: 0,
      sat_adjust: 0,
      lum_adjust: 0,
      invert: false,
    });
  });
});
