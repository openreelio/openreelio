import { describe, expect, it, vi } from 'vitest';
import type { MasterMixerState, TrackMixerState } from '@/stores/audioMixerStore';
import {
  connectSourceToDestination,
  resolveMasterOutputGain,
  resolveTrackPlaybackRouting,
} from './audioRouting';

function createMasterState(overrides: Partial<MasterMixerState> = {}): MasterMixerState {
  return {
    volumeDb: 0,
    muted: false,
    levels: { left: -60, right: -60 },
    ...overrides,
  };
}

function createTrackState(overrides: Partial<TrackMixerState> = {}): TrackMixerState {
  return {
    volumeDb: 0,
    pan: 0,
    muted: false,
    levels: { left: -60, right: -60 },
    ...overrides,
  };
}

describe('audioRouting', () => {
  describe('resolveTrackPlaybackRouting', () => {
    it('uses mixer track state when available', () => {
      const state = resolveTrackPlaybackRouting({
        trackId: 'track-1',
        fallbackTrackVolume: 0.25,
        trackStates: new Map([['track-1', createTrackState({ volumeDb: -6, pan: 0.4 })]]),
        soloedTrackIds: new Set(),
        masterMuted: false,
      });

      expect(state.isAudible).toBe(true);
      expect(state.trackPan).toBe(0.4);
      expect(state.trackGain).toBeCloseTo(Math.pow(10, -6 / 20));
    });

    it('falls back to sequence track volume when mixer state is missing', () => {
      const state = resolveTrackPlaybackRouting({
        trackId: 'track-1',
        fallbackTrackVolume: 0.5,
        trackStates: new Map(),
        soloedTrackIds: new Set(),
        masterMuted: false,
      });

      expect(state.isAudible).toBe(true);
      expect(state.trackGain).toBe(0.5);
      expect(state.trackPan).toBe(0);
    });

    it('mutes tracks that are explicitly muted', () => {
      const state = resolveTrackPlaybackRouting({
        trackId: 'track-1',
        fallbackTrackVolume: 1,
        trackStates: new Map([['track-1', createTrackState({ muted: true })]]),
        soloedTrackIds: new Set(),
        masterMuted: false,
      });

      expect(state.isAudible).toBe(false);
      expect(state.trackGain).toBe(0);
    });

    it('silences non-soloed tracks while solo mode is active', () => {
      const state = resolveTrackPlaybackRouting({
        trackId: 'track-1',
        fallbackTrackVolume: 1,
        trackStates: new Map([['track-1', createTrackState()]]),
        soloedTrackIds: new Set(['track-2']),
        masterMuted: false,
      });

      expect(state.isAudible).toBe(false);
      expect(state.trackGain).toBe(0);
    });

    it('silences all tracks when master is muted', () => {
      const state = resolveTrackPlaybackRouting({
        trackId: 'track-1',
        fallbackTrackVolume: 1,
        trackStates: new Map([['track-1', createTrackState()]]),
        soloedTrackIds: new Set(['track-1']),
        masterMuted: true,
      });

      expect(state.isAudible).toBe(false);
      expect(state.trackGain).toBe(0);
    });
  });

  describe('resolveMasterOutputGain', () => {
    it('combines playback volume with mixer master gain', () => {
      const value = resolveMasterOutputGain(0.5, false, createMasterState({ volumeDb: -6 }));
      expect(value).toBeCloseTo(0.5 * Math.pow(10, -6 / 20));
    });

    it('returns zero when playback is muted', () => {
      expect(resolveMasterOutputGain(1, true, createMasterState())).toBe(0);
    });

    it('returns zero when mixer master is muted', () => {
      expect(resolveMasterOutputGain(1, false, createMasterState({ muted: true }))).toBe(0);
    });
  });

  describe('connectSourceToDestination', () => {
    it('connects source, gain, panner, and destination in order', () => {
      const sourceNode = { connect: vi.fn() } as unknown as AudioNode;
      const gainNode = { connect: vi.fn() } as unknown as AudioNode;
      const pannerNode = { connect: vi.fn() } as unknown as AudioNode;
      const destinationNode = {} as AudioNode;

      connectSourceToDestination(sourceNode, gainNode, pannerNode, destinationNode);

      expect(sourceNode.connect).toHaveBeenCalledWith(gainNode);
      expect(gainNode.connect).toHaveBeenCalledWith(pannerNode);
      expect(pannerNode.connect).toHaveBeenCalledWith(destinationNode);
    });
  });
});
