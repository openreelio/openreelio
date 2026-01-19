/**
 * AudioClipWaveform Component
 *
 * Displays audio waveform visualization on timeline clips.
 * Uses the useAudioWaveform hook to generate and cache waveform images.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAudioWaveform } from '@/hooks';
import { createLogger } from '@/services/logger';

const logger = createLogger('AudioClipWaveform');

// =============================================================================
// Types
// =============================================================================

export interface AudioClipWaveformProps {
  /** Asset ID for caching */
  assetId: string;
  /** Path to the audio/video file */
  inputPath: string;
  /** Width of the waveform display in pixels */
  width: number;
  /** Height of the waveform display in pixels */
  height: number;
  /** Waveform color (CSS color string) */
  color?: string;
  /** Waveform opacity (0-1) */
  opacity?: number;
  /** Whether waveform generation is disabled */
  disabled?: boolean;
  /** Show loading indicator while generating */
  showLoadingIndicator?: boolean;
  /** Source in time for clipping (seconds) */
  sourceInSec?: number;
  /** Source out time for clipping (seconds) */
  sourceOutSec?: number;
  /** Total asset duration for calculating clip region (seconds) */
  totalDurationSec?: number;
  /** Additional CSS class name */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Minimum width to request waveform generation (to avoid generating tiny waveforms) */
const MIN_WAVEFORM_WIDTH = 50;

/** Default waveform height for generation */
const DEFAULT_GENERATION_HEIGHT = 100;

// =============================================================================
// Helpers
// =============================================================================

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function calculateClipRegionPercent({
  sourceInSec,
  sourceOutSec,
  totalDurationSec,
}: Pick<AudioClipWaveformProps, 'sourceInSec' | 'sourceOutSec' | 'totalDurationSec'>): {
  offsetPercent: number;
  widthPercent: number;
} {
  if (!totalDurationSec || totalDurationSec <= 0) {
    return { offsetPercent: 0, widthPercent: 100 };
  }

  const clampedInSec = clampNumber(sourceInSec ?? 0, 0, totalDurationSec);
  const clampedOutSec = clampNumber(sourceOutSec ?? totalDurationSec, 0, totalDurationSec);

  if (clampedOutSec <= clampedInSec) {
    return { offsetPercent: 0, widthPercent: 100 };
  }

  const offsetPercent = (clampedInSec / totalDurationSec) * 100;
  const widthPercent = ((clampedOutSec - clampedInSec) / totalDurationSec) * 100;

  return {
    offsetPercent,
    widthPercent: clampNumber(widthPercent, 0, 100),
  };
}

// =============================================================================
// Component
// =============================================================================

export function AudioClipWaveform({
  assetId,
  inputPath,
  width,
  height,
  color,
  opacity = 1,
  disabled = false,
  showLoadingIndicator = true,
  sourceInSec = 0,
  sourceOutSec,
  totalDurationSec,
  className = '',
}: AudioClipWaveformProps): JSX.Element | null {
  const [waveformSrc, setWaveformSrc] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const { getWaveform } = useAudioWaveform();

  const shouldRequestWaveform =
    assetId.length > 0 && inputPath.length > 0 && width >= MIN_WAVEFORM_WIDTH;

  // Calculate clip region as percentage of total duration
  const clipRegion = useMemo(() => {
    return calculateClipRegionPercent({ sourceInSec, sourceOutSec, totalDurationSec });
  }, [sourceInSec, sourceOutSec, totalDurationSec]);

  // Generate waveform on mount or when dependencies change
  useEffect(() => {
    if (disabled || !shouldRequestWaveform) {
      setIsLoading(false);
      setWaveformSrc(null);
      return;
    }

    let isActive = true;

    // Reset state
    setIsLoading(true);

    const generateWaveform = async () => {
      try {
        // Request waveform generation at a standard height
        // We'll scale it in CSS for display
        const result = await getWaveform(assetId, inputPath, width, DEFAULT_GENERATION_HEIGHT);

        if (isActive) {
          setWaveformSrc(result);
          setIsLoading(false);
        }
      } catch (error) {
        logger.error('Failed to generate waveform', { error });
        if (isActive) {
          setWaveformSrc(null);
          setIsLoading(false);
        }
      }
    };

    void generateWaveform();

    // Cleanup: mark this effect as inactive when dependencies change or unmount
    return () => {
      isActive = false;
    };
  }, [assetId, inputPath, width, disabled, shouldRequestWaveform, getWaveform]);

  // Don't render if disabled
  if (disabled) {
    return null;
  }

  // Container styles
  const containerStyle: React.CSSProperties = {
    width: `${width}px`,
    height: `${height}px`,
    opacity,
    position: 'relative',
    overflow: 'hidden',
  };

  // Waveform image styles with clip region calculation
  const safeWidthPercent = clipRegion.widthPercent <= 0 ? 100 : clipRegion.widthPercent;
  const scalePercent = (100 / safeWidthPercent) * 100;
  const imageStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    // Shift the image to show only the clipped region
    left: `-${clipRegion.offsetPercent}%`,
    // Scale the image so the visible portion fills the container
    width: `${scalePercent}%`,
    height: '100%',
    objectFit: 'fill',
    ...(color && { filter: `drop-shadow(0 0 0 ${color})` }),
  };

  return (
    <div
      data-testid="waveform-container"
      className={`pointer-events-none ${className}`}
      style={containerStyle}
    >
      {/* Loading indicator */}
      {isLoading && showLoadingIndicator && (
        <div
          data-testid="waveform-loading"
          className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-20"
        >
          <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Waveform image */}
      {waveformSrc && !isLoading && (
        <img
          src={waveformSrc}
          alt=""
          style={imageStyle}
          className="select-none"
          draggable={false}
        />
      )}

      {/* Fallback pattern for error or loading state */}
      {!waveformSrc && !isLoading && (
        <div
          className="absolute inset-0 opacity-30"
          style={{
            background: color
              ? `repeating-linear-gradient(90deg, ${color} 0px, ${color} 2px, transparent 2px, transparent 4px)`
              : 'repeating-linear-gradient(90deg, currentColor 0px, currentColor 2px, transparent 2px, transparent 4px)',
          }}
        />
      )}
    </div>
  );
}
