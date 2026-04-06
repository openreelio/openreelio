import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationStore, type SessionSummary } from '@/stores/conversationStore';
import { useAgentDelegationStore } from '@/stores/agentDelegationStore';
import { useAgentSessionStore } from '@/stores/agentSessionStore';
import { SessionList } from './SessionList';

function createSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Editor Session',
    agent: 'editor',
    modelProvider: null,
    modelId: null,
    createdAt: 100,
    updatedAt: 100,
    archived: false,
    messageCount: 2,
    lastMessagePreview: 'Latest update',
    ...overrides,
  };
}

describe('SessionList', () => {
  beforeEach(() => {
    act(() => {
      useAgentSessionStore.getState().clear();
      useAgentDelegationStore.setState({
        recordsBySessionId: {},
        isLoadingBySessionId: {},
        lastErrorBySessionId: {},
        loadDelegations: vi.fn().mockResolvedValue([]),
        createDelegatedSession: vi.fn(),
        updateDelegationRecord: vi.fn(),
        clearForSession: vi.fn(),
        clear: vi.fn(),
      });
      useConversationStore.setState({
        activeConversation: {
          id: 'session-1',
          projectId: 'project-1',
          messages: [],
          createdAt: 100,
          updatedAt: 100,
        },
        isGenerating: false,
        streamingMessageId: null,
        activeProjectId: 'project-1',
        activeSessionId: 'session-1',
        sessions: [
          createSessionSummary(),
          createSessionSummary({
            id: 'session-2',
            title: 'Planner Session',
            agent: 'planner',
            updatedAt: 200,
          }),
        ],
      });
    });
  });

  afterEach(() => {
    act(() => {
      useAgentSessionStore.getState().clear();
    });
  });

  it('does not show persistence badges for healthy sessions', () => {
    render(<SessionList />);

    expect(screen.getByTestId('session-agent-badge-session-1')).toHaveTextContent('Editor');
    expect(screen.getByTestId('session-agent-badge-session-2')).toHaveTextContent('Planner');
    expect(screen.queryByTestId('session-persistence-badge-session-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-persistence-badge-session-2')).not.toBeInTheDocument();
  });

  it('shows degraded and ephemeral persistence badges per session', () => {
    act(() => {
      useAgentSessionStore.getState().reportPersistenceIssue({
        sessionId: 'session-1',
        stage: 'run_finalize',
        error: new Error('failed to finalize run'),
        occurredAt: 200,
      });
      useAgentSessionStore.getState().reportPersistenceIssue({
        sessionId: 'session-2',
        stage: 'run_start',
        error: new Error('failed to create persisted run'),
        occurredAt: 300,
      });
    });

    render(<SessionList />);

    expect(screen.getByTestId('session-persistence-badge-session-1')).toHaveTextContent('Degraded');
    expect(screen.getByTestId('session-persistence-badge-session-2')).toHaveTextContent(
      'Ephemeral',
    );
    expect(screen.getByTestId('session-persistence-badge-session-2')).toHaveAttribute(
      'title',
      expect.stringMatching(/restart survivability is not guaranteed/i),
    );
  });

  it('keeps session badges visible when persistence recovered but the session is latched', () => {
    act(() => {
      useAgentSessionStore.getState().reportPersistenceIssue({
        sessionId: 'session-1',
        stage: 'run_finalize',
        error: new Error('failed to finalize run'),
        occurredAt: 200,
      });
      useAgentSessionStore.getState().clearPersistenceIssue('session-1', 'run_finalize');
    });

    render(<SessionList />);

    expect(screen.getByTestId('session-persistence-badge-session-1')).toHaveTextContent('Degraded');
    expect(screen.getByTestId('session-persistence-badge-session-1')).toHaveAttribute(
      'title',
      expect.stringMatching(/persistence recovered for the active run/i),
    );
  });

  it('shows the resolved experimental agent label when the session uses a specialist profile', () => {
    act(() => {
      useConversationStore.setState((state) => ({
        ...state,
        sessions: [
          createSessionSummary({
            id: 'session-1',
            agent: 'planner',
          }),
        ],
      }));
    });

    render(<SessionList />);

    expect(screen.getByTestId('session-agent-badge-session-1')).toHaveTextContent('Planner');
  });

  it('uses the injected switch handler when provided', async () => {
    const user = userEvent.setup();
    const onSwitchSession = vi.fn();

    render(<SessionList onSwitchSession={onSwitchSession} />);

    await user.click(screen.getByTestId('session-item-session-2'));

    expect(onSwitchSession).toHaveBeenCalledWith('session-2');
  });

  it('shows delegated parent and child session badges when delegation records exist', () => {
    act(() => {
      useAgentDelegationStore.setState((state) => ({
        ...state,
        recordsBySessionId: {
          'session-1': [
            {
              id: 'delegation-1',
              parentSessionId: 'session-1',
              childSessionId: 'session-2',
              parentRunId: 'run-parent',
              agentProfileId: 'planner',
              delegatedGoal: 'Review pacing',
              contextPacketJson: '{}',
              allowedToolsDeltaJson: null,
              permissionSnapshotJson: null,
              status: 'running',
              mergeStatus: 'pending',
              summaryMessageId: null,
              resultJson: null,
              errorMessage: null,
              createdAt: 1,
              updatedAt: 1,
              completedAt: null,
            },
          ],
          'session-2': [
            {
              id: 'delegation-1',
              parentSessionId: 'session-1',
              childSessionId: 'session-2',
              parentRunId: 'run-parent',
              agentProfileId: 'planner',
              delegatedGoal: 'Review pacing',
              contextPacketJson: '{}',
              allowedToolsDeltaJson: null,
              permissionSnapshotJson: null,
              status: 'running',
              mergeStatus: 'pending',
              summaryMessageId: null,
              resultJson: null,
              errorMessage: null,
              createdAt: 1,
              updatedAt: 1,
              completedAt: null,
            },
          ],
        },
      }));
    });

    render(<SessionList />);

    expect(screen.getByTestId('session-delegation-mode-session-1')).toHaveTextContent(
      '1 delegated',
    );
    expect(screen.getByTestId('session-delegation-status-session-1')).toHaveTextContent('1 active');
    expect(screen.getByTestId('session-delegation-mode-session-2')).toHaveTextContent('Child');
    expect(screen.getByTestId('session-delegation-status-session-2')).toHaveTextContent('Running');
  });
});
