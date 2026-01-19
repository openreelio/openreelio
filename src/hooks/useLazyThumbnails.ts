/**
 * useLazyThumbnails Hook
 *
 * Provides viewport-based lazy loading for video thumbnails using IntersectionObserver.
 * Only loads thumbnails when they become visible in the viewport, with configurable
 * buffer zone and concurrency limits.
 *
 * This significantly improves performance for timelines with many clips
 * by avoiding upfront thumbnail extraction for off-screen clips.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface ThumbnailRequest {
  /** Unique identifier for the thumbnail */
  id: string;
  /** Time in seconds to extract the frame from */
  timeSec: number;
  /** Path to the source video file */
  assetPath: string;
}

export interface ThumbnailState {
  /** URL or path to the extracted frame image */
  src: string | null;
  /** Whether the thumbnail is currently being extracted */
  loading: boolean;
  /** Whether extraction failed */
  error: boolean;
}

export interface LazyThumbnailsConfig {
  /** Function to extract a frame from a video */
  extractFrame: (assetPath: string, timeSec: number) => Promise<string | null>;
  /** Root margin for IntersectionObserver (default: '100px') */
  rootMargin?: string;
  /** Maximum concurrent extractions (default: 3) */
  maxConcurrent?: number;
  /** Root element for IntersectionObserver (default: null = viewport) */
  root?: Element | null;
}

