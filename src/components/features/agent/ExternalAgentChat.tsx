import { forwardRef, useCallback, useMemo } from 'react';

import {
  CodexReferenceAdapter,
  ExternalAgentApprovalBroker,
  createTauriExternalAgentSessionPersistence,
  getExternalAgentApprovalPermissionArgs,
  getExternalAgentApprovalPermissionToolName,
  useExternalAgentChatRuntime,
  type ExternalAgentApprovalDecision,
  type ExternalAgentApprovalRequest,
  type ExternalAgentRuntimeAdapter,
} from '@/agents/external';
import { ClaudeCodeAdapter } from '@/agents/external/adapters/ClaudeCodeAdapter';
import { usePermissionStore } from '@/stores/permissionStore';
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
    const resolveExternalApprovalPolicy = useCallback(
      (request: ExternalAgentApprovalRequest): ExternalAgentApprovalDecision | null => {
        const resolution = usePermissionStore
          .getState()
          .resolvePermissionDetails(
            getExternalAgentApprovalPermissionToolName(request),
            getExternalAgentApprovalPermissionArgs(request),
          );

        if (resolution.permission === 'allow') {
          return 'accept';
        }
        if (resolution.permission === 'deny') {
          return 'decline';
        }
        return null;
      },
      [],
    );
    const approvalBroker = useMemo(
      () =>
        new ExternalAgentApprovalBroker({
          policyResolver: resolveExternalApprovalPolicy,
        }),
      [resolveExternalApprovalPolicy],
    );
    const sessionPersistence = useMemo(() => createTauriExternalAgentSessionPersistence(), []);
    const assistantRuntime = useSettingsStore((state) => state.settings.ai.assistantRuntime);
    const codexModel = useSettingsStore((state) => state.settings.ai.codexModel);
    const codexReasoningEffort = useSettingsStore(
      (state) => state.settings.ai.codexReasoningEffort,
    );
    const claudeModel = useSettingsStore((state) => state.settings.ai.claudeModel);
    const claudeEffort = useSettingsStore((state) => state.settings.ai.claudeEffort);
    const claudeAuthMode = useSettingsStore((state) => state.settings.ai.claudeAuthMode);
    const isClaude = assistantRuntime === 'claude_code';
    const adapter = useMemo<ExternalAgentRuntimeAdapter>(
      () =>
        isClaude
          ? new ClaudeCodeAdapter(undefined, {
              approvalDecisionProvider: approvalBroker.requestDecision,
              model: claudeModel,
              effort: claudeEffort,
              authMode: claudeAuthMode,
            })
          : new CodexReferenceAdapter(undefined, {
              approvalDecisionProvider: approvalBroker.requestDecision,
              model: codexModel,
              reasoningEffort: codexReasoningEffort,
            }),
      [
        isClaude,
        approvalBroker,
        codexModel,
        codexReasoningEffort,
        claudeModel,
        claudeEffort,
        claudeAuthMode,
      ],
    );
    const runtime = useExternalAgentChatRuntime({
      adapter,
      projectId,
      cwd: projectPath,
      enabled: ready,
      approvalBroker,
      sessionPersistence,
      retainAcrossUnmount: true,
      onComplete,
      onAbort,
      onError,
    });

    const agentName = isClaude ? 'Claude Code' : 'Codex';
    const disabledReason = unavailableReason ?? `${agentName} is not ready for this project.`;
    const readyDescription = isClaude
      ? 'Using your local Claude Code account.'
      : 'Using your local Codex account through app-server.';

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
          currentActivity: runtime.currentActivity,
          runStartedAt: runtime.runStartedAt,
          lastActivityAt: runtime.lastActivityAt,
        }}
        plan={null}
        pendingClarificationQuestion={null}
        pendingToolPermissionRequest={runtime.pendingToolPermissionRequest}
        placeholder={`Ask ${agentName} to help edit this project...`}
        disabled={disabled || !ready}
        currentAgentName={agentName}
        currentAgentDescription={ready ? readyDescription : disabledReason}
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
        submitWhileRunning="steer"
      />
    );
  },
);
