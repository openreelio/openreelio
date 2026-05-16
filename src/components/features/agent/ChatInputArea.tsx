/**
 * ChatInputArea
 *
 * Composer workspace for the agentic chat.
 *
 * Combines blocking request docks, session tray controls,
 * the prompt input, and stop/queue controls.
 */

import { Square } from 'lucide-react';
import type { Plan } from '@/agents/engine';
import type { AgentDefinition } from '@/agents/engine/core/agentDefinitions';
import { AgentClarificationDock } from './AgentClarificationDock';
import {
  AgentComposerTray,
  type AgentRuntimePermissionRequest,
  type AgentRuntimeSummary,
} from './AgentComposerTray';
import { PromptInput } from './PromptInput';

// =============================================================================
// Types
// =============================================================================

export interface ChatInputAreaProps {
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onApprove: () => void;
  onReject: (reason?: string) => void;
  onToolAllow: () => void;
  onToolAllowAlways: () => void;
  onToolDeny: () => void;
  placeholder: string;
  disabled: boolean;
  isRunning: boolean;
  stopState: 'idle' | 'stopping';
  currentAgentName: string;
  currentAgentDescription?: string;
  isExperimentalSession: boolean;
  specialistDefinitions: Array<Pick<AgentDefinition, 'id' | 'name' | 'description'>>;
  onStartSession?: (agentProfileId?: string) => void;
  /** Phase label from either the TPAO or agent loop hook */
  phase: string;
  runtimeSummary: AgentRuntimeSummary;
  pendingPlan: Plan | null;
  pendingClarificationQuestion: string | null;
  pendingToolPermissionRequest: AgentRuntimePermissionRequest | null;
  queueSize: number;
}

// =============================================================================
// Component
// =============================================================================

export function ChatInputArea({
  input,
  onInputChange,
  onSubmit,
  onStop,
  placeholder,
  disabled,
  isRunning,
  stopState,
  currentAgentName,
  currentAgentDescription,
  isExperimentalSession,
  specialistDefinitions,
  onStartSession,
  phase,
  runtimeSummary,
  pendingPlan,
  pendingClarificationQuestion,
  pendingToolPermissionRequest,
  queueSize,
}: ChatInputAreaProps) {
  // Block new prompt submission while the user needs to resolve an approval or
  // tool-permission decision — sending a fresh prompt in these states would
  // desync the agent.
  const hasBlockingDecision =
    (phase === 'awaiting_approval' && !!pendingPlan) || !!pendingToolPermissionRequest;
  const hasDecisionSurface = !!pendingClarificationQuestion;
  const trayPendingToolPermissionRequest = pendingToolPermissionRequest ?? undefined;

  return (
    <div className="relative z-10 min-w-0 shrink-0 border-t border-border-subtle bg-surface-base px-3 py-2">
      <div className="flex max-h-full min-h-0 flex-col gap-2 overflow-visible">
        {hasDecisionSurface && (
          <div className="min-h-0 shrink overflow-y-auto pr-1">
            <div className="space-y-2">
              {pendingClarificationQuestion && (
                <AgentClarificationDock question={pendingClarificationQuestion} />
              )}
            </div>
          </div>
        )}

        <AgentComposerTray
          currentAgentName={currentAgentName}
          currentAgentDescription={currentAgentDescription}
          isExperimentalSession={isExperimentalSession}
          isRunning={isRunning}
          stopState={stopState}
          phase={phase}
          queueSize={queueSize}
          runtimeSummary={runtimeSummary}
          pendingClarificationQuestion={pendingClarificationQuestion}
          pendingToolPermissionRequest={trayPendingToolPermissionRequest}
          specialistDefinitions={specialistDefinitions}
          onStartSession={onStartSession}
        />

        <div className="shrink-0">
          <div className="flex min-w-0 items-end gap-2">
            <PromptInput
              value={input}
              onChange={onInputChange}
              onSubmit={onSubmit}
              placeholder={placeholder}
              disabled={disabled || hasBlockingDecision}
              className="flex-1"
            />

            {isRunning && (
              <button
                onClick={onStop}
                className={`flex-shrink-0 rounded-lg p-2 transition-colors ${
                  stopState === 'stopping'
                    ? 'bg-orange-600 text-white hover:bg-red-600'
                    : 'bg-red-600 text-white hover:bg-red-500'
                }`}
                aria-label={stopState === 'stopping' ? 'Stopping execution' : 'Stop'}
                title={stopState === 'stopping' ? 'Stopping execution' : 'Stop execution'}
                data-testid="stop-btn"
              >
                <Square className="w-4 h-4" />
              </button>
            )}
          </div>

          {queueSize > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
              <span className="rounded-full bg-primary-500/10 px-2 py-0.5 text-[10px] text-primary-300">
                {queueSize} queued
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
