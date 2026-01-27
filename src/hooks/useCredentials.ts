/**
 * Secure Credential Management Hook
 *
 * Provides a type-safe interface for storing API keys
 * from the encrypted credential vault in the Tauri backend.
 *
 * Security Features:
 * - API keys are encrypted at rest using XChaCha20-Poly1305
 * - Keys are never stored in localStorage or sessionStorage
 * - Keys are only transmitted over Tauri's secure IPC channel
 * - Memory is cleared after use via secure vault implementation
 */

import { useState, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { createLogger } from '@/services/logger';
import { invalidateModelCache } from './useAIModels';

const logger = createLogger('useCredentials');

/** Supported credential provider types */
export type CredentialProvider = 'openai' | 'anthropic' | 'google';

/**
 * Maps credential provider to AI provider type for cache invalidation
 */
function mapProviderToAIProvider(provider: CredentialProvider): 'openai' | 'anthropic' | 'gemini' | undefined {
  switch (provider) {
    case 'openai':
      return 'openai';
    case 'anthropic':
      return 'anthropic';
    case 'google':
      return 'gemini';
    default:
      return undefined;
  }
}

/** Status of credentials for each provider */
export interface CredentialStatus {
  openai: boolean;
  anthropic: boolean;
  google: boolean;
}

/** Hook state */
interface UseCredentialsState {
  /** Status of each credential */
  status: CredentialStatus;
  /** Whether credentials are being loaded */
  isLoading: boolean;
  /** Whether a save operation is in progress */
  isSaving: boolean;
  /** Error message if any operation failed */
  error: string | null;
}

/** Hook actions */
interface UseCredentialsActions {
  /** Store a credential securely */
  storeCredential: (provider: CredentialProvider, apiKey: string) => Promise<void>;
  /** Check if a credential exists */
  hasCredential: (provider: CredentialProvider) => Promise<boolean>;
  /** Delete a credential */
  deleteCredential: (provider: CredentialProvider) => Promise<void>;
  /** Refresh credential status */
  refreshStatus: () => Promise<void>;
  /** Clear any error */
  clearError: () => void;
}

/** Combined hook return type */
export type UseCredentialsReturn = UseCredentialsState & UseCredentialsActions;

/**
 * Hook for managing secure API credentials
 *
 * @example
 * ```tsx
 * const { status, storeCredential, deleteCredential } = useCredentials();
 *
 * // Store a credential
 * await storeCredential('openai', 'sk-...');
 *
 * // Check if configured
 * if (status.openai) {
 *   console.log('OpenAI is configured');
 * }
 *
 * // Delete a credential
 * await deleteCredential('anthropic');
 * ```
 */
export function useCredentials(): UseCredentialsReturn {
  const [status, setStatus] = useState<CredentialStatus>({
    openai: false,
    anthropic: false,
    google: false,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Fetches the current credential status from the vault
   */
  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      setIsLoading(true);
      setError(null);

      const result = await invoke<CredentialStatus>('get_credential_status');
      setStatus(result);

      logger.debug('Credential status refreshed', { result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to refresh credential status', { error: message });
      // Don't set error for initial load - vault may not exist yet
      if (!message.includes('No credentials stored')) {
        setError(message);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Stores a credential securely in the encrypted vault
   */
  const storeCredential = useCallback(
    async (provider: CredentialProvider, apiKey: string): Promise<void> => {
      if (!apiKey.trim()) {
        throw new Error('API key cannot be empty');
      }

      try {
        setIsSaving(true);
        setError(null);

        await invoke('store_credential', {
          provider,
          apiKey: apiKey.trim(),
        });

        // Invalidate model cache for this provider since credential changed
        // This ensures fresh model list is fetched with new credentials
        invalidateModelCache(mapProviderToAIProvider(provider));

        // Refresh status after storing
        await refreshStatus();

        logger.info('Credential stored successfully', { provider });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Failed to store credential', { provider, error: message });
        setError(message);
        throw new Error(message);
      } finally {
        setIsSaving(false);
      }
    },
    [refreshStatus]
  );

  /**
   * Checks if a credential exists without retrieving it
   */
  const hasCredential = useCallback(
    async (provider: CredentialProvider): Promise<boolean> => {
      try {
        const exists = await invoke<boolean>('has_credential', { provider });
        return exists;
      } catch (err) {
        logger.warn('Failed to check credential existence', {
          provider,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },
    []
  );

  /**
   * Deletes a credential from the vault
   */
  const deleteCredential = useCallback(
    async (provider: CredentialProvider): Promise<void> => {
      try {
        setIsSaving(true);
        setError(null);

        await invoke('delete_credential', { provider });

        // Invalidate model cache since credential was removed
        invalidateModelCache(mapProviderToAIProvider(provider));

        // Refresh status after deletion
        await refreshStatus();

        logger.info('Credential deleted successfully', { provider });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Failed to delete credential', { provider, error: message });
        setError(message);
        throw new Error(message);
      } finally {
        setIsSaving(false);
      }
    },
    [refreshStatus]
  );

  /**
   * Clears the current error
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Load credential status on mount
  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  return {
    status,
    isLoading,
    isSaving,
    error,
    storeCredential,
    hasCredential,
    deleteCredential,
    refreshStatus,
    clearError,
  };
}

export default useCredentials;
