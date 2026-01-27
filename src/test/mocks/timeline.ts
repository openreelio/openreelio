/**
 * Timeline Mock Factories
 *
 * Provides consistent, typed mock factories for timeline-related entities.
 * Used across multiple test files to reduce duplication and ensure consistency.
 */

import type {
  Track,
  Clip,
  Sequence,
  Asset,
  SequenceFormat,
  Marker,
} from '@/types';

// =============================================================================
// Track Mocks
// =============================================================================

/**
 * Default values for Track creation
 */
const trackDefaults: Omit<Track, 'id'> = {
  name: 'Video 1',
  kind: 'video',
  clips: [],
  blendMode: 'normal',
  muted: false,
  locked: false,
  visible: true,
  volume: 1.0,
};

/**
 * Creates a mock Track with optional overrides.
 *
 * @param overrides - Partial Track properties to override defaults
 * @returns A complete Track object
 *
 * @example
 * const track = createMockTrack({ name: 'Audio Track', kind: 'audio' });
 */
export function createMockTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: overrides.id ?? `track_${Math.random().toString(36).substring(7)}`,
    ...trackDefaults,
    ...overrides,
  };
}

/**
 * Creates a mock Track with a specific kind.
 * Convenience helper for common track types.
 */
export function createMockVideoTrack(overrides: Partial<Track> = {}): Track {
  return createMockTrack({ kind: 'video', name: 'Video Track', ...overrides });
}

export function createMockAudioTrack(overrides: Partial<Track> = {}): Track {
  return createMockTrack({ kind: 'audio', name: 'Audio Track', ...overrides });
}

// =============================================================================
// Clip Mocks
// =============================================================================

/**
 * Default values for Clip creation
 */
const clipDefaults: Omit<Clip, 'id'> = {
  assetId: 'asset_001',
  range: {
    sourceInSec: 0,
    sourceOutSec: 10,
  },
  place: {
    timelineInSec: 0,
    durationSec: 10,
  },
  transform: {
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotationDeg: 0,
    anchor: { x: 0.5, y: 0.5 },
  },
  audio: {
    volumeDb: 0,
    pan: 0,
    muted: false,
  },
  speed: 1,
  opacity: 1,
  effects: [],
  label: undefined,
  color: undefined,
};

/**
 * Creates a mock Clip with optional overrides.
 *
 * @param overrides - Partial Clip properties to override defaults
 * @returns A complete Clip object
 *
 * @example
 * const clip = createMockClip({ assetId: 'asset_002', place: { timelineInSec: 5, durationSec: 15 } });
 */
export function createMockClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: overrides.id ?? `clip_${Math.random().toString(36).substring(7)}`,
    ...clipDefaults,
    ...overrides,
    // Deep merge nested objects
    range: { ...clipDefaults.range, ...overrides.range },
    place: { ...clipDefaults.place, ...overrides.place },
    transform: { ...clipDefaults.transform, ...overrides.transform },
    audio: { ...clipDefaults.audio, ...overrides.audio },
  };
}

/**
 * Creates multiple mock clips with sequential timeline positions.
 *
 * @param count - Number of clips to create
 * @param options - Options for clip generation
 * @returns Array of Clip objects
 */
export function createMockClips(
  count: number,
  options: { startTime?: number; clipDuration?: number; gap?: number } = {},
): Clip[] {
  const { startTime = 0, clipDuration = 10, gap = 0 } = options;
  const clips: Clip[] = [];

  for (let i = 0; i < count; i++) {
    const timelineIn = startTime + i * (clipDuration + gap);
    clips.push(
      createMockClip({
        id: `clip_${i + 1}`,
        place: {
          timelineInSec: timelineIn,
          durationSec: clipDuration,
        },
      }),
    );
  }

  return clips;
}

// =============================================================================
// Sequence Mocks
// =============================================================================

/**
 * Default sequence format (1080p, 30fps)
 */
const defaultFormat: SequenceFormat = {
  canvas: { width: 1920, height: 1080 },
  fps: { num: 30, den: 1 },
  audioSampleRate: 48000,
  audioChannels: 2,
};

