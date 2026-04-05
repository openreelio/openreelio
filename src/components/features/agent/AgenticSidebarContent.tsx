/**
 * AgenticSidebarContent Component
 *
 * Content for the AI sidebar.
 * Renders the canonical TPAO runtime for the shipping AI sidebar.
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { AgenticChat } from './AgenticChat';
import type { AgentRuntimeChatHandle } from './AgentRuntimeChatShell';
import { AgentSessionRecoveryPanel } from './AgentSessionRecoveryPanel';
import { AgentSessionResumeHistoryPanel } from './AgentSessionResumeHistoryPanel';
import { AgentSessionRecoveryStatus } from './AgentSessionRecoveryStatus';
import { SessionList } from './SessionList';
import { DEFAULT_AGENT_PROFILE_ID } from '@/agents/engine';
import { createTauriLLMAdapter } from '@/agents/engine/adapters/llm/TauriLLMAdapter';
import { createToolRegistryAdapter } from '@/agents/engine/adapters/tools/ToolRegistryAdapter';
import { createBackendToolExecutor } from '@/agents/engine/adapters/tools/BackendToolExecutor';
import {
  getAgentPromptPlaceholder,
  listSelectableAgentDefinitions,
} from '@/agents/engine/core/agentCatalog';
import { globalToolRegistry } from '@/agents';
import {
  loadProjectPromptContext,
  type ProjectPromptContext,
} from '@/agents/engine/core/projectPromptContext';
import { resolveSidebarRuntimePolicy, isBackendToolsEnabled } from '@/config/featureFlags';
import { useConversationStore, useProjectStore } from '@/stores';
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
  const [showSessionList, setShowSessionList] = useState(false);
  const [nextAgentProfileId, setNextAgentProfileId] = useState<string>(DEFAULT_AGENT_PROFILE_ID);
  const [projectPromptContext, setProjectPromptContext] = useState<ProjectPromptContext>({
    knowledge: [],
  });
  // ===========================================================================
  // Adapters
  // ===========================================================================

  const llmClient = useMemo(() => {
    logger.info('Creating TauriLLMAdapter');
    return createTauriLLMAdapter();
  }, []);

  const toolExecutor = useMemo(() => {
    const frontend = createToolRegistryAdapter(globalToolRegistry);
    if (isBackendToolsEnabled()) {
      logger.info('Creating BackendToolExecutor (editing tools → backend IPC)');
      return createBackendToolExecutor(frontend);
    }
    logger.info('Creating ToolRegistryAdapter (all tools → frontend)');
    return frontend;
  }, []);

  // ===========================================================================
  // Chat Handle Ref (for abort/isRunning access)
  // ===========================================================================

  const chatHandleRef = useRef<AgentRuntimeChatHandle>(null);
  const runtimePolicy = resolveSidebarRuntimePolicy();
  const currentProjectId = useProjectStore((state) => state.meta?.id ?? null);
  const currentProjectPath = useProjectStore((state) => state.meta?.path ?? null);
  const activeSessionId = useConversationStore((state) => state.activeSessionId);
  const sessions = useConversationStore((state) => state.sessions);
  const clearConversation = useConversationStore((state) => state.clearConversation);
  const createSession = useConversationStore((state) => state.createSession);
  const activeAgentProfileId = useMemo(
    () => sessions.find((session) => session.id === activeSessionId)?.agent ?? null,
    [activeSessionId, sessions],
  );
  const availableAgentDefinitions = useMemo(() => listSelectableAgentDefinitions(), []);
  const promptPlaceholder = useMemo(
    () => getAgentPromptPlaceholder(activeAgentProfileId ?? nextAgentProfileId),
    [activeAgentProfileId, nextAgentProfileId],
  );

  const abortCurrentSession = useCallback(() => {
    chatHandleRef.current?.abort();
  }, []);

  // ===========================================================================
  // New Chat Hook
  // ===========================================================================

  const createNewSession = useCallback(
    (agentProfileId = nextAgentProfileId) => {
      abortCurrentSession();
      clearConversation();
      void createSession(agentProfileId);
    },
    [abortCurrentSession, clearConversation, createSession, nextAgentProfileId],
  );
  const canCreateNew = Boolean(currentProjectId);

  // Register new chat handler with parent (AISidebar)
  useEffect(() => {
    onRegisterNewChat?.(() => createNewSession(), canCreateNew);
  }, [canCreateNew, createNewSession, onRegisterNewChat]);

  useEffect(() => {
    if (activeAgentProfileId) {
      setNextAgentProfileId(activeAgentProfileId);
    }
  }, [activeAgentProfileId]);

  useEffect(() => {
    let isCancelled = false;

    if (!currentProjectId || !currentProjectPath) {
      setProjectPromptContext({ knowledge: [] });
      return () => {
        isCancelled = true;
      };
    }

    void loadProjectPromptContext(currentProjectId)
      .then((nextContext) => {
        if (!isCancelled) {
          setProjectPromptContext(nextContext);
        }
      })
      .catch((error) => {
        logger.warn('Failed to load project prompt context', {
          projectId: currentProjectId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!isCancelled) {
          setProjectPromptContext({ knowledge: [] });
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [currentProjectId, currentProjectPath]);

  const chatPromptConfig = useMemo(
    () => ({
      knowledge: projectPromptContext.knowledge,
      customInstructions: projectPromptContext.customInstructions,
    }),
    [projectPromptContext.customInstructions, projectPromptContext.knowledge],
  );

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
          <SessionList onNewSession={createNewSession} />
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
          <div className="ml-3 flex items-center gap-2">
            <label
              htmlFor="agent-profile-select"
              className="text-[10px] uppercase tracking-[0.08em] text-text-tertiary"
            >
              Profile
            </label>
            <select
              id="agent-profile-select"
              value={nextAgentProfileId}
              onChange={(event) => setNextAgentProfileId(event.target.value)}
              className="rounded border border-border-subtle bg-surface-elevated px-2 py-1 text-[11px] text-text-primary outline-none transition-colors focus:border-primary-500"
              data-testid="agent-profile-select"
            >
              {availableAgentDefinitions.map((definition) => (
                <option key={definition.id} value={definition.id}>
                  {definition.mode === 'subagent'
                    ? `${definition.name} (Experimental)`
                    : definition.name}
                </option>
              ))}
            </select>
          </div>
          <AgentSessionRecoveryStatus />
        </div>
        <AgentSessionRecoveryPanel />
        <AgentSessionResumeHistoryPanel />

        {runtimePolicy.selectedRuntime === 'disabled' ? (
          <div
            data-testid="agent-runtime-disabled-state"
            className="flex flex-1 items-center justify-center px-6 py-8"
          >
            <div className="max-w-sm text-center">
              <p className="text-sm font-medium text-text-primary">AI runtime is disabled</p>
              <p className="mt-2 text-xs text-text-secondary">
                Enable `USE_AGENTIC_ENGINE` to restore the canonical TPAO runtime.
              </p>
            </div>
          </div>
        ) : (
          <AgenticChat
            ref={chatHandleRef}
            llmClient={llmClient}
            toolExecutor={toolExecutor}
            config={chatPromptConfig}
            onSubmit={handleSubmit}
            onComplete={handleComplete}
            onError={handleError}
            placeholder={promptPlaceholder}
            className="flex-1"
          />
        )}
      </div>
    </div>
  );
}
