/**
 * WaveformCacheStore
 *
 * Global Zustand store for managing audio waveform caching with:
 * - LRU (Least Recently Used) eviction policy
 * - Priority queue for loading visible waveforms first
 * - Statistics tracking for performance monitoring
 * - Concurrent generation management
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

// =============================================================================
// Types
// =============================================================================

export interface WaveformCacheEntry {
  /** Path to the generated waveform image */
  imagePath: string;
  /** Width of the waveform image */
  width: number;
  /** Height of the waveform image */
  height: number;
  /** Timestamp when the entry was added */
  createdAt: number;
  /** Timestamp when the entry was last accessed */
  lastAccessedAt: number;
}

export interface WaveformRequest {
  /** Asset ID for the waveform */
  assetId: string;
  /** Path to the source audio/video file */
  inputPath: string;
  /** Desired width of the waveform */
  width: number;
  /** Desired height of the waveform */
  height: number;
  /** Priority level for queue ordering */
  priority: 'high' | 'normal' | 'low';
}

export interface WaveformCacheStats {
  /** Number of cache hits */
  cacheHits: number;
  /** Number of cache misses */
  cacheMisses: number;
  /** Total number of waveforms generated */
  totalGenerations: number;
  /** Number of evictions performed */
  evictions: number;
}

export interface WaveformCacheState {
  /** Cached waveform entries keyed by cache key */
  entries: Record<string, WaveformCacheEntry>;
  /** Current number of entries in cache */
  cacheSize: number;
  /** Maximum number of entries allowed */
  maxCacheSize: number;
  /** Queue of pending waveform requests */
  pendingRequests: WaveformRequest[];
  /** Set of cache keys currently being generated */
  activeGenerations: Set<string>;
  /** Whether any generation is in progress */
  isGenerating: boolean;
  /** Last error that occurred */
  error: string | null;
  /** Cache statistics */
  stats: WaveformCacheStats;
}

export interface WaveformCacheActions {
  /** Add an entry to the cache */
  addToCache: (assetId: string, width: number, height: number, imagePath: string) => void;
  /** Get an entry from the cache */
  getFromCache: (assetId: string, width: number, height: number) => WaveformCacheEntry | null;
  /** Check if an entry exists in the cache */
  hasInCache: (assetId: string, width: number, height: number) => boolean;
  /** Clear all cached entries */
  clearCache: () => void;
  /** Set maximum cache size */
  setMaxCacheSize: (size: number) => void;
  /** Add a request to the queue */
  queueRequest: (request: WaveformRequest) => void;
  /** Remove a request from the queue */
  removeFromQueue: (assetId: string, width: number, height: number) => void;
  /** Mark a waveform as being generated */
  markGenerating: (assetId: string, width: number, height: number) => void;
  /** Mark a waveform generation as complete */
  markComplete: (assetId: string, width: number, height: number) => void;
  /** Set error state */
  setError: (error: string | null) => void;
  /** Reset statistics */
  resetStats: () => void;
}

type WaveformCacheStore = WaveformCacheState & WaveformCacheActions;

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_CACHE_SIZE = 100;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Create a cache key from asset ID and dimensions
 */
export function createWaveformCacheKey(assetId: string, width: number, height: number): string {
  return `${assetId}:${width}x${height}`;
}

/**
 * Priority order for sorting queue
 */
const PRIORITY_ORDER: Record<string, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

/**
 * Sort requests by priority
 */
function sortByPriority(requests: WaveformRequest[]): WaveformRequest[] {
  return [...requests].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
}

// =============================================================================
// Store
// =============================================================================

const initialStats: WaveformCacheStats = {
  cacheHits: 0,
  cacheMisses: 0,
  totalGenerations: 0,
  evictions: 0,
};

