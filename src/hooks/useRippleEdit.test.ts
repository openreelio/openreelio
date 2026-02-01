/**
 * useRippleEdit Hook Tests
 *
 * Tests for ripple editing operations.
 * Follows TDD methodology.
 *
 * @module hooks/useRippleEdit.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRippleEdit } from './useRippleEdit';
import { useEditorToolStore } from '@/stores/editorToolStore';
import type { Sequence, Clip, Track } from '@/types';

// =============================================================================
// Test Fixtures
// =============================================================================

function createTestClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    label: 'Test Clip',
    place: {
      timelineInSec: 0,
      durationSec: 5,
    },
    range: {
      sourceInSec: 0,
      sourceOutSec: 5,
    },
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
    },
    opacity: 1,
    speed: 1,
    effects: [],
    audio: {
      volumeDb: 0,
      isMuted: false,
      fadeIn: 0,
      fadeOut: 0,
    },
    ...overrides,
  } as Clip;
}

function createTestTrack(clips: Clip[] = [], id = 'track-1'): Track {
  return {
    id,
    kind: 'video',
    name: 'Track 1',
    clips,
    blendMode: 'normal',
    muted: false,
    locked: false,
    visible: true,
    volume: 1,
  } as Track;
}

function createTestSequence(tracks: Track[] = []): Sequence {
  return {
    id: 'sequence-1',
    name: 'Test Sequence',
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks,
    markers: [],
  } as Sequence;
}

// =============================================================================
// Tests
// =============================================================================

describe('useRippleEdit', () => {
  beforeEach(() => {
    // Reset store
    useEditorToolStore.getState().reset();
  });

  describe('ripple mode state', () => {
    it('should return ripple enabled state from store', () => {
      const { result } = renderHook(() =>
        useRippleEdit({ sequence: null })
      );

      expect(result.current.isRippleEnabled).toBe(false);
    });

    it('should toggle ripple mode', () => {
      const { result } = renderHook(() =>
        useRippleEdit({ sequence: null })
      );

      act(() => {
        result.current.toggleRipple();
      });

      expect(result.current.isRippleEnabled).toBe(true);

      act(() => {
        result.current.toggleRipple();
      });

      expect(result.current.isRippleEnabled).toBe(false);
    });

    it('should set ripple mode directly', () => {
      const { result } = renderHook(() =>
        useRippleEdit({ sequence: null })
      );

      act(() => {
        result.current.setRippleEnabled(true);
      });

      expect(result.current.isRippleEnabled).toBe(true);
    });
  });

  describe('getClipsAfter', () => {
    it('should return clips after a given time', () => {
      const clip1 = createTestClip({ id: 'clip-1', place: { timelineInSec: 0, durationSec: 5 } });
      const clip2 = createTestClip({ id: 'clip-2', place: { timelineInSec: 5, durationSec: 5 } });
      const clip3 = createTestClip({ id: 'clip-3', place: { timelineInSec: 10, durationSec: 5 } });
      const track = createTestTrack([clip1, clip2, clip3]);
      const sequence = createTestSequence([track]);

      const { result } = renderHook(() => useRippleEdit({ sequence }));

      const clipsAfter = result.current.getClipsAfter('track-1', 5);

      expect(clipsAfter.length).toBe(2);
      expect(clipsAfter[0].id).toBe('clip-2');
      expect(clipsAfter[1].id).toBe('clip-3');
    });

    it('should exclude specified clip IDs', () => {
      const clip1 = createTestClip({ id: 'clip-1', place: { timelineInSec: 0, durationSec: 5 } });
      const clip2 = createTestClip({ id: 'clip-2', place: { timelineInSec: 5, durationSec: 5 } });
      const clip3 = createTestClip({ id: 'clip-3', place: { timelineInSec: 10, durationSec: 5 } });
      const track = createTestTrack([clip1, clip2, clip3]);
      const sequence = createTestSequence([track]);

      const { result } = renderHook(() => useRippleEdit({ sequence }));

      const clipsAfter = result.current.getClipsAfter('track-1', 5, ['clip-2']);

      expect(clipsAfter.length).toBe(1);
      expect(clipsAfter[0].id).toBe('clip-3');
    });

    it('should return empty array for non-existent track', () => {
      const sequence = createTestSequence([createTestTrack()]);

      const { result } = renderHook(() => useRippleEdit({ sequence }));

      const clipsAfter = result.current.getClipsAfter('non-existent', 0);

      expect(clipsAfter.length).toBe(0);
    });
  });

  describe('getAllClipsAfter', () => {
    it('should return clips from all tracks after a given time', () => {
      const clip1 = createTestClip({ id: 'clip-1', place: { timelineInSec: 0, durationSec: 5 } });
      const clip2 = createTestClip({ id: 'clip-2', place: { timelineInSec: 5, durationSec: 5 } });
      const clip3 = createTestClip({ id: 'clip-3', place: { timelineInSec: 7, durationSec: 5 } });
      const track1 = createTestTrack([clip1, clip2], 'track-1');
      const track2 = createTestTrack([clip3], 'track-2');
      const sequence = createTestSequence([track1, track2]);

      const { result } = renderHook(() => useRippleEdit({ sequence }));

      const clipsAfter = result.current.getAllClipsAfter(5);

      expect(clipsAfter.length).toBe(2);
      expect(clipsAfter.map(c => c.clip.id)).toContain('clip-2');
      expect(clipsAfter.map(c => c.clip.id)).toContain('clip-3');
    });
  });

  describe('calculateDeleteRipple', () => {
    it('should calculate ripple for single clip deletion', () => {
      const clip1 = createTestClip({
        id: 'clip-1',
        place: { timelineInSec: 0, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 5 },
      });
      const clip2 = createTestClip({
        id: 'clip-2',
        place: { timelineInSec: 5, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 3 },
      });
      const clip3 = createTestClip({
        id: 'clip-3',
        place: { timelineInSec: 8, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 4 },
      });
      const track = createTestTrack([clip1, clip2, clip3]);
      const sequence = createTestSequence([track]);

      const { result } = renderHook(() => useRippleEdit({ sequence }));

      const rippleResult = result.current.calculateDeleteRipple(['clip-1']);

      // clip-1 has duration 5s
      // clip-2 should move from 5s to 0s
      // clip-3 should move from 8s to 3s
      expect(rippleResult.affectedClips.length).toBe(2);

      const clip2Affected = rippleResult.affectedClips.find(c => c.clipId === 'clip-2');
      const clip3Affected = rippleResult.affectedClips.find(c => c.clipId === 'clip-3');

      expect(clip2Affected?.originalTime).toBe(5);
      expect(clip2Affected?.newTime).toBe(0);
      expect(clip3Affected?.originalTime).toBe(8);
      expect(clip3Affected?.newTime).toBe(3);
    });

    it('should handle multiple clip deletion', () => {
      const clip1 = createTestClip({
        id: 'clip-1',
        place: { timelineInSec: 0, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 3 },
      });
      const clip2 = createTestClip({
        id: 'clip-2',
        place: { timelineInSec: 3, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 2 },
      });
      const clip3 = createTestClip({
        id: 'clip-3',
        place: { timelineInSec: 5, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 4 },
      });
      const track = createTestTrack([clip1, clip2, clip3]);
      const sequence = createTestSequence([track]);

      const { result } = renderHook(() => useRippleEdit({ sequence }));

      // Delete both clip-1 and clip-2 (total 5s duration)
      const rippleResult = result.current.calculateDeleteRipple(['clip-1', 'clip-2']);

      const clip3Affected = rippleResult.affectedClips.find(c => c.clipId === 'clip-3');
      expect(clip3Affected?.originalTime).toBe(5);
      expect(clip3Affected?.newTime).toBe(0);
    });

    it('should return empty result for empty clip list', () => {
      const sequence = createTestSequence([createTestTrack()]);

      const { result } = renderHook(() => useRippleEdit({ sequence }));

      const rippleResult = result.current.calculateDeleteRipple([]);

      expect(rippleResult.affectedClips.length).toBe(0);
      expect(rippleResult.totalDelta).toBe(0);
    });
  });

  describe('calculateInsertRipple', () => {
    it('should calculate ripple for clip insertion', () => {
      const clip1 = createTestClip({
        id: 'clip-1',
        place: { timelineInSec: 0, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 5 },
      });
      const clip2 = createTestClip({
        id: 'clip-2',
        place: { timelineInSec: 5, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 3 },
      });
      const track = createTestTrack([clip1, clip2]);
      const sequence = createTestSequence([track]);

      const { result } = renderHook(() => useRippleEdit({ sequence }));

      // Insert 4s clip at position 3s
      const rippleResult = result.current.calculateInsertRipple('track-1', 3, 4);

      // clip-1 starts before insert point, so not affected
      // clip-2 starts at 5s, should shift to 9s (5 + 4)
      expect(rippleResult.affectedClips.length).toBe(1);

      const clip2Affected = rippleResult.affectedClips.find(c => c.clipId === 'clip-2');
      expect(clip2Affected?.originalTime).toBe(5);
      expect(clip2Affected?.newTime).toBe(9);
      expect(rippleResult.totalDelta).toBe(4);
    });

    it('should shift all clips after insert point', () => {
      const clip1 = createTestClip({
        id: 'clip-1',
        place: { timelineInSec: 5, durationSec: 5 },
      });
      const clip2 = createTestClip({
        id: 'clip-2',
        place: { timelineInSec: 10, durationSec: 5 },
      });
      const clip3 = createTestClip({
        id: 'clip-3',
        place: { timelineInSec: 15, durationSec: 5 },
      });
      const track = createTestTrack([clip1, clip2, clip3]);
      const sequence = createTestSequence([track]);

      const { result } = renderHook(() => useRippleEdit({ sequence }));

      const rippleResult = result.current.calculateInsertRipple('track-1', 0, 3);

      expect(rippleResult.affectedClips.length).toBe(3);
      expect(rippleResult.affectedClips.every(c => c.newTime === c.originalTime + 3)).toBe(true);
    });
  });

  describe('calculateTrimRipple', () => {
    it('should calculate ripple when extending a clip', () => {
      const clip1 = createTestClip({
        id: 'clip-1',
        place: { timelineInSec: 0, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 5 },
      });
      const clip2 = createTestClip({
        id: 'clip-2',
        place: { timelineInSec: 5, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 3 },
      });
      const track = createTestTrack([clip1, clip2]);
      const sequence = createTestSequence([track]);

      const { result } = renderHook(() => useRippleEdit({ sequence }));

      // Extend clip-1 from 5s to 7s duration
      const rippleResult = result.current.calculateTrimRipple('clip-1', 5, 7);

      // clip-2 should shift from 5s to 7s
      expect(rippleResult.affectedClips.length).toBe(1);

      const clip2Affected = rippleResult.affectedClips.find(c => c.clipId === 'clip-2');
      expect(clip2Affected?.originalTime).toBe(5);
      expect(clip2Affected?.newTime).toBe(7);
      expect(rippleResult.totalDelta).toBe(2);
    });

    it('should calculate ripple when shortening a clip', () => {
      const clip1 = createTestClip({
        id: 'clip-1',
        place: { timelineInSec: 0, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 5 },
      });
      const clip2 = createTestClip({
        id: 'clip-2',
        place: { timelineInSec: 5, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 3 },
      });
      const track = createTestTrack([clip1, clip2]);
      const sequence = createTestSequence([track]);

      const { result } = renderHook(() => useRippleEdit({ sequence }));

      // Shorten clip-1 from 5s to 3s duration
      const rippleResult = result.current.calculateTrimRipple('clip-1', 5, 3);

      // clip-2 should shift from 5s to 3s
      expect(rippleResult.affectedClips.length).toBe(1);

      const clip2Affected = rippleResult.affectedClips.find(c => c.clipId === 'clip-2');
      expect(clip2Affected?.originalTime).toBe(5);
      expect(clip2Affected?.newTime).toBe(3);
      expect(rippleResult.totalDelta).toBe(-2);
    });

    it('should return empty result for no duration change', () => {
      const clip1 = createTestClip({
        id: 'clip-1',
        place: { timelineInSec: 0, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 5 },
      });
      const track = createTestTrack([clip1]);
      const sequence = createTestSequence([track]);

      const { result } = renderHook(() => useRippleEdit({ sequence }));

      const rippleResult = result.current.calculateTrimRipple('clip-1', 5, 5);

      expect(rippleResult.affectedClips.length).toBe(0);
      expect(rippleResult.totalDelta).toBe(0);
    });
  });

  describe('calculateMoveRipple', () => {
    it('should calculate ripple when moving clip right', () => {
      const clip1 = createTestClip({
        id: 'clip-1',
        place: { timelineInSec: 0, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 3 },
      });
      const clip2 = createTestClip({
        id: 'clip-2',
        place: { timelineInSec: 3, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 3 },
      });
      const clip3 = createTestClip({
        id: 'clip-3',
        place: { timelineInSec: 6, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 3 },
      });
      const track = createTestTrack([clip1, clip2, clip3]);
      const sequence = createTestSequence([track]);

      const { result } = renderHook(() => useRippleEdit({ sequence }));

      // Move clip-1 from 0 to 5 (moving right by 5s)
      const rippleResult = result.current.calculateMoveRipple('clip-1', 0, 5);

      expect(rippleResult.totalDelta).toBe(5);
    });

    it('should calculate ripple when moving clip left', () => {
      const clip1 = createTestClip({
        id: 'clip-1',
        place: { timelineInSec: 0, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 3 },
      });
      const clip2 = createTestClip({
        id: 'clip-2',
        place: { timelineInSec: 3, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 3 },
      });
      const clip3 = createTestClip({
        id: 'clip-3',
        place: { timelineInSec: 10, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 3 },
      });
      const track = createTestTrack([clip1, clip2, clip3]);
      const sequence = createTestSequence([track]);

      const { result } = renderHook(() => useRippleEdit({ sequence }));

      // Move clip-3 from 10 to 6 (moving left by 4s)
      const rippleResult = result.current.calculateMoveRipple('clip-3', 10, 6);

      expect(rippleResult.totalDelta).toBe(-4);
    });
  });

  describe('rippleAllTracks option', () => {
    it('should ripple across all tracks when enabled', () => {
      const clip1 = createTestClip({
        id: 'clip-1',
        place: { timelineInSec: 0, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 5 },
      });
      const clip2 = createTestClip({
        id: 'clip-2',
        place: { timelineInSec: 5, durationSec: 5 },
      });
      const clip3 = createTestClip({
        id: 'clip-3',
        place: { timelineInSec: 5, durationSec: 5 },
      });
      const track1 = createTestTrack([clip1, clip2], 'track-1');
      const track2 = createTestTrack([clip3], 'track-2');
      const sequence = createTestSequence([track1, track2]);

      const { result } = renderHook(() =>
        useRippleEdit({ sequence, rippleAllTracks: true })
      );

      const rippleResult = result.current.calculateDeleteRipple(['clip-1']);

      // Both clip-2 and clip-3 should be affected
      expect(rippleResult.affectedClips.length).toBe(2);
      expect(rippleResult.affectedClips.map(c => c.clipId)).toContain('clip-2');
      expect(rippleResult.affectedClips.map(c => c.clipId)).toContain('clip-3');
    });

    it('should only ripple on same track when disabled', () => {
      const clip1 = createTestClip({
        id: 'clip-1',
        place: { timelineInSec: 0, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 5 },
      });
      const clip2 = createTestClip({
        id: 'clip-2',
        place: { timelineInSec: 5, durationSec: 5 },
      });
      const clip3 = createTestClip({
        id: 'clip-3',
        place: { timelineInSec: 5, durationSec: 5 },
      });
      const track1 = createTestTrack([clip1, clip2], 'track-1');
      const track2 = createTestTrack([clip3], 'track-2');
      const sequence = createTestSequence([track1, track2]);

      const { result } = renderHook(() =>
        useRippleEdit({ sequence, rippleAllTracks: false })
      );

      const rippleResult = result.current.calculateDeleteRipple(['clip-1']);

      // Only clip-2 should be affected
      expect(rippleResult.affectedClips.length).toBe(1);
      expect(rippleResult.affectedClips[0].clipId).toBe('clip-2');
    });
  });
});
