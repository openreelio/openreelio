import { forwardRef, useMemo } from 'react';

import {
  CodexReferenceAdapter,
  ExternalAgentApprovalBroker,
  createTauriExternalAgentSessionPersistence,
  useExternalAgentChatRuntime,
} from '@/agents/external';
import { useSettingsStore } from '@/stores/settingsStore';

import { AgentRuntimeChatShell, type AgentRuntimeChatHandle } from './AgentRuntimeChatShell';

const noop = (): void => {};
const noopReject = (): void => {};

export interface ExternalAgentChatProps {
  projectId: string | null;
  projectPath?: string | null;
  ready: boolean;
  unavailableReason?: string | null;
  onComplete?: () => void;
  onAbort?: () => void;
  onError?: (error: Error) => void;
  onStartSession?: () => void;
  disabled?: boolean;
  className?: string;
}

export const ExternalAgentChat = forwardRef<AgentRuntimeChatHandle, ExternalAgentChatProps>(
  function ExternalAgentChat(
    {
      projectId,
      projectPath = null,
      ready,
      unavailableReason = null,
      onComplete,
      onAbort,
      onError,
      onStartSession,
      disabled = false,
      className = '',
    },
    ref,
  ) {
    const approvalBroker = useMemo(() => new ExternalAgentApprovalBroker(), []);
    const sessionPersistence = useMemo(() => createTauriExternalAgentSessionPersistence(), []);
    const codexModel = useSettingsStore((state) => state.settings.ai.codexModel);
    const codexReasoningEffort = useSettingsStore(
      (state) => state.settings.ai.codexReasoningEffort,
    );
    const adapter = useMemo(
      () =>
        new CodexReferenceAdapter(undefined, {
          approvalDecisionProvider: approvalBroker.requestDecision,
          model: codexModel,
          reasoningEffort: codexReasoningEffort,
        }),
      [approvalBroker, codexModel, codexReasoningEffort],
    );
    const runtime = useExternalAgentChatRuntime({
      adapter,
      projectId,
      cwd: projectPath,
      enabled: ready,
      approvalBroker,
      sessionPersistence,
      onComplete,
      onAbort,
      onError,
    });

    const disabledReason = unavailableReason ?? 'Codex is not ready for this project.';

    return (
      <AgentRuntimeChatShell
        ref={ref}
        chatTestId="external-agent-chat"
        executeMessage={runtime.executeMessage}
        abort={runtime.abort}
        phase={runtime.phase}
        isRunning={runtime.isRunning}
        isEnabled={ready}
        error={runtime.error}
        runtimeSummary={{
          startedTools: runtime.startedTools,
          completedTools: runtime.completedTools,
          latestIteration: runtime.latestIteration,
        }}
        plan={null}
        pendingClarificationQuestion={null}
        pendingToolPermissionRequest={runtime.pendingToolPermissionRequest}
        placeholder="Ask Codex to help edit this project..."
        disabled={disabled || !ready}
        currentAgentName="Codex"
        currentAgentDescription={
          ready ? 'Using your local Codex account through app-server.' : disabledReason
        }
        isExperimentalSession
        specialistDefinitions={[]}
        onStartSession={onStartSession}
        className={className}
        onApprove={noop}
        onReject={noopReject}
        onRetry={noop}
        onToolAllow={() => runtime.resolveApproval('accept')}
        onToolAllowAlways={() => runtime.resolveApproval('acceptForSession')}
        onToolDeny={() => runtime.resolveApproval('decline')}
        clearQueueOnProjectSwitch
        clearQueueOnUnmount
      />
    );
  },
);
