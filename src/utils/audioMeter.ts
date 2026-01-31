/**
 * Audio Metering Utilities
 *
 * Functions for analyzing audio levels including:
 * - Peak level detection
 * - RMS (Root Mean Square) level calculation
 * - dB conversion utilities
 * - Level normalization for meter display
 */

// =============================================================================
// Types
// =============================================================================

/** Audio level data for a single channel */
export interface ChannelLevel {
  /** Peak level (0-1 linear) */
  peak: number;
  /** RMS level (0-1 linear) */
  rms: number;
  /** Peak level in dB (typically -60 to 0) */
  peakDb: number;
  /** RMS level in dB */
  rmsDb: number;
  /** Whether the channel is clipping (peak >= 1.0) */
  clipping: boolean;
}

/** Stereo audio levels */
export interface StereoLevels {
  left: ChannelLevel;
  right: ChannelLevel;
}

/** Mono audio levels */
export interface MonoLevels {
  mono: ChannelLevel;
}

/** Configuration for level analysis */
export interface MeterConfig {
  /** Minimum dB value for display (default: -60) */
  minDb?: number;
  /** Maximum dB value for display (default: 0) */
  maxDb?: number;
  /** FFT size for frequency analysis (default: 2048) */
  fftSize?: number;
  /** Smoothing time constant (default: 0.8) */
  smoothingTimeConstant?: number;
  /** Peak hold time in ms (default: 1000) */
  peakHoldTime?: number;
  /** Peak fall rate in dB/second (default: 20) */
  peakFallRate?: number;
}

/** State for peak hold functionality */
export interface PeakHoldState {
  peakValue: number;
  peakTime: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Default meter configuration */
export const DEFAULT_METER_CONFIG: Required<MeterConfig> = {
  minDb: -60,
  maxDb: 0,
  fftSize: 2048,
  smoothingTimeConstant: 0.8,
  peakHoldTime: 1000,
  peakFallRate: 20,
};

/** dB values for standard meter markings */
export const METER_MARKINGS_DB = [-60, -48, -36, -24, -18, -12, -6, -3, 0];

/** Warning threshold in dB (yellow zone) */
export const WARNING_THRESHOLD_DB = -6;

/** Danger threshold in dB (red zone) */
export const DANGER_THRESHOLD_DB = -3;

// =============================================================================
// dB Conversion Utilities
// =============================================================================

/**
 * Converts linear amplitude (0-1) to decibels.
 *
 * @param linear - Linear amplitude value (0-1)
 * @param minDb - Minimum dB value to return (default: -60)
 * @returns dB value, clamped to minDb for very small values
 */
export function linearToDb(linear: number, minDb: number = -60): number {
  if (linear <= 0) return minDb;
  const db = 20 * Math.log10(linear);
  return Math.max(minDb, db);
}

/**
 * Converts decibels to linear amplitude (0-1).
 *
 * @param db - Decibel value
 * @returns Linear amplitude value
 */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * Normalizes a dB value to 0-1 range for meter display.
 *
 * @param db - Decibel value
 * @param minDb - Minimum dB (maps to 0)
 * @param maxDb - Maximum dB (maps to 1)
 * @returns Normalized value between 0 and 1
 */
export function normalizeDb(db: number, minDb: number = -60, maxDb: number = 0): number {
  if (db <= minDb) return 0;
  if (db >= maxDb) return 1;
  return (db - minDb) / (maxDb - minDb);
}

/**
 * Converts a normalized meter value (0-1) back to dB.
 *
 * @param normalized - Normalized value (0-1)
 * @param minDb - Minimum dB
 * @param maxDb - Maximum dB
 * @returns dB value
 */
export function denormalizeDb(normalized: number, minDb: number = -60, maxDb: number = 0): number {
  return minDb + normalized * (maxDb - minDb);
}

// =============================================================================
// Level Analysis
// =============================================================================

/**
 * Calculates peak level from time-domain audio data.
 *
 * @param data - Uint8Array from AnalyserNode.getByteTimeDomainData()
 * @returns Peak level (0-1 linear)
 */
export function calculatePeak(data: Uint8Array): number {
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    // Convert from 0-255 (centered at 128) to -1 to 1
    const amplitude = Math.abs((data[i] - 128) / 128);
    if (amplitude > max) {
      max = amplitude;
    }
  }
  return max;
}

/**
 * Calculates RMS (Root Mean Square) level from time-domain audio data.
 *
 * @param data - Uint8Array from AnalyserNode.getByteTimeDomainData()
 * @returns RMS level (0-1 linear)
 */
export function calculateRms(data: Uint8Array): number {
  let sumSquares = 0;
  for (let i = 0; i < data.length; i++) {
    // Convert from 0-255 (centered at 128) to -1 to 1
    const amplitude = (data[i] - 128) / 128;
    sumSquares += amplitude * amplitude;
  }
  return Math.sqrt(sumSquares / data.length);
}

/**
 * Calculates both peak and RMS levels with dB conversion.
 *
 * @param data - Uint8Array from AnalyserNode.getByteTimeDomainData()
 * @param minDb - Minimum dB for conversion
 * @returns ChannelLevel with all measurements
 */
export function calculateChannelLevel(data: Uint8Array, minDb: number = -60): ChannelLevel {
  const peak = calculatePeak(data);
  const rms = calculateRms(data);
  const peakDb = linearToDb(peak, minDb);
  const rmsDb = linearToDb(rms, minDb);

  return {
    peak,
    rms,
    peakDb,
    rmsDb,
    clipping: peak >= 0.99, // Allow tiny headroom for floating point
  };
}

