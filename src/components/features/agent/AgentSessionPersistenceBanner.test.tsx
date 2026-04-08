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
    expect(
      screen.getByText('Some saved recovery details are temporarily unavailable'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /current work can continue, but resuming an interrupted task may be limited until recovery catches up/i,
      ),
    ).toBeInTheDocument();
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

    expect(
      screen.getByText('Some saved recovery details are temporarily unavailable'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Current work can continue, but resuming an interrupted task may be limited until recovery catches up.',
      ),
    ).toBeInTheDocument();
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

    expect(screen.getByText('Saved recovery protection is limited right now')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Current work can continue, but if the app closes unexpectedly, this turn may not be restorable.',
      ),
    ).toBeInTheDocument();
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
      screen.getByText('Earlier recovery protection was limited in this app session'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Current work can continue, but some interrupted work from earlier in this app session may not be restorable after a reload.',
      ),
    ).toBeInTheDocument();
  });
});
