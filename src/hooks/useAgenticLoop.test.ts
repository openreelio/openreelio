/**
 * useAgenticLoop Hook Tests
 *
 * Tests for the main hook that orchestrates the AgenticEngine.
 * These tests focus on the hook's state management and interface.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgenticLoop, trimDuplicatedTailUserMessageForContext } from './useAgenticLoop';
import type { ILLMClient, LLMMessage } from '@/agents/engine';
import { createMockLLMAdapter, createMockToolExecutor } from '@/agents/engine';
import { useConversationStore } from '@/stores/conversationStore';
import { isAgenticEngineEnabled } from '@/config/featureFlags';

// Mock the feature flags
vi.mock('@/config/featureFlags', () => ({
  isAgenticEngineEnabled: vi.fn().mockReturnValue(true),
  isVideoGenerationEnabled: vi.fn().mockReturnValue(false),
}));

// Mock logger
vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('useAgenticLoop', () => {
  let mockLLM: ReturnType<typeof createMockLLMAdapter>;
  let mockToolExecutor: ReturnType<typeof createMockToolExecutor>;

  beforeEach(() => {
    mockLLM = createMockLLMAdapter();
    mockToolExecutor = createMockToolExecutor();
    vi.mocked(isAgenticEngineEnabled).mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    useConversationStore.getState().clearConversation();
  });

  describe('initial state', () => {
    it('should have correct initial state', () => {
      const { result } = renderHook(() =>
        useAgenticLoop({
          llmClient: mockLLM,
          toolExecutor: mockToolExecutor,
        }),
      );

      expect(result.current.phase).toBe('idle');
      expect(result.current.isRunning).toBe(false);
      expect(result.current.events).toEqual([]);
      expect(result.current.error).toBeNull();
      expect(result.current.thought).toBeNull();
      expect(result.current.plan).toBeNull();
      expect(result.current.sessionId).toBeNull();
      // isEnabled depends on feature flag mock
      expect('isEnabled' in result.current).toBe(true);
    });

    it('should provide run and abort functions', () => {
      const { result } = renderHook(() =>
        useAgenticLoop({
          llmClient: mockLLM,
          toolExecutor: mockToolExecutor,
        }),
      );

      expect(typeof result.current.run).toBe('function');
      expect(typeof result.current.abort).toBe('function');
      expect(typeof result.current.reset).toBe('function');
      expect(typeof result.current.approvePlan).toBe('function');
      expect(typeof result.current.rejectPlan).toBe('function');
    });
  });

  describe('reset', () => {
    it('should reset state to initial values', () => {
      const { result } = renderHook(() =>
        useAgenticLoop({
          llmClient: mockLLM,
          toolExecutor: mockToolExecutor,
        }),
      );

      // Reset should work even from initial state
      act(() => {
        result.current.reset();
      });

      expect(result.current.phase).toBe('idle');
      expect(result.current.events).toEqual([]);
      expect(result.current.error).toBeNull();
      expect(result.current.isRunning).toBe(false);
    });
  });

  describe('abort', () => {
    it('should set phase to aborted', () => {
      const { result } = renderHook(() =>
        useAgenticLoop({
          llmClient: mockLLM,
          toolExecutor: mockToolExecutor,
        }),
      );

      act(() => {
        result.current.abort();
      });

      expect(result.current.phase).toBe('aborted');
      expect(result.current.isRunning).toBe(false);
    });

    it('should call onAbort callback', () => {
      const onAbort = vi.fn();

      const { result } = renderHook(() =>
        useAgenticLoop({
          llmClient: mockLLM,
          toolExecutor: mockToolExecutor,
          onAbort,
        }),
      );

      act(() => {
        result.current.abort();
      });

      expect(onAbort).toHaveBeenCalled();
    });
  });

  describe('feature flag', () => {
    it('should have isEnabled property in return value', () => {
      const { result } = renderHook(() =>
        useAgenticLoop({
          llmClient: mockLLM,
          toolExecutor: mockToolExecutor,
        }),
      );

      // isEnabled should exist in the return value
      expect('isEnabled' in result.current).toBe(true);
    });
  });

  describe('context handling', () => {
    it('should accept external context', () => {
      const { result } = renderHook(() =>
        useAgenticLoop({
          llmClient: mockLLM,
          toolExecutor: mockToolExecutor,
          context: {
            projectId: 'test-project',
            selectedClips: ['clip-1'],
            playheadPosition: 5.5,
          },
        }),
      );

      // Hook should initialize without errors
      expect(result.current.phase).toBe('idle');
    });

    it('should trim duplicate trailing user message from context history', () => {
      const history: LLMMessage[] = [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Done' },
        { role: 'user', content: 'Split clip at 5s' },
      ];

      const trimmed = trimDuplicatedTailUserMessageForContext(history, 'Split clip at 5s');
      expect(trimmed).toHaveLength(2);
      expect(trimmed[trimmed.length - 1]).toEqual({ role: 'assistant', content: 'Done' });
    });
  });

  describe('approval actions', () => {
    it('should provide approvePlan function', () => {
      const { result } = renderHook(() =>
        useAgenticLoop({
          llmClient: mockLLM,
          toolExecutor: mockToolExecutor,
        }),
      );

      // Should not throw when called (even without pending approval)
      expect(() => {
        act(() => {
          result.current.approvePlan();
        });
      }).not.toThrow();
    });

    it('should provide rejectPlan function', () => {
      const { result } = renderHook(() =>
        useAgenticLoop({
          llmClient: mockLLM,
          toolExecutor: mockToolExecutor,
        }),
      );

      // Should not throw when called (even without pending approval)
      expect(() => {
        act(() => {
          result.current.rejectPlan('User rejected');
        });
      }).not.toThrow();
    });
  });

  describe('configuration', () => {
    it('should accept engine configuration', () => {
      const { result } = renderHook(() =>
        useAgenticLoop({
          llmClient: mockLLM,
          toolExecutor: mockToolExecutor,
          config: {
            maxIterations: 3,
            thinkingTimeout: 30000,
          },
        }),
      );

      expect(result.current.phase).toBe('idle');
    });
  });

  describe('provider pre-flight', () => {
    it('refreshes provider status for refreshable clients before blocking run', async () => {
      const refreshStatus = vi.fn(async () => {
        return { isConfigured: true };
      });

      const isConfigured = vi.fn(() => false);

      const refreshableClient = {
        provider: 'test',
        generateStream: async function* () {
          yield '';
        },
        generateWithTools: async function* () {
          yield { type: 'done' } as const;
        },
        generateStructured: async <T>() => ({}) as T,
        complete: async () => ({
          content: '',
          finishReason: 'stop' as const,
        }),
        abort: () => {},
        isGenerating: () => false,
        isConfigured,
        refreshStatus,
      } satisfies ILLMClient & { refreshStatus: () => Promise<{ isConfigured: boolean }> };

      const { result } = renderHook(() =>
        useAgenticLoop({
          llmClient: refreshableClient,
          toolExecutor: mockToolExecutor,
        }),
      );

      expect(result.current.isEnabled).toBe(true);

      let runResult: unknown = null;

      await act(async () => {
        runResult = await result.current.run('Edit this clip');
      });

      expect(refreshStatus).toHaveBeenCalledTimes(1);
      expect(runResult).toBeNull();
      expect(result.current.error?.message).toContain('AI provider not configured');
    });
  });

  describe('callbacks', () => {
    it('should accept callback options', () => {
      const onEvent = vi.fn();
      const onComplete = vi.fn();
      const onError = vi.fn();
      const onApprovalRequired = vi.fn();
      const onAbort = vi.fn();

      const { result } = renderHook(() =>
        useAgenticLoop({
          llmClient: mockLLM,
          toolExecutor: mockToolExecutor,
          onEvent,
          onComplete,
          onError,
          onApprovalRequired,
          onAbort,
        }),
      );

      // Hook should initialize without errors
      expect(result.current.phase).toBe('idle');
    });
  });
});
