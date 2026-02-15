/**
 * Drop Validity Utilities Tests
 */

import { describe, it, expect } from 'vitest';
import {
  validateDrop,
  checkClipOverlap,
  isAssetCompatibleWithTrack,
  getTrackTypeMismatchMessage,
  validDrop,
  invalidDrop,
  type DropValidationContext,
} from './dropValidity';
import type { Track, Clip } from '@/types';

// =============================================================================
// Test Helpers
// =============================================================================

function createTestTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 'track-1',
    name: 'Video 1',
    kind: 'video',
    clips: [],
    blendMode: 'normal',
    muted: false,
    visible: true,
    locked: false,
    volume: 1,
    ...overrides,
  };
}

function createTestClip(
  id: string,
  timelineIn: number,
  sourceIn: number,
  sourceOut: number,
  overrides: Partial<Clip> = {},
): Clip {
  return {
    id,
    assetId: 'asset-1',
    label: 'Test Clip',
    range: { sourceInSec: sourceIn, sourceOutSec: sourceOut },
    place: { timelineInSec: timelineIn, durationSec: sourceOut - sourceIn },
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    },
    speed: 1,
    opacity: 1,
    effects: [],
    audio: { volumeDb: 0, pan: 0, muted: false },
    ...overrides,
  };
}

// =============================================================================
// Tests: Track Type Compatibility
// =============================================================================

describe('isAssetCompatibleWithTrack', () => {
  describe('video assets', () => {
    it('should be compatible with video tracks', () => {
      expect(isAssetCompatibleWithTrack('video', 'video')).toBe(true);
    });

    it('should be compatible with overlay tracks', () => {
      expect(isAssetCompatibleWithTrack('video', 'overlay')).toBe(true);
    });

    it('should be compatible with audio tracks for audio-component workflows', () => {
      expect(isAssetCompatibleWithTrack('video', 'audio')).toBe(true);
    });

    it('should not be compatible with caption tracks', () => {
      expect(isAssetCompatibleWithTrack('video', 'caption')).toBe(false);
    });
  });

  describe('audio assets', () => {
    it('should be compatible with audio tracks', () => {
      expect(isAssetCompatibleWithTrack('audio', 'audio')).toBe(true);
    });

    it('should be compatible with video tracks (for video with audio)', () => {
      expect(isAssetCompatibleWithTrack('audio', 'video')).toBe(true);
    });

    it('should not be compatible with overlay tracks', () => {
      expect(isAssetCompatibleWithTrack('audio', 'overlay')).toBe(false);
    });
  });

  describe('image assets', () => {
    it('should be compatible with video tracks', () => {
      expect(isAssetCompatibleWithTrack('image', 'video')).toBe(true);
    });

    it('should be compatible with overlay tracks', () => {
      expect(isAssetCompatibleWithTrack('image', 'overlay')).toBe(true);
    });

    it('should not be compatible with audio tracks', () => {
      expect(isAssetCompatibleWithTrack('image', 'audio')).toBe(false);
    });
  });

  describe('subtitle assets', () => {
    it('should be compatible with caption tracks', () => {
      expect(isAssetCompatibleWithTrack('subtitle', 'caption')).toBe(true);
    });

    it('should not be compatible with video tracks', () => {
      expect(isAssetCompatibleWithTrack('subtitle', 'video')).toBe(false);
    });
  });

  describe('undefined asset', () => {
    it('should be compatible with any track when undefined', () => {
      expect(isAssetCompatibleWithTrack(undefined, 'video')).toBe(true);
      expect(isAssetCompatibleWithTrack(undefined, 'audio')).toBe(true);
    });
  });
});

describe('getTrackTypeMismatchMessage', () => {
  it('should return user-friendly message for audio on video track', () => {
    const message = getTrackTypeMismatchMessage('audio', 'video');
    expect(message).toContain('audio');
    expect(message).toContain('video');
  });

  it('should return user-friendly message for video on audio track', () => {
    const message = getTrackTypeMismatchMessage('video', 'audio');
    expect(message).toContain('video');
    expect(message).toContain('audio');
  });
});

// =============================================================================
// Tests: Overlap Detection
// =============================================================================

