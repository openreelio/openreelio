/**
 * AgenticSidebarContent Component
 *
 * Content for the AI sidebar. Always uses the agentic engine.
 * Uses useAgenticLoopWithStores for real store integration.
 */

import { useMemo, useCallback, useEffect, useRef } from 'react';
import { AgenticChat, type AgenticChatHandle } from './AgenticChat';
import { createTauriLLMAdapter } from '@/agents/engine/adapters/llm/TauriLLMAdapter';
import { createToolRegistryAdapter } from '@/agents/engine/adapters/tools/ToolRegistryAdapter';
import { globalToolRegistry } from '@/agents';
import { initializeAgentSystem } from '@/stores/aiStore';
import { useNewChat } from '@/hooks/useNewChat';
import { createLogger } from '@/services/logger';

const logger = createLogger('AgenticSidebarContent');

// =============================================================================
// Types
// =============================================================================

export interface AgenticSidebarContentProps {
  /** Whether the component is visible */
  visible?: boolean;
  /** Callback when a session completes */
  onSessionComplete?: () => void;
  /** Register new chat handler with parent */
  onRegisterNewChat?: (handler: () => void, canCreate: boolean) => void;
  /** Optional className */
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

export function AgenticSidebarContent({
  visible = true,
  onSessionComplete,
  onRegisterNewChat,
  className = '',
}: AgenticSidebarContentProps) {
  // ===========================================================================
  // Adapters
  // ===========================================================================

  const llmClient = useMemo(() => {
    logger.info('Creating TauriLLMAdapter');
    return createTauriLLMAdapter();
  }, []);

  const toolExecutor = useMemo(() => {
    logger.info('Creating ToolRegistryAdapter');
    initializeAgentSystem();
    return createToolRegistryAdapter(globalToolRegistry);
  }, []);

  // ===========================================================================
  // Chat Handle Ref (for abort/isRunning access)
  // ===========================================================================

  const chatHandleRef = useRef<AgenticChatHandle>(null);

  // ===========================================================================
  // New Chat Hook
  // ===========================================================================

  const { newChat, canCreateNew } = useNewChat({
    abort: () => chatHandleRef.current?.abort(),
  });

  // Register new chat handler with parent (AISidebar)
  useEffect(() => {
    onRegisterNewChat?.(newChat, canCreateNew);
  }, [onRegisterNewChat, newChat, canCreateNew]);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleComplete = useCallback(
    (result: unknown) => {
      logger.info('Agentic session completed', { result });
      onSessionComplete?.();
    },
    [onSessionComplete],
  );

  const handleError = useCallback((error: Error) => {
    logger.error('Agentic session error', { error: error.message });
  }, []);

  const handleSubmit = useCallback((input: string) => {
    logger.info('User submitted input', { input: input.substring(0, 50) });
  }, []);

  // ===========================================================================
  // Render
  // ===========================================================================

  if (!visible) {
    return null;
  }

  return (
    <div
      data-testid="agentic-sidebar-content"
      className={`flex flex-col flex-1 overflow-hidden ${className}`}
    >
      <AgenticChat
        ref={chatHandleRef}
        llmClient={llmClient}
        toolExecutor={toolExecutor}
        onSubmit={handleSubmit}
        onComplete={handleComplete}
        onError={handleError}
        placeholder="Describe what you want to edit..."
        className="flex-1"
      />
    </div>
  );
}
