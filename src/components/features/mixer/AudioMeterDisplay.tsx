/**
 * AudioMeterDisplay Component
 *
 * Visual VU/peak meter for audio level monitoring.
 * Supports stereo and mono display modes with peak hold indicators.
 *
 * Features:
 * - Green/yellow/red color zones
 * - Peak hold indicator
 * - Clipping warning
 * - dB scale markings
 * - Horizontal or vertical orientation
 */

import { memo, useMemo } from 'react';
import {
  normalizeDb,
  calculateMeterSegments,
  METER_MARKINGS_DB,
  WARNING_THRESHOLD_DB,
  DANGER_THRESHOLD_DB,
} from '@/utils/audioMeter';

// =============================================================================
// Types
// =============================================================================

export type MeterOrientation = 'vertical' | 'horizontal';

export interface AudioMeterDisplayProps {
  /** Current level in dB */
  levelDb: number;
  /** Peak hold level in dB (optional) */
  peakDb?: number;
  /** Whether the channel is clipping */
  clipping?: boolean;
  /** Minimum dB for display range */
  minDb?: number;
  /** Maximum dB for display range */
  maxDb?: number;
  /** Meter orientation */
  orientation?: MeterOrientation;
  /** Width in pixels (or height for horizontal) */
  size?: number;
  /** Thickness in pixels */
  thickness?: number;
  /** Show dB scale markings */
  showScale?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const COLORS = {
  background: '#1f2937',    // gray-800
  green: '#22c55e',         // green-500
  yellow: '#eab308',        // yellow-500
  red: '#ef4444',           // red-500
  peak: '#ffffff',          // white
  clipping: '#ef4444',      // red-500
  scale: 'rgba(156, 163, 175, 0.6)', // gray-400
};

// =============================================================================
// Sub-components
// =============================================================================

interface MeterBarProps {
  levelDb: number;
  peakDb?: number;
  clipping: boolean;
  minDb: number;
  maxDb: number;
  orientation: MeterOrientation;
  size: number;
  thickness: number;
}

const MeterBar = memo(function MeterBar({
  levelDb,
  peakDb,
  clipping,
  minDb,
  maxDb,
  orientation,
  size,
  thickness,
}: MeterBarProps) {
  // Calculate meter segments
  const segments = useMemo(
    () => calculateMeterSegments(levelDb, minDb, maxDb),
    [levelDb, minDb, maxDb]
  );

  // Calculate peak position
  const peakPosition = useMemo(() => {
    if (peakDb === undefined) return null;
    return normalizeDb(peakDb, minDb, maxDb);
  }, [peakDb, minDb, maxDb]);

  const isVertical = orientation === 'vertical';

  return (
    <div
      className="relative overflow-hidden rounded-sm"
      style={{
        width: isVertical ? thickness : size,
        height: isVertical ? size : thickness,
        backgroundColor: COLORS.background,
      }}
      data-testid="meter-bar"
    >
      {/* Meter segments */}
      {segments.map((segment, index) => {
        const startPercent = segment.start * 100;
        const lengthPercent = (segment.end - segment.start) * 100;

        const style: React.CSSProperties = isVertical
          ? {
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: `${startPercent}%`,
              height: `${lengthPercent}%`,
              backgroundColor: COLORS[segment.color],
            }
          : {
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${startPercent}%`,
              width: `${lengthPercent}%`,
              backgroundColor: COLORS[segment.color],
            };

        return <div key={index} style={style} />;
      })}

      {/* Peak indicator */}
      {peakPosition !== null && peakPosition > 0 && (
        <div
          className="absolute"
          style={
            isVertical
              ? {
                  left: 0,
                  right: 0,
                  bottom: `${peakPosition * 100}%`,
                  height: 2,
                  backgroundColor: clipping ? COLORS.clipping : COLORS.peak,
                  transform: 'translateY(50%)',
                }
              : {
                  top: 0,
                  bottom: 0,
                  left: `${peakPosition * 100}%`,
                  width: 2,
                  backgroundColor: clipping ? COLORS.clipping : COLORS.peak,
                  transform: 'translateX(-50%)',
                }
          }
          data-testid="peak-indicator"
        />
      )}

      {/* Clipping indicator */}
      {clipping && (
        <div
          className="absolute animate-pulse"
          style={
            isVertical
              ? {
                  left: 0,
                  right: 0,
                  top: 0,
                  height: 4,
                  backgroundColor: COLORS.clipping,
                }
              : {
                  top: 0,
                  bottom: 0,
                  right: 0,
                  width: 4,
                  backgroundColor: COLORS.clipping,
                }
          }
          data-testid="clipping-indicator"
        />
      )}
    </div>
  );
});

interface MeterScaleProps {
  minDb: number;
  maxDb: number;
  orientation: MeterOrientation;
  size: number;
}

const MeterScale = memo(function MeterScale({
  minDb,
  maxDb,
  orientation,
  size,
}: MeterScaleProps) {
  const isVertical = orientation === 'vertical';

  // Filter markings that are within range
  const markings = METER_MARKINGS_DB.filter((db) => db >= minDb && db <= maxDb);

  return (
    <div
      className="relative"
      style={{
        width: isVertical ? 20 : size,
        height: isVertical ? size : 16,
      }}
      data-testid="meter-scale"
    >
      {markings.map((db) => {
        const position = normalizeDb(db, minDb, maxDb) * 100;
        const isWarning = db >= WARNING_THRESHOLD_DB;
        const isDanger = db >= DANGER_THRESHOLD_DB;

        return (
          <div
            key={db}
            className="absolute text-[9px] font-mono"
            style={{
              color: isDanger
                ? COLORS.red
                : isWarning
                ? COLORS.yellow
                : COLORS.scale,
              ...(isVertical
                ? {
                    bottom: `${position}%`,
                    right: 2,
                    transform: 'translateY(50%)',
                  }
                : {
                    left: `${position}%`,
                    top: 0,
                    transform: 'translateX(-50%)',
                  }),
            }}
          >
            {db}
          </div>
        );
      })}
    </div>
  );
});

// =============================================================================
// Main Component
// =============================================================================

export const AudioMeterDisplay = memo(function AudioMeterDisplay({
  levelDb,
  peakDb,
  clipping = false,
  minDb = -60,
  maxDb = 0,
  orientation = 'vertical',
  size = 150,
  thickness = 8,
  showScale = true,
  className = '',
}: AudioMeterDisplayProps) {
  const isVertical = orientation === 'vertical';

  return (
    <div
      data-testid="audio-meter-display"
      className={`flex ${isVertical ? 'flex-row' : 'flex-col'} gap-1 ${className}`}
      aria-label={`Audio meter showing ${levelDb.toFixed(1)} dB`}
    >
      {showScale && (
        <MeterScale
          minDb={minDb}
          maxDb={maxDb}
          orientation={orientation}
          size={size}
        />
      )}
      <MeterBar
        levelDb={levelDb}
        peakDb={peakDb}
        clipping={clipping}
        minDb={minDb}
        maxDb={maxDb}
        orientation={orientation}
        size={size}
        thickness={thickness}
      />
    </div>
  );
});

export default AudioMeterDisplay;
