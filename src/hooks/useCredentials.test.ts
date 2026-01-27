/**
 * Tests for useCredentials hook
 *
 * Tests the secure credential management functionality including:
 * - Storing credentials
 * - Checking credential existence
 * - Deleting credentials
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCredentials } from './useCredentials';

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

describe('useCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no credentials stored
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'get_credential_status') {
        return { openai: false, anthropic: false, google: false };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('initialization', () => {
    it('should load credential status on mount', async () => {
      mockInvoke.mockResolvedValueOnce({
        openai: true,
        anthropic: false,
        google: true,
      });

      const { result } = renderHook(() => useCredentials());

      expect(result.current.isLoading).toBe(true);

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.status).toEqual({
        openai: true,
        anthropic: false,
        google: true,
      });
      expect(mockInvoke).toHaveBeenCalledWith('get_credential_status');
    });

    it('should handle initialization error gracefully', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('IPC error'));

      const { result } = renderHook(() => useCredentials());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBe('IPC error');
    });

    it('should not set error when no credentials stored', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('No credentials stored'));

      const { result } = renderHook(() => useCredentials());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Should not treat "no credentials" as an error
      expect(result.current.error).toBe(null);
    });
  });

  describe('storeCredential', () => {
    it('should store a credential successfully', async () => {
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === 'get_credential_status') {
          return { openai: false, anthropic: false, google: false };
        }
        if (command === 'store_credential') {
          return undefined;
        }
        throw new Error(`Unexpected: ${command}`);
      });

      const { result } = renderHook(() => useCredentials());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Update mock for after store
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === 'get_credential_status') {
          return { openai: true, anthropic: false, google: false };
        }
        if (command === 'store_credential') {
          return undefined;
        }
        throw new Error(`Unexpected: ${command}`);
      });

      await act(async () => {
        await result.current.storeCredential('openai', 'sk-test1234');
      });

      expect(mockInvoke).toHaveBeenCalledWith('store_credential', {
        provider: 'openai',
        apiKey: 'sk-test1234',
      });

      expect(result.current.status.openai).toBe(true);
    });

    it('should throw error for empty API key', async () => {
      const { result } = renderHook(() => useCredentials());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await expect(
        act(async () => {
          await result.current.storeCredential('openai', '');
        }),
      ).rejects.toThrow('API key cannot be empty');
    });

    it('should trim whitespace from API key', async () => {
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === 'get_credential_status') {
          return { openai: false, anthropic: false, google: false };
        }
        if (command === 'store_credential') {
          return undefined;
        }
        throw new Error(`Unexpected: ${command}`);
      });

      const { result } = renderHook(() => useCredentials());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.storeCredential('openai', '  sk-test1234  ');
      });

      expect(mockInvoke).toHaveBeenCalledWith('store_credential', {
        provider: 'openai',
        apiKey: 'sk-test1234',
      });
    });

    it('should set isSaving while storing', async () => {
      let resolveStore: () => void = () => {};
      const storePromise = new Promise<void>((resolve) => {
        resolveStore = resolve;
      });

      mockInvoke.mockImplementation(async (command: string) => {
        if (command === 'get_credential_status') {
          return { openai: false, anthropic: false, google: false };
        }
        if (command === 'store_credential') {
          await storePromise;
          return undefined;
        }
        return undefined;
      });

      const { result } = renderHook(() => useCredentials());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Start the store operation
      let inFlight: Promise<void> | null = null;
      act(() => {
        inFlight = result.current.storeCredential('openai', 'sk-test');
      });

      // Check isSaving is set
      await waitFor(() => {
        expect(result.current.isSaving).toBe(true);
      });

      // Resolve the store and wait for completion
      resolveStore();
      await act(async () => {
        await inFlight;
      });

      // isSaving should be false after completion
      await waitFor(() => {
        expect(result.current.isSaving).toBe(false);
      });
    });
  });

  describe('hasCredential', () => {
    it('should check credential existence', async () => {
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === 'get_credential_status') {
          return { openai: true, anthropic: false, google: false };
        }
        if (command === 'has_credential') {
          return true;
        }
        return undefined;
      });

      const { result } = renderHook(() => useCredentials());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let exists = false;
      await act(async () => {
        exists = await result.current.hasCredential('openai');
      });

      expect(exists).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('has_credential', { provider: 'openai' });
    });

    it('should return false on error', async () => {
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === 'get_credential_status') {
          return { openai: false, anthropic: false, google: false };
        }
        if (command === 'has_credential') {
          throw new Error('IPC error');
        }
        return undefined;
      });

      const { result } = renderHook(() => useCredentials());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let exists = true;
      await act(async () => {
        exists = await result.current.hasCredential('openai');
      });

      expect(exists).toBe(false);
    });
  });

  describe('deleteCredential', () => {
    it('should delete a credential', async () => {
      let hasOpenAI = true;

      mockInvoke.mockImplementation(async (command: string) => {
        if (command === 'get_credential_status') {
          return { openai: hasOpenAI, anthropic: false, google: false };
        }
        if (command === 'delete_credential') {
          hasOpenAI = false;
          return undefined;
        }
        return undefined;
      });

      const { result } = renderHook(() => useCredentials());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.status.openai).toBe(true);

      await act(async () => {
        await result.current.deleteCredential('openai');
      });

      expect(mockInvoke).toHaveBeenCalledWith('delete_credential', { provider: 'openai' });
      expect(result.current.status.openai).toBe(false);
    });
  });

  describe('refreshStatus', () => {
    it('should refresh credential status', async () => {
      let callCount = 0;
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === 'get_credential_status') {
          callCount++;
          return {
            openai: callCount > 1,
            anthropic: false,
            google: false,
          };
        }
        return undefined;
      });

      const { result } = renderHook(() => useCredentials());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.status.openai).toBe(false);

      await act(async () => {
        await result.current.refreshStatus();
      });

      expect(result.current.status.openai).toBe(true);
      expect(callCount).toBe(2);
    });
  });

  describe('clearError', () => {
    it('should clear the error state', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Test error'));

      const { result } = renderHook(() => useCredentials());

      await waitFor(() => {
        expect(result.current.error).toBe('Test error');
      });

      act(() => {
        result.current.clearError();
      });

      expect(result.current.error).toBe(null);
    });
  });
});

describe('useCredentials security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'get_credential_status') {
        return { openai: false, anthropic: false, google: false };
      }
      return undefined;
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should never expose API keys in error messages', async () => {
    const sensitiveKey = 'sk-supersecret123456789';

    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'get_credential_status') {
        return { openai: false, anthropic: false, google: false };
      }
      if (command === 'store_credential') {
        throw new Error('Storage failed');
      }
      return undefined;
    });

    const { result } = renderHook(() => useCredentials());

    await waitFor(() => {
      expect(result.current?.isLoading).toBe(false);
    });

    await act(async () => {
      try {
        await result.current.storeCredential('openai', sensitiveKey);
      } catch {
        // Expected to throw
      }
    });

    // Verify error message doesn't contain the key
    await waitFor(() => {
      expect(result.current.error).toBe('Storage failed');
    });
    expect(result.current.error).not.toContain(sensitiveKey);
  });
});
