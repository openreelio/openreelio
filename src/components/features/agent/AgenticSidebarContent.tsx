/**
 * AgenticSidebarContent Component
 *
 * Content for the AI sidebar. Always uses the agentic engine.
 * Uses useAgenticLoopWithStores for real store integration.
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { AgenticChat, type AgenticChatHandle } from './AgenticChat';
import { SessionList } from './SessionList';
import { createTauriLLMAdapter } from '@/agents/engine/adapters/llm/TauriLLMAdapter';
import { createToolRegistryAdapter } from '@/agents/engine/adapters/tools/ToolRegistryAdapter';
import { globalToolRegistry } from '@/agents';
import { initializeAgentSystem } from '@/stores/aiStore';
import { useNewChat } from '@/hooks/useNewChat';
import { createLogger } from '@/services/logger';

const agentInitializedRef = { current: false };

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
  const [showSessionList, setShowSessionList] = useState(false);
  // ===========================================================================
  // Adapters
  // ===========================================================================

  // Initialize agent system once (module-level guard to survive strict mode double-renders)
  useEffect(() => {
    if (!agentInitializedRef.current) {
      logger.info('Initializing agent system');
      initializeAgentSystem();
      agentInitializedRef.current = true;
    }
  }, []);

  const llmClient = useMemo(() => {
    logger.info('Creating TauriLLMAdapter');
    return createTauriLLMAdapter();
  }, []);

  const toolExecutor = useMemo(() => {
    logger.info('Creating ToolRegistryAdapter');
    return createToolRegistryAdapter(globalToolRegistry);
  }, []);

  // ===========================================================================
  // Chat Handle Ref (for abort/isRunning access)
  // ===========================================================================

  const chatHandleRef = useRef<AgenticChatHandle>(null);

  const abortCurrentSession = useCallback(() => {
    chatHandleRef.current?.abort();
  }, []);

  // ===========================================================================
  // New Chat Hook
  // ===========================================================================

  const { newChat, canCreateNew } = useNewChat({
    abort: abortCurrentSession,
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
      className={`flex flex-row flex-1 overflow-hidden ${className}`}
    >
      {/* Session List Panel */}
      {showSessionList && (
        <div className="w-48 flex-shrink-0 border-r border-border-subtle bg-surface-base">
          <SessionList onNewSession={newChat} />
        </div>
      )}

      {/* Main Chat Area */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Session toggle bar */}
        <div className="flex items-center px-2 py-1 border-b border-border-subtle bg-surface-base">
          <button
            onClick={() => setShowSessionList((prev) => !prev)}
            className="p-1 rounded hover:bg-surface-active transition-colors"
            aria-label={showSessionList ? 'Hide sessions' : 'Show sessions'}
            title={showSessionList ? 'Hide sessions' : 'Show sessions'}
            data-testid="toggle-sessions-btn"
          >
            {showSessionList ? (
              <PanelLeftClose className="w-3.5 h-3.5 text-text-tertiary" />
            ) : (
              <PanelLeftOpen className="w-3.5 h-3.5 text-text-tertiary" />
            )}
          </button>
          <span className="text-xs text-text-tertiary ml-2">AI Chat</span>
        </div>

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
    </div>
  );
}