export interface UseLazyThumbnailsResult {
  /** Map of thumbnail ID to its state */
  thumbnails: Record<string, ThumbnailState>;
  /** Register an element ref for a thumbnail */
  registerRef: (id: string, element: HTMLElement | null) => void;
  /** Number of thumbnails currently loading */
  loadingCount: number;
  /** Number of thumbnails successfully loaded */
  loadedCount: number;
  /** Get state for a specific thumbnail */
  getThumbnailState: (id: string) => ThumbnailState;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_ROOT_MARGIN = '100px';
const DEFAULT_MAX_CONCURRENT = 3;

const DEFAULT_THUMBNAIL_STATE: ThumbnailState = {
  src: null,
  loading: false,
  error: false,
};

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook for lazy loading video thumbnails based on viewport visibility.
 *
 * @param requests - Array of thumbnail requests to manage
 * @param config - Configuration options
 * @returns Object containing thumbnail states and registration functions
 *
 * @example
 * ```tsx
 * const { thumbnails, registerRef } = useLazyThumbnails(
 *   thumbnailRequests,
 *   { extractFrame: myExtractFunction }
 * );
 *
 * return (
 *   <div>
 *     {requests.map(req => (
 *       <div key={req.id} ref={(el) => registerRef(req.id, el)}>
 *         {thumbnails[req.id]?.src && (
 *           <img src={thumbnails[req.id].src} />
 *         )}
 *       </div>
 *     ))}
 *   </div>
 * );
 * ```
 */
export function useLazyThumbnails(
  requests: ThumbnailRequest[],
  config: LazyThumbnailsConfig
): UseLazyThumbnailsResult {
  const {
    extractFrame,
    rootMargin = DEFAULT_ROOT_MARGIN,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    root = null,
  } = config;

  // State for thumbnail data
  const [thumbnails, setThumbnails] = useState<Record<string, ThumbnailState>>({});

  // Refs for tracking - using refs to avoid re-creating observer
  const elementMapRef = useRef<Map<string, HTMLElement>>(new Map());
  const idMapRef = useRef<Map<HTMLElement, string>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const pendingQueueRef = useRef<ThumbnailRequest[]>([]);
  const activeExtractionsRef = useRef<Set<string>>(new Set());
  const loadedIdsRef = useRef<Set<string>>(new Set());
  const loadingIdsRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  // Keep refs in sync with state-related config
  const extractFrameRef = useRef(extractFrame);
  const maxConcurrentRef = useRef(maxConcurrent);

  useEffect(() => {
    extractFrameRef.current = extractFrame;
  }, [extractFrame]);

  useEffect(() => {
    maxConcurrentRef.current = maxConcurrent;
  }, [maxConcurrent]);

  // Create request lookup map for quick access
  const requestMapRef = useRef<Map<string, ThumbnailRequest>>(new Map());

  useEffect(() => {
    const map = new Map<string, ThumbnailRequest>();
    for (const req of requests) {
      map.set(req.id, req);
    }
    requestMapRef.current = map;
  }, [requests]);

  // Process the pending queue - stable callback that uses refs
  const processQueue = useCallback(async () => {
    if (!mountedRef.current) return;

    while (
      pendingQueueRef.current.length > 0 &&
      activeExtractionsRef.current.size < maxConcurrentRef.current
    ) {
      const request = pendingQueueRef.current.shift();
      if (!request) break;

      // Skip if already loaded or loading (check refs, not state)
      if (loadedIdsRef.current.has(request.id) || loadingIdsRef.current.has(request.id)) {
        continue;
      }

      // Mark as loading
      activeExtractionsRef.current.add(request.id);
      loadingIdsRef.current.add(request.id);

      setThumbnails((prev) => ({
        ...prev,
        [request.id]: { src: null, loading: true, error: false },
      }));

      // Extract frame
      try {
        const framePath = await extractFrameRef.current(request.assetPath, request.timeSec);

        if (!mountedRef.current) return;

        loadingIdsRef.current.delete(request.id);

        if (framePath) {
          loadedIdsRef.current.add(request.id);
          setThumbnails((prev) => ({
            ...prev,
            [request.id]: { src: framePath, loading: false, error: false },
          }));
        } else {
          setThumbnails((prev) => ({
            ...prev,
            [request.id]: { src: null, loading: false, error: true },
          }));
        }
      } catch {
        if (!mountedRef.current) return;

        loadingIdsRef.current.delete(request.id);
        setThumbnails((prev) => ({
          ...prev,
          [request.id]: { src: null, loading: false, error: true },
        }));
      } finally {
        activeExtractionsRef.current.delete(request.id);
        // Continue processing queue
        if (mountedRef.current) {
          void processQueue();
        }
      }
    }
  }, []);

  // Handle intersection changes - stable callback
  const handleIntersection = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      if (!mountedRef.current) return;

      let hasNewItems = false;

      for (const entry of entries) {
        if (!entry.isIntersecting) continue;

        const id = idMapRef.current.get(entry.target as HTMLElement);
        if (!id) continue;

        // Check if already loaded, loading, or queued (use refs)
        if (loadedIdsRef.current.has(id) || loadingIdsRef.current.has(id)) continue;
        if (pendingQueueRef.current.some((r) => r.id === id)) continue;

        // Find the request
        const request = requestMapRef.current.get(id);
        if (!request) continue;

        // Add to queue
        pendingQueueRef.current.push(request);
        hasNewItems = true;
      }

      // Process the queue if we added items
      if (hasNewItems) {
        void processQueue();
      }
    },
    [processQueue]
  );

  // Create and manage IntersectionObserver - only recreate when root/rootMargin changes
  useEffect(() => {
    mountedRef.current = true;

    observerRef.current = new IntersectionObserver(handleIntersection, {
      root,
      rootMargin,
      threshold: 0,
    });

    // Observe all currently registered elements
    for (const element of elementMapRef.current.values()) {
      observerRef.current.observe(element);
    }

    return () => {
      mountedRef.current = false;
      observerRef.current?.disconnect();
      pendingQueueRef.current = [];
      activeExtractionsRef.current.clear();
    };
  }, [handleIntersection, root, rootMargin]);

  // Register element ref
  const registerRef = useCallback((id: string, element: HTMLElement | null) => {
    const currentElement = elementMapRef.current.get(id);

    // Unobserve old element if exists
    if (currentElement) {
      observerRef.current?.unobserve(currentElement);
      idMapRef.current.delete(currentElement);
      elementMapRef.current.delete(id);
    }

    // Observe new element if provided
    if (element) {
      elementMapRef.current.set(id, element);
      idMapRef.current.set(element, id);
      observerRef.current?.observe(element);
    }
  }, []);

  // Get state for a specific thumbnail
  const getThumbnailState = useCallback(
    (id: string): ThumbnailState => {
      return thumbnails[id] ?? DEFAULT_THUMBNAIL_STATE;
    },
    [thumbnails]
  );

  // Calculate counts
  const loadingCount = useMemo(() => {
    return Object.values(thumbnails).filter((t) => t.loading).length;
  }, [thumbnails]);

  const loadedCount = useMemo(() => {
    return Object.values(thumbnails).filter((t) => t.src !== null).length;
  }, [thumbnails]);

  return {
    thumbnails,
    registerRef,
    loadingCount,
    loadedCount,
    getThumbnailState,
  };
}
