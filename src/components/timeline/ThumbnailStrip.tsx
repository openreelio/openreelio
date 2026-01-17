/**
 * ThumbnailStrip Component
 *
 * Displays a strip of video thumbnails for a clip on the timeline.
 * Used to show visual preview of video content within clips.
 */

import { useMemo, useState, useEffect, useCallback, memo } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useFrameExtractor } from '@/hooks';
import type { Asset, TimeSec } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface ThumbnailStripProps {
  /** Asset to extract thumbnails from */
  asset: Asset | null;
  /** Source start time in seconds */
  sourceInSec: TimeSec;
  /** Source end time in seconds */
  sourceOutSec: TimeSec;
  /** Width of the strip in pixels */
  width: number;
  /** Height of the strip in pixels */
  height: number;
  /** Additional CSS classes */
  className?: string;
  /** Maximum number of thumbnails to generate */
  maxThumbnails?: number;
  /** Thumbnail aspect ratio (width/height) */
  thumbnailAspectRatio?: number;
}

interface ThumbnailData {
  timeSec: number;
  src: string | null;
  loading: boolean;
  error: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_THUMBNAILS = 10;
const DEFAULT_THUMBNAIL_ASPECT_RATIO = 16 / 9;
const MIN_THUMBNAIL_WIDTH = 40;

// =============================================================================
// Component
// =============================================================================

export const ThumbnailStrip = memo(function ThumbnailStrip({
  asset,
  sourceInSec,
  sourceOutSec,
  width,
  height,
  className = '',
  maxThumbnails = DEFAULT_MAX_THUMBNAILS,
  thumbnailAspectRatio = DEFAULT_THUMBNAIL_ASPECT_RATIO,
}: ThumbnailStripProps) {
  const [thumbnails, setThumbnails] = useState<ThumbnailData[]>([]);

  const { getFrame, isExtracting } = useFrameExtractor();

  // Calculate optimal thumbnail count based on width
  const thumbnailCount = useMemo(() => {
    if (!asset || width <= 0) return 0;

    const duration = sourceOutSec - sourceInSec;
    if (duration <= 0) return 0;

    // Calculate thumbnail width based on height and aspect ratio
    const thumbnailWidth = Math.max(height * thumbnailAspectRatio, MIN_THUMBNAIL_WIDTH);

    // How many thumbnails can fit?
    const fittingCount = Math.floor(width / thumbnailWidth);

    // Limit to max and ensure at least 1
    return Math.min(Math.max(fittingCount, 1), maxThumbnails);
  }, [asset, width, height, sourceInSec, sourceOutSec, maxThumbnails, thumbnailAspectRatio]);

  // Calculate thumbnail times
  const thumbnailTimes = useMemo(() => {
    if (thumbnailCount <= 0) return [];

    const duration = sourceOutSec - sourceInSec;
    const interval = duration / thumbnailCount;

    return Array.from({ length: thumbnailCount }, (_, i) => {
      // Place thumbnail at center of each interval
      return sourceInSec + interval * (i + 0.5);
    });
  }, [thumbnailCount, sourceInSec, sourceOutSec]);

  // Load thumbnails
  const loadThumbnails = useCallback(async () => {
    if (!asset || thumbnailTimes.length === 0) {
      setThumbnails([]);
      return;
    }

    // Get asset path
    let assetPath = asset.uri;
    if (assetPath.startsWith('file://')) {
      assetPath = assetPath.replace('file://', '');
    }

    // Initialize thumbnail data
    const initialThumbnails: ThumbnailData[] = thumbnailTimes.map((timeSec) => ({
      timeSec,
      src: null,
      loading: true,
      error: false,
    }));
    setThumbnails(initialThumbnails);

    // Load each thumbnail
    const loadPromises = thumbnailTimes.map(async (timeSec, index) => {
      try {
        const framePath = await getFrame(assetPath, timeSec);
        if (framePath) {
          const src = convertFileSrc(framePath);
          setThumbnails((prev) => {
            const next = [...prev];
            if (next[index]) {
              next[index] = { ...next[index], src, loading: false };
            }
            return next;
          });
        } else {
          setThumbnails((prev) => {
            const next = [...prev];
            if (next[index]) {
              next[index] = { ...next[index], loading: false, error: true };
            }
            return next;
          });
        }
      } catch {
        setThumbnails((prev) => {
          const next = [...prev];
          if (next[index]) {
            next[index] = { ...next[index], loading: false, error: true };
          }
          return next;
        });
      }
    });

    await Promise.all(loadPromises);
  }, [asset, thumbnailTimes, getFrame]);

  // Load thumbnails when dependencies change
  useEffect(() => {
    void loadThumbnails();
  }, [loadThumbnails]);

  // Empty state
  if (!asset || thumbnailCount === 0) {
    return (
      <div
        data-testid="thumbnail-strip-empty"
        className={`flex items-center justify-center bg-gray-800 ${className}`}
        style={{ width, height }}
      >
        <span className="text-gray-500 text-xs">No preview</span>
      </div>
    );
  }

  // Calculate individual thumbnail width
  const thumbnailWidth = width / thumbnailCount;

  return (
    <div
      data-testid="thumbnail-strip"
      className={`flex overflow-hidden ${className}`}
      style={{ width, height }}
    >
      {thumbnails.map((thumb, index) => (
        <div
          key={`${thumb.timeSec}-${index}`}
          data-testid={`thumbnail-${index}`}
          className="relative flex-shrink-0 bg-gray-800"
          style={{ width: thumbnailWidth, height }}
        >
          {/* Loading placeholder */}
          {thumb.loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-700">
              <div className="w-4 h-4 border border-gray-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {/* Thumbnail image */}
          {thumb.src && !thumb.loading && (
            <img
              src={thumb.src}
              alt={`Frame at ${thumb.timeSec.toFixed(2)}s`}
              className="absolute inset-0 w-full h-full object-cover"
              loading="lazy"
            />
          )}

          {/* Error placeholder */}
          {thumb.error && !thumb.loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-700">
              <span className="text-gray-500 text-xs">!</span>
            </div>
          )}
        </div>
      ))}

      {/* Loading overlay for global extraction */}
      {isExtracting && thumbnails.every((t) => t.loading) && (
        <div
          data-testid="thumbnail-strip-loading"
          className="absolute inset-0 flex items-center justify-center bg-gray-800 bg-opacity-50"
        >
          <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
        </div>
      )}
    </div>
  );
});
