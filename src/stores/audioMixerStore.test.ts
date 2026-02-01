/**
 * Audio Mixer Store Tests
 *
 * Tests for audio mixer state management including:
 * - Track volume/pan/mute/solo states
 * - Real-time audio level updates
 * - Master channel controls
 * - Solo logic (exclusive and additive)
 *
 * Follows TDD methodology.
 *
 * @module stores/audioMixerStore.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  useAudioMixerStore,
  type TrackMixerState,
  type MasterMixerState,
} from './audioMixerStore';

describe('audioMixerStore', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useAudioMixerStore.getState().reset();
  });

  describe('initial state', () => {
    it('should have empty track states initially', () => {
      const state = useAudioMixerStore.getState();
      expect(state.trackStates.size).toBe(0);
    });

    it('should have default master state', () => {
      const state = useAudioMixerStore.getState();
      expect(state.masterState.volumeDb).toBe(0);
      expect(state.masterState.muted).toBe(false);
      expect(state.masterState.levels).toEqual({ left: -60, right: -60 });
    });

    it('should have empty soloed tracks set', () => {
      const state = useAudioMixerStore.getState();
      expect(state.soloedTrackIds.size).toBe(0);
    });
  });

  describe('initializeTrack', () => {
    it('should create track state with defaults', () => {
      useAudioMixerStore.getState().initializeTrack('track-1', 0, 0);

      const trackState = useAudioMixerStore.getState().trackStates.get('track-1');
      expect(trackState).toBeDefined();
      expect(trackState?.volumeDb).toBe(0);
      expect(trackState?.pan).toBe(0);
      expect(trackState?.muted).toBe(false);
      expect(trackState?.soloed).toBe(false);
      expect(trackState?.levels).toEqual({ left: -60, right: -60 });
    });

    it('should initialize with custom values', () => {
      useAudioMixerStore.getState().initializeTrack('track-1', -6, 0.5);

      const trackState = useAudioMixerStore.getState().trackStates.get('track-1');
      expect(trackState?.volumeDb).toBe(-6);
      expect(trackState?.pan).toBe(0.5);
    });

    it('should not overwrite existing track state', () => {
      useAudioMixerStore.getState().initializeTrack('track-1', -6, 0.5);
      useAudioMixerStore.getState().setTrackVolume('track-1', -12);
      useAudioMixerStore.getState().initializeTrack('track-1', 0, 0); // Should not reset

      const trackState = useAudioMixerStore.getState().trackStates.get('track-1');
      expect(trackState?.volumeDb).toBe(-12);
    });
  });

  describe('removeTrack', () => {
    it('should remove track state', () => {
      useAudioMixerStore.getState().initializeTrack('track-1', 0, 0);
      expect(useAudioMixerStore.getState().trackStates.has('track-1')).toBe(true);

      useAudioMixerStore.getState().removeTrack('track-1');
      expect(useAudioMixerStore.getState().trackStates.has('track-1')).toBe(false);
    });

    it('should remove from soloed set', () => {
      useAudioMixerStore.getState().initializeTrack('track-1', 0, 0);
      useAudioMixerStore.getState().toggleSolo('track-1');
      expect(useAudioMixerStore.getState().soloedTrackIds.has('track-1')).toBe(true);

      useAudioMixerStore.getState().removeTrack('track-1');
      expect(useAudioMixerStore.getState().soloedTrackIds.has('track-1')).toBe(false);
    });
  });

  describe('setTrackVolume', () => {
    it('should update track volume', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', 0, 0);

      store.setTrackVolume('track-1', -12);

      const trackState = useAudioMixerStore.getState().trackStates.get('track-1');
      expect(trackState?.volumeDb).toBe(-12);
    });

    it('should clamp volume to valid range', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', 0, 0);

      store.setTrackVolume('track-1', 20); // Too high
      expect(useAudioMixerStore.getState().trackStates.get('track-1')?.volumeDb).toBe(6);

      store.setTrackVolume('track-1', -100); // Too low
      expect(useAudioMixerStore.getState().trackStates.get('track-1')?.volumeDb).toBe(-60);
    });

    it('should create track if not exists', () => {
      const store = useAudioMixerStore.getState();
      store.setTrackVolume('new-track', -6);

      expect(useAudioMixerStore.getState().trackStates.has('new-track')).toBe(true);
    });
  });

  describe('setTrackPan', () => {
    it('should update track pan', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', 0, 0);

      store.setTrackPan('track-1', 0.75);

      const trackState = useAudioMixerStore.getState().trackStates.get('track-1');
      expect(trackState?.pan).toBe(0.75);
    });

    it('should clamp pan to valid range', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', 0, 0);

      store.setTrackPan('track-1', 2); // Too high
      expect(useAudioMixerStore.getState().trackStates.get('track-1')?.pan).toBe(1);

      store.setTrackPan('track-1', -2); // Too low
      expect(useAudioMixerStore.getState().trackStates.get('track-1')?.pan).toBe(-1);
    });
  });

  describe('toggleMute', () => {
    it('should toggle mute state', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', 0, 0);

      store.toggleMute('track-1');
      expect(useAudioMixerStore.getState().trackStates.get('track-1')?.muted).toBe(true);

      store.toggleMute('track-1');
      expect(useAudioMixerStore.getState().trackStates.get('track-1')?.muted).toBe(false);
    });
  });

  describe('setMuted', () => {
    it('should set mute state directly', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', 0, 0);

      store.setMuted('track-1', true);
      expect(useAudioMixerStore.getState().trackStates.get('track-1')?.muted).toBe(true);

      store.setMuted('track-1', false);
      expect(useAudioMixerStore.getState().trackStates.get('track-1')?.muted).toBe(false);
    });
  });

  describe('toggleSolo', () => {
    it('should add track to soloed set', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', 0, 0);

      store.toggleSolo('track-1');

      const state = useAudioMixerStore.getState();
      expect(state.soloedTrackIds.has('track-1')).toBe(true);
      expect(state.trackStates.get('track-1')?.soloed).toBe(true);
    });

    it('should remove track from soloed set when toggled again', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', 0, 0);

      store.toggleSolo('track-1');
      store.toggleSolo('track-1');

      const state = useAudioMixerStore.getState();
      expect(state.soloedTrackIds.has('track-1')).toBe(false);
      expect(state.trackStates.get('track-1')?.soloed).toBe(false);
    });

    it('should allow multiple soloed tracks (additive solo)', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', 0, 0);
      store.initializeTrack('track-2', 0, 0);

      store.toggleSolo('track-1');
      store.toggleSolo('track-2');

      const state = useAudioMixerStore.getState();
      expect(state.soloedTrackIds.size).toBe(2);
      expect(state.soloedTrackIds.has('track-1')).toBe(true);
      expect(state.soloedTrackIds.has('track-2')).toBe(true);
    });
  });

  describe('clearAllSolos', () => {
    it('should clear all soloed tracks', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', 0, 0);
      store.initializeTrack('track-2', 0, 0);
      store.toggleSolo('track-1');
      store.toggleSolo('track-2');

      store.clearAllSolos();

      const state = useAudioMixerStore.getState();
      expect(state.soloedTrackIds.size).toBe(0);
      expect(state.trackStates.get('track-1')?.soloed).toBe(false);
      expect(state.trackStates.get('track-2')?.soloed).toBe(false);
    });
  });

  describe('updateTrackLevels', () => {
    it('should update track audio levels', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', 0, 0);

      store.updateTrackLevels('track-1', { left: -12, right: -15 });

      const trackState = useAudioMixerStore.getState().trackStates.get('track-1');
      expect(trackState?.levels).toEqual({ left: -12, right: -15 });
    });

    it('should not create track if not exists', () => {
      const store = useAudioMixerStore.getState();
      store.updateTrackLevels('non-existent', { left: -12, right: -15 });

      expect(useAudioMixerStore.getState().trackStates.has('non-existent')).toBe(false);
    });
  });

  describe('master channel', () => {
    it('should update master volume', () => {
      const store = useAudioMixerStore.getState();
      store.setMasterVolume(-6);

      expect(useAudioMixerStore.getState().masterState.volumeDb).toBe(-6);
    });

    it('should clamp master volume to valid range', () => {
      const store = useAudioMixerStore.getState();

      store.setMasterVolume(20);
      expect(useAudioMixerStore.getState().masterState.volumeDb).toBe(6);

      store.setMasterVolume(-100);
      expect(useAudioMixerStore.getState().masterState.volumeDb).toBe(-60);
    });

    it('should toggle master mute', () => {
      const store = useAudioMixerStore.getState();

      store.toggleMasterMute();
      expect(useAudioMixerStore.getState().masterState.muted).toBe(true);

      store.toggleMasterMute();
      expect(useAudioMixerStore.getState().masterState.muted).toBe(false);
    });

    it('should update master levels', () => {
      const store = useAudioMixerStore.getState();
      store.updateMasterLevels({ left: -3, right: -6 });

      expect(useAudioMixerStore.getState().masterState.levels).toEqual({ left: -3, right: -6 });
    });
  });

  describe('getEffectiveTrackVolume', () => {
    it('should return track volume when no solo active', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', -6, 0);

      const effectiveVolume = store.getEffectiveTrackVolume('track-1');
      expect(effectiveVolume).toBe(-6);
    });

    it('should return -60 (silence) when track is muted', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', -6, 0);
      store.setMuted('track-1', true);

      const effectiveVolume = useAudioMixerStore.getState().getEffectiveTrackVolume('track-1');
      expect(effectiveVolume).toBe(-60);
    });

    it('should return track volume when track is soloed', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', -6, 0);
      store.initializeTrack('track-2', -12, 0);
      store.toggleSolo('track-1');

      const store2 = useAudioMixerStore.getState();
      expect(store2.getEffectiveTrackVolume('track-1')).toBe(-6);
    });

    it('should return -60 (silence) when another track is soloed', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', -6, 0);
      store.initializeTrack('track-2', -12, 0);
      store.toggleSolo('track-1');

      const effectiveVolume = useAudioMixerStore.getState().getEffectiveTrackVolume('track-2');
      expect(effectiveVolume).toBe(-60);
    });

    it('should return track volume when master is not muted', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', -6, 0);

      const effectiveVolume = store.getEffectiveTrackVolume('track-1');
      expect(effectiveVolume).toBe(-6);
    });
  });

  describe('isTrackAudible', () => {
    it('should return true when no conditions block audio', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', 0, 0);

      expect(store.isTrackAudible('track-1')).toBe(true);
    });

    it('should return false when track is muted', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', 0, 0);
      store.setMuted('track-1', true);

      expect(useAudioMixerStore.getState().isTrackAudible('track-1')).toBe(false);
    });

    it('should return false when another track is soloed', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', 0, 0);
      store.initializeTrack('track-2', 0, 0);
      store.toggleSolo('track-2');

      expect(useAudioMixerStore.getState().isTrackAudible('track-1')).toBe(false);
    });

    it('should return true when this track is soloed', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', 0, 0);
      store.initializeTrack('track-2', 0, 0);
      store.toggleSolo('track-1');

      expect(useAudioMixerStore.getState().isTrackAudible('track-1')).toBe(true);
    });

    it('should return false when master is muted', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', 0, 0);
      store.toggleMasterMute();

      expect(useAudioMixerStore.getState().isTrackAudible('track-1')).toBe(false);
    });
  });

  describe('reset', () => {
    it('should reset all state to initial values', () => {
      const store = useAudioMixerStore.getState();
      store.initializeTrack('track-1', -6, 0.5);
      store.toggleSolo('track-1');
      store.setMasterVolume(-12);
      store.toggleMasterMute();

      store.reset();

      const state = useAudioMixerStore.getState();
      expect(state.trackStates.size).toBe(0);
      expect(state.soloedTrackIds.size).toBe(0);
      expect(state.masterState.volumeDb).toBe(0);
      expect(state.masterState.muted).toBe(false);
    });
  });
});

describe('TrackMixerState type', () => {
  it('should have correct structure', () => {
    const trackState: TrackMixerState = {
      volumeDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      levels: { left: -60, right: -60 },
    };

    expect(trackState).toBeDefined();
  });
});

describe('MasterMixerState type', () => {
  it('should have correct structure', () => {
    const masterState: MasterMixerState = {
      volumeDb: 0,
      muted: false,
      levels: { left: -60, right: -60 },
    };

    expect(masterState).toBeDefined();
  });
});
