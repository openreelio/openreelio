import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { useProjectStore } from '@/stores';
import { useConversationStore } from '@/stores/conversationStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useAgentArtifactReviewStore } from '@/stores/agentArtifactReviewStore';
import { createDefaultLayout, useWorkspaceLayoutStore } from '@/stores/workspaceLayoutStore';
import { AgentRuntimeChatShell } from './AgentRuntimeChatShell';

const defaultLoadForProject = useConversationStore.getState().loadForProject;

function renderRuntimeShell({
  executeMessage = vi.fn(),
  abort = vi.fn(),
  phase = 'executing',
  isRunning = true,
  submitWhileRunning,
  pendingToolPermissionRequest = null,
}: {
  executeMessage?: ReturnType<typeof vi.fn>;
  abort?: ReturnType<typeof vi.fn>;
  phase?: ComponentProps<typeof AgentRuntimeChatShell>['phase'];
  isRunning?: boolean;
  submitWhileRunning?: ComponentProps<typeof AgentRuntimeChatShell>['submitWhileRunning'];
  pendingToolPermissionRequest?: ComponentProps<
    typeof AgentRuntimeChatShell
  >['pendingToolPermissionRequest'];
} = {}) {
  return render(
    <AgentRuntimeChatShell
      chatTestId="agent-runtime-shell"
      executeMessage={executeMessage}
      abort={abort}
      phase={phase}
      isRunning={isRunning}
      isEnabled={true}
      error={null}
      runtimeSummary={{
        startedTools: 1,
        completedTools: isRunning ? 0 : 1,
        latestIteration: isRunning ? 0 : 1,
      }}
      plan={null}
      pendingClarificationQuestion={null}
      pendingToolPermissionRequest={pendingToolPermissionRequest}
      onApprove={() => {}}
      onReject={() => {}}
      onRetry={() => {}}
      onToolAllow={() => {}}
      onToolAllowAlways={() => {}}
      onToolDeny={() => {}}
      submitWhileRunning={submitWhileRunning}
    />,
  );
}

vi.mock('./ChatMessageList', () => ({
  ChatMessageList: () => <div data-testid="chat-message-list" />,
}));

vi.mock('./AgentSessionPersistenceBanner', () => ({
  AgentSessionPersistenceBanner: () => <div data-testid="persistence-banner" />,
}));

vi.mock('./ChatInputArea', () => ({
  ChatInputArea: (props: {
    input: string;
    onInputChange: (value: string) => void;
    onSubmit: () => void;
    onStop: () => void;
    queueSize: number;
    disabled: boolean;
  }) => (
    <div data-testid="chat-input-area">
      <input
        data-testid="chat-input-field"
        value={props.input}
        onChange={(event) => props.onInputChange(event.target.value)}
      />
      <button type="button" onClick={props.onSubmit} data-testid="chat-input-submit-btn">
        submit
      </button>
      <button type="button" onClick={props.onStop} data-testid="chat-input-stop-btn">
        stop
      </button>
      <span data-testid="chat-input-queue-size">{props.queueSize}</span>
      <span data-testid="chat-input-disabled">{String(props.disabled)}</span>
    </div>
  ),
}));

