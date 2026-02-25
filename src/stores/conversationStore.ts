/**
 * Conversation Store
 *
 * Zustand store for managing conversation state.
 * Provides unified message management with typed parts.
 *
 * Features:
 * - Per-project conversations with SQLite persistence via Tauri IPC
 * - Multi-session support (create, list, switch, delete, archive)
 * - Multi-part message model (text, thinking, plan, tool calls, etc.)
 * - Streaming support via appendPart/updatePart
 * - Conversion to LLMMessage[] for multi-turn context
 * - Debounced persistence to avoid excessive IPC calls
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { invoke } from '@tauri-apps/api/core';
import {
  createConversation,
  createUserMessage,
  createAssistantMessage,
  createSystemMessage,
  toSimpleLLMMessages,
  type Conversation,
  type ConversationMessage,
  type MessagePart,
  type TokenUsage,
} from '@/agents/engine/core/conversation';
import type { LLMMessage } from '@/agents/engine/ports/ILLMClient';
import { createLogger } from '@/services/logger';

const logger = createLogger('ConversationStore');

// =============================================================================
// Constants
// =============================================================================

const SAVE_DEBOUNCE_MS = 1000;

// =============================================================================
// Session Types (mirror backend DTOs)
// =============================================================================

export interface SessionSummary {
  id: string;
  projectId: string;
  title: string;
  agent: string;
  modelProvider: string | null;
  modelId: string | null;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  messageCount: number;
  lastMessagePreview: string | null;
}

// =============================================================================
// Types
// =============================================================================

export interface ConversationState {
  /** The active conversation (loaded per project or session) */
  activeConversation: Conversation | null;
  /** Whether the AI is currently generating a response */
  isGenerating: boolean;
  /** The message ID currently being streamed */
  streamingMessageId: string | null;
  /** The project ID for the active conversation */
  activeProjectId: string | null;
  /** The active session ID (SQLite-backed) */
  activeSessionId: string | null;
  /** Available sessions for the active project */
  sessions: SessionSummary[];
}

