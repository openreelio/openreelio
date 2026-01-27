/**
 * Chat Storage Service
 *
 * Handles persistence of chat messages to localStorage.
 * Supports per-project chat history with automatic cleanup.
 */

import type { ChatMessage } from '@/stores/aiStore';
import { createLogger } from './logger';

const logger = createLogger('ChatStorage');

// =============================================================================
// Constants
// =============================================================================

/** LocalStorage key prefix for chat history */
const STORAGE_KEY_PREFIX = 'openreelio_chat_history_';

/** Maximum messages to store per project */
const MAX_MESSAGES_PER_PROJECT = 100;

/** Maximum total storage size in bytes (1MB) */
const MAX_STORAGE_SIZE_BYTES = 1024 * 1024;

// =============================================================================
// Types
// =============================================================================

export interface StoredChatHistory {
  projectId: string;
  messages: ChatMessage[];
  lastUpdated: string;
  version: number;
}

// =============================================================================
// Storage Functions
// =============================================================================

/**
 * Get the localStorage key for a project's chat history.
 */
function getStorageKey(projectId: string): string {
  // Sanitize projectId to prevent injection
  const sanitizedId = projectId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${STORAGE_KEY_PREFIX}${sanitizedId}`;
}

/**
 * Load chat history for a project from localStorage.
 *
 * @param projectId - The project ID to load history for
 * @returns Array of chat messages, or empty array if not found
 */
export function loadChatHistory(projectId: string): ChatMessage[] {
  if (!projectId) {
    logger.warn('loadChatHistory called with empty projectId');
    return [];
  }

  try {
    const key = getStorageKey(projectId);
    const stored = localStorage.getItem(key);

    if (!stored) {
      return [];
    }

    const data: StoredChatHistory = JSON.parse(stored);

    // Validate version (for future migrations)
    if (data.version !== 1) {
      logger.warn('Chat history version mismatch', {
        expected: 1,
        actual: data.version,
      });
    }

    // Validate and filter messages
    const messages = data.messages.filter(isValidMessage);

    logger.info('Loaded chat history', {
      projectId,
      messageCount: messages.length,
    });

    return messages;
  } catch (error) {
    logger.error('Failed to load chat history', { projectId, error });
    return [];
  }
}

/**
 * Save chat history for a project to localStorage.
 *
 * @param projectId - The project ID to save history for
 * @param messages - The messages to save
 */
export function saveChatHistory(
  projectId: string,
  messages: ChatMessage[]
): void {
  if (!projectId) {
    logger.warn('saveChatHistory called with empty projectId');
    return;
  }

  try {
    const key = getStorageKey(projectId);

    // Limit messages to prevent storage bloat
    const limitedMessages = messages.slice(-MAX_MESSAGES_PER_PROJECT);

    const data: StoredChatHistory = {
      projectId,
      messages: limitedMessages,
      lastUpdated: new Date().toISOString(),
      version: 1,
    };

    const serialized = JSON.stringify(data);

    // Check size before saving
    if (serialized.length > MAX_STORAGE_SIZE_BYTES) {
      logger.warn('Chat history exceeds size limit, truncating', {
        projectId,
        size: serialized.length,
        limit: MAX_STORAGE_SIZE_BYTES,
      });

      // Reduce messages until under limit
      let truncatedMessages = limitedMessages;
      while (truncatedMessages.length > 10) {
        truncatedMessages = truncatedMessages.slice(
          Math.floor(truncatedMessages.length / 2)
        );
        const truncatedData: StoredChatHistory = {
          ...data,
          messages: truncatedMessages,
        };
        const truncatedSerialized = JSON.stringify(truncatedData);
        if (truncatedSerialized.length <= MAX_STORAGE_SIZE_BYTES) {
          localStorage.setItem(key, truncatedSerialized);
          logger.info('Saved truncated chat history', {
            projectId,
            messageCount: truncatedMessages.length,
          });
          return;
        }
      }
    } else {
      localStorage.setItem(key, serialized);
      logger.info('Saved chat history', {
        projectId,
        messageCount: limitedMessages.length,
      });
    }
  } catch (error) {
    if (
      error instanceof DOMException &&
      error.name === 'QuotaExceededError'
    ) {
      logger.error('localStorage quota exceeded', { projectId });
      // Try to clear old histories
      cleanupOldHistories();
    } else {
      logger.error('Failed to save chat history', { projectId, error });
    }
  }
}

/**
 * Clear chat history for a project.
 *
 * @param projectId - The project ID to clear history for
 */
export function clearChatHistory(projectId: string): void {
  if (!projectId) {
    return;
  }

  try {
    const key = getStorageKey(projectId);
    localStorage.removeItem(key);
    logger.info('Cleared chat history', { projectId });
  } catch (error) {
    logger.error('Failed to clear chat history', { projectId, error });
  }
}

/**
 * Cleanup old chat histories to free up localStorage space.
 * Removes histories older than 30 days.
 */
export function cleanupOldHistories(): void {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const keysToRemove: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(STORAGE_KEY_PREFIX)) {
        continue;
      }

      try {
        const stored = localStorage.getItem(key);
        if (!stored) continue;

        const data: StoredChatHistory = JSON.parse(stored);
        const lastUpdated = new Date(data.lastUpdated);

        if (lastUpdated < thirtyDaysAgo) {
          keysToRemove.push(key);
        }
      } catch {
        // If we can't parse it, it's probably corrupted, so remove it
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }

    if (keysToRemove.length > 0) {
      logger.info('Cleaned up old chat histories', {
        count: keysToRemove.length,
      });
    }
  } catch (error) {
    logger.error('Failed to cleanup old histories', { error });
  }
}

/**
 * Get all project IDs that have stored chat histories.
 */
export function getStoredProjectIds(): string[] {
  const projectIds: string[] = [];

  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_KEY_PREFIX)) {
        const projectId = key.slice(STORAGE_KEY_PREFIX.length);
        projectIds.push(projectId);
      }
    }
  } catch (error) {
    logger.error('Failed to get stored project IDs', { error });
  }

  return projectIds;
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Check if a message object is valid.
 */
function isValidMessage(message: unknown): message is ChatMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  const msg = message as Record<string, unknown>;

  return (
    typeof msg.id === 'string' &&
    (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system') &&
    typeof msg.content === 'string' &&
    typeof msg.timestamp === 'string'
  );
}

// =============================================================================
// Debounced Saver
// =============================================================================

type SaverFunction = (projectId: string, messages: ChatMessage[]) => void;

/**
 * Create a debounced save function to avoid excessive writes.
 *
 * @param delayMs - Debounce delay in milliseconds
 * @returns Debounced save function
 */
export function createDebouncedSaver(delayMs = 1000): SaverFunction {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let pendingProjectId: string | null = null;
  let pendingMessages: ChatMessage[] | null = null;

  return (projectId: string, messages: ChatMessage[]) => {
    pendingProjectId = projectId;
    pendingMessages = messages;

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      if (pendingProjectId && pendingMessages) {
        saveChatHistory(pendingProjectId, pendingMessages);
      }
      timeoutId = null;
      pendingProjectId = null;
      pendingMessages = null;
    }, delayMs);
  };
}