describe('AgentRuntimeChatShell', () => {
  beforeEach(() => {
    act(() => {
      useMessageQueueStore.setState({ queue: [] });
      useAgentArtifactReviewStore.getState().clearSelection();
      useWorkspaceLayoutStore.setState((state) => ({
        ...state,
        layout: createDefaultLayout(),
      }));
      useConversationStore.setState((state) => ({
        ...state,
        activeConversation: {
          id: 'session-1',
          projectId: 'project-1',
          messages: [],
          createdAt: 100,
          updatedAt: 100,
        },
        activeProjectId: 'project-1',
        activeSessionId: 'session-1',
        sessions: [],
        loadForProject: defaultLoadForProject,
      }));
      useProjectStore.setState((state) => ({
        ...state,
        meta: {
          id: 'project-1',
          name: 'Test Project',
          path: '/tmp/project',
          createdAt: '2026-01-01T00:00:00.000Z',
          modifiedAt: '2026-01-01T00:00:00.000Z',
        },
      }));
    });
  });

  afterEach(() => {
    act(() => {
      useMessageQueueStore.setState({ queue: [] });
      useAgentArtifactReviewStore.getState().clearSelection();
    });
  });

  it('scopes approval overlays to the message area so the composer remains mounted', () => {
    renderRuntimeShell({
      pendingToolPermissionRequest: {
        id: 'permission-1',
        tool: 'a_very_long_codex_permission_tool_name_that_should_not_move_the_composer',
        args: { command: 'npm test' },
        description: 'Approve a Codex command',
        riskLevel: 'high',
      },
    });

    const messageArea = screen.getByTestId('agent-runtime-shell-message-area');
    const overlay = screen.getByTestId('agent-runtime-approval-overlay');

    expect(messageArea).toContainElement(overlay);
    expect(screen.getByTestId('chat-input-area')).toBeInTheDocument();
  });

  it('submits immediately instead of queueing when running submissions steer the active turn', async () => {
    const user = userEvent.setup();
    const executeMessage = vi.fn().mockResolvedValue(undefined);
    const onSubmit = vi.fn();

    render(
      <AgentRuntimeChatShell
        chatTestId="agent-runtime-shell"
        executeMessage={executeMessage}
        abort={vi.fn()}
        phase="executing"
        isRunning={true}
        isEnabled={true}
        error={null}
        runtimeSummary={{ startedTools: 1, completedTools: 0, latestIteration: 0 }}
        plan={null}
        pendingClarificationQuestion={null}
        pendingToolPermissionRequest={null}
        onSubmit={onSubmit}
        onApprove={() => {}}
        onReject={() => {}}
        onRetry={() => {}}
        onToolAllow={() => {}}
        onToolAllowAlways={() => {}}
        onToolDeny={() => {}}
        submitWhileRunning="steer"
      />,
    );

    await user.type(screen.getByTestId('chat-input-field'), 'Keep it lower');
    await user.click(screen.getByTestId('chat-input-submit-btn'));

    expect(onSubmit).toHaveBeenCalledWith('Keep it lower');
    await waitFor(() => {
      expect(executeMessage).toHaveBeenCalledWith('Keep it lower');
    });
    expect(useMessageQueueStore.getState().queue).toHaveLength(0);
    expect(useConversationStore.getState().activeConversation?.messages[0]).toMatchObject({
      role: 'user',
    });
  });

  it('does not dequeue queued prompts after the user stops execution', async () => {
    const user = userEvent.setup();
    const abort = vi.fn();
    const executeMessage = vi.fn();

    act(() => {
      useMessageQueueStore.getState().enqueue('queued prompt');
    });

    const { rerender } = render(
      <AgentRuntimeChatShell
        chatTestId="agent-runtime-shell"
        executeMessage={executeMessage}
        abort={abort}
        phase="executing"
        isRunning={true}
        isEnabled={true}
        error={null}
        runtimeSummary={{ startedTools: 1, completedTools: 0, latestIteration: 0 }}
        plan={null}
        pendingClarificationQuestion={null}
        pendingToolPermissionRequest={null}
        onApprove={() => {}}
        onReject={() => {}}
        onRetry={() => {}}
        onToolAllow={() => {}}
        onToolAllowAlways={() => {}}
        onToolDeny={() => {}}
      />,
    );

    await user.click(screen.getByTestId('chat-input-stop-btn'));

    rerender(
      <AgentRuntimeChatShell
        chatTestId="agent-runtime-shell"
        executeMessage={executeMessage}
        abort={abort}
        phase="aborted"
        isRunning={false}
        isEnabled={true}
        error={null}
        runtimeSummary={{ startedTools: 1, completedTools: 0, latestIteration: 0 }}
        plan={null}
        pendingClarificationQuestion={null}
        pendingToolPermissionRequest={null}
        onApprove={() => {}}
        onReject={() => {}}
        onRetry={() => {}}
        onToolAllow={() => {}}
        onToolAllowAlways={() => {}}
        onToolDeny={() => {}}
      />,
    );

    expect(abort).toHaveBeenCalledTimes(1);
    expect(executeMessage).not.toHaveBeenCalled();
    expect(useMessageQueueStore.getState().queue).toHaveLength(0);
  });

  it('dequeues the next prompt after normal completion', () => {
    const abort = vi.fn();
    const executeMessage = vi.fn();

    act(() => {
      useMessageQueueStore.getState().enqueue('queued prompt');
    });

    const { rerender } = render(
      <AgentRuntimeChatShell
        chatTestId="agent-runtime-shell"
        executeMessage={executeMessage}
        abort={abort}
        phase="executing"
        isRunning={true}
        isEnabled={true}
        error={null}
        runtimeSummary={{ startedTools: 1, completedTools: 0, latestIteration: 0 }}
        plan={null}
        pendingClarificationQuestion={null}
        pendingToolPermissionRequest={null}
        onApprove={() => {}}
        onReject={() => {}}
        onRetry={() => {}}
        onToolAllow={() => {}}
        onToolAllowAlways={() => {}}
        onToolDeny={() => {}}
      />,
    );

    rerender(
      <AgentRuntimeChatShell
        chatTestId="agent-runtime-shell"
        executeMessage={executeMessage}
        abort={abort}
        phase="completed"
        isRunning={false}
        isEnabled={true}
        error={null}
        runtimeSummary={{ startedTools: 1, completedTools: 1, latestIteration: 1 }}
        plan={null}
        pendingClarificationQuestion={null}
        pendingToolPermissionRequest={null}
        onApprove={() => {}}
        onReject={() => {}}
        onRetry={() => {}}
        onToolAllow={() => {}}
        onToolAllowAlways={() => {}}
        onToolDeny={() => {}}
      />,
    );

    expect(executeMessage).toHaveBeenCalledWith('queued prompt');
  });

  it('drops queued prompts when the active session changed before completion', () => {
    const executeMessage = vi.fn();

    act(() => {
      useMessageQueueStore.getState().enqueue('queued prompt', {
        projectId: 'project-1',
        sessionId: 'session-1',
        conversationId: 'session-1',
        messageId: 'queued-message-1',
      });
    });

    const { rerender } = render(
      <AgentRuntimeChatShell
        chatTestId="agent-runtime-shell"
        executeMessage={executeMessage}
        abort={vi.fn()}
        phase="executing"
        isRunning={true}
        isEnabled={true}
        error={null}
        runtimeSummary={{ startedTools: 1, completedTools: 0, latestIteration: 0 }}
        plan={null}
        pendingClarificationQuestion={null}
        pendingToolPermissionRequest={null}
        onApprove={() => {}}
        onReject={() => {}}
        onRetry={() => {}}
        onToolAllow={() => {}}
        onToolAllowAlways={() => {}}
        onToolDeny={() => {}}
      />,
    );

    act(() => {
      useConversationStore.setState((state) => ({
        ...state,
        activeConversation: {
          id: 'session-2',
          projectId: 'project-1',
          messages: [],
          createdAt: 200,
          updatedAt: 200,
        },
        activeSessionId: 'session-2',
      }));
    });

    act(() => {
      rerender(
        <AgentRuntimeChatShell
          chatTestId="agent-runtime-shell"
          executeMessage={executeMessage}
          abort={vi.fn()}
          phase="completed"
          isRunning={false}
          isEnabled={true}
          error={null}
          runtimeSummary={{ startedTools: 1, completedTools: 1, latestIteration: 1 }}
          plan={null}
          pendingClarificationQuestion={null}
          pendingToolPermissionRequest={null}
          onApprove={() => {}}
          onReject={() => {}}
          onRetry={() => {}}
          onToolAllow={() => {}}
          onToolAllowAlways={() => {}}
          onToolDeny={() => {}}
        />,
      );
    });

    expect(executeMessage).not.toHaveBeenCalled();
    expect(useMessageQueueStore.getState().queue).toHaveLength(0);
  });

  it('skips stale queued prompts and executes the next matching prompt', () => {
    const executeMessage = vi.fn();

    act(() => {
      useMessageQueueStore.getState().enqueue('stale prompt', {
        projectId: 'project-1',
        sessionId: 'session-2',
        conversationId: 'session-2',
        messageId: 'stale-message',
      });
      useMessageQueueStore.getState().enqueue('matching prompt', {
        projectId: 'project-1',
        sessionId: 'session-1',
        conversationId: 'session-1',
      });
    });

    const { rerender } = renderRuntimeShell({ executeMessage });

    act(() => {
      rerender(
        <AgentRuntimeChatShell
          chatTestId="agent-runtime-shell"
          executeMessage={executeMessage}
          abort={vi.fn()}
          phase="completed"
          isRunning={false}
          isEnabled={true}
          error={null}
          runtimeSummary={{ startedTools: 1, completedTools: 1, latestIteration: 1 }}
          plan={null}
          pendingClarificationQuestion={null}
          pendingToolPermissionRequest={null}
          onApprove={() => {}}
          onReject={() => {}}
          onRetry={() => {}}
          onToolAllow={() => {}}
          onToolAllowAlways={() => {}}
          onToolDeny={() => {}}
        />,
      );
    });

    expect(executeMessage).toHaveBeenCalledTimes(1);
    expect(executeMessage).toHaveBeenCalledWith('matching prompt');
    expect(useMessageQueueStore.getState().queue).toHaveLength(0);
  });

  it('drops queued prompts when only the active project changed', () => {
    const executeMessage = vi.fn();

    act(() => {
      const messageId = useConversationStore
        .getState()
        .addUserMessage('project-scoped prompt', { persist: false });
      useMessageQueueStore.getState().enqueue('project-scoped prompt', {
        projectId: 'project-2',
        sessionId: 'session-1',
        conversationId: 'session-1',
        messageId,
      });
    });

    const { rerender } = renderRuntimeShell({ executeMessage });

    act(() => {
      rerender(
        <AgentRuntimeChatShell
          chatTestId="agent-runtime-shell"
          executeMessage={executeMessage}
          abort={vi.fn()}
          phase="completed"
          isRunning={false}
          isEnabled={true}
          error={null}
          runtimeSummary={{ startedTools: 1, completedTools: 1, latestIteration: 1 }}
          plan={null}
          pendingClarificationQuestion={null}
          pendingToolPermissionRequest={null}
          onApprove={() => {}}
          onReject={() => {}}
          onRetry={() => {}}
          onToolAllow={() => {}}
          onToolAllowAlways={() => {}}
          onToolDeny={() => {}}
        />,
      );
    });

    expect(executeMessage).not.toHaveBeenCalled();
    expect(useMessageQueueStore.getState().queue).toHaveLength(0);
  });

  it('drops matching queued prompts when their user message is no longer visible', () => {
    const executeMessage = vi.fn();

    act(() => {
      useMessageQueueStore.getState().enqueue('orphaned prompt', {
        projectId: 'project-1',
        sessionId: 'session-1',
        conversationId: 'session-1',
        messageId: 'missing-message',
      });
    });

    const { rerender } = renderRuntimeShell({ executeMessage });

    rerender(
      <AgentRuntimeChatShell
        chatTestId="agent-runtime-shell"
        executeMessage={executeMessage}
        abort={vi.fn()}
        phase="completed"
        isRunning={false}
        isEnabled={true}
        error={null}
        runtimeSummary={{ startedTools: 1, completedTools: 1, latestIteration: 1 }}
        plan={null}
        pendingClarificationQuestion={null}
        pendingToolPermissionRequest={null}
        onApprove={() => {}}
        onReject={() => {}}
        onRetry={() => {}}
        onToolAllow={() => {}}
        onToolAllowAlways={() => {}}
        onToolDeny={() => {}}
      />,
    );

    expect(executeMessage).not.toHaveBeenCalled();
    expect(useMessageQueueStore.getState().queue).toHaveLength(0);
  });

  it('bootstraps the conversation store before submitting a prompt', async () => {
    const user = userEvent.setup();
    const executeMessage = vi.fn().mockResolvedValue(undefined);
    const loadForProject = vi.fn((projectId: string) => {
      useConversationStore.setState((state) => ({
        ...state,
        activeProjectId: projectId,
        activeConversation: {
          id: `draft-${projectId}`,
          projectId,
          messages: [],
          createdAt: 100,
          updatedAt: 100,
        },
      }));
    });

    act(() => {
      useConversationStore.setState((state) => ({
        ...state,
        activeConversation: null,
        activeProjectId: null,
        activeSessionId: null,
        loadForProject,
      }));
    });

    render(
      <AgentRuntimeChatShell
        chatTestId="agent-runtime-shell"
        executeMessage={executeMessage}
        abort={vi.fn()}
        phase="idle"
        isRunning={false}
        isEnabled={true}
        error={null}
        runtimeSummary={{ startedTools: 0, completedTools: 0, latestIteration: 0 }}
        plan={null}
        pendingClarificationQuestion={null}
        pendingToolPermissionRequest={null}
        onApprove={() => {}}
        onReject={() => {}}
        onRetry={() => {}}
        onToolAllow={() => {}}
        onToolAllowAlways={() => {}}
        onToolDeny={() => {}}
      />,
    );

    await user.type(screen.getByTestId('chat-input-field'), 'Fix intro pacing');
    await user.click(screen.getByTestId('chat-input-submit-btn'));

    expect(loadForProject).toHaveBeenCalledWith('project-1');
    await waitFor(() => {
      expect(executeMessage).toHaveBeenCalledWith('Fix intro pacing');
    });

    expect(useConversationStore.getState().activeProjectId).toBe('project-1');
    expect(useConversationStore.getState().activeConversation?.messages).toHaveLength(1);
    expect(useConversationStore.getState().activeConversation?.messages[0]?.role).toBe('user');
  });

  it('disables composer controls while stopping is in progress', async () => {
    const user = userEvent.setup();

    render(
      <AgentRuntimeChatShell
        chatTestId="agent-runtime-shell"
        executeMessage={vi.fn()}
        abort={vi.fn()}
        phase="executing"
        isRunning={true}
        isEnabled={true}
        error={null}
        runtimeSummary={{ startedTools: 1, completedTools: 0, latestIteration: 0 }}
        plan={null}
        pendingClarificationQuestion={null}
        pendingToolPermissionRequest={null}
        onApprove={() => {}}
        onReject={() => {}}
        onRetry={() => {}}
        onToolAllow={() => {}}
        onToolAllowAlways={() => {}}
        onToolDeny={() => {}}
      />,
    );

    expect(screen.getByTestId('chat-input-disabled')).toHaveTextContent('false');

    await user.click(screen.getByTestId('chat-input-stop-btn'));

    expect(screen.getByTestId('chat-input-disabled')).toHaveTextContent('true');
  });

  it('aborts the active run when the user switches projects', async () => {
    const abort = vi.fn();
    const loadForProject = vi.fn((projectId: string) => {
      useConversationStore.setState((state) => ({
        ...state,
        activeProjectId: projectId,
        activeConversation: {
          id: `draft-${projectId}`,
          projectId,
          messages: [],
          createdAt: 200,
          updatedAt: 200,
        },
      }));
    });

    act(() => {
      useMessageQueueStore.getState().enqueue('queued prompt');
      useConversationStore.setState((state) => ({
        ...state,
        loadForProject,
      }));
    });

    render(
      <AgentRuntimeChatShell
        chatTestId="agent-runtime-shell"
        executeMessage={vi.fn()}
        abort={abort}
        phase="executing"
        isRunning={true}
        isEnabled={true}
        error={null}
        runtimeSummary={{ startedTools: 1, completedTools: 0, latestIteration: 0 }}
        plan={null}
        pendingClarificationQuestion={null}
        pendingToolPermissionRequest={null}
        onApprove={() => {}}
        onReject={() => {}}
        onRetry={() => {}}
        onToolAllow={() => {}}
        onToolAllowAlways={() => {}}
        onToolDeny={() => {}}
      />,
    );

    act(() => {
      useProjectStore.setState((state) => ({
        ...state,
        meta: {
          ...(state.meta ?? {
            name: 'Test Project',
            path: '/tmp/project',
            createdAt: '2026-01-01T00:00:00.000Z',
            modifiedAt: '2026-01-01T00:00:00.000Z',
          }),
          id: 'project-2',
        },
      }));
    });

    await waitFor(() => {
      expect(abort).toHaveBeenCalledTimes(1);
      expect(loadForProject).toHaveBeenCalledWith('project-2');
    });

    expect(useMessageQueueStore.getState().queue).toHaveLength(0);
  });

  it('clears artifact focus when the active conversation changes', async () => {
    const user = userEvent.setup();

    act(() => {
      useConversationStore.setState((state) => ({
        ...state,
        activeConversation: {
          id: 'session-1',
          projectId: 'project-1',
          messages: [
            {
              id: 'msg-1',
              role: 'assistant',
              parts: [
                {
                  type: 'tool_call',
                  stepId: 's1',
                  tool: 'delete_clip',
                  args: { clipId: 'clip-1' },
                  description: 'Delete clip-1',
                  riskLevel: 'medium',
                  status: 'completed',
                },
              ],
              timestamp: 1,
            },
          ],
          createdAt: 100,
          updatedAt: 100,
        },
      }));
    });

    render(
      <AgentRuntimeChatShell
        chatTestId="agent-runtime-shell"
        executeMessage={vi.fn()}
        abort={vi.fn()}
        phase="idle"
        isRunning={false}
        isEnabled={true}
        error={null}
        runtimeSummary={{ startedTools: 1, completedTools: 1, latestIteration: 1 }}
        plan={null}
        pendingClarificationQuestion={null}
        pendingToolPermissionRequest={null}
        onApprove={() => {}}
        onReject={() => {}}
        onRetry={() => {}}
        onToolAllow={() => {}}
        onToolAllowAlways={() => {}}
        onToolDeny={() => {}}
      />,
    );

    await user.click(screen.getByTestId('artifact-tool-delete_clip'));
    expect(screen.getByTestId('agent-artifact-focus-banner')).toBeInTheDocument();

    act(() => {
      useConversationStore.setState((state) => ({
        ...state,
        activeConversation: {
          id: 'session-2',
          projectId: 'project-1',
          messages: [],
          createdAt: 200,
          updatedAt: 200,
        },
      }));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('agent-artifact-focus-banner')).not.toBeInTheDocument();
    });
  });

  it('keeps artifact review inline when an artifact is selected', async () => {
    const user = userEvent.setup();

    act(() => {
      useConversationStore.setState((state) => ({
        ...state,
        activeConversation: {
          id: 'session-1',
          projectId: 'project-1',
          messages: [
            {
              id: 'msg-1',
              role: 'assistant',
              parts: [
                {
                  type: 'tool_call',
                  stepId: 's1',
                  tool: 'delete_clip',
                  args: { clipId: 'clip-1' },
                  description: 'Delete clip-1',
                  riskLevel: 'medium',
                  status: 'completed',
                },
              ],
              timestamp: 1,
            },
          ],
          createdAt: 100,
          updatedAt: 100,
        },
      }));
    });

    render(
      <AgentRuntimeChatShell
        chatTestId="agent-runtime-shell"
        executeMessage={vi.fn()}
        abort={vi.fn()}
        phase="idle"
        isRunning={false}
        isEnabled={true}
        error={null}
        runtimeSummary={{ startedTools: 1, completedTools: 1, latestIteration: 1 }}
        plan={null}
        pendingClarificationQuestion={null}
        pendingToolPermissionRequest={null}
        onApprove={() => {}}
        onReject={() => {}}
        onRetry={() => {}}
        onToolAllow={() => {}}
        onToolAllowAlways={() => {}}
        onToolDeny={() => {}}
      />,
    );

    await user.click(screen.getByTestId('artifact-tool-delete_clip'));

    const layout = useWorkspaceLayoutStore.getState().layout;
    expect(layout.zones.bottom.panelIds).not.toContain('agent-review');
    expect(layout.zones.bottom.activePanelId).toBe('history');
    expect(layout.zones.bottom.collapsed).toBe(true);
    expect(screen.getByTestId('agent-artifact-detail-panel')).toHaveTextContent('delete_clip');
    expect(useAgentArtifactReviewStore.getState().selection.focus).toEqual({
      kind: 'tool',
      value: 'delete_clip',
    });
  });
});