export interface ConversationActions {
  /** Load or create a conversation for a project */
  loadForProject: (projectId: string) => void;
  /** Load sessions list for the active project from SQLite */
  loadSessions: (projectId: string) => Promise<void>;
  /** Create a new session and switch to it */
  createSession: (agent?: string) => Promise<string | null>;
  /** Switch to an existing session */
  switchSession: (sessionId: string) => Promise<void>;
  /** Delete a session */
  deleteSession: (sessionId: string) => Promise<void>;
  /** Archive a session */
  archiveSession: (sessionId: string) => Promise<void>;
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
// Debounced Persistence (SQLite via IPC)
// =============================================================================

const saveTimeoutBySession = new Map<string, ReturnType<typeof setTimeout>>();

/** Clear all pending debounced saves (e.g., on project switch or conversation clear). */
function clearAllPendingSaves(): void {
  for (const timeout of saveTimeoutBySession.values()) {
    clearTimeout(timeout);
  }
  saveTimeoutBySession.clear();
}

/**
 * Schedule a debounced save of a finalized message to SQLite.
 * During streaming, parts are appended in-memory only; the full message
 * is persisted once finalizeMessage is called.
 */
function debouncedPersistMessage(
  sessionId: string,
  message: ConversationMessage,
): void {
  const key = `${sessionId}:${message.id}`;
  const existing = saveTimeoutBySession.get(key);
  if (existing) clearTimeout(existing);

  const timeoutId = setTimeout(() => {
    saveTimeoutBySession.delete(key);
    persistMessage(sessionId, message).catch((err) => {
      logger.error('Failed to persist message to SQLite', { sessionId, messageId: message.id, err });
    });
  }, SAVE_DEBOUNCE_MS);
  saveTimeoutBySession.set(key, timeoutId);
}

async function persistMessage(
  sessionId: string,
  message: ConversationMessage,
): Promise<void> {
  try {
    const parts = message.parts.map((part, idx) => ({
      id: `${message.id}_p${idx}`,
      sortOrder: idx,
      partType: part.type,
      dataJson: JSON.stringify(part),
    }));

    await invoke('save_ai_message', {
      input: {
        id: message.id,
        sessionId,
        role: message.role,
        timestamp: message.timestamp,
        parts,
        usageJson: message.usage ? JSON.stringify(message.usage) : null,
        finishReason: null,
      },
    });
  } catch (err) {
    logger.error('Failed to save message via IPC', { sessionId, err });
  }
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
    activeSessionId: null,
    sessions: [],

    // =========================================================================
    // Actions
    // =========================================================================

    loadForProject: (projectId: string) => {
      clearAllPendingSaves();
      set((state) => {
        state.activeProjectId = projectId;
        state.activeConversation = createConversation(projectId);
        state.isGenerating = false;
        state.streamingMessageId = null;
        state.activeSessionId = null;
        state.sessions = [];
      });

      // Fire-and-forget: load sessions from SQLite
      get().loadSessions(projectId);

      logger.info('Loaded conversation for project', { projectId });
    },

    loadSessions: async (projectId: string) => {
      try {
        const sessions = await invoke<SessionSummary[]>('list_ai_sessions', { projectId });
        // Only update if the active project hasn't changed while we were loading
        if (get().activeProjectId === projectId) {
          set((state) => {
            state.sessions = sessions;
          });
        }
      } catch (err) {
        logger.error('Failed to load sessions from SQLite', { projectId, err });
      }
    },

    createSession: async (agent?: string) => {
      const projectId = get().activeProjectId;
      if (!projectId) return null;

      try {
        const session = await invoke<SessionSummary>('create_ai_session', {
          projectId,
          agent: agent ?? 'editor',
          modelProvider: null,
          modelId: null,
        });

        set((state) => {
          state.sessions.unshift(session);
          state.activeSessionId = session.id;
          state.activeConversation = createConversation(projectId);
          state.activeConversation.id = session.id;
          state.isGenerating = false;
          state.streamingMessageId = null;
        });

        logger.info('Created new AI session', { sessionId: session.id, projectId });
        return session.id;
      } catch (err) {
        logger.error('Failed to create AI session', { projectId, err });
        return null;
      }
    },

    switchSession: async (sessionId: string) => {
      try {
        const data = await invoke<{
          session: SessionSummary;
          messages: Array<{
            id: string;
            sessionId: string;
            role: string;
            timestamp: number;
            parts: Array<{ partType: string; dataJson: string }>;
            usageJson: string | null;
          }>;
        }>('get_ai_session', { sessionId });

        const projectId = get().activeProjectId ?? data.session.projectId;

        // Reconstruct ConversationMessage[] from backend data
        const messages: ConversationMessage[] = data.messages.map((msg) => ({
          id: msg.id,
          role: msg.role as ConversationMessage['role'],
          parts: msg.parts.map((p) => {
            try {
              return JSON.parse(p.dataJson) as MessagePart;
            } catch {
              return { type: 'text' as const, content: p.dataJson };
            }
          }),
          timestamp: msg.timestamp,
          sessionId: msg.sessionId,
          usage: msg.usageJson
            ? (() => { try { return JSON.parse(msg.usageJson) as TokenUsage; } catch { return undefined; } })()
            : undefined,
        }));

        set((state) => {
          state.activeSessionId = sessionId;
          state.activeConversation = {
            id: sessionId,
            projectId,
            messages,
            createdAt: data.session.createdAt,
            updatedAt: data.session.updatedAt,
          };
          state.isGenerating = false;
          state.streamingMessageId = null;
        });

        logger.info('Switched to session', { sessionId, messageCount: messages.length });
      } catch (err) {
        logger.error('Failed to switch session', { sessionId, err });
      }
    },

    deleteSession: async (sessionId: string) => {
      try {
        await invoke('delete_ai_session', { sessionId });
        set((state) => {
          state.sessions = state.sessions.filter((s) => s.id !== sessionId);
          if (state.activeSessionId === sessionId) {
            state.activeSessionId = null;
            const pid = state.activeProjectId;
            state.activeConversation = pid ? createConversation(pid) : null;
          }
        });
        logger.info('Deleted AI session', { sessionId });
      } catch (err) {
        logger.error('Failed to delete session', { sessionId, err });
      }
    },

    archiveSession: async (sessionId: string) => {
      try {
        await invoke('archive_ai_session', { sessionId });
        set((state) => {
          state.sessions = state.sessions.filter((s) => s.id !== sessionId);
          if (state.activeSessionId === sessionId) {
            state.activeSessionId = null;
            const pid = state.activeProjectId;
            state.activeConversation = pid ? createConversation(pid) : null;
          }
        });
        logger.info('Archived AI session', { sessionId });
      } catch (err) {
        logger.error('Failed to archive session', { sessionId, err });
      }
    },

    addUserMessage: (content: string) => {
      const msg = createUserMessage(content);
      set((state) => {
        if (!state.activeConversation) return;
        state.activeConversation.messages.push(msg);
        state.activeConversation.updatedAt = Date.now();
      });
      // Persist to SQLite if we have an active session
      const sid = get().activeSessionId;
      if (sid) debouncedPersistMessage(sid, msg);
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

      // Persist finalized message to SQLite
      const sid = get().activeSessionId;
      const conv = get().activeConversation;
      if (sid && conv) {
        const message = conv.messages.find((m) => m.id === messageId);
        if (message) debouncedPersistMessage(sid, message);
      }
    },

    addSystemMessage: (content: string) => {
      const msg = createSystemMessage(content);
      set((state) => {
        if (!state.activeConversation) return;
        state.activeConversation.messages.push(msg);
        state.activeConversation.updatedAt = Date.now();
      });
      const sid = get().activeSessionId;
      if (sid) debouncedPersistMessage(sid, msg);
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
      clearAllPendingSaves();
      const projectId = get().activeProjectId;
      const sessionId = get().activeSessionId;

      set((state) => {
        if (projectId) {
          state.activeConversation = createConversation(projectId);
        } else {
          state.activeConversation = null;
        }
        state.isGenerating = false;
        state.streamingMessageId = null;
        state.activeSessionId = null;
      });

      // Delete the session from SQLite if it exists
      if (sessionId) {
        invoke('delete_ai_session', { sessionId }).catch((err) => {
          logger.error('Failed to delete session during clear', { sessionId, err });
        });
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
