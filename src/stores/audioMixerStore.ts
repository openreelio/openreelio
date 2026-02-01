/**
 * Audio Mixer Store
 *
 * Zustand store for audio mixer state management.
 * Handles track volume, pan, mute, solo states and real-time audio levels.
 *
 * This store provides the state layer for the audio mixer UI.
 * The actual Web Audio API integration is handled by useAudioMixer hook.
 *
 * @module stores/audioMixerStore
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';

// Enable Immer MapSet plugin for Map and Set support
enableMapSet();

// =============================================================================
// Types
// =============================================================================

/** Audio level data for stereo channels */
export interface StereoLevels {
  left: number;  // dB value (-60 to 0+)
  right: number; // dB value (-60 to 0+)
}

/** State for a single track in the mixer */
export interface TrackMixerState {
  /** Volume in dB (-60 to +6) */
  volumeDb: number;
  /** Pan position (-1 = left, 0 = center, 1 = right) */
  pan: number;
  /** Whether the track is muted */
  muted: boolean;
  /** Whether the track is soloed */
  soloed: boolean;
  /** Current audio levels (updated in real-time during playback) */
  levels: StereoLevels;
}

/** State for the master channel */
export interface MasterMixerState {
  /** Volume in dB (-60 to +6) */
  volumeDb: number;
  /** Whether master output is muted */
  muted: boolean;
  /** Current audio levels (updated in real-time during playback) */
  levels: StereoLevels;
}

/** Complete mixer store state */
export interface AudioMixerState {
  /** Map of track ID to mixer state */
  trackStates: Map<string, TrackMixerState>;
  /** Set of currently soloed track IDs */
  soloedTrackIds: Set<string>;
  /** Master channel state */
  masterState: MasterMixerState;
}

/** Mixer store actions */
export interface AudioMixerActions {
  // Track management
  initializeTrack: (trackId: string, volumeDb?: number, pan?: number) => void;
  removeTrack: (trackId: string) => void;

  // Track controls
  setTrackVolume: (trackId: string, volumeDb: number) => void;
  setTrackPan: (trackId: string, pan: number) => void;
  toggleMute: (trackId: string) => void;
  setMuted: (trackId: string, muted: boolean) => void;
  toggleSolo: (trackId: string) => void;
  clearAllSolos: () => void;

  // Level updates (called by audio analysis)
  updateTrackLevels: (trackId: string, levels: StereoLevels) => void;

  // Master controls
  setMasterVolume: (volumeDb: number) => void;
  toggleMasterMute: () => void;
  updateMasterLevels: (levels: StereoLevels) => void;

  // Computed getters
  getEffectiveTrackVolume: (trackId: string) => number;
  isTrackAudible: (trackId: string) => boolean;

  // Reset
  reset: () => void;
}

export type AudioMixerStore = AudioMixerState & AudioMixerActions;

// =============================================================================
// Constants
// =============================================================================

/** Minimum volume in dB */
const MIN_VOLUME_DB = -60;

/** Maximum volume in dB */
const MAX_VOLUME_DB = 6;

/** Default silence level in dB */
const SILENCE_DB = -60;

/** Default track mixer state */
const DEFAULT_TRACK_STATE: TrackMixerState = {
  volumeDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  levels: { left: SILENCE_DB, right: SILENCE_DB },
};

/** Default master mixer state */
const DEFAULT_MASTER_STATE: MasterMixerState = {
  volumeDb: 0,
  muted: false,
  levels: { left: SILENCE_DB, right: SILENCE_DB },
};

// =============================================================================
// Initial State
// =============================================================================

