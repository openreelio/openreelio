/**
 * AudioMixerPanel Component
 *
 * Main container for the audio mixer interface.
 * Displays channel strips for all audio/video tracks plus a master output.
 *
 * Features:
 * - Channel strip for each audio/video track
 * - Master output channel
 * - Volume faders with dB display
 * - Stereo audio meters
 * - Pan controls (per-track)
 * - Mute/Solo controls
 * - Horizontal scrolling for many tracks
 */

import { memo, useMemo } from 'react';
import { MixerChannelStrip, ChannelLevels } from './MixerChannelStrip';
import { linearToDb } from '@/utils/audioMeter';
import type { Track, TrackKind } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface AudioMixerPanelProps {
  /** Array of tracks to display */
  tracks: Track[];
  /** Map of track ID to current audio levels */
  trackLevels?: Map<string, ChannelLevels>;
  /** Map of track ID to pan value (-1 to 1) */
  trackPans?: Map<string, number>;
  /** Set of currently soloed track IDs */
  soloedTrackIds?: Set<string>;
  /** Master volume in linear (0-2) */
  masterVolume?: number;
  /** Master mute state */
  masterMuted?: boolean;
  /** Master channel audio levels */
  masterLevels?: ChannelLevels;
  /** Callback when track volume changes */
  onVolumeChange?: (trackId: string, volumeDb: number) => void;
  /** Callback when track pan changes */
  onPanChange?: (trackId: string, pan: number) => void;
  /** Callback when track mute is toggled */
  onMuteToggle?: (trackId: string) => void;
  /** Callback when track solo is toggled */
  onSoloToggle?: (trackId: string) => void;
  /** Callback when master volume changes */
  onMasterVolumeChange?: (volumeDb: number) => void;
  /** Callback when master mute is toggled */
  onMasterMuteToggle?: () => void;
  /** Whether controls are disabled */
  disabled?: boolean;
  /** Whether to use compact layout */
  compact?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Track kinds that should be shown in the mixer */
const MIXABLE_TRACK_KINDS: TrackKind[] = ['audio', 'video'];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Converts linear volume (0-2) to dB for mixer display.
 * Linear 1.0 = 0 dB, Linear 0 = -60 dB, Linear 2.0 = +6 dB
 */
function linearVolumeToDb(linear: number): number {
  if (linear <= 0) return -60;
  return linearToDb(linear);
}

/**
 * Gets the channel type for styling based on track kind.
 */
function getChannelType(kind: TrackKind): 'audio' | 'video' {
  return kind === 'audio' ? 'audio' : 'video';
}

// =============================================================================
// Main Component
// =============================================================================

export const AudioMixerPanel = memo(function AudioMixerPanel({
  tracks,
  trackLevels,
  trackPans,
  soloedTrackIds,
  masterVolume = 1.0,
  masterMuted = false,
  masterLevels,
  onVolumeChange,
  onPanChange,
  onMuteToggle,
  onSoloToggle,
  onMasterVolumeChange,
  onMasterMuteToggle,
  disabled = false,
  compact = false,
  className = '',
}: AudioMixerPanelProps) {
  // Filter tracks to only show audio and video tracks
  const mixableTracks = useMemo(
    () => tracks.filter((track) => MIXABLE_TRACK_KINDS.includes(track.kind)),
    [tracks]
  );

  // Calculate master volume in dB
  const masterVolumeDb = linearVolumeToDb(masterVolume);

  // Handle volume change (convert from dB callback to linear for track update)
  const handleVolumeChange = (trackId: string, volumeDb: number) => {
    onVolumeChange?.(trackId, volumeDb);
  };

  // Handle pan change
  const handlePanChange = (trackId: string, pan: number) => {
    onPanChange?.(trackId, pan);
  };

  // Handle mute toggle
  const handleMuteToggle = (trackId: string) => {
    onMuteToggle?.(trackId);
  };

  // Handle solo toggle
  const handleSoloToggle = (trackId: string) => {
    onSoloToggle?.(trackId);
  };

  // Handle master volume change
  const handleMasterVolumeChange = (_id: string, volumeDb: number) => {
    onMasterVolumeChange?.(volumeDb);
  };

  // Handle master mute toggle
  const handleMasterMuteToggle = () => {
    onMasterMuteToggle?.();
  };

  return (
    <div
      data-testid="audio-mixer-panel"
      className={`flex h-full bg-editor-bg overflow-x-auto ${
        compact ? 'compact' : ''
      } ${className}`}
    >
      {mixableTracks.length === 0 ? (
        <div className="flex items-center justify-center w-full h-full text-editor-text-muted">
          No tracks
        </div>
      ) : (
        <>
          {/* Track channel strips */}
          <div className="flex gap-1 p-2">
            {mixableTracks.map((track) => (
              <MixerChannelStrip
                key={track.id}
                id={track.id}
                name={track.name}
                type={getChannelType(track.kind)}
                volumeDb={linearVolumeToDb(track.volume)}
                pan={trackPans?.get(track.id) ?? 0}
                muted={track.muted}
                soloed={soloedTrackIds?.has(track.id) ?? false}
                levels={trackLevels?.get(track.id)}
                onVolumeChange={handleVolumeChange}
                onPanChange={handlePanChange}
                onMuteToggle={handleMuteToggle}
                onSoloToggle={handleSoloToggle}
                disabled={disabled}
                compact={compact}
              />
            ))}
          </div>

          {/* Separator */}
          <div className="w-px bg-editor-border my-2" />

          {/* Master channel */}
          <div className="p-2">
            <MixerChannelStrip
              id="master"
              name="Master"
              type="master"
              volumeDb={masterVolumeDb}
              pan={0}
              muted={masterMuted}
              levels={masterLevels}
              onVolumeChange={handleMasterVolumeChange}
              onMuteToggle={handleMasterMuteToggle}
              disabled={disabled}
              compact={compact}
            />
          </div>
        </>
      )}
    </div>
  );
});

export default AudioMixerPanel;
