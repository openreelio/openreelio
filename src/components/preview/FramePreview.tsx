/**
 * FramePreview Component
 *
 * Displays a single video frame extracted via FFmpeg.
 * Optimized for timeline scrubbing with frame caching.
 */

import { useState, useEffect, useRef, memo } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useFrameExtractor } from '@/hooks';
import type { Asset, TimeSec } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface FramePreviewProps {
  /** Asset to extract frame from */
  asset: Asset | null;
  /** Time in seconds to extract frame at */
  timeSec: TimeSec;
  /** Additional CSS classes */
  className?: string;
  /** Width of the preview (for aspect ratio) */
  width?: number;
  /** Height of the preview (for aspect ratio) */
  height?: number;
  /** Whether to show loading indicator */
  showLoading?: boolean;
  /** Callback when frame is loaded */
  onFrameLoaded?: (framePath: string) => void;
  /** Callback when error occurs */
  onError?: (error: string) => void;
}

// =============================================================================
// Constants
// =============================================================================

const DEBOUNCE_DELAY_MS = 100;
const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 180;

// =============================================================================
// Component
// =============================================================================

export const FramePreview = memo(function FramePreview({
  asset,
  timeSec,
  className = '',
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  showLoading = true,
  onFrameLoaded,
  onError,
}: FramePreviewProps) {
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { getFrame, isExtracting, error: extractorError } = useFrameExtractor();

  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRequestRef = useRef<{ assetId: string; timeSec: number } | null>(null);

  /**
   * Debounced frame loading for smooth scrubbing
   */
  useEffect(() => {
    if (!asset) {
      setFrameSrc(null);
      setIsLoading(false);
      return;
    }

    // Track whether this effect is still active (for cleanup)
    let isActive = true;

    // Clear any existing timeout
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    debounceTimeoutRef.current = setTimeout(() => {
      // Skip if same request
      if (
        lastRequestRef.current?.assetId === asset.id &&
        lastRequestRef.current?.timeSec === timeSec
      ) {
        return;
      }

      lastRequestRef.current = { assetId: asset.id, timeSec };
      setIsLoading(true);
      setError(null);

      const loadFrame = async () => {
        try {
          // Get asset path (remove file:// prefix if present)
          let assetPath = asset.uri;
          if (assetPath.startsWith('file://')) {
            assetPath = assetPath.replace('file://', '');
          }

          const framePath = await getFrame(assetPath, timeSec);

          // Check if component is still mounted before updating state
          if (!isActive) return;

          if (framePath) {
            // Convert to Tauri asset protocol URL
            const src = convertFileSrc(framePath);
            setFrameSrc(src);
            onFrameLoaded?.(framePath);
          } else {
            setError('Failed to extract frame');
            onError?.('Failed to extract frame');
          }
        } catch (err) {
          // Check if component is still mounted before updating state
          if (!isActive) return;

          const errorMessage = err instanceof Error ? err.message : 'Unknown error';
          setError(errorMessage);
          onError?.(errorMessage);
        } finally {
          // Check if component is still mounted before updating state
          if (isActive) {
            setIsLoading(false);
          }
        }
      };

      void loadFrame();
    }, DEBOUNCE_DELAY_MS);

    // Cleanup: mark effect as inactive and clear timeout
    return () => {
      isActive = false;
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [asset, timeSec, getFrame, onFrameLoaded, onError]);

  // Sync extractor error
  useEffect(() => {
    if (extractorError) {
      setError(extractorError);
    }
  }, [extractorError]);

  // Empty state
  if (!asset) {
    return (
      <div
        data-testid="frame-preview-empty"
        className={`flex items-center justify-center bg-gray-900 ${className}`}
        style={{ width, height }}
      >
        <span className="text-gray-500 text-sm">No asset</span>
      </div>
    );
  }

  // Error state
  if (error && !isLoading) {
    return (
      <div
        data-testid="frame-preview-error"
        className={`flex items-center justify-center bg-gray-900 ${className}`}
        style={{ width, height }}
      >
        <div className="text-center text-red-400">
          <svg
            className="w-8 h-8 mx-auto mb-1"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <span className="text-xs">Error</span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="frame-preview"
      className={`relative bg-gray-900 overflow-hidden ${className}`}
      style={{ width, height }}
    >
      {/* Frame Image */}
      {frameSrc && (
        <img
          data-testid="frame-preview-image"
          src={frameSrc}
          alt={`Frame at ${timeSec.toFixed(2)}s`}
          className="absolute inset-0 w-full h-full object-contain"
          loading="lazy"
        />
      )}

      {/* Loading Indicator */}
      {showLoading && (isLoading || isExtracting) && (
        <div
          data-testid="frame-preview-loading"
          className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50"
        >
          <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Time Badge */}
      <div className="absolute bottom-1 right-1 bg-black bg-opacity-70 text-white text-xs px-1 py-0.5 rounded">
        {formatTime(timeSec)}
      </div>
    </div>
  );
});

// =============================================================================
// Helpers
// =============================================================================

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}
