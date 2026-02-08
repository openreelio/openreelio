/**
 * Conversation Store
 *
 * Zustand store for managing conversation state.
 * Replaces the fragmented chat state across aiStore and AgenticChat.
 * Provides unified message management with typed parts.
 *
 * Features:
 * - Per-project conversations with persistence
 * - Multi-part message model (text, thinking, plan, tool calls, etc.)
 * - Streaming support via appendPart/updatePart
 * - Conversion to LLMMessage[] for multi-turn context
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  createConversation,
  createUserMessage,
  createAssistantMessage,
  createSystemMessage,
  toSimpleLLMMessages,
  isValidConversationMessage,
  type Conversation,
  type MessagePart,
  type TokenUsage,
} from '@/agents/engine/core/conversation';
import type { LLMMessage } from '@/agents/engine/ports/ILLMClient';
import { createLogger } from '@/services/logger';

const logger = createLogger('ConversationStore');

// =============================================================================
// Constants
// =============================================================================

const STORAGE_KEY_PREFIX = 'openreelio_conversation_';
const MAX_MESSAGES_PER_CONVERSATION = 200;
const MAX_STORAGE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
const SAVE_DEBOUNCE_MS = 1000;

// =============================================================================
// Types
// =============================================================================

export interface ConversationState {
  /** The active conversation (loaded per project) */
  activeConversation: Conversation | null;
  /** Whether the AI is currently generating a response */
  isGenerating: boolean;
  /** The message ID currently being streamed */
  streamingMessageId: string | null;
  /** The project ID for the active conversation */
  activeProjectId: string | null;
}

export interface ConversationActions {
  /** Load or create a conversation for a project */
  loadForProject: (projectId: string) => void;
  /** Add a user message and return its ID */
  addUserMessage: (content: string) => string;
  /** Start a new assistant message (for streaming) and return its ID */
  startAssistantMessage: (sessionId?: string) => string;
  /** Append a part to an existing message */
  appendPart: (messageId: string, part: MessagePart) => void;
  /** Update an existing part on a message */
  updatePart: (messageId: string, partIndex: number, update: Partial<MessagePart>) => void;
  /** Finalize a streaming message (mark generation as complete) */
  finalizeMessage: (messageId: string, usage?: TokenUsage) => void;
  /** Add a system message */
  addSystemMessage: (content: string) => string;
  /** Get messages formatted for LLM context */
  getMessagesForContext: (maxMessages?: number) => LLMMessage[];
  /** Get the last user input text */
  getLastUserInput: () => string | null;
  /** Clear the current conversation */
  clearConversation: () => void;
  /** Set generating state */
  setGenerating: (isGenerating: boolean) => void;
}

export type ConversationStore = ConversationState & ConversationActions;

// =============================================================================
// Persistence Helpers
// =============================================================================

