/**
 * ThumbnailStrip Component
 *
 * Displays a strip of video thumbnails for a clip on the timeline.
 * Used to show visual preview of video content within clips.
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useFrameExtractor } from '@/hooks';
import { normalizeFileUriToPath } from '@/utils/uri';
import type { Asset, TimeSec } from '@/types';
import { createLogger } from '@/services/logger';

const logger = createLogger('ThumbnailStrip');

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

  const assetPath = useMemo(() => {
    if (!asset) return null;
    return normalizeFileUriToPath(asset.uri);
  }, [asset]);

  const thumbnailCount = useMemo(() => {
    if (!asset || width <= 0) return 0;

    const duration = sourceOutSec - sourceInSec;
    if (duration <= 0) return 0;

    const thumbnailWidth = Math.max(height * thumbnailAspectRatio, MIN_THUMBNAIL_WIDTH);
    const fittingCount = Math.floor(width / thumbnailWidth);

    return Math.min(Math.max(fittingCount, 1), maxThumbnails);
  }, [asset, width, height, sourceInSec, sourceOutSec, maxThumbnails, thumbnailAspectRatio]);

  const thumbnailTimes = useMemo(() => {
    if (thumbnailCount <= 0) return [];

    const duration = sourceOutSec - sourceInSec;
    const interval = duration / thumbnailCount;

    return Array.from({ length: thumbnailCount }, (_, i) => sourceInSec + interval * (i + 0.5));
  }, [thumbnailCount, sourceInSec, sourceOutSec]);

  useEffect(() => {
    if (!asset || !assetPath || thumbnailTimes.length === 0) {
      setThumbnails([]);
      return;
    }

    let isActive = true;

    const initialThumbnails: ThumbnailData[] = thumbnailTimes.map((timeSec) => ({
      timeSec,
      src: null,
      loading: true,
      error: false,
    }));
    setThumbnails(initialThumbnails);

    const loadThumbnails = async () => {
      const results = await Promise.all(
        thumbnailTimes.map(async (timeSec): Promise<ThumbnailData> => {
          try {
            const framePath = await getFrame(assetPath, timeSec);
            if (!isActive) return { timeSec, src: null, loading: false, error: true };
            if (!framePath) {
              logger.warn('Thumbnail extraction returned empty result', { assetId: asset.id, timeSec, assetPath });
              return { timeSec, src: null, loading: false, error: true };
            }
            return { timeSec, src: convertFileSrc(framePath), loading: false, error: false };
          } catch (err) {
            logger.error('Thumbnail extraction threw', {
              assetId: asset.id,
              timeSec,
              error: err instanceof Error ? err.message : String(err),
            });
            return { timeSec, src: null, loading: false, error: true };
          }
        }),
      );

      if (!isActive) return;
      setThumbnails(results);
    };

    void loadThumbnails();

    return () => {
      isActive = false;
    };
  }, [asset, assetPath, getFrame, thumbnailTimes]);

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

  const thumbnailWidth = width / thumbnailCount;

  return (
    <div
      data-testid="thumbnail-strip"
      className={`relative flex overflow-hidden ${className}`}
      style={{ width, height }}
    >
      {thumbnails.map((thumb, index) => (
        <div
          key={`${thumb.timeSec}-${index}`}
          data-testid={`thumbnail-${index}`}
          data-index={index}
          className="relative flex-shrink-0 bg-gray-800"
          style={{ width: thumbnailWidth, height }}
        >
          {thumb.loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-700">
              <div className="w-4 h-4 border border-gray-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {thumb.src && !thumb.loading && (
            <img
              src={thumb.src}
              alt={`Frame at ${thumb.timeSec.toFixed(2)}s`}
              className="absolute inset-0 w-full h-full object-cover"
              loading="lazy"
            />
          )}

          {thumb.error && !thumb.loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-700">
              <span className="text-gray-500 text-xs">!</span>
            </div>
          )}
        </div>
      ))}

      {isExtracting && thumbnails.length > 0 && thumbnails.every((t) => t.loading) && (
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
