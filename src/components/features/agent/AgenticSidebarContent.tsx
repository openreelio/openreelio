/**
 * AgenticSidebarContent Component
 *
 * Content for the AI sidebar when the agentic engine is enabled.
 * Uses useAgenticLoopWithStores for real store integration.
 */

import { useMemo, useCallback } from 'react';
import { AgenticChat } from './AgenticChat';
import { createTauriLLMAdapter } from '@/agents/engine/adapters/llm/TauriLLMAdapter';
import { createToolRegistryAdapter } from '@/agents/engine/adapters/tools/ToolRegistryAdapter';
import { globalToolRegistry } from '@/agents';
import { initializeAgentSystem } from '@/stores/aiStore';
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
  /** Optional className */
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

export function AgenticSidebarContent({
  visible = true,
  onSessionComplete,
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
  // Handlers
  // ===========================================================================

  const handleComplete = useCallback(
    (result: unknown) => {
      logger.info('Agentic session completed', { result });
      onSessionComplete?.();
    },
    [onSessionComplete]
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
