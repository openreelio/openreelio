/**
 * Scope Analysis Utilities Tests
 *
 * TDD: Tests for video frame analysis functions.
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeHistogram,
  analyzeWaveform,
  analyzeVectorscope,
  analyzeRGBParade,
  analyzeFrame,
  createEmptyAnalysis,
  normalizeHistogram,
  calculateExposureLevel,
  type HistogramData,
} from './scopeAnalysis';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a mock ImageData for testing.
 */
function createMockImageData(
  width: number,
  height: number,
  fillColor: [number, number, number, number] = [128, 128, 128, 255]
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let i = 0; i < data.length; i += 4) {
    data[i] = fillColor[0];     // R
    data[i + 1] = fillColor[1]; // G
    data[i + 2] = fillColor[2]; // B
    data[i + 3] = fillColor[3]; // A
  }

  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

/**
 * Creates ImageData with a gradient pattern.
 */
function createGradientImageData(
  width: number,
  height: number,
  direction: 'horizontal' | 'vertical' = 'horizontal'
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const value = direction === 'horizontal'
        ? Math.floor((x / width) * 255)
        : Math.floor((y / height) * 255);

      data[i] = value;     // R
      data[i + 1] = value; // G
      data[i + 2] = value; // B
      data[i + 3] = 255;   // A
    }
  }

  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

/**
 * Creates ImageData with specific color regions.
 */
function createColorRegionsImageData(
  width: number,
  height: number
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  const halfWidth = Math.floor(width / 2);
  const halfHeight = Math.floor(height / 2);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;

      // Quadrant colors: Red (TL), Green (TR), Blue (BL), White (BR)
      if (x < halfWidth && y < halfHeight) {
        // Top-left: Red
        data[i] = 255; data[i + 1] = 0; data[i + 2] = 0;
      } else if (x >= halfWidth && y < halfHeight) {
        // Top-right: Green
        data[i] = 0; data[i + 1] = 255; data[i + 2] = 0;
      } else if (x < halfWidth && y >= halfHeight) {
        // Bottom-left: Blue
        data[i] = 0; data[i + 1] = 0; data[i + 2] = 255;
      } else {
        // Bottom-right: White
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
      }
      data[i + 3] = 255; // Alpha
    }
  }

  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

// =============================================================================
// Histogram Analysis Tests
// =============================================================================

describe('analyzeHistogram', () => {
  it('should return histogram with 256 values per channel', () => {
    const imageData = createMockImageData(10, 10);
    const result = analyzeHistogram(imageData);

    expect(result.red).toHaveLength(256);
    expect(result.green).toHaveLength(256);
    expect(result.blue).toHaveLength(256);
    expect(result.luminance).toHaveLength(256);
  });

  it('should count solid color correctly', () => {
    // Create 10x10 pure red image
    const imageData = createMockImageData(10, 10, [255, 0, 0, 255]);
    const result = analyzeHistogram(imageData);

    // All 100 pixels should be counted in red[255]
    expect(result.red[255]).toBe(100);
    expect(result.red[0]).toBe(0);

    // Green and blue should be at 0
    expect(result.green[0]).toBe(100);
    expect(result.blue[0]).toBe(100);
  });

  it('should calculate luminance correctly', () => {
    // Pure white (255, 255, 255) should have luminance ~255
    const whiteImage = createMockImageData(10, 10, [255, 255, 255, 255]);
    const whiteResult = analyzeHistogram(whiteImage);
    expect(whiteResult.luminance[255]).toBe(100);

    // Pure black (0, 0, 0) should have luminance 0
    const blackImage = createMockImageData(10, 10, [0, 0, 0, 255]);
    const blackResult = analyzeHistogram(blackImage);
    expect(blackResult.luminance[0]).toBe(100);
  });

  it('should handle sampling rate', () => {
    // 10x10 image = 100 pixels
    const imageData = createMockImageData(10, 10, [128, 128, 128, 255]);

    // Sample every 2nd pixel should give ~50 samples
    const result = analyzeHistogram(imageData, 2);
    expect(result.red[128]).toBe(50);
  });

  it('should track maxCount correctly', () => {
    const imageData = createMockImageData(10, 10, [100, 100, 100, 255]);
    const result = analyzeHistogram(imageData);

    // maxCount should be 100 (all pixels at same value)
    expect(result.maxCount).toBe(100);
  });

  it('should handle empty/small images', () => {
    const imageData = createMockImageData(1, 1, [128, 64, 192, 255]);
    const result = analyzeHistogram(imageData);

    expect(result.red[128]).toBe(1);
    expect(result.green[64]).toBe(1);
    expect(result.blue[192]).toBe(1);
    expect(result.maxCount).toBe(1);
  });
});

