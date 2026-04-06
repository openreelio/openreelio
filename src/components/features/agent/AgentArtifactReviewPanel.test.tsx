import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useConversationStore } from '@/stores/conversationStore';
import { useAgentArtifactReviewStore } from '@/stores/agentArtifactReviewStore';
import { AgentArtifactReviewPanel } from './AgentArtifactReviewPanel';

describe('AgentArtifactReviewPanel', () => {
  beforeEach(() => {
    act(() => {
      useAgentArtifactReviewStore.setState((state) => ({
        ...state,
        selection: {
          focus: null,
          projectId: null,
          conversationId: null,
          sourceLabel: null,
          sourceAgentProfileId: null,
        },
        sourcesByConversationId: {},
        isLoadingByConversationId: {},
        lastErrorByConversationId: {},
      }));
      useConversationStore.setState((state) => ({
        ...state,
        activeProjectId: 'project-1',
        activeConversation: {
          id: 'session-1',
          projectId: 'project-1',
          messages: [
            {
              id: 'msg-1',
              role: 'assistant',
              parts: [
                {
                  type: 'patch',
                  diff: 'diff --git a/src/foo.ts b/src/foo.ts',
                  files: ['src/foo.ts'],
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
  });

  afterEach(() => {
    act(() => {
      useAgentArtifactReviewStore.setState((state) => ({
        ...state,
        selection: {
          focus: null,
          projectId: null,
          conversationId: null,
          sourceLabel: null,
          sourceAgentProfileId: null,
        },
        sourcesByConversationId: {},
        isLoadingByConversationId: {},
        lastErrorByConversationId: {},
      }));
    });
  });

  it('renders the unselected review state when artifacts exist but none is selected', () => {
    render(<AgentArtifactReviewPanel />);

    expect(screen.getByTestId('agent-artifact-review-panel')).toBeInTheDocument();
    expect(screen.getByTestId('agent-artifact-review-panel-unselected')).toBeInTheDocument();
    expect(screen.getByText('Select an artifact to review')).toBeInTheDocument();
  });

  it('renders review detail for the selected artifact in the active conversation', () => {
    act(() => {
      useAgentArtifactReviewStore.getState().setSelection({
        focus: { kind: 'file', value: 'src/foo.ts' },
        projectId: 'project-1',
        conversationId: 'session-1',
      });
    });

    render(<AgentArtifactReviewPanel />);

    expect(screen.getByTestId('agent-artifact-review-panel')).toBeInTheDocument();
    expect(screen.getByText('Patch Review')).toBeInTheDocument();
    expect(screen.getByTestId('agent-artifact-detail-panel')).toHaveTextContent('src/foo.ts');
  });

  it('allows selecting an artifact directly inside the review panel', async () => {
    const user = userEvent.setup();

    render(<AgentArtifactReviewPanel />);

    await user.click(screen.getByTestId('review-file-src/foo.ts'));

    expect(screen.getByText('Patch Review')).toBeInTheDocument();
    expect(useAgentArtifactReviewStore.getState().selection.focus).toEqual({
      kind: 'file',
      value: 'src/foo.ts',
    });
  });

  it('renders a delegated child review source without switching the active session', () => {
    act(() => {
      useAgentArtifactReviewStore.setState((state) => ({
        ...state,
        selection: {
          focus: { kind: 'tool', value: 'query_timeline' },
          projectId: 'project-1',
          conversationId: 'session-child',
          sourceLabel: 'Planner Session',
          sourceAgentProfileId: 'planner',
        },
        sourcesByConversationId: {
          'session-child': {
            conversationId: 'session-child',
            projectId: 'project-1',
            title: 'Planner Session',
            agentProfileId: 'planner',
            messages: [
              {
                id: 'child-msg-1',
                role: 'assistant',
                parts: [
                  {
                    type: 'tool_call',
                    stepId: 's1',
                    tool: 'query_timeline',
                    args: {},
                    description: 'Inspect the current cut',
                    riskLevel: 'low',
                    status: 'completed',
                  },
                  {
                    type: 'tool_result',
                    stepId: 's1',
                    tool: 'query_timeline',
                    success: true,
                    duration: 12,
                  },
                ],
                timestamp: 2,
              },
            ],
            createdAt: 2,
            updatedAt: 2,
          },
        },
      }));
    });

    render(<AgentArtifactReviewPanel />);

    expect(screen.getByTestId('review-source-session-child')).toHaveTextContent('Planner Session');
    expect(screen.getByText('Tool Review')).toBeInTheDocument();
    expect(screen.getByTestId('agent-artifact-detail-panel')).toHaveTextContent('query_timeline');
    expect(screen.getByTestId('review-source-session-1')).toBeInTheDocument();
    expect(screen.getByTestId('review-source-session-child')).toBeInTheDocument();
  });

  it('lets the review panel switch back to the current session source', async () => {
    const user = userEvent.setup();

    act(() => {
      useAgentArtifactReviewStore.setState((state) => ({
        ...state,
        selection: {
          focus: { kind: 'tool', value: 'query_timeline' },
          projectId: 'project-1',
          conversationId: 'session-child',
          sourceLabel: 'Planner Session',
          sourceAgentProfileId: 'planner',
        },
        sourcesByConversationId: {
          'session-child': {
            conversationId: 'session-child',
            projectId: 'project-1',
            title: 'Planner Session',
            agentProfileId: 'planner',
            messages: [
              {
                id: 'child-msg-1',
                role: 'assistant',
                parts: [
                  {
                    type: 'tool_call',
                    stepId: 's1',
                    tool: 'query_timeline',
                    args: {},
                    description: 'Inspect the current cut',
                    riskLevel: 'low',
                    status: 'completed',
                  },
                ],
                timestamp: 2,
              },
            ],
            createdAt: 2,
            updatedAt: 2,
          },
        },
      }));
    });

    render(<AgentArtifactReviewPanel />);

    await user.click(screen.getByTestId('review-source-session-1'));

    expect(useAgentArtifactReviewStore.getState().selection).toEqual(
      expect.objectContaining({
        conversationId: 'session-1',
        sourceLabel: 'Current Session',
      }),
    );
  });
});
