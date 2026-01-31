/**
 * Audio Meter Utilities Tests
 *
 * TDD: Tests for audio level analysis and metering functions.
 */

import { describe, it, expect } from 'vitest';
import {
  linearToDb,
  dbToLinear,
  normalizeDb,
  denormalizeDb,
  calculatePeak,
  calculateRms,
  calculateChannelLevel,
  updatePeakHold,
  createPeakHoldState,
  calculateMeterSegments,
  faderToDb,
  dbToFader,
  formatDb,
  formatPan,
  DEFAULT_METER_CONFIG,
  WARNING_THRESHOLD_DB,
  DANGER_THRESHOLD_DB,
} from './audioMeter';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates mock audio data centered at silence.
 */
function createSilentData(length: number = 256): Uint8Array {
  return new Uint8Array(length).fill(128); // 128 = silence (center)
}

/**
 * Creates mock audio data with specific amplitude.
 */
function createToneData(amplitude: number, length: number = 256): Uint8Array {
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    // Simple sine wave
    const sample = Math.sin((i / length) * Math.PI * 4) * amplitude;
    data[i] = Math.round(128 + sample * 128);
  }
  return data;
}

/**
 * Creates clipping audio data.
 */
function createClippingData(length: number = 256): Uint8Array {
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    // Alternating max values
    data[i] = i % 2 === 0 ? 255 : 0;
  }
  return data;
}

// =============================================================================
// dB Conversion Tests
// =============================================================================

describe('linearToDb', () => {
  it('should convert 1.0 to 0 dB', () => {
    expect(linearToDb(1.0)).toBeCloseTo(0, 1);
  });

  it('should convert 0.5 to approximately -6 dB', () => {
    expect(linearToDb(0.5)).toBeCloseTo(-6.02, 1);
  });

  it('should convert 0.1 to approximately -20 dB', () => {
    expect(linearToDb(0.1)).toBeCloseTo(-20, 1);
  });

  it('should return minDb for zero', () => {
    expect(linearToDb(0, -60)).toBe(-60);
  });

  it('should return minDb for negative values', () => {
    expect(linearToDb(-0.5, -60)).toBe(-60);
  });

  it('should clamp very small values to minDb', () => {
    expect(linearToDb(0.000001, -60)).toBe(-60);
  });
});

describe('dbToLinear', () => {
  it('should convert 0 dB to 1.0', () => {
    expect(dbToLinear(0)).toBeCloseTo(1.0, 4);
  });

  it('should convert -6 dB to approximately 0.5', () => {
    expect(dbToLinear(-6)).toBeCloseTo(0.501, 2);
  });

  it('should convert -20 dB to approximately 0.1', () => {
    expect(dbToLinear(-20)).toBeCloseTo(0.1, 2);
  });

  it('should convert +6 dB to approximately 2.0', () => {
    expect(dbToLinear(6)).toBeCloseTo(1.995, 2);
  });
});

describe('normalizeDb', () => {
  it('should normalize -60 dB to 0', () => {
    expect(normalizeDb(-60, -60, 0)).toBe(0);
  });

  it('should normalize 0 dB to 1', () => {
    expect(normalizeDb(0, -60, 0)).toBe(1);
  });

  it('should normalize -30 dB to 0.5', () => {
    expect(normalizeDb(-30, -60, 0)).toBe(0.5);
  });

  it('should clamp values below minDb to 0', () => {
    expect(normalizeDb(-100, -60, 0)).toBe(0);
  });

  it('should clamp values above maxDb to 1', () => {
    expect(normalizeDb(10, -60, 0)).toBe(1);
  });
});

describe('denormalizeDb', () => {
  it('should denormalize 0 to minDb', () => {
    expect(denormalizeDb(0, -60, 0)).toBe(-60);
  });

  it('should denormalize 1 to maxDb', () => {
    expect(denormalizeDb(1, -60, 0)).toBe(0);
  });

  it('should denormalize 0.5 to midpoint', () => {
    expect(denormalizeDb(0.5, -60, 0)).toBe(-30);
  });
});

// =============================================================================
// Level Calculation Tests
// =============================================================================

