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
  type PersistenceStatus,
} from '@/agents/engine/core/conversation';
import type { LLMMessage } from '@/agents/engine/ports/ILLMClient';
import { hydratePersistedPermissionRules } from '@/agents/engine/core/permissionAudit';
import { createLogger } from '@/services/logger';
import { useAgentArtifactReviewStore } from '@/stores/agentArtifactReviewStore';
import { useAgentDelegationStore } from '@/stores/agentDelegationStore';
import { useAgentSessionStore } from '@/stores/agentSessionStore';
import { usePermissionStore } from '@/stores/permissionStore';

const logger = createLogger('ConversationStore');

// =============================================================================
// Constants
// =============================================================================

const SAVE_DEBOUNCE_MS = 1000;
const PERSIST_MAX_RETRIES = 3;
const PERSIST_BACKOFF_BASE_MS = 1000;

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
  /** In-memory transcripts keyed by session so background runs survive session switches. */
  conversationsBySessionId: Record<string, Conversation>;
  /** Streaming status keyed by session so live background runs survive session switches. */
  sessionGenerationBySessionId: Record<string, ConversationSessionGenerationState>;
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

export interface ConversationSessionGenerationState {
  isGenerating: boolean;
  streamingMessageId: string | null;
}

export interface ConversationActions {
  /** Load or create a conversation for a project */
  loadForProject: (projectId: string) => void;
  /** Load sessions list for the active project from SQLite */
  loadSessions: (projectId: string) => Promise<void>;
  /** Create a new session and switch to it */
  createSession: (
    agent?: string,
    options?: { preserveDraftConversation?: boolean },
  ) => Promise<string | null>;
  /** Switch to an existing session */
  switchSession: (sessionId: string) => Promise<void>;
  /** Delete a session */
  deleteSession: (sessionId: string) => Promise<void>;
  /** Archive a session */
  archiveSession: (sessionId: string) => Promise<void>;
  /** Add a user message and return its ID */
  addUserMessage: (content: string, options?: { persist?: boolean }) => string;
  /** Persist a queued message once it is actually dequeued for execution */
  persistQueuedMessage: (messageId: string, sessionId?: string | null) => void;
  /** Start a new assistant message (for streaming) and return its ID */
  startAssistantMessage: (sessionId?: string) => string;
  /** Append a part to an existing message */
  appendPart: (messageId: string, part: MessagePart) => void;
  /** Update an existing part on a message */
  updatePart: (messageId: string, partIndex: number, update: Partial<MessagePart>) => void;
  /** Finalize a streaming message (mark generation as complete) */
  finalizeMessage: (messageId: string, usage?: TokenUsage) => void;
  /** Return message parts by message ID, including inactive cached sessions. */
  getMessageParts: (messageId: string) => MessagePart[] | null;
  /** Add a system message */
  addSystemMessage: (content: string) => string;
  /** Add a system message to a specific session */
  addSystemMessageToSession: (sessionId: string, content: string) => string;
  /** Get messages formatted for LLM context */
  getMessagesForContext: (maxMessages?: number) => LLMMessage[];
  /** Get the last user input text */
  getLastUserInput: () => string | null;
  /** Clear the current conversation (creates new session, preserves old one) */
  clearConversation: () => void;
  /** Set generating state */
  setGenerating: (isGenerating: boolean) => void;
  /** Ensure an active session exists, creating one if needed. Returns the session ID. */
  ensureSession: (agent?: string) => Promise<string | null>;
}

export type ConversationStore = ConversationState & ConversationActions;

// =============================================================================
// Debounced Persistence (SQLite via IPC)
// =============================================================================

interface PendingMessageSave {
  timeoutId: ReturnType<typeof setTimeout>;
  sessionId: string;
  message: ConversationMessage;
}

const pendingMessageSaves = new Map<string, PendingMessageSave>();
const pendingSessionCreationByProject = new Map<string, Promise<string | null>>();
let latestSwitchSessionRequestToken = 0;

function createConversationForSession(state: ConversationState, sessionId: string): Conversation {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  const conversation = createConversation(
    session?.projectId ?? state.activeProjectId ?? state.activeConversation?.projectId ?? 'unknown',
  );
  conversation.id = sessionId;
  if (session) {
    conversation.createdAt = session.createdAt;
    conversation.updatedAt = session.updatedAt;
  }
  return conversation;
}

