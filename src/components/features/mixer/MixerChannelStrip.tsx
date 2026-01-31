/**
 * MixerChannelStrip Component
 *
 * Individual audio channel strip with fader, meter, pan, and controls.
 * Used for both track channels and master output.
 *
 * Features:
 * - Volume fader with dB scale
 * - Stereo audio meter
 * - Pan control
 * - Mute/Solo buttons
 * - Channel label
 */

import { memo, useState, useCallback, useRef } from 'react';
import { Volume2, VolumeX, Headphones } from 'lucide-react';
import { AudioMeterDisplay } from './AudioMeterDisplay';
import {
  faderToDb,
  dbToFader,
  formatDb,
  formatPan,
  linearToDb,
} from '@/utils/audioMeter';

// =============================================================================
// Types
// =============================================================================

export interface ChannelLevels {
  left: number;  // Linear 0-1
  right: number; // Linear 0-1
  peakLeft?: number;
  peakRight?: number;
}

export interface MixerChannelStripProps {
  /** Channel ID */
  id: string;
  /** Channel name/label */
  name: string;
  /** Channel type for styling */
  type?: 'audio' | 'video' | 'master';
  /** Current volume in dB (-60 to +6) */
  volumeDb: number;
  /** Current pan (-1 to 1) */
  pan: number;
  /** Whether channel is muted */
  muted: boolean;
  /** Whether channel is soloed */
  soloed?: boolean;
  /** Current audio levels (for meter display) */
  levels?: ChannelLevels;
  /** Callback when volume changes */
  onVolumeChange?: (id: string, volumeDb: number) => void;
  /** Callback when pan changes */
  onPanChange?: (id: string, pan: number) => void;
  /** Callback when mute is toggled */
  onMuteToggle?: (id: string) => void;
  /** Callback when solo is toggled */
  onSoloToggle?: (id: string) => void;
  /** Whether controls are disabled */
  disabled?: boolean;
  /** Whether this is a compact view */
  compact?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const FADER_MIN_DB = -60;
const FADER_MAX_DB = 6;

const TYPE_COLORS = {
  audio: 'border-green-500',
  video: 'border-blue-500',
  master: 'border-yellow-500',
};

// =============================================================================
// Sub-components
// =============================================================================

interface FaderProps {
  value: number; // 0-1 normalized
  onChange: (value: number) => void;
  disabled: boolean;
  height: number;
}

const Fader = memo(function Fader({ value, onChange, disabled, height }: FaderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;
      e.preventDefault();
      setIsDragging(true);

      const updateValue = (clientY: number) => {
        const track = trackRef.current;
        if (!track) return;

        const rect = track.getBoundingClientRect();
        const y = clientY - rect.top;
        const normalized = 1 - Math.max(0, Math.min(1, y / rect.height));
        onChange(normalized);
      };

      updateValue(e.clientY);

      const handleMouseMove = (e: MouseEvent) => {
        updateValue(e.clientY);
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [disabled, onChange]
  );

  // Handle double-click to reset to unity (0 dB)
  const handleDoubleClick = useCallback(() => {
    if (disabled) return;
    // Unity gain (0 dB) corresponds to fader position ~0.909
    onChange(dbToFader(0, FADER_MIN_DB, FADER_MAX_DB));
  }, [disabled, onChange]);

  return (
    <div
      ref={trackRef}
      className={`relative w-6 rounded cursor-pointer ${
        disabled ? 'opacity-50 cursor-not-allowed' : ''
      }`}
      style={{
        height,
        background: 'linear-gradient(to top, #374151 0%, #4b5563 50%, #6b7280 100%)',
      }}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      data-testid="fader-track"
    >
      {/* Fader groove */}
      <div className="absolute inset-x-2 top-2 bottom-2 bg-editor-border rounded-full" />

      {/* Fader thumb */}
      <div
        className={`absolute left-0 right-0 h-6 mx-0.5 rounded transition-shadow ${
          isDragging ? 'shadow-lg shadow-primary-500/50' : ''
        }`}
        style={{
          bottom: `${value * 100}%`,
          transform: 'translateY(50%)',
          background: 'linear-gradient(to bottom, #e5e7eb, #9ca3af)',
          border: '1px solid #6b7280',
        }}
        data-testid="fader-thumb"
      />

      {/* Unity mark (0 dB) */}
      <div
        className="absolute left-0 right-0 h-px bg-yellow-500/50"
        style={{
          bottom: `${dbToFader(0, FADER_MIN_DB, FADER_MAX_DB) * 100}%`,
        }}
      />
    </div>
  );
});

interface PanKnobProps {
  value: number; // -1 to 1
  onChange: (value: number) => void;
  disabled: boolean;
}

const PanKnob = memo(function PanKnob({ value, onChange, disabled }: PanKnobProps) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(parseFloat(e.target.value));
    },
    [onChange]
  );

  // Handle double-click to center
  const handleDoubleClick = useCallback(() => {
    if (disabled) return;
    onChange(0);
  }, [disabled, onChange]);

  return (
    <div className="flex flex-col items-center gap-1" onDoubleClick={handleDoubleClick}>
      <input
        type="range"
        min="-1"
        max="1"
        step="0.01"
        value={value}
        onChange={handleChange}
        disabled={disabled}
        className="w-12 h-2 accent-primary-500 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Pan control"
        data-testid="pan-control"
      />
      <span className="text-[10px] text-editor-text-muted font-mono">
        {formatPan(value)}
      </span>
    </div>
  );
});

