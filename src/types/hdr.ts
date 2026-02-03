/**
 * HDR (High Dynamic Range) Types
 *
 * Types for HDR workflow support including color spaces,
 * transfer functions, and tonemapping.
 */

// =============================================================================
// Color Primaries
// =============================================================================

/** Color primaries (gamut definition) */
export type ColorPrimaries =
  | 'bt709' // Standard HD (sRGB)
  | 'bt2020' // Ultra HD / HDR (wide gamut)
  | 'dci_p3' // Digital Cinema
  | 'display_p3'; // Apple displays

/** Check if primaries are wide gamut */
export function isWideGamut(primaries: ColorPrimaries): boolean {
  return primaries !== 'bt709';
}

// =============================================================================
// Transfer Characteristics
// =============================================================================

/** Transfer characteristics (gamma/EOTF) */
export type TransferCharacteristics =
  | 'srgb' // Standard sRGB gamma
  | 'bt709' // BT.709 gamma
  | 'pq' // Perceptual Quantizer (HDR10/Dolby Vision)
  | 'hlg' // Hybrid Log-Gamma (Broadcast HDR)
  | 'linear'; // Linear light

/** Check if transfer function is HDR */
export function isHdrTransfer(transfer: TransferCharacteristics): boolean {
  return transfer === 'pq' || transfer === 'hlg';
}

/** Get max luminance for transfer function (nits) */
export function getMaxLuminance(transfer: TransferCharacteristics): number {
  switch (transfer) {
    case 'pq':
      return 10000;
    case 'hlg':
      return 1000;
    default:
      return 100;
  }
}

// =============================================================================
// Color Space
// =============================================================================

/** Complete color space definition */
export interface ColorSpace {
  primaries: ColorPrimaries;
  transfer: TransferCharacteristics;
}

/** Preset color spaces */
export const COLOR_SPACE_PRESETS = {
  sdr: { primaries: 'bt709', transfer: 'srgb' } as ColorSpace,
  hdr10: { primaries: 'bt2020', transfer: 'pq' } as ColorSpace,
  hlg: { primaries: 'bt2020', transfer: 'hlg' } as ColorSpace,
  display_p3: { primaries: 'display_p3', transfer: 'srgb' } as ColorSpace,
} as const;

// =============================================================================
// HDR Metadata
// =============================================================================

/** Mastering display info (SMPTE ST 2086) */
export interface MasteringDisplayInfo {
  redX: number;
  redY: number;
  greenX: number;
  greenY: number;
  blueX: number;
  blueY: number;
  whiteX: number;
  whiteY: number;
  maxLuminance: number; // Peak luminance in nits
  minLuminance: number; // Min luminance in nits
}

/** HDR metadata for content */
export interface HdrMetadata {
  colorSpace: ColorSpace;
  maxCll?: number; // Max Content Light Level (nits)
  maxFall?: number; // Max Frame-Average Light Level (nits)
  masteringDisplay?: MasteringDisplayInfo;
}

/** Check if metadata indicates HDR content */
export function isHdrContent(metadata: HdrMetadata): boolean {
  return isHdrTransfer(metadata.colorSpace.transfer);
}

// =============================================================================
// Tonemapping
// =============================================================================

/** Tonemapping algorithm mode */
export type TonemapMode =
  | 'none' // No tonemapping (direct clip)
  | 'reinhard' // Reinhard global operator (fast, preview)
  | 'hable' // Filmic curve (cinematic)
  | 'mobius' // Smooth rolloff
  | 'bt2390'; // BT.2390 EETF (broadcast standard)

/** Tonemapping parameters */
export interface TonemapParams {
  mode: TonemapMode;
  targetPeak: number; // Target peak luminance (typically 100 nits for SDR)
  desat: number; // Desaturation strength (0.0-1.0)
}

/** Preset tonemapping configurations */
export const TONEMAP_PRESETS = {
  preview: { mode: 'reinhard', targetPeak: 100, desat: 0.5 } as TonemapParams,
  high_quality: { mode: 'bt2390', targetPeak: 100, desat: 0.75 } as TonemapParams,
  filmic: { mode: 'hable', targetPeak: 100, desat: 0.9 } as TonemapParams,
} as const;

// =============================================================================
// HDR Detection
// =============================================================================

/** Detected HDR information from media */
export interface DetectedHdrInfo {
  isHdr: boolean;
  primaries?: ColorPrimaries;
  transfer?: TransferCharacteristics;
  bitDepth?: number;
  maxCll?: number;
  maxFall?: number;
  formatName: string; // "SDR", "HDR10", "HLG", "Dolby Vision"
}

/** Default SDR detection result */
export const SDR_DETECTION: DetectedHdrInfo = {
  isHdr: false,
  formatName: 'SDR',
};

/** Get display-friendly HDR format name */
export function getHdrFormatDisplay(info: DetectedHdrInfo): string {
  if (!info.isHdr) return 'SDR';
  if (info.transfer === 'pq') {
    return info.maxCll ? `HDR10 (${info.maxCll} nits)` : 'HDR10';
  }
  if (info.transfer === 'hlg') return 'HLG';
  return info.formatName;
}

// =============================================================================
// Export Settings
// =============================================================================

/** HDR mode for export */
export type HdrMode = 'sdr' | 'hdr10' | 'hlg';

/** HDR export settings */
export interface HdrExportSettings {
  hdrMode: HdrMode;
  maxCll?: number; // 1-10000 nits
  maxFall?: number; // 1-10000 nits
  bitDepth: 8 | 10 | 12;
}

/** Default HDR export settings */
export const DEFAULT_HDR_EXPORT: HdrExportSettings = {
  hdrMode: 'sdr',
  bitDepth: 8,
};

/** HDR10 preset */
export const HDR10_EXPORT_PRESET: HdrExportSettings = {
  hdrMode: 'hdr10',
  maxCll: 1000,
  maxFall: 400,
  bitDepth: 10,
};

/** Validate HDR export settings */
export function validateHdrExportSettings(
  settings: HdrExportSettings,
  codec: string
): string | null {
  if (settings.hdrMode !== 'sdr') {
    // HDR requires H.265
    if (codec.toLowerCase() !== 'h265' && codec.toLowerCase() !== 'hevc') {
      return 'HDR export requires H.265 (HEVC) codec. H.264 does not support HDR metadata.';
    }
    // Recommend 10-bit for HDR
    if (settings.bitDepth < 10) {
      return 'HDR content typically requires 10-bit or higher color depth.';
    }
  }
  return null;
}
