import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useConversationStore } from '@/stores/conversationStore';
import { useAgentSessionStore } from '@/stores/agentSessionStore';
import { AgentSessionRecoveryStatus } from './AgentSessionRecoveryStatus';

describe('AgentSessionRecoveryStatus', () => {
  beforeEach(() => {
    act(() => {
      useAgentSessionStore.getState().clear();
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
        sessions: [],
      });
    });
  });

  afterEach(() => {
    act(() => {
      useAgentSessionStore.getState().clear();
    });
  });

  it('does not render when the active session is healthy', () => {
    const { container } = render(<AgentSessionRecoveryStatus />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders active ephemeral restart guidance', () => {
    act(() => {
      useAgentSessionStore.getState().reportPersistenceIssue({
        sessionId: 'session-1',
        stage: 'run_start',
        error: new Error('failed to create persisted run'),
        occurredAt: 100,
      });
    });

    render(<AgentSessionRecoveryStatus />);

    expect(screen.getByTestId('agent-session-recovery-status')).toBeInTheDocument();
    expect(screen.getByText('Ephemeral')).toBeInTheDocument();
    expect(
      screen.getByText('Restart safety is not guaranteed for this session.'),
    ).toBeInTheDocument();
  });

  it('renders latched degraded guidance after recovery', () => {
    act(() => {
      useAgentSessionStore.getState().reportPersistenceIssue({
        sessionId: 'session-1',
        stage: 'run_finalize',
        error: new Error('failed to finalize run'),
        occurredAt: 100,
      });
      useAgentSessionStore.getState().clearPersistenceIssue('session-1', 'run_finalize');
    });

    render(<AgentSessionRecoveryStatus />);

    expect(screen.getByText('Degraded')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Recovered in this app session, but earlier resume history may still be partial.',
      ),
    ).toBeInTheDocument();
  });
});