// =============================================================================
// Main Component
// =============================================================================

export const MixerChannelStrip = memo(function MixerChannelStrip({
  id,
  name,
  type = 'audio',
  volumeDb,
  pan,
  muted,
  soloed = false,
  levels,
  onVolumeChange,
  onPanChange,
  onMuteToggle,
  onSoloToggle,
  disabled = false,
  compact = false,
  className = '',
}: MixerChannelStripProps) {
  // Convert volumeDb to fader position
  const faderPosition = dbToFader(volumeDb, FADER_MIN_DB, FADER_MAX_DB);

  // Convert levels to dB for meter display
  const leftDb = levels?.left ? linearToDb(levels.left) : -60;
  const rightDb = levels?.right ? linearToDb(levels.right) : -60;
  const leftPeakDb = levels?.peakLeft ? linearToDb(levels.peakLeft) : undefined;
  const rightPeakDb = levels?.peakRight ? linearToDb(levels.peakRight) : undefined;

  // Handlers
  const handleFaderChange = useCallback(
    (position: number) => {
      if (onVolumeChange) {
        const db = faderToDb(position, FADER_MIN_DB, FADER_MAX_DB);
        onVolumeChange(id, db);
      }
    },
    [id, onVolumeChange]
  );

  const handlePanChange = useCallback(
    (value: number) => {
      if (onPanChange) {
        onPanChange(id, value);
      }
    },
    [id, onPanChange]
  );

  const handleMuteClick = useCallback(() => {
    if (onMuteToggle) {
      onMuteToggle(id);
    }
  }, [id, onMuteToggle]);

  const handleSoloClick = useCallback(() => {
    if (onSoloToggle) {
      onSoloToggle(id);
    }
  }, [id, onSoloToggle]);

  const faderHeight = compact ? 100 : 150;
  const meterHeight = compact ? 100 : 150;

  return (
    <div
      data-testid={`mixer-channel-${id}`}
      className={`flex flex-col items-center gap-2 p-2 bg-editor-sidebar rounded-lg border-t-2 ${
        TYPE_COLORS[type]
      } ${className}`}
    >
      {/* Channel name */}
      <div
        className="w-full text-center text-xs font-medium text-editor-text truncate px-1"
        title={name}
      >
        {name}
      </div>

      {/* Pan control (not for master) */}
      {type !== 'master' && (
        <PanKnob value={pan} onChange={handlePanChange} disabled={disabled} />
      )}

      {/* Fader and meter */}
      <div className="flex gap-1">
        {/* Stereo meters */}
        <div className="flex gap-0.5">
          <AudioMeterDisplay
            levelDb={leftDb}
            peakDb={leftPeakDb}
            clipping={levels?.left !== undefined && levels.left >= 0.99}
            size={meterHeight}
            thickness={6}
            showScale={false}
          />
          <AudioMeterDisplay
            levelDb={rightDb}
            peakDb={rightPeakDb}
            clipping={levels?.right !== undefined && levels.right >= 0.99}
            size={meterHeight}
            thickness={6}
            showScale={false}
          />
        </div>

        {/* Fader */}
        <Fader
          value={faderPosition}
          onChange={handleFaderChange}
          disabled={disabled}
          height={faderHeight}
        />
      </div>

      {/* Volume display */}
      <div
        className="text-xs font-mono text-editor-text-muted"
        data-testid="volume-display"
      >
        {formatDb(volumeDb)}
      </div>

      {/* Mute/Solo buttons */}
      <div className="flex gap-1">
        <button
          type="button"
          onClick={handleMuteClick}
          disabled={disabled}
          className={`p-1.5 rounded transition-colors ${
            muted
              ? 'bg-red-500 text-white'
              : 'bg-editor-border text-editor-text-muted hover:text-editor-text'
          } disabled:opacity-50 disabled:cursor-not-allowed`}
          aria-label={muted ? 'Unmute' : 'Mute'}
          aria-pressed={muted}
          data-testid="mute-button"
        >
          {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </button>

        {type !== 'master' && onSoloToggle && (
          <button
            type="button"
            onClick={handleSoloClick}
            disabled={disabled}
            className={`p-1.5 rounded transition-colors ${
              soloed
                ? 'bg-yellow-500 text-black'
                : 'bg-editor-border text-editor-text-muted hover:text-editor-text'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
            aria-label={soloed ? 'Unsolo' : 'Solo'}
            aria-pressed={soloed}
            data-testid="solo-button"
          >
            <Headphones className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
});

export default MixerChannelStrip;