function getOrCreateConversationForSession(
  state: ConversationState,
  sessionId: string,
): Conversation {
  if (state.activeSessionId === sessionId && state.activeConversation) {
    return state.activeConversation;
  }

  const existing = state.conversationsBySessionId[sessionId];
  if (existing) {
    return existing;
  }

  const created = createConversationForSession(state, sessionId);
  state.conversationsBySessionId[sessionId] = created;
  return created;
}

function rememberActiveSessionGeneration(state: ConversationState): void {
  if (!state.activeSessionId) {
    return;
  }

  state.sessionGenerationBySessionId[state.activeSessionId] = {
    isGenerating: state.isGenerating,
    streamingMessageId: state.streamingMessageId,
  };
}

function restoreSessionGeneration(state: ConversationState, sessionId: string): void {
  const generation = state.sessionGenerationBySessionId[sessionId];
  state.isGenerating = generation?.isGenerating ?? false;
  state.streamingMessageId = generation?.streamingMessageId ?? null;
}

function clearSessionGeneration(state: ConversationState, sessionId: string): void {
  state.sessionGenerationBySessionId[sessionId] = {
    isGenerating: false,
    streamingMessageId: null,
  };
}

function findMessageInConversations(
  state: ConversationState,
  messageId: string,
): { sessionId: string | null; conversation: Conversation; message: ConversationMessage } | null {
  const activeMessage = state.activeConversation?.messages.find(
    (message) => message.id === messageId,
  );
  if (state.activeConversation && activeMessage) {
    return {
      sessionId: activeMessage.sessionId ?? state.activeSessionId,
      conversation: state.activeConversation,
      message: activeMessage,
    };
  }

  for (const [sessionId, conversation] of Object.entries(state.conversationsBySessionId)) {
    if (conversation === state.activeConversation) {
      continue;
    }
    const message = conversation.messages.find((candidate) => candidate.id === messageId);
    if (message) {
      return { sessionId: message.sessionId ?? sessionId, conversation, message };
    }
  }

  return null;
}

function snapshotMessage(message: ConversationMessage): ConversationMessage {
  return {
    ...message,
    parts: message.parts.map((part) => ({ ...part }) as MessagePart),
  };
}

function logPendingSaveError(sessionId: string, messageId: string, err: unknown): void {
  logger.error('Failed to persist pending message to SQLite', {
    sessionId,
    messageId,
    err,
  });
}

/** Flush all pending debounced saves before changing the active conversation. */
function clearAllPendingSaves(): void {
  for (const [key, pending] of pendingMessageSaves.entries()) {
    clearTimeout(pending.timeoutId);
    pendingMessageSaves.delete(key);
    persistMessage(pending.sessionId, pending.message).catch((err) => {
      logPendingSaveError(pending.sessionId, pending.message.id, err);
    });
  }
}

function cancelPendingSavesForSession(sessionId: string): void {
  for (const [key, pending] of pendingMessageSaves.entries()) {
    if (pending.sessionId !== sessionId) {
      continue;
    }

    clearTimeout(pending.timeoutId);
    pendingMessageSaves.delete(key);
  }
}

/**
 * Schedule a debounced save of a finalized message to SQLite.
 * During streaming, parts are appended in-memory only; the full message
 * is persisted once finalizeMessage is called.
 */
function debouncedPersistMessage(sessionId: string, message: ConversationMessage): void {
  const key = `${sessionId}:${message.id}`;
  const existing = pendingMessageSaves.get(key);
  if (existing) clearTimeout(existing.timeoutId);

  const timeoutId = setTimeout(() => {
    pendingMessageSaves.delete(key);
    persistMessage(sessionId, message).catch((err) => {
      logger.error('Failed to persist message to SQLite', {
        sessionId,
        messageId: message.id,
        err,
      });
    });
  }, SAVE_DEBOUNCE_MS);
  pendingMessageSaves.set(key, { timeoutId, sessionId, message });
}

/** Update the persistenceStatus of a message in the store. */
function updatePersistenceStatus(messageId: string, status: PersistenceStatus): void {
  useConversationStore.setState((state) => {
    if (!state.activeConversation) return;
    const message = state.activeConversation.messages.find((m) => m.id === messageId);
    if (message) {
      message.persistenceStatus = status;
    }
  });
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}

