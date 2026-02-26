/**
 * useNewChat Hook
 *
 * Handles new chat lifecycle: aborts running engine,
 * detaches from current session (preserves it in session list),
 * and starts a fresh conversation.
 */

import { useCallback } from 'react';
import { useConversationStore } from '@/stores/conversationStore';

const EMPTY_MESSAGES: readonly unknown[] = [];

export interface UseNewChatOptions {
  /**
   * Abort callback from the agentic loop.
   * Called unconditionally before clearing — should be a no-op when the engine is idle.
   */
  abort?: () => void;
}

export interface UseNewChatReturn {
  /** Start a new chat session */
  newChat: () => void;
  /** Whether creating a new chat is possible */
  canCreateNew: boolean;
}

export function useNewChat(options: UseNewChatOptions = {}): UseNewChatReturn {
  const { abort } = options;

  const messages = useConversationStore(
    (s) => s.activeConversation?.messages ?? EMPTY_MESSAGES,
  );
  const clearConversation = useConversationStore((s) => s.clearConversation);

  const canCreateNew = messages.length > 0;

  const newChat = useCallback(() => {
    // Always attempt abort — the abort callback reads the ref at call time
    // and is a no-op when the engine is not running.
    abort?.();

    // Detach from current session and start fresh
    // (clearConversation preserves the old session in the session list)
    clearConversation();
  }, [abort, clearConversation]);

  return { newChat, canCreateNew };
}
