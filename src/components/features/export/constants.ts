/**
 * Export Constants
 *
 * Centralized constants for export dialog component.
 */

import type { AudioExportFormat, AudioFormatOption, ExportPreset } from './types';

// =============================================================================
// Export Presets
// =============================================================================

/** Available export presets */
export const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: 'youtube_1080p',
    name: 'YouTube 1080p',
    description: 'H.264, 1920x1080, 8Mbps',
    icon: 'monitor',
  },
  {
    id: 'youtube_4k',
    name: 'YouTube 4K',
    description: 'H.264, 3840x2160, 35Mbps',
    icon: 'monitor',
  },
  {
    id: 'youtube_shorts',
    name: 'Shorts/Reels',
    description: 'Vertical 1080x1920',
    icon: 'smartphone',
  },
  {
    id: 'twitter',
    name: 'Twitter/X',
    description: 'H.264, 1280x720, 5Mbps',
    icon: 'globe',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    description: 'Square 1080x1080',
    icon: 'smartphone',
  },
  {
    id: 'webm_vp9',
    name: 'WebM VP9',
    description: 'VP9/Opus, High quality',
    icon: 'globe',
  },
  {
    id: 'prores',
    name: 'ProRes',
    description: 'Apple ProRes 422',
    icon: 'film',
  },
];

/** Available audio export formats */
export const AUDIO_EXPORT_FORMATS: AudioFormatOption[] = [
  {
    id: 'wav',
    name: 'WAV Audio',
    description: 'PCM, uncompressed master',
    icon: 'audio',
  },
  {
    id: 'mp3',
    name: 'MP3 Audio',
    description: 'Widely compatible lossy export',
    icon: 'audio',
  },
  {
    id: 'm4a',
    name: 'M4A Audio',
    description: 'AAC, compact modern delivery',
    icon: 'audio',
  },
  {
    id: 'flac',
    name: 'FLAC Audio',
    description: 'Lossless compressed archive',
    icon: 'audio',
  },
  {
    id: 'ogg',
    name: 'Ogg Audio',
    description: 'Opus, efficient open delivery',
    icon: 'audio',
  },
];

// =============================================================================
// Preset ID to File Extension Mapping
// =============================================================================

/** Map of preset IDs to file extensions */
export const PRESET_EXTENSIONS: Record<string, string> = {
  youtube_1080p: 'mp4',
  youtube_4k: 'mp4',
  youtube_shorts: 'mp4',
  twitter: 'mp4',
  instagram: 'mp4',
  webm_vp9: 'webm',
  prores: 'mov',
};

/** Map of audio formats to file extensions */
export const AUDIO_FORMAT_EXTENSIONS: Record<AudioExportFormat, string> = {
  wav: 'wav',
  mp3: 'mp3',
  m4a: 'm4a',
  flac: 'flac',
  ogg: 'ogg',
};

/**
 * Get file extension for a preset ID.
 * @param presetId - The preset ID
 * @returns The file extension (default: 'mp4')
 */
export function getPresetExtension(presetId: string): string {
  return PRESET_EXTENSIONS[presetId] || 'mp4';
}

/** Get file extension for an audio export format. */
export function getAudioFormatExtension(format: AudioExportFormat): string {
  return AUDIO_FORMAT_EXTENSIONS[format] || 'wav';
}

/** Look up the metadata for an audio export format. */
export function getAudioFormatOption(format: AudioExportFormat): AudioFormatOption {
  return AUDIO_EXPORT_FORMATS.find((option) => option.id === format) ?? AUDIO_EXPORT_FORMATS[0];
}
