/**
 * Noise Reduction Utility Tests
 *
 * Tests for audio noise reduction parameter definitions and utilities.
 * Following TDD methodology.
 */

import { describe, it, expect } from 'vitest';
import {
  NOISE_REDUCTION_ALGORITHMS,
  NOISE_REDUCTION_PRESETS,
  DEFAULT_NOISE_REDUCTION_SETTINGS,
  getNoiseReductionAlgorithmLabel,
  getNoiseReductionAlgorithmDescription,
  getNoiseReductionPreset,
  isValidNoiseReductionAlgorithm,
  buildNoiseReductionFFmpegFilter,
  validateNoiseReductionSettings,
  algorithmRequiresModel,
  type NoiseReductionSettings,
  type NoiseReductionAlgorithm,
} from './noiseReduction';

// =============================================================================
// Algorithm Definitions Tests
// =============================================================================

describe('NOISE_REDUCTION_ALGORITHMS', () => {
  it('should define all noise reduction algorithms', () => {
    const algorithms: NoiseReductionAlgorithm[] = ['anlmdn', 'afftdn', 'arnndn'];
    algorithms.forEach((algo) => {
      expect(NOISE_REDUCTION_ALGORITHMS[algo]).toBeDefined();
    });
  });

  it('should have label for each algorithm', () => {
    const algorithms: NoiseReductionAlgorithm[] = ['anlmdn', 'afftdn', 'arnndn'];
    algorithms.forEach((algo) => {
      expect(NOISE_REDUCTION_ALGORITHMS[algo].label).toBeDefined();
      expect(typeof NOISE_REDUCTION_ALGORITHMS[algo].label).toBe('string');
    });
  });

  it('should have description for each algorithm', () => {
    const algorithms: NoiseReductionAlgorithm[] = ['anlmdn', 'afftdn', 'arnndn'];
    algorithms.forEach((algo) => {
      expect(NOISE_REDUCTION_ALGORITHMS[algo].description).toBeDefined();
    });
  });

  it('should have ffmpegFilter for each algorithm', () => {
    const algorithms: NoiseReductionAlgorithm[] = ['anlmdn', 'afftdn', 'arnndn'];
    algorithms.forEach((algo) => {
      expect(NOISE_REDUCTION_ALGORITHMS[algo].ffmpegFilter).toBeDefined();
    });
  });
});

// =============================================================================
// Preset Tests
// =============================================================================

describe('NOISE_REDUCTION_PRESETS', () => {
  it('should define light, medium, and heavy presets', () => {
    expect(NOISE_REDUCTION_PRESETS.light).toBeDefined();
    expect(NOISE_REDUCTION_PRESETS.medium).toBeDefined();
    expect(NOISE_REDUCTION_PRESETS.heavy).toBeDefined();
  });

  it('should have increasing strength values', () => {
    expect(NOISE_REDUCTION_PRESETS.light.strength).toBeLessThan(
      NOISE_REDUCTION_PRESETS.medium.strength
    );
    expect(NOISE_REDUCTION_PRESETS.medium.strength).toBeLessThan(
      NOISE_REDUCTION_PRESETS.heavy.strength
    );
  });

  it('should have valid algorithm for each preset', () => {
    const presets = ['light', 'medium', 'heavy'] as const;
    presets.forEach((preset) => {
      expect(
        isValidNoiseReductionAlgorithm(NOISE_REDUCTION_PRESETS[preset].algorithm)
      ).toBe(true);
    });
  });
});

// =============================================================================
// Default Settings Tests
// =============================================================================

describe('DEFAULT_NOISE_REDUCTION_SETTINGS', () => {
  it('should have valid default algorithm', () => {
    expect(
      isValidNoiseReductionAlgorithm(DEFAULT_NOISE_REDUCTION_SETTINGS.algorithm)
    ).toBe(true);
  });

  it('should have strength between 0 and 1', () => {
    expect(DEFAULT_NOISE_REDUCTION_SETTINGS.strength).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_NOISE_REDUCTION_SETTINGS.strength).toBeLessThanOrEqual(1);
  });

  it('should be disabled by default', () => {
    expect(DEFAULT_NOISE_REDUCTION_SETTINGS.enabled).toBe(false);
  });
});