describe('calculatePeak', () => {
  it('should return 0 for silent data', () => {
    const data = createSilentData();
    expect(calculatePeak(data)).toBe(0);
  });

  it('should return correct peak for tone data', () => {
    const data = createToneData(0.5); // 50% amplitude
    const peak = calculatePeak(data);
    expect(peak).toBeCloseTo(0.5, 1);
  });

  it('should return approximately 1.0 for clipping data', () => {
    const data = createClippingData();
    const peak = calculatePeak(data);
    expect(peak).toBeGreaterThan(0.99);
  });
});

describe('calculateRms', () => {
  it('should return 0 for silent data', () => {
    const data = createSilentData();
    expect(calculateRms(data)).toBe(0);
  });

  it('should return lower value than peak for tone data', () => {
    const data = createToneData(0.5);
    const rms = calculateRms(data);
    const peak = calculatePeak(data);
    expect(rms).toBeLessThan(peak);
  });

  it('should return approximately 0.707 of peak for sine wave', () => {
    // RMS of a sine wave is peak / sqrt(2) ≈ 0.707 * peak
    const data = createToneData(1.0);
    const rms = calculateRms(data);
    const peak = calculatePeak(data);
    expect(rms / peak).toBeCloseTo(0.707, 1);
  });
});

describe('calculateChannelLevel', () => {
  it('should return complete level data for silent input', () => {
    const data = createSilentData();
    const level = calculateChannelLevel(data);

    expect(level.peak).toBe(0);
    expect(level.rms).toBe(0);
    expect(level.peakDb).toBe(-60);
    expect(level.rmsDb).toBe(-60);
    expect(level.clipping).toBe(false);
  });

  it('should detect clipping', () => {
    const data = createClippingData();
    const level = calculateChannelLevel(data);

    expect(level.clipping).toBe(true);
  });

  it('should calculate all values consistently', () => {
    const data = createToneData(0.5);
    const level = calculateChannelLevel(data);

    // dB values should match linear conversions
    expect(level.peakDb).toBeCloseTo(linearToDb(level.peak), 1);
    expect(level.rmsDb).toBeCloseTo(linearToDb(level.rms), 1);
  });
});

// =============================================================================
// Peak Hold Tests
// =============================================================================

describe('createPeakHoldState', () => {
  it('should create initial state with zero values', () => {
    const state = createPeakHoldState();
    expect(state.peakValue).toBe(0);
    expect(state.peakTime).toBe(0);
  });
});

describe('updatePeakHold', () => {
  const config = DEFAULT_METER_CONFIG;

  it('should update immediately when new peak is higher', () => {
    const current = { peakValue: 0.5, peakTime: 1000 };
    const result = updatePeakHold(current, 0.8, 1100, config);

    expect(result.peakValue).toBe(0.8);
    expect(result.peakTime).toBe(1100);
  });

  it('should hold peak during hold time', () => {
    const current = { peakValue: 0.8, peakTime: 1000 };
    // 500ms later, still in hold time (default 1000ms)
    const result = updatePeakHold(current, 0.3, 1500, config);

    expect(result.peakValue).toBe(0.8);
    expect(result.peakTime).toBe(1000);
  });

  it('should start falling after hold time expires', () => {
    const current = { peakValue: 0.8, peakTime: 1000 };
    // 2000ms later, past hold time
    const result = updatePeakHold(current, 0.3, 3000, config);

    expect(result.peakValue).toBeLessThan(0.8);
    expect(result.peakValue).toBeGreaterThanOrEqual(0.3);
  });

  it('should not fall below current level', () => {
    const current = { peakValue: 0.8, peakTime: 1000 };
    // Long time later
    const result = updatePeakHold(current, 0.5, 10000, config);

    expect(result.peakValue).toBeGreaterThanOrEqual(0.5);
  });
});

// =============================================================================
// Meter Segment Tests
// =============================================================================

