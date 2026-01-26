/**
 * Tests for useAIModels hook
 *
 * Tests the AI model fetching functionality including:
 * - Model loading for each provider
 * - Caching behavior
 * - Error handling and fallbacks
 * - Provider switching
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAIModels, getDefaultModel, clearModelCache, invalidateModelCache } from './useAIModels';
import type { ProviderType } from '@/stores/settingsStore';

// Mock Tauri invoke
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Mock logger
vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('useAIModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearModelCache();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('model loading', () => {
    it('should load OpenAI models', async () => {
      const models = ['gpt-5.2', 'gpt-5.1', 'gpt-4.1'];
      mockInvoke.mockResolvedValueOnce(models);

      const { result } = renderHook(() => useAIModels('openai'));

      expect(result.current.isLoading).toBe(true);

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.models).toEqual(models);
      expect(result.current.error).toBe(null);
      expect(mockInvoke).toHaveBeenCalledWith('get_available_ai_models', {
        providerType: 'openai',
      });
    });

    it('should load Anthropic models', async () => {
      const models = ['claude-opus-4-5-20251115', 'claude-sonnet-4-5-20251015'];
      mockInvoke.mockResolvedValueOnce(models);

      const { result } = renderHook(() => useAIModels('anthropic'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.models).toEqual(models);
      expect(mockInvoke).toHaveBeenCalledWith('get_available_ai_models', {
        providerType: 'anthropic',
      });
    });

    it('should load Gemini models', async () => {
      const models = ['gemini-3-pro-preview', 'gemini-3-flash-preview'];
      mockInvoke.mockResolvedValueOnce(models);

      const { result } = renderHook(() => useAIModels('gemini'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.models).toEqual(models);
    });

    it('should load local models', async () => {
      const models = ['llama3.2', 'mistral', 'codellama'];
      mockInvoke.mockResolvedValueOnce(models);

      const { result } = renderHook(() => useAIModels('local'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.models).toEqual(models);
    });
  });

  describe('caching', () => {
    it('should cache models after first load', async () => {
      const models = ['gpt-5.2', 'gpt-5.1'];
      mockInvoke.mockResolvedValueOnce(models);

      // First render
      const { result, rerender } = renderHook(() => useAIModels('openai'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockInvoke).toHaveBeenCalledTimes(1);

      // Re-render same provider - should use cache
      rerender();

      await waitFor(() => {
        expect(result.current.models).toEqual(models);
      });

      // Should not call invoke again due to cache
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('should fetch new models when provider changes', async () => {
      const openaiModels = ['gpt-5.2'];
      const anthropicModels = ['claude-opus-4-5-20251115'];

      mockInvoke
        .mockResolvedValueOnce(openaiModels)
        .mockResolvedValueOnce(anthropicModels);

      const { result, rerender } = renderHook(
        ({ provider }: { provider: ProviderType }) => useAIModels(provider),
        { initialProps: { provider: 'openai' as ProviderType } }
      );

      await waitFor(() => {
        expect(result.current.models).toEqual(openaiModels);
      });

      // Change provider
      rerender({ provider: 'anthropic' as ProviderType });

      await waitFor(() => {
        expect(result.current.models).toEqual(anthropicModels);
      });

      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });
  });

  describe('refreshModels', () => {
    it('should clear cache and refetch', async () => {
      const initialModels = ['gpt-5.2'];
      const updatedModels = ['gpt-5.2', 'gpt-5.3'];

      mockInvoke
        .mockResolvedValueOnce(initialModels)
        .mockResolvedValueOnce(updatedModels);

      const { result } = renderHook(() => useAIModels('openai'));

      await waitFor(() => {
        expect(result.current.models).toEqual(initialModels);
      });

      await act(async () => {
        await result.current.refreshModels();
      });

      expect(result.current.models).toEqual(updatedModels);
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('should set error on fetch failure', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useAIModels('openai'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBe('Network error');
    });

    it('should provide fallback models on error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useAIModels('openai'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Should have fallback models
      expect(result.current.models.length).toBeGreaterThan(0);
      expect(result.current.models).toContain('gpt-5.2');
    });

    it('should provide provider-specific fallback models', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useAIModels('anthropic'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.models).toContain('claude-opus-4-5-20251115');
    });
  });

  describe('race conditions', () => {
    it('should handle rapid provider changes', async () => {
      let resolveFirst: (value: string[]) => void;
      let resolveSecond: (value: string[]) => void;

      const firstPromise = new Promise<string[]>((resolve) => {
        resolveFirst = resolve;
      });
      const secondPromise = new Promise<string[]>((resolve) => {
        resolveSecond = resolve;
      });

      mockInvoke
        .mockReturnValueOnce(firstPromise)
        .mockReturnValueOnce(secondPromise);

      const { result, rerender } = renderHook(
        ({ provider }: { provider: ProviderType }) => useAIModels(provider),
        { initialProps: { provider: 'openai' as ProviderType } }
      );

      // Quickly switch provider before first resolves
      rerender({ provider: 'anthropic' as ProviderType });

      // Resolve in reverse order
      resolveSecond!(['claude-opus-4-5-20251115']);
      resolveFirst!(['gpt-5.2']);

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Should have anthropic models (current provider), not openai
      expect(result.current.models).toContain('claude-opus-4-5-20251115');
    });
  });
});

describe('getDefaultModel', () => {
  it('should return correct default for OpenAI', () => {
    expect(getDefaultModel('openai')).toBe('gpt-5.2');
  });

  it('should return correct default for Anthropic', () => {
    expect(getDefaultModel('anthropic')).toBe('claude-sonnet-4-5-20251015');
  });

  it('should return correct default for Gemini', () => {
    expect(getDefaultModel('gemini')).toBe('gemini-3-flash-preview');
  });

  it('should return correct default for local', () => {
    expect(getDefaultModel('local')).toBe('llama3.2');
  });

  it('should return empty string for unknown provider', () => {
    expect(getDefaultModel('unknown' as never)).toBe('');
  });
});

describe('clearModelCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearModelCache();
  });

  it('should clear the cache', async () => {
    const models = ['gpt-5.2'];
    mockInvoke.mockResolvedValue(models);

    // Load models - first render
    const { result, unmount } = renderHook(() => useAIModels('openai'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    unmount();

    // Clear cache
    clearModelCache();

    // Render again - should fetch
    const { result: result2 } = renderHook(() => useAIModels('openai'));

    await waitFor(() => {
      expect(result2.current.isLoading).toBe(false);
    });

    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });
});

describe('invalidateModelCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearModelCache();
  });

  it('should invalidate cache for specific provider', async () => {
    const openaiModels = ['gpt-5.2'];
    const anthropicModels = ['claude-opus-4-5-20251115'];

    mockInvoke
      .mockResolvedValueOnce(openaiModels)
      .mockResolvedValueOnce(anthropicModels)
      .mockResolvedValueOnce(['gpt-5.3']); // New models after invalidation

    // Load both providers
    const { result: openaiResult, unmount: unmountOpenai } = renderHook(() =>
      useAIModels('openai')
    );
    await waitFor(() => expect(openaiResult.current.isLoading).toBe(false));

    const { result: anthropicResult, unmount: unmountAnthropic } = renderHook(() =>
      useAIModels('anthropic')
    );
    await waitFor(() => expect(anthropicResult.current.isLoading).toBe(false));

    unmountOpenai();
    unmountAnthropic();

    expect(mockInvoke).toHaveBeenCalledTimes(2);

    // Invalidate only OpenAI cache
    invalidateModelCache('openai');

    // Render OpenAI again - should fetch
    const { result: openaiResult2 } = renderHook(() => useAIModels('openai'));
    await waitFor(() => expect(openaiResult2.current.isLoading).toBe(false));

    // Should fetch because cache was invalidated
    expect(mockInvoke).toHaveBeenCalledTimes(3);
  });

  it('should invalidate all caches when no provider specified', async () => {
    const openaiModels = ['gpt-5.2'];
    const anthropicModels = ['claude-opus-4-5-20251115'];

    mockInvoke
      .mockResolvedValueOnce(openaiModels)
      .mockResolvedValueOnce(anthropicModels)
      .mockResolvedValueOnce(['gpt-5.3'])
      .mockResolvedValueOnce(['claude-opus-5']);

    // Load both providers
    const { result: openaiResult, unmount: unmountOpenai } = renderHook(() =>
      useAIModels('openai')
    );
    await waitFor(() => expect(openaiResult.current.isLoading).toBe(false));

    const { result: anthropicResult, unmount: unmountAnthropic } = renderHook(() =>
      useAIModels('anthropic')
    );
    await waitFor(() => expect(anthropicResult.current.isLoading).toBe(false));

    unmountOpenai();
    unmountAnthropic();

    expect(mockInvoke).toHaveBeenCalledTimes(2);

    // Invalidate all caches
    invalidateModelCache();

    // Render both again - both should fetch
    const { result: openaiResult2 } = renderHook(() => useAIModels('openai'));
    await waitFor(() => expect(openaiResult2.current.isLoading).toBe(false));

    const { result: anthropicResult2 } = renderHook(() => useAIModels('anthropic'));
    await waitFor(() => expect(anthropicResult2.current.isLoading).toBe(false));

    // Both should have fetched again
    expect(mockInvoke).toHaveBeenCalledTimes(4);
  });
});
