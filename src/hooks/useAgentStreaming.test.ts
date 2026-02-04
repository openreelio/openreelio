/**
 * useAgentStreaming Hook Tests
 *
 * Tests for the streaming response hook.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentStreaming, useAgentStreamingStore } from './useAgentStreaming';

describe('useAgentStreaming', () => {
  beforeEach(() => {
    useAgentStreamingStore.getState().reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('should not be streaming initially', () => {
      const { result } = renderHook(() => useAgentStreaming());

      expect(result.current.isStreaming).toBe(false);
    });

    it('should have empty content initially', () => {
      const { result } = renderHook(() => useAgentStreaming());

      expect(result.current.content).toBe('');
    });

    it('should have no error initially', () => {
      const { result } = renderHook(() => useAgentStreaming());

      expect(result.current.error).toBeNull();
    });

    it('should have zero chunk count initially', () => {
      const { result } = renderHook(() => useAgentStreaming());

      expect(result.current.chunkCount).toBe(0);
    });
  });

  describe('startStreaming', () => {
    it('should set streaming state to true', () => {
      const { result } = renderHook(() => useAgentStreaming());

      act(() => {
        result.current.startStreaming();
      });

      expect(result.current.isStreaming).toBe(true);
    });

    it('should clear previous content', () => {
      const { result } = renderHook(() => useAgentStreaming());

      act(() => {
        result.current.appendChunk('old content');
      });

      act(() => {
        result.current.startStreaming();
      });

      expect(result.current.content).toBe('');
    });

    it('should clear previous error', () => {
      const { result } = renderHook(() => useAgentStreaming());

      act(() => {
        result.current.setError('Previous error');
      });

      act(() => {
        result.current.startStreaming();
      });

      expect(result.current.error).toBeNull();
    });
  });

  describe('appendChunk', () => {
    it('should append content', () => {
      const { result } = renderHook(() => useAgentStreaming());

      act(() => {
        result.current.startStreaming();
      });

      act(() => {
        result.current.appendChunk('Hello');
      });

      expect(result.current.content).toBe('Hello');
    });

    it('should accumulate multiple chunks', () => {
      const { result } = renderHook(() => useAgentStreaming());

      act(() => {
        result.current.startStreaming();
      });

      act(() => {
        result.current.appendChunk('Hello');
        result.current.appendChunk(' ');
        result.current.appendChunk('World');
      });

      expect(result.current.content).toBe('Hello World');
    });

    it('should increment chunk count', () => {
      const { result } = renderHook(() => useAgentStreaming());

      act(() => {
        result.current.startStreaming();
      });

      act(() => {
        result.current.appendChunk('a');
        result.current.appendChunk('b');
        result.current.appendChunk('c');
      });

      expect(result.current.chunkCount).toBe(3);
    });

    it('should call onChunk callback if provided', () => {
      const onChunk = vi.fn();
      const { result } = renderHook(() => useAgentStreaming({ onChunk }));

      act(() => {
        result.current.startStreaming();
      });

      act(() => {
        result.current.appendChunk('test');
      });

      expect(onChunk).toHaveBeenCalledWith('test');
    });
  });

  describe('completeStreaming', () => {
    it('should set streaming to false', () => {
      const { result } = renderHook(() => useAgentStreaming());

      act(() => {
        result.current.startStreaming();
        result.current.appendChunk('content');
      });

      act(() => {
        result.current.completeStreaming();
      });

      expect(result.current.isStreaming).toBe(false);
    });

    it('should preserve final content', () => {
      const { result } = renderHook(() => useAgentStreaming());

      act(() => {
        result.current.startStreaming();
        result.current.appendChunk('final content');
      });

      act(() => {
        result.current.completeStreaming();
      });

      expect(result.current.content).toBe('final content');
    });

    it('should set isComplete to true', () => {
      const { result } = renderHook(() => useAgentStreaming());

      act(() => {
        result.current.startStreaming();
      });

      act(() => {
        result.current.completeStreaming();
      });

      expect(result.current.isComplete).toBe(true);
    });

    it('should call onComplete callback if provided', () => {
      const onComplete = vi.fn();
      const { result } = renderHook(() => useAgentStreaming({ onComplete }));

      act(() => {
        result.current.startStreaming();
        result.current.appendChunk('content');
      });

      act(() => {
        result.current.completeStreaming();
      });

      expect(onComplete).toHaveBeenCalledWith('content');
    });
  });

  describe('abortStreaming', () => {
    it('should stop streaming', () => {
      const { result } = renderHook(() => useAgentStreaming());

      act(() => {
        result.current.startStreaming();
      });

      act(() => {
        result.current.abortStreaming();
      });

      expect(result.current.isStreaming).toBe(false);
    });

    it('should set isAborted to true', () => {
      const { result } = renderHook(() => useAgentStreaming());

      act(() => {
        result.current.startStreaming();
      });

      act(() => {
        result.current.abortStreaming();
      });

      expect(result.current.isAborted).toBe(true);
    });

    it('should preserve partial content', () => {
      const { result } = renderHook(() => useAgentStreaming());

      act(() => {
        result.current.startStreaming();
        result.current.appendChunk('partial');
      });

      act(() => {
        result.current.abortStreaming();
      });

      expect(result.current.content).toBe('partial');
    });

    it('should call onAbort callback if provided', () => {
      const onAbort = vi.fn();
      const { result } = renderHook(() => useAgentStreaming({ onAbort }));

      act(() => {
        result.current.startStreaming();
      });

      act(() => {
        result.current.abortStreaming('User cancelled');
      });

      expect(onAbort).toHaveBeenCalledWith('User cancelled');
    });
  });

  describe('setError', () => {
    it('should set error message', () => {
      const { result } = renderHook(() => useAgentStreaming());

      act(() => {
        result.current.setError('Something went wrong');
      });

      expect(result.current.error).toBe('Something went wrong');
    });

    it('should stop streaming on error', () => {
      const { result } = renderHook(() => useAgentStreaming());

      act(() => {
        result.current.startStreaming();
      });

      act(() => {
        result.current.setError('Error');
      });

      expect(result.current.isStreaming).toBe(false);
    });

    it('should call onError callback if provided', () => {
      const onError = vi.fn();
      const { result } = renderHook(() => useAgentStreaming({ onError }));

      act(() => {
        result.current.setError('Error message');
      });

      expect(onError).toHaveBeenCalledWith('Error message');
    });
  });

  describe('reset', () => {
    it('should reset all state', () => {
      const { result } = renderHook(() => useAgentStreaming());

      act(() => {
        result.current.startStreaming();
        result.current.appendChunk('content');
        result.current.completeStreaming();
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.isStreaming).toBe(false);
      expect(result.current.content).toBe('');
      expect(result.current.chunkCount).toBe(0);
      expect(result.current.isComplete).toBe(false);
      expect(result.current.isAborted).toBe(false);
    });
  });

  describe('statistics', () => {
    it('should track content length', () => {
      const { result } = renderHook(() => useAgentStreaming());

      act(() => {
        result.current.startStreaming();
        result.current.appendChunk('12345');
        result.current.appendChunk('67890');
      });

      expect(result.current.contentLength).toBe(10);
    });

    it('should track streaming duration', () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useAgentStreaming());

      act(() => {
        result.current.startStreaming();
      });

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      act(() => {
        result.current.completeStreaming();
      });

      expect(result.current.duration).toBeGreaterThanOrEqual(1000);

      vi.useRealTimers();
    });
  });

  describe('streamContent async generator', () => {
    it('should process async generator', async () => {
      const { result } = renderHook(() => useAgentStreaming());

      async function* mockGenerator() {
        yield 'Hello';
        yield ' ';
        yield 'World';
      }

      await act(async () => {
        await result.current.streamContent(mockGenerator());
      });

      expect(result.current.content).toBe('Hello World');
      expect(result.current.isComplete).toBe(true);
    });

    it('should handle generator error', async () => {
      const { result } = renderHook(() => useAgentStreaming());

      async function* errorGenerator() {
        yield 'Start';
        throw new Error('Generator error');
      }

      await act(async () => {
        await result.current.streamContent(errorGenerator());
      });

      expect(result.current.error).toBe('Generator error');
      expect(result.current.isStreaming).toBe(false);
    });
  });
});