// =============================================================================
// Utility Function Tests
// =============================================================================

describe('getNoiseReductionAlgorithmLabel', () => {
  it('should return label for anlmdn', () => {
    expect(getNoiseReductionAlgorithmLabel('anlmdn')).toBe(
      'Non-Local Means Denoise'
    );
  });

  it('should return label for afftdn', () => {
    expect(getNoiseReductionAlgorithmLabel('afftdn')).toBe('FFT Denoise');
  });

  it('should return label for arnndn', () => {
    expect(getNoiseReductionAlgorithmLabel('arnndn')).toBe('RNN Denoise');
  });
});

describe('getNoiseReductionAlgorithmDescription', () => {
  it('should return description for each algorithm', () => {
    const algorithms: NoiseReductionAlgorithm[] = ['anlmdn', 'afftdn', 'arnndn'];
    algorithms.forEach((algo) => {
      const desc = getNoiseReductionAlgorithmDescription(algo);
      expect(desc).toBeDefined();
      expect(desc.length).toBeGreaterThan(10);
    });
  });
});

describe('getNoiseReductionPreset', () => {
  it('should return settings for light preset', () => {
    const settings = getNoiseReductionPreset('light');
    expect(settings).toEqual(NOISE_REDUCTION_PRESETS.light);
  });

  it('should return settings for medium preset', () => {
    const settings = getNoiseReductionPreset('medium');
    expect(settings).toEqual(NOISE_REDUCTION_PRESETS.medium);
  });

  it('should return settings for heavy preset', () => {
    const settings = getNoiseReductionPreset('heavy');
    expect(settings).toEqual(NOISE_REDUCTION_PRESETS.heavy);
  });

  it('should return undefined for unknown preset', () => {
    const settings = getNoiseReductionPreset('unknown' as any);
    expect(settings).toBeUndefined();
  });
});

describe('isValidNoiseReductionAlgorithm', () => {
  it('should return true for valid algorithms', () => {
    expect(isValidNoiseReductionAlgorithm('anlmdn')).toBe(true);
    expect(isValidNoiseReductionAlgorithm('afftdn')).toBe(true);
    expect(isValidNoiseReductionAlgorithm('arnndn')).toBe(true);
  });

  it('should return false for invalid algorithms', () => {
    expect(isValidNoiseReductionAlgorithm('invalid' as any)).toBe(false);
    expect(isValidNoiseReductionAlgorithm('' as any)).toBe(false);
    expect(isValidNoiseReductionAlgorithm(null as any)).toBe(false);
  });
});

// =============================================================================
// FFmpeg Filter Builder Tests
// =============================================================================

