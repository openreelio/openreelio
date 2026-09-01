/**
 * Render Cache Store
 *
 * Single source of truth for preview render-cache status, fill progress and
 * backend event wiring.
 *
 * ## Why a store rather than hook-local state
 *
 * More than one surface needs the same cache picture at the same time: the
 * timeline indicator bar, the idle fill scheduler, and (from the cache-first
 * preview onward) the player deciding whether a cached segment can be drawn.
 * Held in hook state, each consumer would register its own Tauri event
 * listeners and hold a divergent copy of the same backend truth. The store
 * keeps one copy and, through `attachListeners`/`detachListeners`, at most one
 * registration of each backend event no matter how many components subscribe.
 *
 * Plain Zustand (no Immer) is deliberate: the state carries a `Set`, and
 * replacing it with a fresh copy is clearer here than enabling Immer's Map/Set
 * plugin for a single field.
 */

import { create } from 'zustand';
import { commands } from '@/bindings';
import type { RenderCacheStatus, PreviewCacheScope } from '@/bindings';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isDesktopRuntimeAvailable } from '@/services/runtimeEnvironment';

/** Message shown when a cache action is attempted outside the desktop runtime. */
const DESKTOP_ONLY_MESSAGE = 'Render cache is only available in the desktop app runtime.';

/**
 * Backend errors that simply mean "there is nothing to report yet".
 *
 * They are a normal state on app start, not a failure worth surfacing.
 */
const BENIGN_STATUS_ERRORS = ['No project open', 'No active sequence'] as const;

/** Cache progress event payload */
interface CacheProgressPayload {
  sequenceId: string;
  completedSegments: number;
  totalSegments: number;
  percent: number;
  /**
   * Which segments the running fill is producing. Optional: a fill started by an
   * older backend emits no scope.
   */
  scope?: PreviewCacheScope;
}

/** Render cache state */
export interface RenderCacheState {
  /** Current cache status (null if not loaded) */
  status: RenderCacheStatus | null;
  /** Whether a cache fill is currently running */
  isRendering: boolean;
  /** Fill progress percentage (0-100) */
  progress: number;
  /** Error message if any */
  error: string | null;
  /**
   * Cached segment files a consumer found unplayable since the last refresh.
   *
   * The manifest can name a file that no longer decodes (evicted, truncated by
   * a crash). A consumer that hits one marks it here so every other consumer
   * stops reaching for it, without waiting for the backend to notice.
   */
  deadCachedPaths: Set<string>;
}

/** Render cache actions */
export interface RenderCacheActions {
  /** Refresh cache status from the backend */
  refreshStatus: () => Promise<void>;
  /**
   * Ask the backend to fill the cache.
   *
   * @param scope - Which segments to fill; `null` means the whole timeline.
   */
  renderCache: (scope: PreviewCacheScope | null) => Promise<void>;
  /** Clear all cached segments */
  clearCache: () => Promise<void>;
  /** Mark a cached segment file as unplayable until the next successful refresh */
  markCachedPathDead: (path: string) => void;
  /** Register backend cache listeners (ref-counted; safe to call from every consumer) */
  attachListeners: () => void;
  /** Release one listener registration; the last release tears the listeners down */
  detachListeners: () => void;
  /** Restore initial state and drop every listener registration (for testing purposes) */
  _resetForTests: () => void;
}

/** Combined render cache store */
export type RenderCacheStore = RenderCacheState & RenderCacheActions;

const INITIAL_STATE: RenderCacheState = {
  status: null,
  isRendering: false,
  progress: 0,
  error: null,
  deadCachedPaths: new Set<string>(),
};

// =============================================================================
// Listener ref-counting (module scope: one registration per process, not per store read)
// =============================================================================

let listenerRefCount = 0;
let listenerHandles: UnlistenFn[] = [];
/**
 * Bumped whenever the listener set is torn down.
 *
 * `listen()` is async, so an attach → detach → attach cycle that completes
 * inside one await window puts two registrations in flight at once. Without a
 * generation stamp both would see a live ref-count on resolution and the second
 * would overwrite the first's handles, orphaning listeners that keep firing
 * with no consumer left. React StrictMode performs exactly that cycle on every
 * dev mount.
 */
let listenerGeneration = 0;

function releaseListenerHandles(): void {
  for (const unlisten of listenerHandles) {
    if (typeof unlisten === 'function') {
      unlisten();
    }
  }
  listenerHandles = [];
}