// =============================================================================
// Peak Hold
// =============================================================================

/**
 * Updates peak hold state with new level.
 *
 * @param current - Current peak hold state
 * @param newPeak - New peak value (linear 0-1)
 * @param currentTime - Current time in ms (Date.now())
 * @param config - Meter configuration
 * @returns Updated peak hold state
 */
export function updatePeakHold(
  current: PeakHoldState,
  newPeak: number,
  currentTime: number,
  config: Required<MeterConfig>
): PeakHoldState {
  // If new peak is higher, update immediately
  if (newPeak >= current.peakValue) {
    return {
      peakValue: newPeak,
      peakTime: currentTime,
    };
  }

  // Check if hold time has expired
  const elapsed = currentTime - current.peakTime;
  if (elapsed > config.peakHoldTime) {
    // Start falling
    const fallAmount = (elapsed - config.peakHoldTime) / 1000 * config.peakFallRate;
    const fallDb = linearToDb(current.peakValue, config.minDb) - fallAmount;
    const newValue = Math.max(newPeak, dbToLinear(fallDb));

    return {
      peakValue: newValue,
      peakTime: current.peakTime,
    };
  }

  // Still in hold period
  return current;
}

/**
 * Creates initial peak hold state.
 */
export function createPeakHoldState(): PeakHoldState {
  return {
    peakValue: 0,
    peakTime: 0,
  };
}

// =============================================================================
// Meter Segment Calculation
// =============================================================================

/** Meter segment with color information */
export interface MeterSegment {
  start: number; // 0-1 normalized position
  end: number;
  color: 'green' | 'yellow' | 'red';
  db: number;
}

/**
 * Calculates meter segments for a given level.
 *
 * @param levelDb - Level in dB
 * @param minDb - Minimum dB
 * @param maxDb - Maximum dB
 * @returns Array of meter segments
 */
export function calculateMeterSegments(
  levelDb: number,
  minDb: number = -60,
  maxDb: number = 0
): MeterSegment[] {
  const segments: MeterSegment[] = [];
  const normalized = normalizeDb(levelDb, minDb, maxDb);

  if (normalized <= 0) return segments;

  // Green zone: minDb to WARNING_THRESHOLD_DB
  const greenEnd = normalizeDb(WARNING_THRESHOLD_DB, minDb, maxDb);
  if (normalized > 0) {
    segments.push({
      start: 0,
      end: Math.min(normalized, greenEnd),
      color: 'green',
      db: Math.min(levelDb, WARNING_THRESHOLD_DB),
    });
  }

  // Yellow zone: WARNING_THRESHOLD_DB to DANGER_THRESHOLD_DB
  const yellowEnd = normalizeDb(DANGER_THRESHOLD_DB, minDb, maxDb);
  if (normalized > greenEnd) {
    segments.push({
      start: greenEnd,
      end: Math.min(normalized, yellowEnd),
      color: 'yellow',
      db: Math.min(levelDb, DANGER_THRESHOLD_DB),
    });
  }

  // Red zone: DANGER_THRESHOLD_DB to maxDb
  if (normalized > yellowEnd) {
    segments.push({
      start: yellowEnd,
      end: Math.min(normalized, 1),
      color: 'red',
      db: levelDb,
    });
  }

  return segments;
}

// =============================================================================
// Volume/Pan Utilities
// =============================================================================

/**
 * Converts fader position (0-1) to volume in dB.
 * Uses a logarithmic curve for natural feel.
 *
 * @param faderPosition - Fader position (0-1)
 * @param minDb - Minimum dB at position 0 (default: -60)
 * @param maxDb - Maximum dB at position 1 (default: 6)
 * @returns Volume in dB
 */
export function faderToDb(
  faderPosition: number,
  minDb: number = -60,
  maxDb: number = 6
): number {
  // Use exponential curve for natural feel
  // Position 0 = minDb, Position 1 = maxDb
  // Unity (0 dB) is typically around 0.75-0.8 on the fader
  if (faderPosition <= 0) return minDb;
  if (faderPosition >= 1) return maxDb;

  // Logarithmic curve
  const range = maxDb - minDb;
  return minDb + Math.pow(faderPosition, 2) * range;
}

/**
 * Converts volume in dB to fader position (0-1).
 *
 * @param db - Volume in dB
 * @param minDb - Minimum dB
 * @param maxDb - Maximum dB
 * @returns Fader position (0-1)
 */
export function dbToFader(
  db: number,
  minDb: number = -60,
  maxDb: number = 6
): number {
  if (db <= minDb) return 0;
  if (db >= maxDb) return 1;

  const range = maxDb - minDb;
  return Math.sqrt((db - minDb) / range);
}

/**
 * Formats a dB value for display.
 *
 * @param db - Decibel value
 * @param precision - Decimal places (default: 1)
 * @returns Formatted string (e.g., "-12.0 dB", "+3.0 dB", "-∞")
 */
export function formatDb(db: number, precision: number = 1): string {
  if (db <= -60) return '-∞';
  const sign = db > 0 ? '+' : '';
  return `${sign}${db.toFixed(precision)} dB`;
}

/**
 * Formats pan value for display.
 *
 * @param pan - Pan value (-1 to 1)
 * @returns Formatted string (e.g., "L50", "C", "R25")
 */
export function formatPan(pan: number): string {
  if (Math.abs(pan) < 0.01) return 'C';
  const percentage = Math.abs(Math.round(pan * 100));
  return pan < 0 ? `L${percentage}` : `R${percentage}`;
}