/**
 * Default values for Sequence creation
 */
const sequenceDefaults: Omit<Sequence, 'id'> = {
  name: 'Main Sequence',
  format: defaultFormat,
  tracks: [],
  markers: [],
};

/**
 * Creates a mock Sequence with optional overrides.
 *
 * @param overrides - Partial Sequence properties to override defaults
 * @returns A complete Sequence object
 *
 * @example
 * const seq = createMockSequence({ name: 'Intro', tracks: [videoTrack, audioTrack] });
 */
export function createMockSequence(overrides: Partial<Sequence> = {}): Sequence {
  return {
    id: overrides.id ?? `seq_${Math.random().toString(36).substring(7)}`,
    ...sequenceDefaults,
    ...overrides,
    format: { ...sequenceDefaults.format, ...overrides.format },
  };
}

/**
 * Creates a mock Sequence with default video and audio tracks.
 *
 * @param trackCount - Number of track pairs (video + audio) to create
 * @param overrides - Partial Sequence properties to override
 * @returns Sequence with tracks
 */
export function createMockSequenceWithTracks(
  trackCount = 1,
  overrides: Partial<Sequence> = {},
): Sequence {
  const tracks: Track[] = [];

  for (let i = 0; i < trackCount; i++) {
    tracks.push(createMockVideoTrack({ id: `video_track_${i + 1}`, name: `Video ${i + 1}` }));
    tracks.push(createMockAudioTrack({ id: `audio_track_${i + 1}`, name: `Audio ${i + 1}` }));
  }

  return createMockSequence({ tracks, ...overrides });
}

// =============================================================================
// Asset Mocks
// =============================================================================

/**
 * Default values for Asset creation
 * Note: importedAt is set dynamically in createMockAsset to ensure fresh timestamps
 */
const assetDefaults: Omit<Asset, 'id' | 'importedAt'> = {
  name: 'video.mp4',
  uri: '/path/to/video.mp4',
  kind: 'video',
  hash: 'abc123def456',
  fileSize: 1024000,
  durationSec: 60,
  thumbnailUrl: undefined,
  proxyUrl: undefined,
  proxyStatus: 'notNeeded',
  license: {
    source: 'user',
    licenseType: 'unknown',
    allowedUse: [],
  },
  tags: [],
};

/**
 * Creates a mock Asset with optional overrides.
 *
 * @param overrides - Partial Asset properties to override defaults
 * @returns A complete Asset object
 *
 * @example
 * const asset = createMockAsset({ name: 'clip.mp4', durationSec: 30 });
 */
export function createMockAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: overrides.id ?? `asset_${Math.random().toString(36).substring(7)}`,
    ...assetDefaults,
    // Generate fresh timestamp for each mock to avoid test flakiness
    importedAt: overrides.importedAt ?? new Date().toISOString(),
    ...overrides,
    license: { ...assetDefaults.license, ...overrides.license },
  };
}

/**
 * Creates a mock video asset with video info.
 */
export function createMockVideoAsset(overrides: Partial<Asset> = {}): Asset {
  return createMockAsset({
    kind: 'video',
    video: {
      width: 1920,
      height: 1080,
      fps: { num: 30, den: 1 },
      codec: 'h264',
      hasAlpha: false,
    },
    ...overrides,
  });
}

/**
 * Creates a mock audio asset with audio info.
 */
export function createMockAudioAsset(overrides: Partial<Asset> = {}): Asset {
  return createMockAsset({
    kind: 'audio',
    name: 'audio.mp3',
    uri: '/path/to/audio.mp3',
    audio: {
      sampleRate: 48000,
      channels: 2,
      codec: 'mp3',
    },
    ...overrides,
  });
}

// =============================================================================
// Marker Mocks
// =============================================================================

/**
 * Creates a mock Marker with optional overrides.
 */
export function createMockMarker(overrides: Partial<Marker> = {}): Marker {
  return {
    id: overrides.id ?? `marker_${Math.random().toString(36).substring(7)}`,
    timeSec: 0,
    label: 'Marker',
    color: { r: 255, g: 0, b: 0 },
    markerType: 'generic',
    ...overrides,
  };
}
