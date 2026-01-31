/**
 * Video Scope Analysis Utilities
 *
 * Functions for analyzing video frame pixel data to generate:
 * - Histogram (RGB + Luminance distribution)
 * - Waveform (Luminance across horizontal axis)
 * - Vectorscope (Color hue/saturation in Cb/Cr space)
 * - RGB Parade (Per-channel waveforms)
 *
 * All analysis functions work with ImageData from canvas.getImageData().
 */

// =============================================================================
// Types
// =============================================================================

/** Histogram data for a single channel (256 values, 0-255 intensity) */
export type HistogramChannel = number[];

/** Complete histogram analysis result */
export interface HistogramData {
  red: HistogramChannel;
  green: HistogramChannel;
  blue: HistogramChannel;
  luminance: HistogramChannel;
  /** Maximum count across all channels (for normalization) */
  maxCount: number;
}

/** Waveform data - luminance values per column */
export interface WaveformData {
  /** Array of column data, each containing min/max luminance values */
  columns: WaveformColumn[];
  /** Target width of the waveform display */
  width: number;
}

/** Single column in waveform display */
export interface WaveformColumn {
  /** Minimum luminance value (0-255) */
  min: number;
  /** Maximum luminance value (0-255) */
  max: number;
  /** Average luminance value (0-255) */
  avg: number;
  /** Distribution of luminance values (sparse array) */
  distribution: number[];
}

/** Point in vectorscope (Cb/Cr color space) */
export interface VectorscopePoint {
  /** Cb (blue-difference chroma) - range: -0.5 to 0.5, mapped to 0-1 */
  cb: number;
  /** Cr (red-difference chroma) - range: -0.5 to 0.5, mapped to 0-1 */
  cr: number;
  /** Count of pixels at this location */
  count: number;
}

/** Vectorscope analysis result */
export interface VectorscopeData {
  /** 2D grid of point intensities (size x size) */
  grid: number[][];
  /** Grid size (typically 256 or 512) */
  size: number;
  /** Maximum intensity in grid (for normalization) */
  maxIntensity: number;
}

/** RGB Parade data - separate waveforms for each channel */
export interface RGBParadeData {
  red: WaveformData;
  green: WaveformData;
  blue: WaveformData;
}

/** Complete frame analysis result */
export interface FrameAnalysis {
  histogram: HistogramData;
  waveform: WaveformData;
  vectorscope: VectorscopeData;
  rgbParade: RGBParadeData;
  /** Analysis timestamp */
  timestamp: number;
  /** Source dimensions */
  width: number;
  height: number;
}

/** Analysis options */
export interface AnalysisOptions {
  /** Target width for waveform/parade (default: 256) */
  waveformWidth?: number;
  /** Vectorscope grid size (default: 256) */
  vectorscopeSize?: number;
  /** Sample rate for performance (1 = every pixel, 2 = every other, etc.) */
  sampleRate?: number;
}

// =============================================================================
// Constants
// =============================================================================

/** ITU-R BT.709 luminance coefficients */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/** Default analysis options */
const DEFAULT_OPTIONS: Required<AnalysisOptions> = {
  waveformWidth: 256,
  vectorscopeSize: 256,
  sampleRate: 1,
};

// =============================================================================
// Histogram Analysis
// =============================================================================

/**
 * Analyzes pixel data to generate histogram for all channels.
 *
 * @param imageData - ImageData from canvas.getImageData()
 * @param sampleRate - Sample every Nth pixel (default: 1)
 * @returns Histogram data with RGB and luminance channels
 */
export function analyzeHistogram(
  imageData: ImageData,
  sampleRate: number = 1
): HistogramData {
  const data = imageData.data;
  const red = new Array(256).fill(0);
  const green = new Array(256).fill(0);
  const blue = new Array(256).fill(0);
  const luminance = new Array(256).fill(0);

  // Sample pixels (RGBA = 4 bytes per pixel)
  const step = Math.max(1, Math.floor(sampleRate)) * 4;

  for (let i = 0; i < data.length; i += step) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Skip alpha (data[i + 3])

    // Increment channel counts
    red[r]++;
    green[g]++;
    blue[b]++;

    // Calculate luminance (ITU-R BT.709)
    const lum = Math.round(LUMA_R * r + LUMA_G * g + LUMA_B * b);
    luminance[Math.min(255, lum)]++;
  }

  // Find max count for normalization
  const maxCount = Math.max(
    ...red,
    ...green,
    ...blue,
    ...luminance
  );

  return { red, green, blue, luminance, maxCount };
}

// =============================================================================
// Waveform Analysis
// =============================================================================