describe('checkClipOverlap', () => {
  const clips = [
    createTestClip('clip-1', 0, 0, 10), // 0-10
    createTestClip('clip-2', 20, 0, 10), // 20-30
    createTestClip('clip-3', 40, 0, 5), // 40-45
  ];

  it('should detect overlap when new clip starts inside existing clip', () => {
    const result = checkClipOverlap(clips, 5, 15);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('clip-1');
  });

  it('should detect overlap when new clip ends inside existing clip', () => {
    const result = checkClipOverlap(clips, 15, 25);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('clip-2');
  });

  it('should detect overlap when new clip completely contains existing clip', () => {
    const result = checkClipOverlap(clips, 35, 50);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('clip-3');
  });

  it('should detect overlap when new clip is completely inside existing clip', () => {
    const result = checkClipOverlap(clips, 2, 8);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('clip-1');
  });

  it('should return null when no overlap in gap', () => {
    const result = checkClipOverlap(clips, 10, 20);
    expect(result).toBeNull();
  });

  it('should return null when after all clips', () => {
    const result = checkClipOverlap(clips, 50, 60);
    expect(result).toBeNull();
  });

  it('should exclude specified clip from check', () => {
    const result = checkClipOverlap(clips, 5, 15, 'clip-1');
    expect(result).toBeNull();
  });

  it('should handle adjacent clips (touching but not overlapping)', () => {
    const result = checkClipOverlap(clips, 10, 20);
    expect(result).toBeNull();
  });
});

// =============================================================================
// Tests: Main Validation Function
// =============================================================================

describe('validateDrop', () => {
  describe('locked track', () => {
    it('should return invalid for locked track', () => {
      const track = createTestTrack({ locked: true });
      const context: DropValidationContext = {
        track,
        clips: [],
      };

      const result = validateDrop(0, 10, context);

      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('locked_track');
      expect(result.message).toContain('locked');
    });
  });

  describe('track type compatibility', () => {
    it('should return invalid for incompatible asset type', () => {
      const track = createTestTrack({ kind: 'audio' });
      const context: DropValidationContext = {
        track,
        clips: [],
        assetKind: 'image',
      };

      const result = validateDrop(0, 10, context);

      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('wrong_track_type');
    });

    it('should return valid for compatible asset type', () => {
      const track = createTestTrack({ kind: 'video' });
      const context: DropValidationContext = {
        track,
        clips: [],
        assetKind: 'video',
      };

      const result = validateDrop(0, 10, context);

      expect(result.isValid).toBe(true);
    });
  });

  describe('position bounds', () => {
    it('should return invalid for negative position', () => {
      const track = createTestTrack();
      const context: DropValidationContext = {
        track,
        clips: [],
      };

      const result = validateDrop(-5, 10, context);

      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('out_of_bounds');
    });

    it('should return valid for zero position', () => {
      const track = createTestTrack();
      const context: DropValidationContext = {
        track,
        clips: [],
      };

      const result = validateDrop(0, 10, context);

      expect(result.isValid).toBe(true);
    });
  });

  describe('overlap detection', () => {
    it('should return invalid for overlapping clips', () => {
      const track = createTestTrack();
      const existingClip = createTestClip('clip-1', 10, 0, 10);
      const context: DropValidationContext = {
        track,
        clips: [existingClip],
      };

      const result = validateDrop(15, 10, context);

      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('overlap');
      expect(result.conflictingClipId).toBe('clip-1');
    });

    it('should exclude source clip from overlap check', () => {
      const track = createTestTrack();
      const existingClip = createTestClip('clip-1', 10, 0, 10);
      const context: DropValidationContext = {
        track,
        clips: [existingClip],
        sourceClip: existingClip,
      };

      // Moving clip-1 to position 15 (within its original range)
      const result = validateDrop(15, 10, context);

      expect(result.isValid).toBe(true);
    });
  });

  describe('valid drops', () => {
    it('should return valid for all checks passing', () => {
      const track = createTestTrack();
      const context: DropValidationContext = {
        track,
        clips: [createTestClip('clip-1', 0, 0, 10)],
        assetKind: 'video',
      };

      const result = validateDrop(15, 10, context);

      expect(result.isValid).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.message).toBeUndefined();
    });
  });
});

// =============================================================================
// Tests: Helper Functions
// =============================================================================

describe('validDrop', () => {
  it('should return valid drop result', () => {
    const result = validDrop();
    expect(result.isValid).toBe(true);
  });
});

describe('invalidDrop', () => {
  it('should return invalid drop result with reason', () => {
    const result = invalidDrop('overlap', 'Clips would overlap', 'clip-1');
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('overlap');
    expect(result.message).toBe('Clips would overlap');
    expect(result.conflictingClipId).toBe('clip-1');
  });
});