function getStorageKey(projectId: string): string {
  const sanitized = projectId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${STORAGE_KEY_PREFIX}${sanitized}`;
}

function loadFromStorage(projectId: string): Conversation | null {
  try {
    const key = getStorageKey(projectId);
    const stored = localStorage.getItem(key);
    if (!stored) return null;

    const data = JSON.parse(stored) as Conversation;
    if (!data || !data.id || !data.projectId || !Array.isArray(data.messages)) {
      return null;
    }

    // Validate and filter messages
    data.messages = data.messages.filter(isValidConversationMessage);
    return data;
  } catch (error) {
    logger.error('Failed to load conversation from storage', { projectId, error });
    return null;
  }
}

function saveToStorage(conversation: Conversation): void {
  try {
    const key = getStorageKey(conversation.projectId);

    // Limit messages
    const limitedConv: Conversation = {
      ...conversation,
      messages: conversation.messages.slice(-MAX_MESSAGES_PER_CONVERSATION),
      updatedAt: Date.now(),
    };

    const serialized = JSON.stringify(limitedConv);

    if (serialized.length > MAX_STORAGE_SIZE_BYTES) {
      logger.warn('Conversation exceeds size limit, truncating', {
        projectId: conversation.projectId,
        size: serialized.length,
      });
      // Keep most recent messages
      limitedConv.messages = limitedConv.messages.slice(
        -Math.floor(MAX_MESSAGES_PER_CONVERSATION / 2)
      );
      const truncated = JSON.stringify(limitedConv);
      localStorage.setItem(key, truncated);
    } else {
      localStorage.setItem(key, serialized);
    }
  } catch (error) {
    logger.error('Failed to save conversation to storage', {
      projectId: conversation.projectId,
      error,
    });
  }
}

// =============================================================================
// Debounced Save
// =============================================================================

let saveTimeoutId: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule a debounced save. Reads the latest conversation from the
 * store when the timeout fires, so rapid mutations within the debounce
 * window all get persisted (not just the first snapshot).
 */
function debouncedSave(getLatest: () => Conversation | null): void {
  if (saveTimeoutId) {
    clearTimeout(saveTimeoutId);
  }
  saveTimeoutId = setTimeout(() => {
    const conversation = getLatest();
    if (conversation) {
      saveToStorage(conversation);
    }
    saveTimeoutId = null;
  }, SAVE_DEBOUNCE_MS);
}

// =============================================================================
// Store
// =============================================================================

export const useConversationStore = create<ConversationStore>()(
  immer((set, get) => ({
    // =========================================================================
    // State
    // =========================================================================
    activeConversation: null,
    isGenerating: false,
    streamingMessageId: null,
    activeProjectId: null,

    // =========================================================================
    // Actions
    // =========================================================================

    loadForProject: (projectId: string) => {
      const existing = loadFromStorage(projectId);
      set((state) => {
        state.activeProjectId = projectId;
        state.activeConversation = existing ?? createConversation(projectId);
        state.isGenerating = false;
        state.streamingMessageId = null;
      });
      logger.info('Loaded conversation for project', {
        projectId,
        messageCount: existing?.messages.length ?? 0,
      });
    },

    addUserMessage: (content: string) => {
      const msg = createUserMessage(content);
      set((state) => {
        if (!state.activeConversation) return;
        state.activeConversation.messages.push(msg);
        state.activeConversation.updatedAt = Date.now();
      });
      debouncedSave(() => get().activeConversation);
      return msg.id;
    },

    startAssistantMessage: (sessionId?: string) => {
      const msg = createAssistantMessage(sessionId);
      set((state) => {
        if (!state.activeConversation) return;
        state.activeConversation.messages.push(msg);
        state.activeConversation.updatedAt = Date.now();
        state.isGenerating = true;
        state.streamingMessageId = msg.id;
      });
      return msg.id;
    },

    appendPart: (messageId: string, part: MessagePart) => {
      set((state) => {
        if (!state.activeConversation) return;
        const message = state.activeConversation.messages.find(
          (m) => m.id === messageId
        );
        if (message) {
          message.parts.push(part);
          state.activeConversation.updatedAt = Date.now();
        }
      });
    },

    updatePart: (messageId: string, partIndex: number, update: Partial<MessagePart>) => {
      set((state) => {
        if (!state.activeConversation) return;
        const message = state.activeConversation.messages.find(
          (m) => m.id === messageId
        );
        if (message && message.parts[partIndex]) {
          Object.assign(message.parts[partIndex], update);
          state.activeConversation.updatedAt = Date.now();
        }
      });
    },

    finalizeMessage: (messageId: string, usage?: TokenUsage) => {
      set((state) => {
        if (!state.activeConversation) return;
        const message = state.activeConversation.messages.find(
          (m) => m.id === messageId
        );
        if (message && usage) {
          message.usage = usage;
        }
        state.isGenerating = false;
        state.streamingMessageId = null;
        state.activeConversation.updatedAt = Date.now();
      });
      debouncedSave(() => get().activeConversation);
    },

    addSystemMessage: (content: string) => {
      const msg = createSystemMessage(content);
      set((state) => {
        if (!state.activeConversation) return;
        state.activeConversation.messages.push(msg);
        state.activeConversation.updatedAt = Date.now();
      });
      debouncedSave(() => get().activeConversation);
      return msg.id;
    },

    getMessagesForContext: (maxMessages?: number) => {
      const conv = get().activeConversation;
      if (!conv) return [];
      return toSimpleLLMMessages(conv.messages, maxMessages);
    },

    getLastUserInput: () => {
      const conv = get().activeConversation;
      if (!conv) return null;
      for (let i = conv.messages.length - 1; i >= 0; i--) {
        const msg = conv.messages[i];
        if (msg.role === 'user') {
          const textPart = msg.parts.find((p) => p.type === 'text');
          if (textPart && textPart.type === 'text') {
            return textPart.content;
          }
        }
      }
      return null;
    },

    clearConversation: () => {
      const projectId = get().activeProjectId;
      set((state) => {
        if (projectId) {
          state.activeConversation = createConversation(projectId);
        } else {
          state.activeConversation = null;
        }
        state.isGenerating = false;
        state.streamingMessageId = null;
      });
      if (projectId) {
        try {
          localStorage.removeItem(getStorageKey(projectId));
        } catch {
          // Ignore storage errors during clear
        }
      }
    },

    setGenerating: (isGenerating: boolean) => {
      set((state) => {
        state.isGenerating = isGenerating;
        if (!isGenerating) {
          state.streamingMessageId = null;
        }
      });
    },
  }))
);