/**
 * Analyzes pixel data to generate waveform (luminance per column).
 *
 * @param imageData - ImageData from canvas.getImageData()
 * @param targetWidth - Target width of waveform display
 * @param sampleRate - Sample every Nth row (default: 1)
 * @returns Waveform data with column luminance distributions
 */
export function analyzeWaveform(
  imageData: ImageData,
  targetWidth: number = 256,
  sampleRate: number = 1
): WaveformData {
  const { data, width, height } = imageData;
  const columns: WaveformColumn[] = [];

  // Calculate actual width and use floating-point scaling to cover entire image
  const actualWidth = Math.min(targetWidth, width);

  for (let col = 0; col < actualWidth; col++) {
    // Use floating-point scaling to ensure entire image width is covered evenly
    const startX = Math.floor((col * width) / actualWidth);
    const endX = Math.floor(((col + 1) * width) / actualWidth);

    let min = 255;
    let max = 0;
    let sum = 0;
    let count = 0;
    const distribution = new Array(256).fill(0);

    // Sample rows
    const rowStep = Math.max(1, Math.floor(sampleRate));

    for (let y = 0; y < height; y += rowStep) {
      for (let x = startX; x < endX; x++) {
        const i = (y * width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        // Calculate luminance
        const lum = Math.round(LUMA_R * r + LUMA_G * g + LUMA_B * b);
        const clampedLum = Math.min(255, Math.max(0, lum));

        min = Math.min(min, clampedLum);
        max = Math.max(max, clampedLum);
        sum += clampedLum;
        count++;
        distribution[clampedLum]++;
      }
    }

    columns.push({
      min: count > 0 ? min : 0,
      max: count > 0 ? max : 0,
      avg: count > 0 ? Math.round(sum / count) : 0,
      distribution,
    });
  }

  return { columns, width: actualWidth };
}

// =============================================================================
// Vectorscope Analysis
// =============================================================================

/**
 * Converts RGB to YCbCr color space.
 *
 * Uses ITU-R BT.709 conversion matrix.
 *
 * @returns Object with Y (luminance), Cb (blue-diff), Cr (red-diff)
 */
function rgbToYCbCr(r: number, g: number, b: number): { y: number; cb: number; cr: number } {
  // Normalize to 0-1 range
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;

  // BT.709 conversion
  const y = LUMA_R * rn + LUMA_G * gn + LUMA_B * bn;
  const cb = (bn - y) / 1.8556; // Range: -0.5 to 0.5
  const cr = (rn - y) / 1.5748; // Range: -0.5 to 0.5

  return { y, cb, cr };
}

/**
 * Analyzes pixel data to generate vectorscope (Cb/Cr color plot).
 *
 * @param imageData - ImageData from canvas.getImageData()
 * @param gridSize - Size of the vectorscope grid (default: 256)
 * @param sampleRate - Sample every Nth pixel (default: 1)
 * @returns Vectorscope data with intensity grid
 */
export function analyzeVectorscope(
  imageData: ImageData,
  gridSize: number = 256,
  sampleRate: number = 1
): VectorscopeData {
  const data = imageData.data;

  // Initialize 2D grid
  const grid: number[][] = Array(gridSize)
    .fill(null)
    .map(() => new Array(gridSize).fill(0));

  let maxIntensity = 0;

  // Sample pixels
  const step = Math.max(1, Math.floor(sampleRate)) * 4;

  for (let i = 0; i < data.length; i += step) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Convert to YCbCr
    const { cb, cr } = rgbToYCbCr(r, g, b);

    // Map Cb/Cr (-0.5 to 0.5) to grid coordinates (0 to gridSize-1)
    // Cb is horizontal (x), Cr is vertical (y, inverted)
    const gridX = Math.floor((cb + 0.5) * (gridSize - 1));
    const gridY = Math.floor((0.5 - cr) * (gridSize - 1));

    // Clamp to valid range
    const x = Math.max(0, Math.min(gridSize - 1, gridX));
    const y = Math.max(0, Math.min(gridSize - 1, gridY));

    grid[y][x]++;
    maxIntensity = Math.max(maxIntensity, grid[y][x]);
  }

  return { grid, size: gridSize, maxIntensity };
}

// =============================================================================
// RGB Parade Analysis
// =============================================================================

/**
 * Analyzes a single color channel to generate waveform data.
 *
 * @param imageData - ImageData from canvas.getImageData()
 * @param channelOffset - Offset in RGBA (0=R, 1=G, 2=B)
 * @param targetWidth - Target width of waveform display
 * @param sampleRate - Sample every Nth row (default: 1)
 * @returns Waveform data for the specified channel
 */