async function registerListeners(): Promise<void> {
  const generation = listenerGeneration;

  try {
    const handles = await Promise.all([
      listen<CacheProgressPayload>('render-cache-progress', (event) => {
        useRenderCacheStore.setState({ progress: event.payload.percent });
        // Refresh full status so the timeline indicator updates per segment.
        void useRenderCacheStore.getState().refreshStatus();
      }),
      listen<{ sequenceId: string }>('render-cache-complete', async () => {
        useRenderCacheStore.setState({ isRendering: false, progress: 100 });
        await useRenderCacheStore.getState().refreshStatus();
      }),
      listen<string>('render-cache-error', (event) => {
        // Per-segment errors do not stop the overall fill; `isRendering` is
        // only cleared on render-cache-complete.
        useRenderCacheStore.setState({ error: event.payload });
      }),
    ]);

    const isStale = generation !== listenerGeneration || listenerRefCount === 0;
    if (isStale || listenerHandles.length > 0) {
      // Either every consumer detached while this registration was in flight,
      // or a later registration already won the slot. Drop the handles this
      // call created rather than orphaning someone else's.
      for (const unlisten of handles) {
        if (typeof unlisten === 'function') {
          unlisten();
        }
      }
      return;
    }

    listenerHandles = handles;
  } catch (listenerError) {
    useRenderCacheStore.setState({
      isRendering: false,
      error: listenerError instanceof Error ? listenerError.message : String(listenerError),
    });
  }
}

// =============================================================================
// Store
// =============================================================================

/** Global render cache store */
export const useRenderCacheStore = create<RenderCacheStore>((set, get) => ({
  ...INITIAL_STATE,

  refreshStatus: async () => {
    if (!isDesktopRuntimeAvailable()) {
      set({ status: null, error: null });
      return;
    }

    const result = await commands.getCacheStatus();
    if (result.status === 'ok') {
      set((state) => ({
        status: result.data,
        error: null,
        // A fresh snapshot supersedes local death marks: whatever the backend
        // now reports as cached is the current truth about those files.
        deadCachedPaths: state.deadCachedPaths.size > 0 ? new Set<string>() : state.deadCachedPaths,
      }));
      return;
    }

    const message = String(result.error);
    if (BENIGN_STATUS_ERRORS.some((benign) => message.includes(benign))) {
      set({ status: null, error: null });
      return;
    }

    set({ status: null, error: message });
  },

  renderCache: async (scope) => {
    if (!isDesktopRuntimeAvailable()) {
      set({ error: DESKTOP_ONLY_MESSAGE });
      return;
    }

    // `isRendering`/`progress` are set from the outcome, never optimistically:
    // this request may land on a fill that is already running, and rewinding
    // its progress to 0 before the backend has said anything would report a
    // restart that never happened.
    set({ error: null });

    let failure: string | null = null;

    try {
      const result = await commands.renderPreviewCache(scope);
      if (result.status === 'ok') {
        if (result.data.status === 'started') {
          set({ isRendering: true, progress: 0 });
        } else if (result.data.status === 'already_cached') {
          set({ isRendering: false, progress: 100 });
        }
        // `already_converging` / `retargeted`: this call started nothing — a
        // fill already in flight absorbed the request, and its own progress and
        // completion events keep both fields current. Writing either here would
        // clobber a genuinely running fill.
      } else {
        failure = result.error;
        set({ error: failure });
      }
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      set({ error: failure });
    }

    await get().refreshStatus();

    // A successful status refresh clears `error`, which would otherwise erase
    // the failure this call just reported before anything could render it.
    if (failure !== null) {
      set({ error: failure });
    }
  },

  clearCache: async () => {
    if (!isDesktopRuntimeAvailable()) {
      set({ error: DESKTOP_ONLY_MESSAGE });
      return;
    }

    try {
      const result = await commands.clearRenderCache();
      if (result.status === 'ok') {
        set({ status: null, progress: 0, isRendering: false });
        await get().refreshStatus();
      } else {
        set({ error: result.error });
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  markCachedPathDead: (path) => {
    set((state) => {
      if (state.deadCachedPaths.has(path)) {
        return state;
      }
      const next = new Set(state.deadCachedPaths);
      next.add(path);
      return { deadCachedPaths: next };
    });
  },

  attachListeners: () => {
    listenerRefCount += 1;
    if (listenerRefCount === 1) {
      void registerListeners();
    }
  },

  detachListeners: () => {
    listenerRefCount = Math.max(0, listenerRefCount - 1);
    if (listenerRefCount === 0) {
      // Invalidate any registration still in flight before dropping the ones
      // that already landed.
      listenerGeneration += 1;
      releaseListenerHandles();
    }
  },

  _resetForTests: () => {
    listenerRefCount = 0;
    listenerGeneration += 1;
    releaseListenerHandles();
    set({ ...INITIAL_STATE, deadCachedPaths: new Set<string>() });
  },
}));
