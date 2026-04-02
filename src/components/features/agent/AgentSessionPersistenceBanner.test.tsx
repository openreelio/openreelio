import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useConversationStore } from '@/stores/conversationStore';
import { useAgentSessionStore } from '@/stores/agentSessionStore';
import { AgentSessionPersistenceBanner } from './AgentSessionPersistenceBanner';

describe('AgentSessionPersistenceBanner', () => {
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
    const { container } = render(<AgentSessionPersistenceBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  it('should render a degraded persistence warning for the active session', () => {
    act(() => {
      useAgentSessionStore.getState().reportPersistenceIssue({
        sessionId: 'session-1',
        stage: 'run_finalize',
        error: new Error('failed to persist final run phase'),
        occurredAt: 300,
      });
    });

    render(<AgentSessionPersistenceBanner />);

    expect(screen.getByTestId('agent-session-persistence-banner')).toBeInTheDocument();
    expect(screen.getByText('Agent session persistence is degraded')).toBeInTheDocument();
    expect(screen.getByText('Run completion could not be persisted.')).toBeInTheDocument();
    expect(
      screen.getByText(
        /resume, approval history, or audit trail may be incomplete until persistence recovers/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('failed to persist final run phase')).toBeInTheDocument();
  });

  it('should render multiple unresolved persistence issues for the active session', () => {
    act(() => {
      useAgentSessionStore.getState().reportPersistenceIssue({
        sessionId: 'session-1',
        stage: 'permission_replay',
        error: new Error('failed to replay permissions'),
        occurredAt: 200,
      });
      useAgentSessionStore.getState().reportPersistenceIssue({
        sessionId: 'session-1',
        stage: 'run_finalize',
        error: new Error('failed to finalize run'),
        occurredAt: 300,
      });
    });

    render(<AgentSessionPersistenceBanner />);

    expect(screen.getByText('Saved permission decisions could not be restored.')).toBeInTheDocument();
    expect(screen.getByText('Run completion could not be persisted.')).toBeInTheDocument();
    expect(screen.getByText('failed to replay permissions')).toBeInTheDocument();
    expect(screen.getByText('failed to finalize run')).toBeInTheDocument();
  });

  it('should escalate to ephemeral copy when restart survivability is not guaranteed', () => {
    act(() => {
      useAgentSessionStore.getState().reportPersistenceIssue({
        sessionId: 'session-1',
        stage: 'run_start',
        error: new Error('failed to create persisted run'),
        occurredAt: 300,
      });
    });

    render(<AgentSessionPersistenceBanner />);

    expect(screen.getByText('Agent session persistence is ephemeral')).toBeInTheDocument();
    expect(
      screen.getByText(/restart survivability is not guaranteed/i),
    ).toBeInTheDocument();
    expect(screen.getByText('failed to create persisted run')).toBeInTheDocument();
  });

  it('should keep showing a latched warning after the active issue is cleared', () => {
    act(() => {
      useAgentSessionStore.getState().reportPersistenceIssue({
        sessionId: 'session-1',
        stage: 'run_start',
        error: new Error('failed to create persisted run'),
        occurredAt: 300,
      });
      useAgentSessionStore.getState().clearPersistenceIssue('session-1', 'run_start');
    });

    render(<AgentSessionPersistenceBanner />);

    expect(
      screen.getByText('Agent session persistence was ephemeral earlier in this app session'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/persistence recovered for the active run, but this session crossed a non-durable boundary earlier in this app session/i),
    ).toBeInTheDocument();
    expect(screen.getByText('failed to create persisted run')).toBeInTheDocument();
  });
});