function analyzeChannelWaveform(
  imageData: ImageData,
  channelOffset: number,
  targetWidth: number = 256,
  sampleRate: number = 1
): WaveformData {
  const { data, width, height } = imageData;
  const columns: WaveformColumn[] = [];

  // Calculate actual width and use floating-point scaling to cover entire image
  const actualWidth = Math.min(targetWidth, width);

  for (let col = 0; col < actualWidth; col++) {
    // Use floating-point scaling to ensure entire image width is covered evenly
    const startX = Math.floor((col * width) / actualWidth);
    const endX = Math.floor(((col + 1) * width) / actualWidth);

    let min = 255;
    let max = 0;
    let sum = 0;
    let count = 0;
    const distribution = new Array(256).fill(0);

    const rowStep = Math.max(1, Math.floor(sampleRate));

    for (let y = 0; y < height; y += rowStep) {
      for (let x = startX; x < endX; x++) {
        const i = (y * width + x) * 4 + channelOffset;
        const value = data[i];

        min = Math.min(min, value);
        max = Math.max(max, value);
        sum += value;
        count++;
        distribution[value]++;
      }
    }

    columns.push({
      min: count > 0 ? min : 0,
      max: count > 0 ? max : 0,
      avg: count > 0 ? Math.round(sum / count) : 0,
      distribution,
    });
  }

  return { columns, width: actualWidth };
}

/**
 * Analyzes pixel data to generate RGB Parade (separate channel waveforms).
 *
 * @param imageData - ImageData from canvas.getImageData()
 * @param targetWidth - Target width of each parade section
 * @param sampleRate - Sample every Nth row (default: 1)
 * @returns RGB Parade data with separate waveforms per channel
 */
export function analyzeRGBParade(
  imageData: ImageData,
  targetWidth: number = 256,
  sampleRate: number = 1
): RGBParadeData {
  return {
    red: analyzeChannelWaveform(imageData, 0, targetWidth, sampleRate),
    green: analyzeChannelWaveform(imageData, 1, targetWidth, sampleRate),
    blue: analyzeChannelWaveform(imageData, 2, targetWidth, sampleRate),
  };
}

// =============================================================================
// Complete Frame Analysis
// =============================================================================

/**
 * Performs complete frame analysis including all scope types.
 *
 * @param imageData - ImageData from canvas.getImageData()
 * @param options - Analysis options
 * @returns Complete frame analysis with all scope data
 */
export function analyzeFrame(
  imageData: ImageData,
  options: AnalysisOptions = {}
): FrameAnalysis {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  return {
    histogram: analyzeHistogram(imageData, opts.sampleRate),
    waveform: analyzeWaveform(imageData, opts.waveformWidth, opts.sampleRate),
    vectorscope: analyzeVectorscope(imageData, opts.vectorscopeSize, opts.sampleRate),
    rgbParade: analyzeRGBParade(imageData, opts.waveformWidth, opts.sampleRate),
    timestamp: Date.now(),
    width: imageData.width,
    height: imageData.height,
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Creates empty/default analysis data (for initial state).
 */
export function createEmptyAnalysis(): FrameAnalysis {
  const emptyHistogram: HistogramData = {
    red: new Array(256).fill(0),
    green: new Array(256).fill(0),
    blue: new Array(256).fill(0),
    luminance: new Array(256).fill(0),
    maxCount: 0,
  };

  const emptyWaveform: WaveformData = {
    columns: [],
    width: 0,
  };

  const emptyVectorscope: VectorscopeData = {
    grid: [],
    size: 0,
    maxIntensity: 0,
  };

  return {
    histogram: emptyHistogram,
    waveform: emptyWaveform,
    vectorscope: emptyVectorscope,
    rgbParade: { red: emptyWaveform, green: emptyWaveform, blue: emptyWaveform },
    timestamp: 0,
    width: 0,
    height: 0,
  };
}

/**
 * Normalizes histogram values to 0-1 range.
 */
export function normalizeHistogram(histogram: HistogramChannel, maxCount: number): number[] {
  if (maxCount === 0) return histogram.map(() => 0);
  return histogram.map((count) => count / maxCount);
}

/**
 * Calculates the exposure level from histogram data.
 * Returns a value from -1 (underexposed) to 1 (overexposed), 0 = balanced.
 */
export function calculateExposureLevel(histogram: HistogramData): number {
  const { luminance, maxCount } = histogram;
  if (maxCount === 0) return 0;

  // Calculate weighted average position
  let totalWeight = 0;
  let weightedSum = 0;

  for (let i = 0; i < 256; i++) {
    totalWeight += luminance[i];
    weightedSum += luminance[i] * i;
  }

  if (totalWeight === 0) return 0;

  // Average luminance (0-255) -> normalized to -1 to 1
  const avgLuminance = weightedSum / totalWeight;
  return (avgLuminance - 128) / 128;
}