// =============================================================================
// Waveform Analysis Tests
// =============================================================================

describe('analyzeWaveform', () => {
  it('should return waveform with specified width', () => {
    const imageData = createMockImageData(100, 50);
    const result = analyzeWaveform(imageData, 50);

    expect(result.columns).toHaveLength(50);
    expect(result.width).toBe(50);
  });

  it('should calculate min/max/avg luminance per column', () => {
    // Solid gray image
    const imageData = createMockImageData(10, 10, [128, 128, 128, 255]);
    const result = analyzeWaveform(imageData, 10);

    // All columns should have same values for solid color
    for (const col of result.columns) {
      // BT.709: 0.2126*128 + 0.7152*128 + 0.0722*128 ≈ 128
      expect(col.min).toBeCloseTo(128, 0);
      expect(col.max).toBeCloseTo(128, 0);
      expect(col.avg).toBeCloseTo(128, 0);
    }
  });

  it('should detect horizontal gradient', () => {
    // Create horizontal gradient (dark left, bright right)
    const imageData = createGradientImageData(100, 10, 'horizontal');
    const result = analyzeWaveform(imageData, 10);

    // First column should be dark, last column should be bright
    expect(result.columns[0].avg).toBeLessThan(50);
    expect(result.columns[result.columns.length - 1].avg).toBeGreaterThan(200);
  });

  it('should include distribution data', () => {
    const imageData = createMockImageData(10, 10, [100, 100, 100, 255]);
    const result = analyzeWaveform(imageData, 5);

    // Each column should have distribution data
    for (const col of result.columns) {
      expect(col.distribution).toHaveLength(256);
      // Distribution should have counts at luminance value
      const expectedLum = Math.round(0.2126 * 100 + 0.7152 * 100 + 0.0722 * 100);
      expect(col.distribution[expectedLum]).toBeGreaterThan(0);
    }
  });

  it('should handle sampling rate', () => {
    const imageData = createMockImageData(100, 100);
    // Higher sample rate should still produce valid results
    const result = analyzeWaveform(imageData, 50, 4);

    expect(result.columns).toHaveLength(50);
    expect(result.columns[0].avg).toBeGreaterThanOrEqual(0);
    expect(result.columns[0].avg).toBeLessThanOrEqual(255);
  });
});

// =============================================================================
// Vectorscope Analysis Tests
// =============================================================================

