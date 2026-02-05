/**
 * useAgenticLoop Hook Tests
 *
 * Tests for the main hook that orchestrates the AgenticEngine.
 * These tests focus on the hook's state management and interface.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgenticLoop } from './useAgenticLoop';
import { createMockLLMAdapter, createMockToolExecutor } from '@/agents/engine';

// Mock the feature flags
vi.mock('@/config/featureFlags', () => ({
  isAgenticEngineEnabled: vi.fn().mockReturnValue(true),
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
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should have correct initial state', () => {
      const { result } = renderHook(() =>
        useAgenticLoop({
          llmClient: mockLLM,
          toolExecutor: mockToolExecutor,
        })
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
        })
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
        })
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
        })
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
        })
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
        })
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
        })
      );

      // Hook should initialize without errors
      expect(result.current.phase).toBe('idle');
    });
  });

  describe('approval actions', () => {
    it('should provide approvePlan function', () => {
      const { result } = renderHook(() =>
        useAgenticLoop({
          llmClient: mockLLM,
          toolExecutor: mockToolExecutor,
        })
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
        })
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
        })
      );

      expect(result.current.phase).toBe('idle');
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
        })
      );

      // Hook should initialize without errors
      expect(result.current.phase).toBe('idle');
    });
  });
});