export const useWaveformCacheStore = create<WaveformCacheStore>()(
  devtools(
    (set, get) => ({
      // State
      entries: {},
      cacheSize: 0,
      maxCacheSize: DEFAULT_MAX_CACHE_SIZE,
      pendingRequests: [],
      activeGenerations: new Set(),
      isGenerating: false,
      error: null,
      stats: { ...initialStats },

      // Actions
      addToCache: (assetId, width, height, imagePath) => {
        const key = createWaveformCacheKey(assetId, width, height);
        const now = Date.now();

        set((state) => {
          const newEntries = { ...state.entries };
          let evictions = 0;
          const isNewEntry = !newEntries[key];

          // Check if we need to evict entries (use state.cacheSize for efficiency)
          if (state.cacheSize >= state.maxCacheSize && isNewEntry) {
            // Find LRU entry to evict
            const entriesArray = Object.entries(newEntries);
            entriesArray.sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);

            // Evict oldest
            const toEvict = entriesArray.slice(0, 1);
            for (const [evictKey] of toEvict) {
              delete newEntries[evictKey];
              evictions++;
            }
          }

          // Add new entry
          newEntries[key] = {
            imagePath,
            width,
            height,
            createdAt: now,
            lastAccessedAt: now,
          };

          // Calculate new size: previous size - evictions + (1 if new entry, 0 if update)
          const newCacheSize = state.cacheSize - evictions + (isNewEntry ? 1 : 0);

          return {
            entries: newEntries,
            cacheSize: newCacheSize,
            error: null, // Clear error on successful add
            stats: {
              ...state.stats,
              evictions: state.stats.evictions + evictions,
            },
          };
        }, false, 'addToCache');
      },

      getFromCache: (assetId, width, height) => {
        const key = createWaveformCacheKey(assetId, width, height);
        const entry = get().entries[key];

        if (entry) {
          // Update last accessed time
          set((state) => ({
            entries: {
              ...state.entries,
              [key]: {
                ...entry,
                lastAccessedAt: Date.now(),
              },
            },
            stats: {
              ...state.stats,
              cacheHits: state.stats.cacheHits + 1,
            },
          }), false, 'cacheHit');

          return entry;
        }

        // Track cache miss
        set((state) => ({
          stats: {
            ...state.stats,
            cacheMisses: state.stats.cacheMisses + 1,
          },
        }), false, 'cacheMiss');

        return null;
      },

      hasInCache: (assetId, width, height) => {
        const key = createWaveformCacheKey(assetId, width, height);
        return key in get().entries;
      },

      clearCache: () => {
        set({
          entries: {},
          cacheSize: 0,
          pendingRequests: [],
          activeGenerations: new Set(),
          isGenerating: false,
          error: null,
        }, false, 'clearCache');
      },

      setMaxCacheSize: (size) => {
        set((state) => {
          const newEntries = { ...state.entries };
          let evictions = 0;

          // Evict entries if current size exceeds new max (use state.cacheSize)
          if (state.cacheSize > size) {
            const entriesArray = Object.entries(newEntries);
            entriesArray.sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);

            const toEvictCount = state.cacheSize - size;
            const toEvict = entriesArray.slice(0, toEvictCount);

            for (const [evictKey] of toEvict) {
              delete newEntries[evictKey];
              evictions++;
            }
          }

          return {
            maxCacheSize: size,
            entries: newEntries,
            cacheSize: state.cacheSize - evictions,
            stats: {
              ...state.stats,
              evictions: state.stats.evictions + evictions,
            },
          };
        }, false, 'setMaxCacheSize');
      },

      queueRequest: (request) => {
        set((state) => {
          const key = createWaveformCacheKey(request.assetId, request.width, request.height);

          // Check if request already in queue
          const existingIndex = state.pendingRequests.findIndex(
            (r) => createWaveformCacheKey(r.assetId, r.width, r.height) === key
          );

          let newRequests: WaveformRequest[];

          if (existingIndex >= 0) {
            // Update priority if new priority is higher
            const existing = state.pendingRequests[existingIndex];
            if (PRIORITY_ORDER[request.priority] < PRIORITY_ORDER[existing.priority]) {
              newRequests = [...state.pendingRequests];
              newRequests[existingIndex] = request;
            } else {
              newRequests = state.pendingRequests;
            }
          } else {
            newRequests = [...state.pendingRequests, request];
          }

          return {
            pendingRequests: sortByPriority(newRequests),
          };
        }, false, 'queueRequest');
      },

      removeFromQueue: (assetId, width, height) => {
        const key = createWaveformCacheKey(assetId, width, height);

        set((state) => ({
          pendingRequests: state.pendingRequests.filter(
            (r) => createWaveformCacheKey(r.assetId, r.width, r.height) !== key
          ),
        }), false, 'removeFromQueue');
      },

      markGenerating: (assetId, width, height) => {
        const key = createWaveformCacheKey(assetId, width, height);

        set((state) => {
          const newActiveGenerations = new Set(state.activeGenerations);
          newActiveGenerations.add(key);

          return {
            activeGenerations: newActiveGenerations,
            isGenerating: true,
          };
        }, false, 'markGenerating');
      },

      markComplete: (assetId, width, height) => {
        const key = createWaveformCacheKey(assetId, width, height);

        set((state) => {
          const newActiveGenerations = new Set(state.activeGenerations);
          newActiveGenerations.delete(key);

          return {
            activeGenerations: newActiveGenerations,
            isGenerating: newActiveGenerations.size > 0,
            stats: {
              ...state.stats,
              totalGenerations: state.stats.totalGenerations + 1,
            },
          };
        }, false, 'markComplete');
      },

      setError: (error) => {
        set({ error }, false, 'setError');
      },

      resetStats: () => {
        set({ stats: { ...initialStats } }, false, 'resetStats');
      },
    }),
    { name: 'WaveformCacheStore' }
  )
);
