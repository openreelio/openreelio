/**
 * AI Model Selection Hook
 *
 * Provides a list of available AI models for each provider,
 * fetched directly from the Tauri backend.
 *
 * Models are cached per provider to avoid repeated IPC calls.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { createLogger } from '@/services/logger';
import type { ProviderType } from '@/stores/settingsStore';

const logger = createLogger('useAIModels');

/** Hook state */
interface UseAIModelsState {
  /** Available models for the current provider */
  models: string[];
  /** Whether models are being loaded */
  isLoading: boolean;
  /** Error message if loading failed */
  error: string | null;
}

/** Hook actions */
interface UseAIModelsActions {
  /** Refresh models for the current provider */
  refreshModels: () => Promise<void>;
}

/** Combined hook return type */
export type UseAIModelsReturn = UseAIModelsState & UseAIModelsActions;

// =============================================================================
// Model Cache with TTL and Invalidation
// =============================================================================

interface CacheEntry {
  models: string[];
  timestamp: number;
}

/** Cache TTL in milliseconds (5 minutes) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Model cache with TTL support */
const modelCache = new Map<ProviderType, CacheEntry>();

/** Cache version - incremented to invalidate all cache entries */
let cacheVersion = 0;

/**
 * Invalidates the model cache for a specific provider.
 * Should be called when credentials change.
 */
export function invalidateModelCache(provider?: ProviderType): void {
  if (provider) {
    modelCache.delete(provider);
    logger.debug('Model cache invalidated for provider', { provider });
  } else {
    modelCache.clear();
    cacheVersion++;
    logger.debug('All model caches invalidated', { newVersion: cacheVersion });
  }
}

/**
 * Checks if a cache entry is valid (exists and not expired)
 */
function isCacheValid(provider: ProviderType): boolean {
  const entry = modelCache.get(provider);
  if (!entry) return false;

  const age = Date.now() - entry.timestamp;
  return age < CACHE_TTL_MS;
}

/**
 * Gets cached models if valid, otherwise returns null
 */
function getCachedModels(provider: ProviderType): string[] | null {
  if (!isCacheValid(provider)) {
    return null;
  }
  return modelCache.get(provider)?.models ?? null;
}

/**
 * Stores models in cache with current timestamp
 */
function setCachedModels(provider: ProviderType, models: string[]): void {
  modelCache.set(provider, {
    models,
    timestamp: Date.now(),
  });
}

/**
 * Hook for fetching available AI models for a provider
 *
 * @param provider - The AI provider type
 *
 * @example
 * ```tsx
 * const { models, isLoading, error } = useAIModels('anthropic');
 *
 * if (isLoading) return <Spinner />;
 * if (error) return <Error message={error} />;
 *
 * return (
 *   <select>
 *     {models.map(model => (
 *       <option key={model} value={model}>{model}</option>
 *     ))}
 *   </select>
 * );
 * ```
 */
export function useAIModels(provider: ProviderType): UseAIModelsReturn {
  const [models, setModels] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track the current provider to handle race conditions
  const currentProviderRef = useRef(provider);
  currentProviderRef.current = provider;

  /**
   * Fetches available models for the specified provider
   */
  const fetchModels = useCallback(async (targetProvider: ProviderType): Promise<string[]> => {
    // Check cache first (with TTL validation)
    const cached = getCachedModels(targetProvider);
    if (cached) {
      logger.debug('Using cached models', { provider: targetProvider, count: cached.length });
      return cached;
    }

    // Fetch from backend
    const fetchedModels = await invoke<string[]>('get_available_ai_models', {
      providerType: targetProvider,
    });

    // Cache the result with timestamp
    setCachedModels(targetProvider, fetchedModels);

    logger.info('Fetched models from backend', {
      provider: targetProvider,
      count: fetchedModels.length,
    });

    return fetchedModels;
  }, []);

  /**
   * Refreshes models for the current provider
   */
  const refreshModels = useCallback(async (): Promise<void> => {
    try {
      setIsLoading(true);
      setError(null);

      // Invalidate cache for this provider (forces fresh fetch)
      invalidateModelCache(provider);

      const fetchedModels = await fetchModels(provider);

      // Only update state if the provider hasn't changed
      if (currentProviderRef.current === provider) {
        setModels(fetchedModels);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to refresh models', { provider, error: message });

      if (currentProviderRef.current === provider) {
        setError(message);
      }
    } finally {
      if (currentProviderRef.current === provider) {
        setIsLoading(false);
      }
    }
  }, [provider, fetchModels]);

  // Load models when provider changes
  useEffect(() => {
    let isMounted = true;

    const loadModels = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const fetchedModels = await fetchModels(provider);

        if (isMounted && currentProviderRef.current === provider) {
          setModels(fetchedModels);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Failed to load models', { provider, error: message });

        if (isMounted && currentProviderRef.current === provider) {
          setError(message);
          // Provide fallback models for offline use
          setModels(getFallbackModels(provider));
        }
      } finally {
        if (isMounted && currentProviderRef.current === provider) {
          setIsLoading(false);
        }
      }
    };

    loadModels();

    return () => {
      isMounted = false;
    };
  }, [provider, fetchModels]);

  return {
    models,
    isLoading,
    error,
    refreshModels,
  };
}

/**
 * Fallback models for offline use (when IPC fails)
 */
function getFallbackModels(provider: ProviderType): string[] {
  switch (provider) {
    case 'openai':
      return [
        'gpt-5.2',
        'gpt-5.1',
        'gpt-5-mini',
        'gpt-5-nano',
        'gpt-4.1',
        'gpt-4.1-mini',
        'o3',
        'o3-mini',
        'o4-mini',
      ];
    case 'anthropic':
      return [
        'claude-opus-4-5-20251115',
        'claude-sonnet-4-5-20251015',
        'claude-haiku-4-5-20251015',
        'claude-opus-4-1-20250805',
        'claude-sonnet-4-20250514',
      ];
    case 'gemini':
      return [
        'gemini-3-pro-preview',
        'gemini-3-flash-preview',
        'gemini-2.5-flash',
        'gemini-2.5-pro',
      ];
    case 'local':
      return [
        'llama3.2',
        'llama3.1',
        'mistral',
        'mixtral',
        'codellama',
        'deepseek-coder',
        'qwen2.5',
        'phi3',
      ];
    default:
      return [];
  }
}

/**
 * Returns the default model for a provider
 */
export function getDefaultModel(provider: ProviderType): string {
  switch (provider) {
    case 'openai':
      return 'gpt-5.2';
    case 'anthropic':
      return 'claude-sonnet-4-5-20251015';
    case 'gemini':
      return 'gemini-3-flash-preview';
    case 'local':
      return 'llama3.2';
    default:
      return '';
  }
}

/**
 * Clears the model cache (useful for testing)
 * @deprecated Use invalidateModelCache() instead
 */
export function clearModelCache(): void {
  invalidateModelCache();
}

export default useAIModels;