describe('calculateMeterSegments', () => {
  it('should return empty array for very low levels', () => {
    const segments = calculateMeterSegments(-70);
    expect(segments).toHaveLength(0);
  });

  it('should return only green segment for low levels', () => {
    const segments = calculateMeterSegments(-20);
    expect(segments).toHaveLength(1);
    expect(segments[0].color).toBe('green');
  });

  it('should include yellow segment for moderate levels', () => {
    const segments = calculateMeterSegments(-4); // Above -6 dB
    expect(segments.some((s) => s.color === 'yellow')).toBe(true);
  });

  it('should include red segment for high levels', () => {
    const segments = calculateMeterSegments(-1); // Above -3 dB
    expect(segments.some((s) => s.color === 'red')).toBe(true);
  });

  it('should have continuous segments', () => {
    const segments = calculateMeterSegments(-1);

    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].start).toBeCloseTo(segments[i - 1].end, 4);
    }
  });

  it('should start at 0', () => {
    const segments = calculateMeterSegments(-10);
    expect(segments[0].start).toBe(0);
  });
});

// =============================================================================
// Fader Conversion Tests
// =============================================================================

describe('faderToDb', () => {
  it('should return minDb at position 0', () => {
    expect(faderToDb(0)).toBe(-60);
  });

  it('should return maxDb at position 1', () => {
    expect(faderToDb(1)).toBe(6);
  });

  it('should return intermediate value at 0.5', () => {
    const db = faderToDb(0.5);
    expect(db).toBeGreaterThan(-60);
    expect(db).toBeLessThan(6);
  });

  it('should use custom minDb and maxDb', () => {
    expect(faderToDb(0, -96, 12)).toBe(-96);
    expect(faderToDb(1, -96, 12)).toBe(12);
  });
});

describe('dbToFader', () => {
  it('should return 0 at minDb', () => {
    expect(dbToFader(-60)).toBe(0);
  });

  it('should return 1 at maxDb', () => {
    expect(dbToFader(6)).toBe(1);
  });

  it('should be inverse of faderToDb', () => {
    const positions = [0, 0.25, 0.5, 0.75, 1];
    for (const pos of positions) {
      const db = faderToDb(pos);
      const backToPos = dbToFader(db);
      expect(backToPos).toBeCloseTo(pos, 4);
    }
  });
});

// =============================================================================
// Formatting Tests
// =============================================================================

describe('formatDb', () => {
  it('should format 0 dB correctly', () => {
    expect(formatDb(0)).toBe('0.0 dB');
  });

  it('should format negative values correctly', () => {
    expect(formatDb(-12)).toBe('-12.0 dB');
  });

  it('should format positive values with + sign', () => {
    expect(formatDb(3)).toBe('+3.0 dB');
  });

  it('should return -∞ for very low values', () => {
    expect(formatDb(-60)).toBe('-∞');
    expect(formatDb(-100)).toBe('-∞');
  });

  it('should respect precision parameter', () => {
    expect(formatDb(-12.345, 2)).toBe('-12.35 dB');
  });
});

describe('formatPan', () => {
  it('should return C for center', () => {
    expect(formatPan(0)).toBe('C');
    expect(formatPan(0.005)).toBe('C'); // Near center
  });

  it('should format left panning correctly', () => {
    expect(formatPan(-0.5)).toBe('L50');
    expect(formatPan(-1.0)).toBe('L100');
  });

  it('should format right panning correctly', () => {
    expect(formatPan(0.5)).toBe('R50');
    expect(formatPan(1.0)).toBe('R100');
  });

  it('should round to nearest integer percentage', () => {
    expect(formatPan(-0.123)).toBe('L12');
    expect(formatPan(0.567)).toBe('R57');
  });
});

// =============================================================================
// Constants Tests
// =============================================================================

describe('constants', () => {
  it('should have reasonable default config', () => {
    expect(DEFAULT_METER_CONFIG.minDb).toBe(-60);
    expect(DEFAULT_METER_CONFIG.maxDb).toBe(0);
    expect(DEFAULT_METER_CONFIG.fftSize).toBe(2048);
    expect(DEFAULT_METER_CONFIG.peakHoldTime).toBe(1000);
  });

  it('should have warning threshold below danger threshold', () => {
    expect(WARNING_THRESHOLD_DB).toBeLessThan(DANGER_THRESHOLD_DB);
  });

  it('should have danger threshold below 0 dB', () => {
    expect(DANGER_THRESHOLD_DB).toBeLessThan(0);
  });
});
