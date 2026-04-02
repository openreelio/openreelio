import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useConversationStore, type SessionSummary } from '@/stores/conversationStore';
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

    expect(screen.getByTestId('session-persistence-badge-session-1')).toHaveTextContent(
      'Degraded',
    );
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

    expect(screen.getByTestId('session-persistence-badge-session-1')).toHaveTextContent(
      'Degraded',
    );
    expect(screen.getByTestId('session-persistence-badge-session-1')).toHaveAttribute(
      'title',
      expect.stringMatching(/persistence recovered for the active run/i),
    );
  });
});
