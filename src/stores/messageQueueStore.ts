/**
 * Message Queue Store
 *
 * Manages a queue of user messages that are pending execution.
 * When the agent engine is running, new messages are queued
 * and auto-dequeued when the engine becomes idle.
 */

import { create } from 'zustand';

// =============================================================================
// Types
// =============================================================================

export interface QueuedMessage {
  id: string;
  content: string;
  projectId: string | null;
  sessionId: string | null;
  conversationId: string | null;
  messageId: string | null;
  queuedAt: number;
}

export interface QueueMessageContext {
  projectId?: string | null;
  sessionId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
}

export interface MessageQueueState {
  /** Queued messages awaiting execution */
  queue: QueuedMessage[];
  /** Add a message to the queue */
  enqueue: (content: string, context?: QueueMessageContext) => string;
  /** Remove and return the next message */
  dequeue: () => QueuedMessage | null;
  /** Peek at the next message without removing */
  peek: () => QueuedMessage | null;
  /** Clear all queued messages */
  clear: () => void;
  /** Number of queued messages */
  size: () => number;
}

// =============================================================================
// Store
// =============================================================================

export const useMessageQueueStore = create<MessageQueueState>()((set, get) => ({
  queue: [],

  enqueue: (content: string, context: QueueMessageContext = {}) => {
    const id = crypto.randomUUID();
    const message: QueuedMessage = {
      id,
      content,
      projectId: context.projectId ?? null,
      sessionId: context.sessionId ?? null,
      conversationId: context.conversationId ?? null,
      messageId: context.messageId ?? null,
      queuedAt: Date.now(),
    };
    set((state) => ({ queue: [...state.queue, message] }));
    return id;
  },

  dequeue: () => {
    const { queue } = get();
    if (queue.length === 0) return null;
    const [next, ...rest] = queue;
    set({ queue: rest });
    return next;
  },

  peek: () => {
    const { queue } = get();
    return queue.length > 0 ? queue[0] : null;
  },

  clear: () => {
    set({ queue: [] });
  },

  size: () => {
    return get().queue.length;
  },
}));
