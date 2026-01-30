/**
 * ThumbnailStrip Component
 *
 * Displays a strip of video thumbnails for a clip on the timeline.
 * Uses IntersectionObserver for lazy loading to optimize performance
 * on long timelines with many clips.
 */

import { memo, useEffect, useMemo, useState, useRef, useCallback } from 'react';
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
  isVisible: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_THUMBNAILS = 10;
const DEFAULT_THUMBNAIL_ASPECT_RATIO = 16 / 9;
const MIN_THUMBNAIL_WIDTH = 40;
/** Pre-load margin for IntersectionObserver */
const PRELOAD_MARGIN = '50px';

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
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbnailRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);

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

  // Initialize thumbnails with isVisible: false for lazy loading
  useEffect(() => {
    if (!asset || !assetPath || thumbnailTimes.length === 0) {
      setThumbnails([]);
      return;
    }

    const initialThumbnails: ThumbnailData[] = thumbnailTimes.map((timeSec) => ({
      timeSec,
      src: null,
      loading: false,
      error: false,
      isVisible: false,
    }));
    setThumbnails(initialThumbnails);
  }, [asset, assetPath, thumbnailTimes]);

  // Load a single thumbnail
  const loadThumbnail = useCallback(
    async (index: number, timeSec: number) => {
      if (!asset || !assetPath) return;

      // Mark as loading
      setThumbnails((prev) => {
        const next = [...prev];
        if (next[index] && !next[index].src && !next[index].loading) {
          next[index] = { ...next[index], loading: true };
        }
        return next;
      });

      try {
        const framePath = await getFrame(assetPath, timeSec);
        if (!framePath) {
          logger.warn('Thumbnail extraction returned empty result', {
            assetId: asset.id,
            timeSec,
            assetPath,
          });
          setThumbnails((prev) => {
            const next = [...prev];
            if (next[index]) {
              next[index] = { ...next[index], loading: false, error: true };
            }
            return next;
          });
          return;
        }
        setThumbnails((prev) => {
          const next = [...prev];
          if (next[index]) {
            next[index] = {
              ...next[index],
              src: convertFileSrc(framePath),
              loading: false,
              error: false,
            };
          }
          return next;
        });
      } catch (err) {
        logger.error('Thumbnail extraction threw', {
          assetId: asset.id,
          timeSec,
          error: err instanceof Error ? err.message : String(err),
        });
        setThumbnails((prev) => {
          const next = [...prev];
          if (next[index]) {
            next[index] = { ...next[index], loading: false, error: true };
          }
          return next;
        });
      }
    },
    [asset, assetPath, getFrame]
  );

  // Set up IntersectionObserver for lazy loading
  useEffect(() => {
    if (thumbnails.length === 0) return;

    // Clean up previous observer
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const indexAttr = entry.target.getAttribute('data-index');
            if (indexAttr === null) return;
            const index = parseInt(indexAttr, 10);
            if (Number.isNaN(index)) return;

            // Mark as visible and trigger load
            setThumbnails((prev) => {
              const thumb = prev[index];
              if (!thumb || thumb.isVisible) return prev;

              const next = [...prev];
              next[index] = { ...next[index], isVisible: true };
              return next;
            });
          }
        });
      },
      {
        root: null, // Use viewport
        rootMargin: PRELOAD_MARGIN,
        threshold: 0,
      }
    );

    observerRef.current = observer;

    // Observe all thumbnail elements
    thumbnailRefs.current.forEach((element) => {
      observer.observe(element);
    });

    return () => {
      observer.disconnect();
    };
  }, [thumbnails.length]);

  // Load visible thumbnails
  useEffect(() => {
    thumbnails.forEach((thumb, index) => {
      if (thumb.isVisible && !thumb.src && !thumb.loading && !thumb.error) {
        void loadThumbnail(index, thumb.timeSec);
      }
    });
  }, [thumbnails, loadThumbnail]);

  // Callback ref for thumbnail elements
  const setThumbnailRef = useCallback(
    (index: number, element: HTMLDivElement | null) => {
      if (element) {
        thumbnailRefs.current.set(index, element);
        // Observe immediately if observer exists
        if (observerRef.current) {
          observerRef.current.observe(element);
        }
      } else {
        const existing = thumbnailRefs.current.get(index);
        if (existing && observerRef.current) {
          observerRef.current.unobserve(existing);
        }
        thumbnailRefs.current.delete(index);
      }
    },
    []
  );

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
      ref={containerRef}
      data-testid="thumbnail-strip"
      className={`relative flex overflow-hidden ${className}`}
      style={{ width, height }}
    >
      {thumbnails.map((thumb, index) => (
        <div
          key={`${thumb.timeSec}-${index}`}
          ref={(el) => setThumbnailRef(index, el)}
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

          {/* Placeholder for not-yet-visible thumbnails */}
          {!thumb.isVisible && !thumb.loading && !thumb.src && !thumb.error && (
            <div className="absolute inset-0 bg-gray-800" />
          )}
        </div>
      ))}

      {isExtracting && thumbnails.length > 0 && thumbnails.some((t) => t.loading) && (
        <div
          data-testid="thumbnail-strip-loading"
          className="absolute inset-0 flex items-center justify-center bg-gray-800 bg-opacity-50 pointer-events-none"
        >
          <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
        </div>
      )}
    </div>
  );
});