function isMissingAgentSessionError(error: unknown): boolean {
  return /not found/i.test(extractErrorMessage(error));
}

async function hydrateAgentSessionKernel(projectId: string, sessionId: string): Promise<void> {
  const agentSessionStore = useAgentSessionStore.getState();
  agentSessionStore.loadForProject(projectId);

  try {
    await agentSessionStore.loadSession(sessionId);
  } catch (error) {
    const message = extractErrorMessage(error);
    if (isMissingAgentSessionError(error)) {
      logger.info('No persisted agent session kernel found for conversation session', {
        projectId,
        sessionId,
      });
      return;
    }

    logger.warn('Failed to hydrate agent session kernel for conversation session', {
      projectId,
      sessionId,
      error: message,
    });
  }
}

async function persistMessage(sessionId: string, message: ConversationMessage): Promise<void> {
  const parts = message.parts.map((part, idx) => ({
    id: `${message.id}_p${idx}`,
    sortOrder: idx,
    partType: part.type,
    dataJson: JSON.stringify(part),
  }));

  const input = {
    id: message.id,
    sessionId,
    role: message.role,
    timestamp: message.timestamp,
    parts,
    usageJson: message.usage ? JSON.stringify(message.usage) : null,
    finishReason: null,
  };

  for (let attempt = 1; attempt <= PERSIST_MAX_RETRIES; attempt++) {
    try {
      await invoke('save_ai_message', { input });
      updatePersistenceStatus(message.id, 'saved');
      return;
    } catch (err) {
      logger.error('Failed to save message via IPC', {
        sessionId,
        messageId: message.id,
        attempt,
        maxRetries: PERSIST_MAX_RETRIES,
        err,
      });

      if (attempt < PERSIST_MAX_RETRIES) {
        const delay = PERSIST_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // All retries exhausted
  updatePersistenceStatus(message.id, 'failed');
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
    conversationsBySessionId: {},
    sessionGenerationBySessionId: {},
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
      usePermissionStore.getState().resetSessionRules();
      useAgentArtifactReviewStore.getState().clearSelection();
      useAgentDelegationStore.getState().clear();
      set((state) => {
        state.activeProjectId = projectId;
        state.activeConversation = createConversation(projectId);
        state.conversationsBySessionId = {};
        state.sessionGenerationBySessionId = {};
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

          // Auto-select the most recent session if none is active
          if (!get().activeSessionId && sessions.length > 0) {
            const currentState = get();
            const hasDraftTranscript =
              currentState.activeConversation?.projectId === projectId &&
              currentState.activeConversation.messages.length > 0;
            const hasPendingDraftSession = pendingSessionCreationByProject.has(projectId);

            // If the user already started a new draft turn while sessions were loading,
            // keep that draft attached to the session creation flow instead of
            // clobbering it with an auto-restored historical session.
            if (!hasDraftTranscript && !hasPendingDraftSession) {
              const mostRecent = sessions[0]; // Backend returns ordered by updated_at DESC
              await get().switchSession(mostRecent.id);
            } else {
              logger.info('Skipped auto-restoring most recent AI session', {
                projectId,
                hasDraftTranscript,
                hasPendingDraftSession,
              });
            }
          }
        }
      } catch (err) {
        logger.error('Failed to load sessions from SQLite', { projectId, err });
      }
    },

    createSession: async (agent?: string, options?: { preserveDraftConversation?: boolean }) => {
      const projectId = get().activeProjectId;
      if (!projectId) return null;
      latestSwitchSessionRequestToken += 1;

      try {
        const session = await invoke<SessionSummary>('create_ai_session', {
          projectId,
          agent: agent ?? 'editor',
          modelProvider: null,
          modelId: null,
        });

        // Project may have changed while the async IPC call was in-flight.
        if (get().activeProjectId !== projectId) {
          logger.warn('Discarding stale session creation result after project switch', {
            sessionId: session.id,
            createdForProjectId: projectId,
            activeProjectId: get().activeProjectId,
          });
          return session.id;
        }

        usePermissionStore.getState().resetSessionRules();
        set((state) => {
          if (state.activeSessionId && state.activeConversation) {
            state.conversationsBySessionId[state.activeSessionId] = state.activeConversation;
            rememberActiveSessionGeneration(state);
          }

          const hadNoActiveSession = !state.activeSessionId;
          const shouldPreserveDraftConversation =
            options?.preserveDraftConversation === true &&
            hadNoActiveSession &&
            state.activeConversation?.projectId === projectId &&
            state.activeConversation.messages.length > 0;

          state.sessions = [session, ...state.sessions.filter((s) => s.id !== session.id)];
          state.activeSessionId = session.id;

          if (shouldPreserveDraftConversation && state.activeConversation) {
            state.activeConversation.id = session.id;
            state.activeConversation.updatedAt = Date.now();
          } else {
            state.activeConversation = createConversation(projectId);
            state.activeConversation.id = session.id;
          }

          state.conversationsBySessionId[session.id] = state.activeConversation;
          clearSessionGeneration(state, session.id);
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
      const requestToken = ++latestSwitchSessionRequestToken;
      set((state) => {
        if (state.activeSessionId && state.activeConversation) {
          state.conversationsBySessionId[state.activeSessionId] = state.activeConversation;
          rememberActiveSessionGeneration(state);
        }
      });

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

        if (requestToken !== latestSwitchSessionRequestToken) {
          logger.info('Ignoring stale session switch response', { sessionId });
          return;
        }

        const activeProjectId = get().activeProjectId;
        if (activeProjectId && activeProjectId !== data.session.projectId) {
          logger.warn('Ignoring switchSession from a different project context', {
            sessionId,
            sessionProjectId: data.session.projectId,
            activeProjectId,
          });
          return;
        }

        const projectId = data.session.projectId;

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
            ? (() => {
                try {
                  return JSON.parse(msg.usageJson) as TokenUsage;
                } catch {
                  return undefined;
                }
              })()
            : undefined,
        }));

        usePermissionStore.getState().resetSessionRules();
        const cachedConversation = get().conversationsBySessionId[sessionId] ?? null;
        set((state) => {
          state.activeSessionId = sessionId;
          state.activeConversation = cachedConversation ?? {
            id: sessionId,
            projectId,
            messages,
            createdAt: data.session.createdAt,
            updatedAt: data.session.updatedAt,
          };
          state.conversationsBySessionId[sessionId] = state.activeConversation;
          restoreSessionGeneration(state, sessionId);
        });

        await hydratePersistedPermissionRules(sessionId, {
          shouldApply: () => get().activeSessionId === sessionId,
        });
        void hydrateAgentSessionKernel(projectId, sessionId);
        logger.info('Switched to session', { sessionId, messageCount: messages.length });
      } catch (err) {
        logger.error('Failed to switch session', { sessionId, err });
      }
    },

    deleteSession: async (sessionId: string) => {
      try {
        await invoke('delete_ai_session', { sessionId });
        cancelPendingSavesForSession(sessionId);
        const wasActive = get().activeSessionId === sessionId;
        set((state) => {
          state.sessions = state.sessions.filter((s) => s.id !== sessionId);
          delete state.conversationsBySessionId[sessionId];
          delete state.sessionGenerationBySessionId[sessionId];
          if (state.activeSessionId === sessionId) {
            state.activeSessionId = null;
            const pid = state.activeProjectId;
            state.activeConversation = pid ? createConversation(pid) : null;
            state.isGenerating = false;
            state.streamingMessageId = null;
          }
        });
        useAgentDelegationStore.getState().clearForSession(sessionId);
        if (wasActive) {
          usePermissionStore.getState().resetSessionRules();
        }
        logger.info('Deleted AI session', { sessionId });
      } catch (err) {
        logger.error('Failed to delete session', { sessionId, err });
      }
    },

    archiveSession: async (sessionId: string) => {
      try {
        await invoke('archive_ai_session', { sessionId });
        cancelPendingSavesForSession(sessionId);
        const wasActive = get().activeSessionId === sessionId;
        set((state) => {
          state.sessions = state.sessions.filter((s) => s.id !== sessionId);
          delete state.conversationsBySessionId[sessionId];
          delete state.sessionGenerationBySessionId[sessionId];
          if (state.activeSessionId === sessionId) {
            state.activeSessionId = null;
            const pid = state.activeProjectId;
            state.activeConversation = pid ? createConversation(pid) : null;
            state.isGenerating = false;
            state.streamingMessageId = null;
          }
        });
        useAgentDelegationStore.getState().clearForSession(sessionId);
        if (wasActive) {
          usePermissionStore.getState().resetSessionRules();
        }
        logger.info('Archived AI session', { sessionId });
      } catch (err) {
        logger.error('Failed to archive session', { sessionId, err });
      }
    },

    addUserMessage: (content: string, options?: { persist?: boolean }) => {
      const msg = createUserMessage(content);
      const sid = get().activeSessionId;
      const shouldPersist = options?.persist !== false;
      if (sid) {
        msg.sessionId = sid;
      }

      set((state) => {
        if (!state.activeConversation) return;
        state.activeConversation.messages.push(msg);
        state.activeConversation.updatedAt = Date.now();
        if (state.activeSessionId) {
          state.conversationsBySessionId[state.activeSessionId] = state.activeConversation;
        }
      });

      // Persist to SQLite if we have an active session
      if (!shouldPersist) {
        return msg.id;
      }

      if (sid) {
        debouncedPersistMessage(sid, msg);
      } else {
        // Auto-create a session on first message if none exists
        get()
          .ensureSession()
          .then((newSid) => {
            if (!newSid) return;

            // Bind the message to the newly created session for deterministic persistence.
            set((state) => {
              if (!state.activeConversation) return;
              const target = state.activeConversation.messages.find((m) => m.id === msg.id);
              if (target) {
                target.sessionId = newSid;
              }
              state.conversationsBySessionId[newSid] = state.activeConversation;
            });

            const boundMessage = get().activeConversation?.messages.find(
              (m) => m.id === msg.id,
            ) ?? {
              ...msg,
              sessionId: newSid,
            };
            debouncedPersistMessage(newSid, boundMessage);
          })
          .catch((err) => {
            logger.error('Failed to auto-create session for user message', { err });
          });
      }
      return msg.id;
    },

    persistQueuedMessage: (messageId: string, sessionId?: string | null) => {
      const resolvedSessionId = sessionId ?? get().activeSessionId;
      if (!resolvedSessionId) return;

      set((state) => {
        const message = state.activeConversation?.messages.find((m) => m.id === messageId);
        if (!message) return;

        message.sessionId = resolvedSessionId;
        message.persistenceStatus = 'pending';
        if (state.activeConversation) {
          state.conversationsBySessionId[resolvedSessionId] = state.activeConversation;
        }
      });

      const queuedMessage = get().activeConversation?.messages.find((m) => m.id === messageId);
      if (!queuedMessage) return;

      persistMessage(resolvedSessionId, queuedMessage).catch((err) => {
        logger.error('Failed to persist dequeued user message', {
          sessionId: resolvedSessionId,
          messageId,
          err,
        });
      });
    },

    startAssistantMessage: (sessionId?: string) => {
      const resolvedSessionId = sessionId ?? get().activeSessionId ?? undefined;
      const msg = createAssistantMessage(resolvedSessionId);
      set((state) => {
        const isActiveTarget =
          !resolvedSessionId ||
          !state.activeSessionId ||
          state.activeSessionId === resolvedSessionId;
        const conversation =
          resolvedSessionId && !isActiveTarget
            ? getOrCreateConversationForSession(state, resolvedSessionId)
            : state.activeConversation;

        if (!conversation) return;

        conversation.messages.push(msg);
        conversation.updatedAt = Date.now();

        if (resolvedSessionId) {
          state.conversationsBySessionId[resolvedSessionId] = conversation;
          state.sessionGenerationBySessionId[resolvedSessionId] = {
            isGenerating: true,
            streamingMessageId: msg.id,
          };
        }

        if (isActiveTarget) {
          state.isGenerating = true;
          state.streamingMessageId = msg.id;
        }
      });
      return msg.id;
    },

    appendPart: (messageId: string, part: MessagePart) => {
      set((state) => {
        const target = findMessageInConversations(state, messageId);
        if (!target) return;

        target.message.parts.push(part);
        target.conversation.updatedAt = Date.now();
        if (target.sessionId) {
          state.conversationsBySessionId[target.sessionId] = target.conversation;
        }
      });
    },

    updatePart: (messageId: string, partIndex: number, update: Partial<MessagePart>) => {
      set((state) => {
        const target = findMessageInConversations(state, messageId);
        if (!target?.message.parts[partIndex]) return;

        Object.assign(target.message.parts[partIndex], update);
        target.conversation.updatedAt = Date.now();
        if (target.sessionId) {
          state.conversationsBySessionId[target.sessionId] = target.conversation;
        }
      });
    },

    finalizeMessage: (messageId: string, usage?: TokenUsage) => {
      let finalizedMessage: ConversationMessage | null = null;
      let finalizedSessionId: string | null = null;

      set((state) => {
        const target = findMessageInConversations(state, messageId);
        if (!target) return;

        if (usage) {
          target.message.usage = usage;
        }

        target.conversation.updatedAt = Date.now();
        finalizedSessionId = target.sessionId;
        finalizedMessage = snapshotMessage(target.message);

        if (target.sessionId) {
          state.conversationsBySessionId[target.sessionId] = target.conversation;
          clearSessionGeneration(state, target.sessionId);
        }

        if (
          state.activeConversation === target.conversation ||
          state.streamingMessageId === messageId
        ) {
          state.isGenerating = false;
          state.streamingMessageId = null;
        }
      });

      if (finalizedSessionId && finalizedMessage) {
        updatePersistenceStatus(messageId, 'pending');
        persistMessage(finalizedSessionId, finalizedMessage).catch((err) => {
          logger.error('Failed to persist finalized message', {
            sessionId: finalizedSessionId,
            messageId,
            err,
          });
        });
      }
    },

    getMessageParts: (messageId: string) => {
      return findMessageInConversations(get(), messageId)?.message.parts ?? null;
    },

    addSystemMessage: (content: string) => {
      const sid = get().activeSessionId;
      if (sid) {
        return get().addSystemMessageToSession(sid, content);
      }

      const msg = createSystemMessage(content);
      set((state) => {
        if (!state.activeConversation) return;
        state.activeConversation.messages.push(msg);
        state.activeConversation.updatedAt = Date.now();
      });
      return msg.id;
    },

    addSystemMessageToSession: (sessionId: string, content: string) => {
      const msg = createSystemMessage(content);
      msg.sessionId = sessionId;
      const isActiveTarget = get().activeSessionId === sessionId;

      set((state) => {
        if (state.activeSessionId === sessionId && state.activeConversation) {
          state.activeConversation.messages.push(msg);
          state.activeConversation.updatedAt = Date.now();
          state.conversationsBySessionId[sessionId] = state.activeConversation;
          return;
        }

        const conversation = state.conversationsBySessionId[sessionId];
        if (conversation) {
          conversation.messages.push(msg);
          conversation.updatedAt = Date.now();
        }
      });

      if (isActiveTarget) {
        debouncedPersistMessage(sessionId, msg);
      } else {
        persistMessage(sessionId, msg).catch((err) => {
          logger.error('Failed to persist system message for inactive session', {
            sessionId,
            messageId: msg.id,
            err,
          });
        });
      }

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
      const activeSessionId = get().activeSessionId;
      usePermissionStore.getState().resetSessionRules();

      set((state) => {
        if (activeSessionId) {
          clearSessionGeneration(state, activeSessionId);
        }
        if (projectId) {
          state.activeConversation = createConversation(projectId);
        } else {
          state.activeConversation = null;
        }
        state.isGenerating = false;
        state.streamingMessageId = null;
        state.activeSessionId = null;
        // Preserve sessions list — do NOT delete old session from SQLite
      });
    },

    setGenerating: (isGenerating: boolean) => {
      set((state) => {
        state.isGenerating = isGenerating;
        if (!isGenerating) {
          state.streamingMessageId = null;
        }
        if (state.activeSessionId) {
          state.sessionGenerationBySessionId[state.activeSessionId] = {
            isGenerating,
            streamingMessageId: state.streamingMessageId,
          };
        }
      });
    },

    ensureSession: async (agent?: string) => {
      const existing = get().activeSessionId;
      if (existing) return existing;

      const projectId = get().activeProjectId;
      if (!projectId) return null;

      const inFlight = pendingSessionCreationByProject.get(projectId);
      if (inFlight) return inFlight;

      const creationPromise = get()
        .createSession(agent, { preserveDraftConversation: true })
        .finally(() => {
          const current = pendingSessionCreationByProject.get(projectId);
          if (current === creationPromise) {
            pendingSessionCreationByProject.delete(projectId);
          }
        });

      pendingSessionCreationByProject.set(projectId, creationPromise);
      return creationPromise;
    },
  })),
);
