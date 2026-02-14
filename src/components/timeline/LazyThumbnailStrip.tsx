/**
 * LazyThumbnailStrip Component
 *
 * A performance-optimized version of ThumbnailStrip that uses
 * IntersectionObserver-based lazy loading to only extract and
 * render thumbnails that are visible in the viewport.
 *
 * Use this component for clips in virtualized timelines where
 * thumbnails outside the viewport should not be loaded until
 * they become visible.
 */

import { useMemo, memo, useCallback } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useFrameExtractor, useLazyThumbnails, type ThumbnailRequest } from '@/hooks';
import { normalizeFileUriToPath } from '@/utils/uri';
import type { Asset, TimeSec } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface LazyThumbnailStripProps {
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
  /** Root margin for IntersectionObserver (controls preload distance) */
  rootMargin?: string;
  /** Maximum concurrent thumbnail extractions */
  maxConcurrent?: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_THUMBNAILS = 10;
const DEFAULT_THUMBNAIL_ASPECT_RATIO = 16 / 9;
const MIN_THUMBNAIL_WIDTH = 40;
const DEFAULT_ROOT_MARGIN = '100px';
const DEFAULT_MAX_CONCURRENT = 3;
const TIMESTAMP_PRECISION_MULTIPLIER = 1000;

function buildThumbnailRequestId(
  assetId: string,
  index: number,
  sourceInSec: number,
  sourceOutSec: number,
  timeSec: number,
): string {
  const sourceInMs = Math.round(sourceInSec * TIMESTAMP_PRECISION_MULTIPLIER);
  const sourceOutMs = Math.round(sourceOutSec * TIMESTAMP_PRECISION_MULTIPLIER);
  const timeMs = Math.round(timeSec * TIMESTAMP_PRECISION_MULTIPLIER);
  return `thumb-${assetId}-${index}-${sourceInMs}-${sourceOutMs}-${timeMs}`;
}

// =============================================================================
// Component
// =============================================================================

export const LazyThumbnailStrip = memo(function LazyThumbnailStrip({
  asset,
  sourceInSec,
  sourceOutSec,
  width,
  height,
  className = '',
  maxThumbnails = DEFAULT_MAX_THUMBNAILS,
  thumbnailAspectRatio = DEFAULT_THUMBNAIL_ASPECT_RATIO,
  rootMargin = DEFAULT_ROOT_MARGIN,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
}: LazyThumbnailStripProps) {
  const { getFrame } = useFrameExtractor();

  // Calculate optimal thumbnail count based on width
  const thumbnailCount = useMemo(() => {
    if (!asset || width <= 0) return 0;

    const duration = sourceOutSec - sourceInSec;
    if (duration <= 0) return 0;

    // Calculate thumbnail width based on height and aspect ratio
    const thumbWidth = Math.max(height * thumbnailAspectRatio, MIN_THUMBNAIL_WIDTH);

    // How many thumbnails can fit?
    const fittingCount = Math.floor(width / thumbWidth);

    // Limit to max and ensure at least 1
    return Math.min(Math.max(fittingCount, 1), maxThumbnails);
  }, [asset, width, height, sourceInSec, sourceOutSec, maxThumbnails, thumbnailAspectRatio]);

  // Generate thumbnail requests
  const thumbnailRequests = useMemo((): ThumbnailRequest[] => {
    if (!asset || thumbnailCount <= 0) return [];

    const assetPath = normalizeFileUriToPath(asset.uri);

    const duration = sourceOutSec - sourceInSec;
    const interval = duration / thumbnailCount;

    return Array.from({ length: thumbnailCount }, (_, i) => {
      // Place thumbnail at center of each interval
      const timeSec = sourceInSec + interval * (i + 0.5);
      return {
        id: buildThumbnailRequestId(asset.id, i, sourceInSec, sourceOutSec, timeSec),
        timeSec,
        assetPath,
      };
    });
  }, [asset, thumbnailCount, sourceInSec, sourceOutSec]);

  // Wrap getFrame with convertFileSrc for use in lazy loading
  const extractFrame = useCallback(
    async (assetPath: string, timeSec: number): Promise<string | null> => {
      const framePath = await getFrame(assetPath, timeSec);
      if (framePath) {
        return convertFileSrc(framePath);
      }
      return null;
    },
    [getFrame],
  );

  // Use lazy thumbnails hook
  const { thumbnails, registerRef, loadingCount } = useLazyThumbnails(thumbnailRequests, {
    extractFrame,
    rootMargin,
    maxConcurrent,
  });

  // Empty state
  if (!asset || thumbnailCount === 0) {
    return (
      <div
        data-testid="lazy-thumbnail-strip-empty"
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
      data-testid="lazy-thumbnail-strip"
      className={`relative flex overflow-hidden ${className}`}
      style={{ width, height }}
    >
      {thumbnailRequests.map((request, index) => {
        const state = thumbnails[request.id];
        const hasLoaded = state?.src !== null && state?.src !== undefined;
        const isLoading = state?.loading ?? false;
        const hasError = state?.error ?? false;

        return (
          <div
            key={request.id}
            ref={(el) => registerRef(request.id, el)}
            data-testid={`lazy-thumbnail-${index}`}
            className="relative flex-shrink-0 bg-gray-800"
            style={{ width: thumbnailWidth, height }}
          >
            {/* Loading placeholder */}
            {isLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-700">
                <div className="w-4 h-4 border border-gray-500 border-t-transparent rounded-full animate-spin" />
              </div>
            )}

            {/* Thumbnail image */}
            {hasLoaded && !isLoading && state?.src && (
              <img
                src={state.src}
                alt={`Frame at ${request.timeSec.toFixed(2)}s`}
                className="absolute inset-0 w-full h-full object-cover"
              />
            )}

            {/* Error placeholder */}
            {hasError && !isLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-700">
                <span className="text-gray-500 text-xs">!</span>
              </div>
            )}

            {/* Pending placeholder (not yet started loading) */}
            {!isLoading && !hasLoaded && !hasError && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
                <div className="w-2 h-2 bg-gray-600 rounded-full" />
              </div>
            )}
          </div>
        );
      })}

      {/* Loading overlay for global extraction */}
      {loadingCount > 0 && loadingCount === thumbnailRequests.length && (
        <div
          data-testid="lazy-thumbnail-strip-loading"
          className="absolute inset-0 flex items-center justify-center bg-gray-800 bg-opacity-50"
        >
          <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
        </div>
      )}
    </div>
  );
});

export default LazyThumbnailStrip;
