/**
 * Noise Reduction Utility
 *
 * Provides definitions and utilities for audio noise reduction.
 * Uses FFmpeg's built-in noise reduction filters:
 * - anlmdn: Non-Local Means Denoise
 * - afftdn: FFT-based Denoise
 * - arnndn: RNN-based Denoise (requires model)
 *
 * @module utils/noiseReduction
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Available noise reduction algorithms
 */
export type NoiseReductionAlgorithm = 'anlmdn' | 'afftdn' | 'arnndn';

/**
 * Preset levels for noise reduction
 */
export type NoiseReductionPresetLevel = 'light' | 'medium' | 'heavy';

/**
 * Algorithm definition with metadata
 */
export interface NoiseReductionAlgorithmDef {
  /** Display label */
  label: string;
  /** Human-readable description */
  description: string;
  /** FFmpeg filter name */
  ffmpegFilter: string;
  /** Whether this algorithm requires an external model */
  requiresModel?: boolean;
}

/**
 * Settings for noise reduction
 */
export interface NoiseReductionSettings {
  /** The algorithm to use */
  algorithm: NoiseReductionAlgorithm;
  /** Strength from 0 (no reduction) to 1 (maximum) */
  strength: number;
  /** Whether noise reduction is enabled */
  enabled: boolean;
  /** Analysis window in seconds (for afftdn) */
  analysisWindow?: number;
  /** Noise floor in dB (for advanced tuning) */
  noiseFloor?: number;
  /** Path to RNN model file (required for arnndn algorithm) */
  modelPath?: string;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * All available noise reduction algorithms
 */
export const ALL_NOISE_REDUCTION_ALGORITHMS: readonly NoiseReductionAlgorithm[] =
  ['anlmdn', 'afftdn', 'arnndn'] as const;

/**
 * Definitions for each noise reduction algorithm
 */
export const NOISE_REDUCTION_ALGORITHMS: Record<
  NoiseReductionAlgorithm,
  NoiseReductionAlgorithmDef
> = {
  anlmdn: {
    label: 'Non-Local Means Denoise',
    description:
      'High-quality denoise using non-local means algorithm. Best for moderate noise levels with good quality preservation.',
    ffmpegFilter: 'anlmdn',
  },
  afftdn: {
    label: 'FFT Denoise',
    description:
      'Fast Fourier Transform-based denoise. Good balance of speed and quality. Works well with consistent background noise.',
    ffmpegFilter: 'afftdn',
  },
  arnndn: {
    label: 'RNN Denoise',
    description:
      'Recurrent Neural Network-based denoise. Excellent for speech clarity. Requires external model file.',
    ffmpegFilter: 'arnndn',
    requiresModel: true,
  },
};

/**
 * Preset settings for quick noise reduction setup
 */
export const NOISE_REDUCTION_PRESETS: Record<
  NoiseReductionPresetLevel,
  Omit<NoiseReductionSettings, 'enabled'>
> = {
  light: {
    algorithm: 'anlmdn',
    strength: 0.3,
  },
  medium: {
    algorithm: 'anlmdn',
    strength: 0.5,
  },
  heavy: {
    algorithm: 'afftdn',
    strength: 0.8,
  },
};

/**
 * Default noise reduction settings
 */
export const DEFAULT_NOISE_REDUCTION_SETTINGS: NoiseReductionSettings = {
  algorithm: 'anlmdn',
  strength: 0.5,
  enabled: false,
};

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get the display label for a noise reduction algorithm
 */
export function getNoiseReductionAlgorithmLabel(
  algorithm: NoiseReductionAlgorithm
): string {
  return NOISE_REDUCTION_ALGORITHMS[algorithm]?.label ?? algorithm;
}

/**
 * Get the description for a noise reduction algorithm
 */
export function getNoiseReductionAlgorithmDescription(
  algorithm: NoiseReductionAlgorithm
): string {
  return NOISE_REDUCTION_ALGORITHMS[algorithm]?.description ?? '';
}

/**
 * Get settings for a preset level
 */
export function getNoiseReductionPreset(
  level: NoiseReductionPresetLevel
): Omit<NoiseReductionSettings, 'enabled'> | undefined {
  return NOISE_REDUCTION_PRESETS[level];
}

/**
 * Check if a value is a valid noise reduction algorithm
 */
export function isValidNoiseReductionAlgorithm(
  value: unknown
): value is NoiseReductionAlgorithm {
  if (typeof value !== 'string') return false;
  return ALL_NOISE_REDUCTION_ALGORITHMS.includes(
    value as NoiseReductionAlgorithm
  );
}

/**
 * Build FFmpeg filter string for noise reduction
 *
 * @param settings - Noise reduction settings
 * @returns FFmpeg filter string, or empty string if disabled
 */
/**
 * Validation result for noise reduction settings
 */
export interface NoiseReductionValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates noise reduction settings
 *
 * @param settings - Settings to validate
 * @returns Validation result with any errors
 */
export function validateNoiseReductionSettings(
  settings: NoiseReductionSettings
): NoiseReductionValidationResult {
  const errors: string[] = [];

  if (!isValidNoiseReductionAlgorithm(settings.algorithm)) {
    errors.push(`Invalid algorithm: ${settings.algorithm}`);
  }

  if (settings.strength < 0 || settings.strength > 1) {
    errors.push(`Strength must be between 0 and 1, got ${settings.strength}`);
  }

  if (settings.algorithm === 'arnndn' && settings.enabled && !settings.modelPath) {
    errors.push('RNN denoise (arnndn) requires a model file path');
  }

  if (settings.analysisWindow !== undefined && settings.analysisWindow <= 0) {
    errors.push('Analysis window must be positive');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Build FFmpeg filter string for noise reduction
 *
 * @param settings - Noise reduction settings
 * @returns FFmpeg filter string, or empty string if disabled or invalid
 * @throws Error if settings are invalid for the selected algorithm
 */
export function buildNoiseReductionFFmpegFilter(
  settings: NoiseReductionSettings
): string {
  if (!settings.enabled) {
    return '';
  }

  const validation = validateNoiseReductionSettings(settings);
  if (!validation.valid) {
    throw new Error(`Invalid noise reduction settings: ${validation.errors.join(', ')}`);
  }

  const { algorithm, strength, analysisWindow, noiseFloor, modelPath } = settings;

  switch (algorithm) {
    case 'anlmdn': {
      // anlmdn uses s parameter (0.0001 to 10)
      // Map strength (0-1) to reasonable range (0.0001 to 5)
      const s = 0.0001 + strength * 4.9999;
      let filter = `anlmdn=s=${s.toFixed(4)}`;
      // Add patch size based on strength (higher strength = larger patch)
      const p = Math.max(1, Math.round(7 + strength * 8)); // 7-15
      filter += `:p=${p}`;
      return filter;
    }

    case 'afftdn': {
      // afftdn uses nr (noise reduction) parameter in dB (0 to 50+)
      // Map strength (0-1) to dB range (0 to 30)
      const nr = Math.round(strength * 30);
      let filter = `afftdn=nr=${nr}`;
      // Add noise floor if specified
      if (noiseFloor !== undefined) {
        filter += `:nf=${noiseFloor.toFixed(1)}`;
      }
      // Add analysis window type if specified
      if (analysisWindow !== undefined) {
        // nt=w enables windowed noise floor tracking
        filter += `:nt=w`;
      }
      return filter;
    }

    case 'arnndn': {
      // arnndn requires a model file - validation ensures modelPath exists
      if (!modelPath) {
        throw new Error('arnndn algorithm requires modelPath to be specified');
      }
      // Escape path for FFmpeg (handle spaces and special characters)
      const escapedPath = modelPath.replace(/\\/g, '/').replace(/'/g, "'\\''");
      return `arnndn=m='${escapedPath}'`;
    }

    default:
      return '';
  }
}

/**
 * Get all preset levels
 */
export function getNoiseReductionPresetLevels(): NoiseReductionPresetLevel[] {
  return ['light', 'medium', 'heavy'];
}

/**
 * Check if an algorithm requires an external model
 */
export function algorithmRequiresModel(
  algorithm: NoiseReductionAlgorithm
): boolean {
  return NOISE_REDUCTION_ALGORITHMS[algorithm]?.requiresModel ?? false;
}
