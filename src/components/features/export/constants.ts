/**
 * Export Constants
 *
 * Centralized constants for export dialog component.
 */

import type {
  AudioExportFormat,
  AudioFormatOption,
  ExportPreset,
  TimelineExportFormat,
  TimelineFormatOption,
} from './types';
import type { VideoExportRequest } from '@/bindings';

// =============================================================================
// Export Presets
// =============================================================================

/** Available export presets */
export const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: 'youtube_1080p',
    name: 'MP4 Standard',
    description: 'H.264, 1080p, balanced delivery',
    icon: 'monitor',
    settings: {
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      qualityTier: 'standard',
      width: 1920,
      height: 1080,
      fps: 30,
      videoBitrate: '8M',
      audioBitrate: '192k',
      crf: 23,
      twoPass: false,
    },
  },
  {
    id: 'mp4_draft',
    name: 'MP4 Draft',
    description: 'H.264, 720p, small review file',
    icon: 'monitor',
    settings: {
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      qualityTier: 'draft',
      width: 1280,
      height: 720,
      fps: 30,
      videoBitrate: '3M',
      audioBitrate: '128k',
      crf: 28,
      twoPass: false,
    },
  },
  {
    id: 'mp4_high',
    name: 'MP4 High',
    description: 'H.264, 1080p, higher quality',
    icon: 'monitor',
    settings: {
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      qualityTier: 'high',
      width: 1920,
      height: 1080,
      fps: 30,
      videoBitrate: '15M',
      audioBitrate: '320k',
      crf: 18,
      twoPass: false,
    },
  },
  {
    id: 'youtube_4k',
    name: 'MP4 4K High',
    description: 'H.264, 2160p, high bitrate',
    icon: 'monitor',
    settings: {
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      qualityTier: 'high',
      width: 3840,
      height: 2160,
      fps: 30,
      videoBitrate: '35M',
      audioBitrate: '320k',
      crf: 18,
      twoPass: false,
    },
  },
  {
    id: 'youtube_shorts',
    name: 'Shorts/Reels',
    description: 'H.264, vertical 1080x1920',
    icon: 'smartphone',
    settings: {
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      qualityTier: 'standard',
      width: 1080,
      height: 1920,
      fps: 30,
      videoBitrate: '8M',
      audioBitrate: '192k',
      crf: 23,
      twoPass: false,
    },
  },
  {
    id: 'twitter',
    name: 'Twitter/X',
    description: 'H.264, 1280x720, 5Mbps',
    icon: 'globe',
    settings: {
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      qualityTier: 'draft',
      width: 1280,
      height: 720,
      fps: 30,
      videoBitrate: '5M',
      audioBitrate: '128k',
      crf: 24,
      twoPass: false,
    },
  },
  {
    id: 'instagram',
    name: 'Instagram',
    description: 'H.264, square 1080x1080',
    icon: 'smartphone',
    settings: {
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      qualityTier: 'standard',
      width: 1080,
      height: 1080,
      fps: 30,
      videoBitrate: '6M',
      audioBitrate: '128k',
      crf: 23,
      twoPass: false,
    },
  },
  {
    id: 'webm_vp9',
    name: 'WebM VP9',
    description: 'VP9/Opus, High quality',
    icon: 'globe',
    settings: {
      container: 'webm',
      videoCodec: 'vp9',
      audioCodec: 'opus',
      qualityTier: 'high',
      width: 1920,
      height: 1080,
      fps: 30,
      videoBitrate: '6M',
      audioBitrate: '128k',
      crf: 31,
      twoPass: false,
    },
  },
  {
    id: 'prores',
    name: 'MOV Master',
    description: 'ProRes 422, PCM audio',
    icon: 'film',
    settings: {
      container: 'mov',
      videoCodec: 'prores',
      audioCodec: 'pcm',
      qualityTier: 'master',
      width: null,
      height: null,
      fps: null,
      videoBitrate: null,
      audioBitrate: null,
      crf: null,
      twoPass: false,
    },
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

/** Editable timeline export formats */
export const TIMELINE_EXPORT_FORMATS: TimelineFormatOption[] = [
  {
    id: 'fcpxml',
    name: 'FCPXML',
    description: 'Editable timeline for FCP/Resolve',
    icon: 'film',
  },
  {
    id: 'edl',
    name: 'EDL',
    description: 'CMX 3600 edit decision list',
    icon: 'film',
  },
];

/** Map of audio formats to file extensions */
export const AUDIO_FORMAT_EXTENSIONS: Record<AudioExportFormat, string> = {
  wav: 'wav',
  mp3: 'mp3',
  m4a: 'm4a',
  flac: 'flac',
  ogg: 'ogg',
};

/** Map of editable timeline formats to file extensions */
export const TIMELINE_FORMAT_EXTENSIONS: Record<TimelineExportFormat, string> = {
  edl: 'edl',
  fcpxml: 'fcpxml',
};

/**
 * Get file extension for a preset ID.
 * @param presetId - The preset ID
 * @returns The file extension for the preset container
 * @throws Error when the preset ID is unknown
 */
export function getPresetExtension(presetId: string): string {
  return getExportPreset(presetId).settings.container;
}

/** Get file extension for an audio export format. */
export function getAudioFormatExtension(format: AudioExportFormat): string {
  return AUDIO_FORMAT_EXTENSIONS[format] || 'wav';
}

/** Get file extension for an editable timeline format. */
export function getTimelineFormatExtension(format: TimelineExportFormat): string {
  return TIMELINE_FORMAT_EXTENSIONS[format] || 'fcpxml';
}

/** Look up the metadata for an audio export format. */
export function getAudioFormatOption(format: AudioExportFormat): AudioFormatOption {
  return AUDIO_EXPORT_FORMATS.find((option) => option.id === format) ?? AUDIO_EXPORT_FORMATS[0];
}

/** Look up the metadata for a video export preset. */
export function getExportPreset(presetId: string): ExportPreset {
  const preset = EXPORT_PRESETS.find((option) => option.id === presetId);
  if (!preset) {
    throw new Error(`Unknown export preset: ${presetId}`);
  }
  return preset;
}

/** Return a fresh request object for the selected video export preset. */
export function getVideoExportRequest(presetId: string): VideoExportRequest {
  const preset = getExportPreset(presetId);
  return { ...preset.settings };
}

/** Look up the metadata for an editable timeline export format. */
export function getTimelineFormatOption(format: TimelineExportFormat): TimelineFormatOption {
  return (
    TIMELINE_EXPORT_FORMATS.find((option) => option.id === format) ?? TIMELINE_EXPORT_FORMATS[0]
  );
}