describe('analyzeVectorscope', () => {
  it('should return grid with specified size', () => {
    const imageData = createMockImageData(10, 10);
    const result = analyzeVectorscope(imageData, 128);

    expect(result.grid).toHaveLength(128);
    expect(result.grid[0]).toHaveLength(128);
    expect(result.size).toBe(128);
  });

  it('should place neutral gray at center', () => {
    // Pure gray (128, 128, 128) should be at center of vectorscope
    const imageData = createMockImageData(10, 10, [128, 128, 128, 255]);
    const result = analyzeVectorscope(imageData, 256);

    const center = Math.floor(result.size / 2);
    // Check area around center has the counts
    let centerRegionCount = 0;
    for (let y = center - 5; y <= center + 5; y++) {
      for (let x = center - 5; x <= center + 5; x++) {
        centerRegionCount += result.grid[y]?.[x] ?? 0;
      }
    }
    expect(centerRegionCount).toBe(100); // All 100 pixels
  });

  it('should place saturated colors away from center', () => {
    // Pure red (255, 0, 0) should be away from center
    const redImage = createMockImageData(10, 10, [255, 0, 0, 255]);
    const result = analyzeVectorscope(redImage, 256);

    const center = Math.floor(result.size / 2);
    // Center should be empty for saturated colors
    expect(result.grid[center][center]).toBe(0);
    // Max intensity should be > 0 somewhere
    expect(result.maxIntensity).toBe(100);
  });

  it('should track maxIntensity', () => {
    const imageData = createMockImageData(10, 10, [200, 100, 50, 255]);
    const result = analyzeVectorscope(imageData);

    // All pixels at same color, so maxIntensity should equal pixel count
    expect(result.maxIntensity).toBe(100);
  });

  it('should handle sampling rate', () => {
    const imageData = createMockImageData(100, 100, [128, 128, 128, 255]);
    const result = analyzeVectorscope(imageData, 256, 2);

    // With sample rate 2, should have ~5000 samples instead of 10000
    let totalCount = 0;
    for (const row of result.grid) {
      for (const cell of row) {
        totalCount += cell;
      }
    }
    expect(totalCount).toBe(5000);
  });
});

// =============================================================================
// RGB Parade Analysis Tests
// =============================================================================

describe('analyzeRGBParade', () => {
  it('should return waveform data for each channel', () => {
    const imageData = createMockImageData(100, 50);
    const result = analyzeRGBParade(imageData, 50);

    expect(result.red.columns).toHaveLength(50);
    expect(result.green.columns).toHaveLength(50);
    expect(result.blue.columns).toHaveLength(50);
  });

  it('should separate color channels correctly', () => {
    // Create image with different values per channel
    const imageData = createMockImageData(10, 10, [255, 128, 64, 255]);
    const result = analyzeRGBParade(imageData, 5);

    // Each channel should show its specific value
    expect(result.red.columns[0].avg).toBe(255);
    expect(result.green.columns[0].avg).toBe(128);
    expect(result.blue.columns[0].avg).toBe(64);
  });

  it('should detect channel-specific gradients', () => {
    // Create horizontal gradient
    const imageData = createGradientImageData(100, 10, 'horizontal');
    const result = analyzeRGBParade(imageData, 10);

    // All channels should show gradient (since it's grayscale)
    expect(result.red.columns[0].avg).toBeLessThan(50);
    expect(result.red.columns[9].avg).toBeGreaterThan(200);
    expect(result.green.columns[0].avg).toBeLessThan(50);
    expect(result.blue.columns[0].avg).toBeLessThan(50);
  });

  it('should handle color regions', () => {
    // Create image with color regions
    const imageData = createColorRegionsImageData(100, 100);
    const result = analyzeRGBParade(imageData, 2);

    // Left side has red (top) and blue (bottom)
    // Red channel left side should have high values (from red region)
    // Blue channel left side should have high values (from blue region)
    expect(result.red.columns[0].max).toBe(255);
    expect(result.blue.columns[0].max).toBe(255);
  });
});

// =============================================================================
// Complete Frame Analysis Tests
// =============================================================================

