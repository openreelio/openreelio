/**
 * Export Constants
 *
 * Centralized constants for export dialog component.
 */

import type { ExportPreset } from './types';

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

/**
 * Get file extension for a preset ID.
 * @param presetId - The preset ID
 * @returns The file extension (default: 'mp4')
 */
export function getPresetExtension(presetId: string): string {
  return PRESET_EXTENSIONS[presetId] || 'mp4';
}