const initialState: AudioMixerState = {
  trackStates: new Map(),
  soloedTrackIds: new Set(),
  masterState: { ...DEFAULT_MASTER_STATE },
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Clamps a volume value to valid dB range.
 */
function clampVolume(volumeDb: number): number {
  return Math.max(MIN_VOLUME_DB, Math.min(MAX_VOLUME_DB, volumeDb));
}

/**
 * Clamps a pan value to valid range.
 */
function clampPan(pan: number): number {
  return Math.max(-1, Math.min(1, pan));
}

/**
 * Gets or creates a track state.
 */
function getOrCreateTrackState(
  trackStates: Map<string, TrackMixerState>,
  trackId: string
): TrackMixerState {
  if (!trackStates.has(trackId)) {
    trackStates.set(trackId, { ...DEFAULT_TRACK_STATE });
  }
  return trackStates.get(trackId)!;
}

// =============================================================================
// Store
// =============================================================================

export const useAudioMixerStore = create<AudioMixerStore>()(
  immer((set, get) => ({
    ...initialState,

    // =========================================================================
    // Track Management
    // =========================================================================

    initializeTrack: (trackId: string, volumeDb = 0, pan = 0) => {
      set((state) => {
        // Don't overwrite existing track state
        if (state.trackStates.has(trackId)) {
          return;
        }

        state.trackStates.set(trackId, {
          volumeDb: clampVolume(volumeDb),
          pan: clampPan(pan),
          muted: false,
          soloed: false,
          levels: { left: SILENCE_DB, right: SILENCE_DB },
        });
      });
    },

    removeTrack: (trackId: string) => {
      set((state) => {
        state.trackStates.delete(trackId);
        state.soloedTrackIds.delete(trackId);
      });
    },

    // =========================================================================
    // Track Controls
    // =========================================================================

    setTrackVolume: (trackId: string, volumeDb: number) => {
      set((state) => {
        const trackState = getOrCreateTrackState(state.trackStates, trackId);
        trackState.volumeDb = clampVolume(volumeDb);
      });
    },

    setTrackPan: (trackId: string, pan: number) => {
      set((state) => {
        const trackState = getOrCreateTrackState(state.trackStates, trackId);
        trackState.pan = clampPan(pan);
      });
    },

    toggleMute: (trackId: string) => {
      set((state) => {
        const trackState = getOrCreateTrackState(state.trackStates, trackId);
        trackState.muted = !trackState.muted;
      });
    },

    setMuted: (trackId: string, muted: boolean) => {
      set((state) => {
        const trackState = getOrCreateTrackState(state.trackStates, trackId);
        trackState.muted = muted;
      });
    },

    toggleSolo: (trackId: string) => {
      set((state) => {
        const trackState = getOrCreateTrackState(state.trackStates, trackId);

        if (trackState.soloed) {
          // Un-solo
          trackState.soloed = false;
          state.soloedTrackIds.delete(trackId);
        } else {
          // Solo (additive - doesn't clear other solos)
          trackState.soloed = true;
          state.soloedTrackIds.add(trackId);
        }
      });
    },

    clearAllSolos: () => {
      set((state) => {
        for (const trackState of state.trackStates.values()) {
          trackState.soloed = false;
        }
        state.soloedTrackIds.clear();
      });
    },

    // =========================================================================
    // Level Updates
    // =========================================================================

    updateTrackLevels: (trackId: string, levels: StereoLevels) => {
      set((state) => {
        const trackState = state.trackStates.get(trackId);
        if (trackState) {
          trackState.levels = levels;
        }
      });
    },

    // =========================================================================
    // Master Controls
    // =========================================================================

    setMasterVolume: (volumeDb: number) => {
      set((state) => {
        state.masterState.volumeDb = clampVolume(volumeDb);
      });
    },

    toggleMasterMute: () => {
      set((state) => {
        state.masterState.muted = !state.masterState.muted;
      });
    },

    updateMasterLevels: (levels: StereoLevels) => {
      set((state) => {
        state.masterState.levels = levels;
      });
    },

    // =========================================================================
    // Computed Getters
    // =========================================================================

    getEffectiveTrackVolume: (trackId: string) => {
      const state = get();
      const trackState = state.trackStates.get(trackId);

      if (!trackState) {
        return SILENCE_DB;
      }

      // Check mute first
      if (trackState.muted) {
        return SILENCE_DB;
      }

      // Check solo logic: if any track is soloed, non-soloed tracks are silenced
      if (state.soloedTrackIds.size > 0 && !trackState.soloed) {
        return SILENCE_DB;
      }

      return trackState.volumeDb;
    },

    isTrackAudible: (trackId: string) => {
      const state = get();
      const trackState = state.trackStates.get(trackId);

      if (!trackState) {
        return false;
      }

      // Master mute blocks all audio
      if (state.masterState.muted) {
        return false;
      }

      // Track mute blocks this track
      if (trackState.muted) {
        return false;
      }

      // Solo logic: if any track is soloed, only soloed tracks are audible
      if (state.soloedTrackIds.size > 0 && !trackState.soloed) {
        return false;
      }

      return true;
    },

    // =========================================================================
    // Reset
    // =========================================================================

    reset: () => {
      set(() => ({
        trackStates: new Map(),
        soloedTrackIds: new Set(),
        masterState: { ...DEFAULT_MASTER_STATE },
      }));
    },
  }))
);