describe('analyzeFrame', () => {
  it('should return complete analysis with all scope types', () => {
    const imageData = createMockImageData(100, 100);
    const result = analyzeFrame(imageData);

    expect(result.histogram).toBeDefined();
    expect(result.waveform).toBeDefined();
    expect(result.vectorscope).toBeDefined();
    expect(result.rgbParade).toBeDefined();
    expect(result.timestamp).toBeGreaterThan(0);
    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
  });

  it('should use provided options', () => {
    const imageData = createMockImageData(200, 200);
    const result = analyzeFrame(imageData, {
      waveformWidth: 100,
      vectorscopeSize: 128,
      sampleRate: 2,
    });

    expect(result.waveform.width).toBeLessThanOrEqual(100);
    expect(result.vectorscope.size).toBe(128);
  });

  it('should use default options when not specified', () => {
    const imageData = createMockImageData(500, 500);
    const result = analyzeFrame(imageData);

    expect(result.waveform.width).toBeLessThanOrEqual(256);
    expect(result.vectorscope.size).toBe(256);
  });
});

// =============================================================================
// Utility Function Tests
// =============================================================================

describe('createEmptyAnalysis', () => {
  it('should return valid empty analysis structure', () => {
    const result = createEmptyAnalysis();

    expect(result.histogram.red).toHaveLength(256);
    expect(result.histogram.green).toHaveLength(256);
    expect(result.histogram.blue).toHaveLength(256);
    expect(result.histogram.luminance).toHaveLength(256);
    expect(result.histogram.maxCount).toBe(0);
    expect(result.waveform.columns).toHaveLength(0);
    expect(result.vectorscope.grid).toHaveLength(0);
    expect(result.timestamp).toBe(0);
  });

  it('should have all histogram values as zero', () => {
    const result = createEmptyAnalysis();

    expect(result.histogram.red.every((v) => v === 0)).toBe(true);
    expect(result.histogram.luminance.every((v) => v === 0)).toBe(true);
  });
});

describe('normalizeHistogram', () => {
  it('should normalize values to 0-1 range', () => {
    const histogram = [0, 50, 100, 25, 0];
    const result = normalizeHistogram(histogram, 100);

    expect(result[0]).toBe(0);
    expect(result[1]).toBe(0.5);
    expect(result[2]).toBe(1);
    expect(result[3]).toBe(0.25);
    expect(result[4]).toBe(0);
  });

  it('should handle zero maxCount', () => {
    const histogram = [10, 20, 30];
    const result = normalizeHistogram(histogram, 0);

    expect(result.every((v) => v === 0)).toBe(true);
  });
});

describe('calculateExposureLevel', () => {
  it('should return 0 for balanced exposure (mid-gray)', () => {
    const histogram: HistogramData = {
      red: new Array(256).fill(0),
      green: new Array(256).fill(0),
      blue: new Array(256).fill(0),
      luminance: new Array(256).fill(0),
      maxCount: 100,
    };
    // All pixels at mid-gray (128)
    histogram.luminance[128] = 100;

    const result = calculateExposureLevel(histogram);
    expect(result).toBeCloseTo(0, 1);
  });

  it('should return negative for underexposed (dark) images', () => {
    const histogram: HistogramData = {
      red: new Array(256).fill(0),
      green: new Array(256).fill(0),
      blue: new Array(256).fill(0),
      luminance: new Array(256).fill(0),
      maxCount: 100,
    };
    // All pixels at dark value (32)
    histogram.luminance[32] = 100;

    const result = calculateExposureLevel(histogram);
    expect(result).toBeLessThan(-0.5);
  });

  it('should return positive for overexposed (bright) images', () => {
    const histogram: HistogramData = {
      red: new Array(256).fill(0),
      green: new Array(256).fill(0),
      blue: new Array(256).fill(0),
      luminance: new Array(256).fill(0),
      maxCount: 100,
    };
    // All pixels at bright value (224)
    histogram.luminance[224] = 100;

    const result = calculateExposureLevel(histogram);
    expect(result).toBeGreaterThan(0.5);
  });

  it('should handle empty histogram', () => {
    const histogram: HistogramData = {
      red: new Array(256).fill(0),
      green: new Array(256).fill(0),
      blue: new Array(256).fill(0),
      luminance: new Array(256).fill(0),
      maxCount: 0,
    };

    const result = calculateExposureLevel(histogram);
    expect(result).toBe(0);
  });
});