describe('buildNoiseReductionFFmpegFilter', () => {
  it('should build filter string for anlmdn algorithm', () => {
    const settings: NoiseReductionSettings = {
      algorithm: 'anlmdn',
      strength: 0.5,
      enabled: true,
    };
    const filter = buildNoiseReductionFFmpegFilter(settings);
    expect(filter).toContain('anlmdn');
    expect(filter).toContain('s=');
  });

  it('should build filter string for afftdn algorithm', () => {
    const settings: NoiseReductionSettings = {
      algorithm: 'afftdn',
      strength: 0.7,
      enabled: true,
    };
    const filter = buildNoiseReductionFFmpegFilter(settings);
    expect(filter).toContain('afftdn');
    expect(filter).toContain('nr=');
  });

  it('should return empty string when disabled', () => {
    const settings: NoiseReductionSettings = {
      algorithm: 'anlmdn',
      strength: 0.5,
      enabled: false,
    };
    const filter = buildNoiseReductionFFmpegFilter(settings);
    expect(filter).toBe('');
  });

  it('should scale strength to appropriate range for each algorithm', () => {
    const settings: NoiseReductionSettings = {
      algorithm: 'anlmdn',
      strength: 1.0,
      enabled: true,
    };
    const filter = buildNoiseReductionFFmpegFilter(settings);
    // anlmdn uses s parameter in range 0.0001 to 10
    expect(filter).toMatch(/s=\d+(\.\d+)?/);
  });

  it('should include analysis parameters for afftdn', () => {
    const settings: NoiseReductionSettings = {
      algorithm: 'afftdn',
      strength: 0.5,
      enabled: true,
      analysisWindow: 0.15,
    };
    const filter = buildNoiseReductionFFmpegFilter(settings);
    expect(filter).toContain('afftdn');
  });

  describe('arnndn algorithm (RNN denoise)', () => {
    it('should throw error when model path is not provided', () => {
      const settings: NoiseReductionSettings = {
        algorithm: 'arnndn',
        strength: 0.5,
        enabled: true,
        // No modelPath provided
      };
      expect(() => buildNoiseReductionFFmpegFilter(settings)).toThrow(
        /model file path|modelPath/i
      );
    });

    it('should build filter string when model path is provided', () => {
      const settings: NoiseReductionSettings = {
        algorithm: 'arnndn',
        strength: 0.5,
        enabled: true,
        modelPath: '/path/to/model.onnx',
      };
      const filter = buildNoiseReductionFFmpegFilter(settings);
      expect(filter).toContain('arnndn');
      expect(filter).toContain('m=');
      expect(filter).toContain('/path/to/model.onnx');
    });

    it('should escape special characters in model path', () => {
      const settings: NoiseReductionSettings = {
        algorithm: 'arnndn',
        strength: 0.5,
        enabled: true,
        modelPath: "C:\\Users\\Test's Files\\model.onnx",
      };
      const filter = buildNoiseReductionFFmpegFilter(settings);
      expect(filter).toContain('arnndn');
      // Should convert backslashes and escape quotes
      expect(filter).toContain('/');
    });
  });
});

// =============================================================================
// Validation Tests
// =============================================================================

describe('validateNoiseReductionSettings', () => {
  it('should validate valid settings', () => {
    const settings: NoiseReductionSettings = {
      algorithm: 'anlmdn',
      strength: 0.5,
      enabled: true,
    };
    const result = validateNoiseReductionSettings(settings);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject invalid algorithm', () => {
    const settings: NoiseReductionSettings = {
      algorithm: 'invalid' as NoiseReductionAlgorithm,
      strength: 0.5,
      enabled: true,
    };
    const result = validateNoiseReductionSettings(settings);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('algorithm'))).toBe(true);
  });

  it('should reject strength below 0', () => {
    const settings: NoiseReductionSettings = {
      algorithm: 'anlmdn',
      strength: -0.5,
      enabled: true,
    };
    const result = validateNoiseReductionSettings(settings);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('trength'))).toBe(true);
  });

  it('should reject strength above 1', () => {
    const settings: NoiseReductionSettings = {
      algorithm: 'anlmdn',
      strength: 1.5,
      enabled: true,
    };
    const result = validateNoiseReductionSettings(settings);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('trength'))).toBe(true);
  });

  it('should reject arnndn without model path when enabled', () => {
    const settings: NoiseReductionSettings = {
      algorithm: 'arnndn',
      strength: 0.5,
      enabled: true,
      // No modelPath
    };
    const result = validateNoiseReductionSettings(settings);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('model'))).toBe(true);
  });

  it('should allow arnndn without model path when disabled', () => {
    const settings: NoiseReductionSettings = {
      algorithm: 'arnndn',
      strength: 0.5,
      enabled: false,
      // No modelPath - OK because disabled
    };
    const result = validateNoiseReductionSettings(settings);
    expect(result.valid).toBe(true);
  });

  it('should reject invalid analysis window', () => {
    const settings: NoiseReductionSettings = {
      algorithm: 'afftdn',
      strength: 0.5,
      enabled: true,
      analysisWindow: -1,
    };
    const result = validateNoiseReductionSettings(settings);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('nalysis'))).toBe(true);
  });
});

// =============================================================================
// Algorithm Model Requirement Tests
// =============================================================================

describe('algorithmRequiresModel', () => {
  it('should return true for arnndn', () => {
    expect(algorithmRequiresModel('arnndn')).toBe(true);
  });

  it('should return false for anlmdn', () => {
    expect(algorithmRequiresModel('anlmdn')).toBe(false);
  });

  it('should return false for afftdn', () => {
    expect(algorithmRequiresModel('afftdn')).toBe(false);
  });
});
