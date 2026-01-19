/**
 * ThumbnailStrip Component
 *
 * Displays a strip of video thumbnails for a clip on the timeline.
 * Used to show visual preview of video content within clips.
 */

import { useMemo, useState, useEffect, useRef, useCallback, memo } from 'react';
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
  /** Whether this thumbnail is visible in viewport (for lazy loading) */
  isVisible: boolean;
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
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbnailRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // Counter to trigger load effect when new thumbnails become visible
  const [loadTrigger, setLoadTrigger] = useState(0);

  const { getFrame, isExtracting } = useFrameExtractor();

  // Mark a thumbnail as visible (triggered by IntersectionObserver)
  const markVisible = useCallback((index: number) => {
    setThumbnails((prev) => {
      if (prev[index]?.isVisible) return prev; // Already visible
      const next = [...prev];
      if (next[index]) {
        next[index] = { ...next[index], isVisible: true };
      }
      return next;
    });
    // Trigger load effect
    setLoadTrigger((prev) => prev + 1);
  }, []);

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

  // Initialize thumbnails when dependencies change
  useEffect(() => {
    if (!asset || thumbnailTimes.length === 0) {
      setThumbnails([]);
      return;
    }

    // Initialize thumbnail data (isVisible: false, will be set by IntersectionObserver)
    const initialThumbnails: ThumbnailData[] = thumbnailTimes.map((timeSec) => ({
      timeSec,
      src: null,
      loading: false,
      error: false,
      isVisible: false,
    }));
    setThumbnails(initialThumbnails);
  }, [asset, thumbnailTimes]);

  // Set up IntersectionObserver for lazy loading
  useEffect(() => {
    const container = containerRef.current;
    if (!container || thumbnails.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const index = Number(entry.target.getAttribute('data-index'));
            if (!isNaN(index)) {
              markVisible(index);
            }
          }
        });
      },
      {
        root: null, // Use viewport
        rootMargin: '50px', // Pre-load slightly before entering viewport
        threshold: 0,
      },
    );

    // Observe all thumbnail elements
    thumbnailRefs.current.forEach((element) => {
      observer.observe(element);
    });

    return () => {
      observer.disconnect();
    };
  }, [thumbnails.length, markVisible]);

  // Load visible thumbnails when loadTrigger changes (triggered by markVisible)
  useEffect(() => {
    if (!asset) return;

    // Track whether this effect is still active (for cleanup)
    let isActive = true;

    // Get asset path
    let assetPath = asset.uri;
    if (assetPath.startsWith('file://')) {
      assetPath = assetPath.replace('file://', '');
    }

    // Find thumbnails that are visible but not yet loaded (use functional update to get latest state)
    setThumbnails((currentThumbnails) => {
      const thumbsToLoad = currentThumbnails
        .map((thumb, index) => ({ thumb, index }))
        .filter(({ thumb }) => thumb.isVisible && !thumb.src && !thumb.loading && !thumb.error);

      if (thumbsToLoad.length === 0) return currentThumbnails;

      // Mark as loading
      const next = [...currentThumbnails];
      thumbsToLoad.forEach(({ index }) => {
        if (next[index]) {
          next[index] = { ...next[index], loading: true };
        }
      });

      // Load each visible thumbnail asynchronously
      const loadVisibleThumbnails = async () => {
        const loadPromises = thumbsToLoad.map(async ({ thumb, index }) => {
          try {
            const framePath = await getFrame(assetPath, thumb.timeSec);

            // Check if component is still mounted before updating state
            if (!isActive) return;

            if (framePath) {
              const src = convertFileSrc(framePath);
              setThumbnails((prev) => {
                const updated = [...prev];
                if (updated[index]) {
                  updated[index] = { ...updated[index], src, loading: false };
                }
                return updated;
              });
            } else {
              setThumbnails((prev) => {
                const updated = [...prev];
                if (updated[index]) {
                  updated[index] = { ...updated[index], loading: false, error: true };
                }
                return updated;
              });
            }
          } catch {
            // Check if component is still mounted before updating state
            if (!isActive) return;

            setThumbnails((prev) => {
              const updated = [...prev];
              if (updated[index]) {
                updated[index] = { ...updated[index], loading: false, error: true };
              }
              return updated;
            });
          }
        });

        await Promise.all(loadPromises);
      };

      void loadVisibleThumbnails();

      return next;
    });

    // Cleanup: mark effect as inactive to prevent state updates after unmount
    return () => {
      isActive = false;
    };
  }, [asset, getFrame, loadTrigger]);

  // Callback ref to register thumbnail elements for IntersectionObserver
  const setThumbnailRef = useCallback((index: number, element: HTMLDivElement | null) => {
    if (element) {
      thumbnailRefs.current.set(index, element);
    } else {
      thumbnailRefs.current.delete(index);
    }
  }, []);

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
      ref={containerRef}
      data-testid="thumbnail-strip"
      className={`flex overflow-hidden ${className}`}
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
