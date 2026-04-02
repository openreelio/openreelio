import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useConversationStore } from '@/stores/conversationStore';
import { useAgentSessionStore } from '@/stores/agentSessionStore';
import { AgentSessionRecoveryPanel } from './AgentSessionRecoveryPanel';

describe('AgentSessionRecoveryPanel', () => {
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

  it('should not render when the active session is healthy', () => {
    const { container } = render(<AgentSessionRecoveryPanel />);

    expect(container).toBeEmptyDOMElement();
  });

  it('should render current-run recovery guidance for active issues', () => {
    act(() => {
      useAgentSessionStore.getState().reportPersistenceIssue({
        sessionId: 'session-1',
        stage: 'run_finalize',
        error: new Error('failed to finalize run'),
        occurredAt: 100,
      });
    });

    render(<AgentSessionRecoveryPanel />);

    expect(screen.getByTestId('agent-session-recovery-panel')).toBeInTheDocument();
    expect(screen.getByText('Session Recovery')).toBeInTheDocument();
    expect(screen.getByText('Degraded')).toBeInTheDocument();
    expect(screen.getByText('Current run')).toBeInTheDocument();
    expect(screen.getByText('Restart safety: limited')).toBeInTheDocument();
    expect(screen.getByText('Persisted run finalization failed')).toBeInTheDocument();
  });

  it('should render latched recovery guidance after active issues clear', () => {
    act(() => {
      useAgentSessionStore.getState().reportPersistenceIssue({
        sessionId: 'session-1',
        stage: 'run_start',
        error: new Error('failed to create persisted run'),
        occurredAt: 100,
      });
      useAgentSessionStore.getState().clearPersistenceIssue('session-1', 'run_start');
    });

    render(<AgentSessionRecoveryPanel />);

    expect(screen.getByText('Ephemeral')).toBeInTheDocument();
    expect(screen.getByText('Earlier in this app session')).toBeInTheDocument();
    expect(screen.getByText('Restart safety: not guaranteed')).toBeInTheDocument();
    expect(screen.getByText('Persisted run creation failed')).toBeInTheDocument();
  });
});
