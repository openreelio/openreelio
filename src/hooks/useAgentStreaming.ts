/**
 * useAgentStreaming Hook
 *
 * Manages streaming response state for the AI agent system.
 * Provides real-time content accumulation and lifecycle tracking.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { useCallback, useRef, useEffect } from 'react';

// =============================================================================
// Types
// =============================================================================

/** Options for the streaming hook */
export interface UseAgentStreamingOptions {
  onChunk?: (chunk: string) => void;
  onComplete?: (content: string) => void;
  onAbort?: (reason?: string) => void;
  onError?: (error: string) => void;
}

/** Streaming store state */
interface StreamingState {
  isStreaming: boolean;
  isComplete: boolean;
  isAborted: boolean;
  content: string;
  chunkCount: number;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

/** Streaming store actions */
interface StreamingActions {
  startStreaming: () => void;
  appendChunk: (chunk: string) => void;
  completeStreaming: () => void;
  abortStreaming: (reason?: string) => void;
  setError: (error: string) => void;
  reset: () => void;
}

type StreamingStore = StreamingState & StreamingActions;

// =============================================================================
// Initial State
// =============================================================================

const initialState: StreamingState = {
  isStreaming: false,
  isComplete: false,
  isAborted: false,
  content: '',
  chunkCount: 0,
  error: null,
  startedAt: null,
  completedAt: null,
};

// =============================================================================
// Store
// =============================================================================

export const useAgentStreamingStore = create<StreamingStore>()(
  immer((set) => ({
    ...initialState,

    startStreaming: () => {
      set((state) => {
        state.isStreaming = true;
        state.isComplete = false;
        state.isAborted = false;
        state.content = '';
        state.chunkCount = 0;
        state.error = null;
        state.startedAt = Date.now();
        state.completedAt = null;
      });
    },

    appendChunk: (chunk: string) => {
      set((state) => {
        state.content += chunk;
        state.chunkCount += 1;
      });
    },

    completeStreaming: () => {
      set((state) => {
        state.isStreaming = false;
        state.isComplete = true;
        state.completedAt = Date.now();
      });
    },

    abortStreaming: (_reason?: string) => {
      void _reason; // Reserved for future use (e.g., logging abort reason)
      set((state) => {
        state.isStreaming = false;
        state.isAborted = true;
        state.completedAt = Date.now();
      });
    },

    setError: (error: string) => {
      set((state) => {
        state.isStreaming = false;
        state.error = error;
        state.completedAt = Date.now();
      });
    },

    reset: () => {
      set(() => ({ ...initialState }));
    },
  }))
);

// =============================================================================
// Hook
// =============================================================================

export interface UseAgentStreamingReturn {
  // State
  isStreaming: boolean;
  isComplete: boolean;
  isAborted: boolean;
  content: string;
  chunkCount: number;
  contentLength: number;
  error: string | null;
  duration: number;

  // Actions
  startStreaming: () => void;
  appendChunk: (chunk: string) => void;
  completeStreaming: () => void;
  abortStreaming: (reason?: string) => void;
  setError: (error: string) => void;
  reset: () => void;
  streamContent: (generator: AsyncGenerator<string>) => Promise<void>;
}

export function useAgentStreaming(
  options?: UseAgentStreamingOptions
): UseAgentStreamingReturn {
  const store = useAgentStreamingStore();
  const optionsRef = useRef(options);

  // Update options ref when options change
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  // Wrap appendChunk to call onChunk callback
  const appendChunk = useCallback((chunk: string) => {
    store.appendChunk(chunk);
    optionsRef.current?.onChunk?.(chunk);
  }, [store]);

  // Wrap completeStreaming to call onComplete callback
  const completeStreaming = useCallback(() => {
    const content = useAgentStreamingStore.getState().content;
    store.completeStreaming();
    optionsRef.current?.onComplete?.(content);
  }, [store]);

  // Wrap abortStreaming to call onAbort callback
  const abortStreaming = useCallback((reason?: string) => {
    store.abortStreaming(reason);
    optionsRef.current?.onAbort?.(reason);
  }, [store]);

  // Wrap setError to call onError callback
  const setError = useCallback((error: string) => {
    store.setError(error);
    optionsRef.current?.onError?.(error);
  }, [store]);

  // Stream content from async generator
  const streamContent = useCallback(async (generator: AsyncGenerator<string>) => {
    store.startStreaming();

    try {
      for await (const chunk of generator) {
        // Check if aborted
        if (useAgentStreamingStore.getState().isAborted) {
          break;
        }
        appendChunk(chunk);
      }

      if (!useAgentStreamingStore.getState().isAborted) {
        completeStreaming();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setError(errorMessage);
    }
  }, [store, appendChunk, completeStreaming, setError]);

  // Calculate duration
  const duration = store.startedAt
    ? (store.completedAt ?? Date.now()) - store.startedAt
    : 0;

  return {
    // State
    isStreaming: store.isStreaming,
    isComplete: store.isComplete,
    isAborted: store.isAborted,
    content: store.content,
    chunkCount: store.chunkCount,
    contentLength: store.content.length,
    error: store.error,
    duration,

    // Actions
    startStreaming: store.startStreaming,
    appendChunk,
    completeStreaming,
    abortStreaming,
    setError,
    reset: store.reset,
    streamContent,
  };
}
