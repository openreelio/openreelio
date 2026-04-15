import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationStore } from '@/stores/conversationStore';
import { useAgentArtifactReviewStore } from '@/stores/agentArtifactReviewStore';
import { useAgentDelegationStore } from '@/stores/agentDelegationStore';
import { useAgentSessionStore } from '@/stores/agentSessionStore';
import { writeWorkspaceDocumentToBackend } from '@/services/workspaceGateway';
import { AgentArtifactReviewPanel } from './AgentArtifactReviewPanel';

vi.mock('@/services/workspaceGateway', () => ({
  writeWorkspaceDocumentToBackend: vi.fn().mockResolvedValue({
    relativePath: '.openreelio/reviews/delegation-1-verifier.md',
  }),
}));

describe('AgentArtifactReviewPanel', () => {
  beforeEach(() => {
    vi.mocked(writeWorkspaceDocumentToBackend).mockClear();
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
      useAgentDelegationStore.setState((state) => ({
        ...state,
        recordsBySessionId: {},
        isLoadingBySessionId: {},
        lastErrorBySessionId: {},
      }));
      useAgentSessionStore.setState((state) => ({
        ...state,
        snapshotsById: {},
        activeSessionId: null,
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
      useAgentDelegationStore.setState((state) => ({
        ...state,
        recordsBySessionId: {},
        isLoadingBySessionId: {},
        lastErrorBySessionId: {},
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
    expect(screen.getByText('File Changes')).toBeInTheDocument();
    expect(screen.getByTestId('agent-artifact-detail-panel')).toHaveTextContent('src/foo.ts');
  });

  it('allows selecting an artifact directly inside the review panel', async () => {
    const user = userEvent.setup();

    render(<AgentArtifactReviewPanel />);

    await user.click(screen.getByTestId('review-file-src/foo.ts'));

    expect(screen.getByText('File Changes')).toBeInTheDocument();
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
    expect(screen.getByText('Action Details')).toBeInTheDocument();
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

  it('shows delegation verification controls and persists a parent review decision', async () => {
    const user = userEvent.setup();
    const updateDelegationRecord = vi.fn().mockResolvedValue({});

    act(() => {
      useAgentDelegationStore.setState((state) => ({
        ...state,
        recordsBySessionId: {
          'session-1': [
            {
              id: 'delegation-1',
              parentSessionId: 'session-1',
              childSessionId: 'session-child',
              parentRunId: 'run-parent',
              agentProfileId: 'planner',
              delegatedGoal: 'Review pacing',
              contextPacketJson: JSON.stringify({
                source: 'agent-workspace',
                parentSessionId: 'session-1',
                parentAgentId: 'editor',
                parentAgentName: 'Editor Session',
                delegatedGoal: 'Review pacing',
                createdAt: 2,
                taskContract: {
                  objective: 'Review pacing',
                  specialistId: 'planner',
                  specialistName: 'Planner',
                  verificationSpec: {
                    handoffSchemaVersion: 1,
                    requireStructuredHandoff: true,
                    requireSummary: true,
                    requireEvidence: true,
                    requireOpenIssuesStatement: true,
                    minimumEvidenceCount: 1,
                  },
                  expectedDeliverables: [
                    'Break down the goal into an execution-ready plan: Review pacing',
                  ],
                  acceptanceChecklist: [
                    'Provide a parent-reviewable summary before declaring the task done.',
                  ],
                  handoffRequirement:
                    'Parent verification is required before this delegated result can be merged.',
                },
              }),
              allowedToolsDeltaJson: null,
              permissionSnapshotJson: null,
              status: 'completed',
              mergeStatus: 'pending',
              summaryMessageId: 'child-msg-1',
              resultJson: JSON.stringify({
                success: true,
                aborted: false,
                totalDuration: 800,
                iterations: 1,
                finalState: 'Suggested a shorter intro section.',
                executedSteps: 1,
                successfulSteps: 1,
                failedSteps: 0,
                preview: 'Suggested a shorter intro section.',
                recentTools: [],
                recentFiles: [],
                handoff: {
                  parseStatus: 'parsed',
                  summary: 'Suggested a shorter intro section.',
                  openIssues: [],
                  openIssuesDeclared: true,
                  evidence: [{ kind: 'summary', value: 'Suggested a shorter intro section.' }],
                },
                autoVerification: {
                  status: 'pass',
                  summary:
                    'Automatic verification passed the delegated handoff against the stored task contract.',
                  missingRequirements: [],
                  warnings: [],
                  checkedAt: 2,
                },
                verification: {
                  verdict: 'unverified',
                  summary: 'Completed child work remains pending until parent verification.',
                  verifiedAt: null,
                  evidence: [{ kind: 'summary', value: 'Suggested a shorter intro section.' }],
                },
              }),
              errorMessage: null,
              createdAt: 2,
              updatedAt: 2,
              completedAt: 2,
            },
          ],
        },
        updateDelegationRecord,
      }));
      useAgentArtifactReviewStore.setState((state) => ({
        ...state,
        selection: {
          focus: null,
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
                parts: [{ type: 'text', content: 'Suggested a shorter intro section.' }],
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

    expect(screen.getByText('Delegation handoff')).toBeInTheDocument();
    expect(screen.getByText('Needs verification')).toBeInTheDocument();
    expect(screen.getByText('Automatic verification')).toBeInTheDocument();
    expect(screen.getByText('Contract check passed')).toBeInTheDocument();
    expect(screen.getByText('Task contract')).toBeInTheDocument();
    expect(screen.getByText('Review pacing')).toBeInTheDocument();
    expect(
      screen.getByText('Provide a parent-reviewable summary before declaring the task done.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('delegation-review-verify-btn')).toBeInTheDocument();
    expect(screen.getByTestId('delegation-review-verify-btn')).not.toBeDisabled();
    expect(
      screen.getByText(/No detailed artifacts were captured for this delegation\./),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId('delegation-review-verify-btn'));

    expect(updateDelegationRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'delegation-1',
        mergeStatus: 'merged',
      }),
    );
    expect(JSON.parse(updateDelegationRecord.mock.calls[0][0].resultJson as string)).toEqual(
      expect.objectContaining({
        verification: expect.objectContaining({
          verdict: 'pass',
          summary: 'Verified by parent review and ready to merge.',
        }),
      }),
    );
  });

  it('disables merge confirmation when automatic contract verification needs follow-up', () => {
    act(() => {
      useAgentDelegationStore.setState((state) => ({
        ...state,
        recordsBySessionId: {
          'session-1': [
            {
              id: 'delegation-follow-up',
              parentSessionId: 'session-1',
              childSessionId: 'session-child',
              parentRunId: 'run-parent',
              agentProfileId: 'planner',
              delegatedGoal: 'Review pacing',
              contextPacketJson: JSON.stringify({
                source: 'agent-workspace',
                parentSessionId: 'session-1',
                parentAgentId: 'editor',
                parentAgentName: 'Editor Session',
                delegatedGoal: 'Review pacing',
                createdAt: 2,
                taskContract: {
                  objective: 'Review pacing',
                  specialistId: 'planner',
                  specialistName: 'Planner',
                  verificationSpec: {
                    handoffSchemaVersion: 1,
                    requireStructuredHandoff: true,
                    requireSummary: true,
                    requireEvidence: true,
                    requireOpenIssuesStatement: true,
                    minimumEvidenceCount: 1,
                  },
                  expectedDeliverables: [
                    'Break down the goal into an execution-ready plan: Review pacing',
                  ],
                  acceptanceChecklist: [
                    'Provide a parent-reviewable summary before declaring the task done.',
                  ],
                  handoffRequirement:
                    'Parent verification is required before this delegated result can be merged.',
                },
              }),
              allowedToolsDeltaJson: null,
              permissionSnapshotJson: null,
              status: 'completed',
              mergeStatus: 'pending',
              summaryMessageId: 'child-msg-follow-up',
              resultJson: JSON.stringify({
                success: true,
                aborted: false,
                totalDuration: 800,
                iterations: 1,
                finalState: 'Suggested a shorter intro section.',
                executedSteps: 1,
                successfulSteps: 1,
                failedSteps: 0,
                preview: 'Suggested a shorter intro section.',
                recentTools: [],
                recentFiles: [],
                handoff: {
                  parseStatus: 'missing',
                  summary: 'Suggested a shorter intro section.',
                  openIssues: [],
                  openIssuesDeclared: false,
                  evidence: [{ kind: 'summary', value: 'Suggested a shorter intro section.' }],
                },
                autoVerification: {
                  status: 'needs_follow_up',
                  summary:
                    'Automatic verification needs follow-up because the delegated handoff was not returned in the required structured format.',
                  missingRequirements: ['Return a final DELEGATION_HANDOFF JSON block.'],
                  warnings: [],
                  checkedAt: 2,
                },
                verification: {
                  verdict: 'unverified',
                  summary: 'Completed child work remains pending until parent verification.',
                  verifiedAt: null,
                  evidence: [{ kind: 'summary', value: 'Suggested a shorter intro section.' }],
                },
              }),
              errorMessage: null,
              createdAt: 2,
              updatedAt: 2,
              completedAt: 2,
            },
          ],
        },
      }));
      useAgentArtifactReviewStore.setState((state) => ({
        ...state,
        selection: {
          focus: null,
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
                id: 'child-msg-follow-up',
                role: 'assistant',
                parts: [{ type: 'text', content: 'Suggested a shorter intro section.' }],
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

    expect(screen.getByText('Contract follow-up')).toBeInTheDocument();
    expect(screen.getByText('Return a final DELEGATION_HANDOFF JSON block.')).toBeInTheDocument();
    expect(screen.getByTestId('delegation-review-verify-btn')).toBeDisabled();
    expect(
      screen.getByText(
        'Automatic contract verification must pass before this handoff can be merged.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('delegation-review-follow-up-btn')).toBeInTheDocument();
    expect(screen.getByTestId('delegation-review-discard-btn')).toBeInTheDocument();
  });

  it('does not offer merge controls for failed delegation results', () => {
    act(() => {
      useAgentDelegationStore.setState((state) => ({
        ...state,
        recordsBySessionId: {
          'session-1': [
            {
              id: 'delegation-failed',
              parentSessionId: 'session-1',
              childSessionId: 'session-child',
              parentRunId: 'run-parent',
              agentProfileId: 'planner',
              delegatedGoal: 'Review pacing',
              contextPacketJson: '{}',
              allowedToolsDeltaJson: null,
              permissionSnapshotJson: null,
              status: 'failed',
              mergeStatus: 'pending',
              summaryMessageId: 'child-msg-2',
              resultJson: JSON.stringify({
                success: false,
                aborted: false,
                totalDuration: 0,
                iterations: 1,
                finalState: null,
                executedSteps: 0,
                successfulSteps: 0,
                failedSteps: 1,
                preview: 'Tool execution failed.',
                recentTools: [],
                recentFiles: [],
                verification: {
                  verdict: 'unverified',
                  summary: 'Completed child work remains pending until parent verification.',
                  verifiedAt: null,
                  evidence: [{ kind: 'summary', value: 'Tool execution failed.' }],
                },
              }),
              errorMessage: 'Tool execution failed.',
              createdAt: 3,
              updatedAt: 3,
              completedAt: 3,
            },
          ],
        },
      }));
      useAgentArtifactReviewStore.setState((state) => ({
        ...state,
        selection: {
          focus: null,
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
                id: 'child-msg-2',
                role: 'assistant',
                parts: [{ type: 'text', content: 'Tool execution failed.' }],
                timestamp: 3,
              },
            ],
            createdAt: 3,
            updatedAt: 3,
          },
        },
      }));
    });

    render(<AgentArtifactReviewPanel />);

    expect(screen.getByText('Delegation handoff')).toBeInTheDocument();
    expect(screen.queryByTestId('delegation-review-verify-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('delegation-review-follow-up-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('delegation-review-discard-btn')).not.toBeInTheDocument();
  });

  it('launches a verifier specialist from the review flow', async () => {
    const user = userEvent.setup();
    const createDelegatedSession = vi.fn().mockResolvedValue({
      childSession: {
        id: 'session-verifier',
        projectId: 'project-1',
      },
      delegationRecord: {
        id: 'delegation-verifier',
      },
      delegationErrorMessage: null,
    });
    const loadDelegations = vi.fn().mockResolvedValue([]);
    const loadSessions = vi.fn().mockResolvedValue(undefined);
    const switchSession = vi.fn().mockImplementation(async (sessionId: string) => {
      useConversationStore.setState((state) => ({
        ...state,
        activeSessionId: sessionId,
      }));
    });
    const addSystemMessageToSession = vi.fn();
    const loadAgentSession = vi
      .fn()
      .mockResolvedValueOnce({ session: { sequenceId: 'seq-1' } })
      .mockResolvedValueOnce({ session: { sequenceId: 'seq-1' } });

    act(() => {
      useConversationStore.setState((state) => ({
        ...state,
        activeProjectId: 'project-1',
        sessions: [
          {
            id: 'session-1',
            projectId: 'project-1',
            title: 'Editor Session',
            agent: 'editor',
            modelProvider: null,
            modelId: null,
            createdAt: 1,
            updatedAt: 1,
            archived: false,
            messageCount: 1,
            lastMessagePreview: 'review',
          },
          {
            id: 'session-child',
            projectId: 'project-1',
            title: 'Planner Session',
            agent: 'planner',
            modelProvider: null,
            modelId: null,
            createdAt: 2,
            updatedAt: 2,
            archived: false,
            messageCount: 1,
            lastMessagePreview: 'Suggested a shorter intro section.',
          },
        ],
        loadSessions,
        switchSession,
        addSystemMessageToSession,
      }));
      useAgentSessionStore.setState((state) => ({
        ...state,
        loadSession: loadAgentSession,
      }));
      useAgentDelegationStore.setState((state) => ({
        ...state,
        recordsBySessionId: {
          'session-1': [
            {
              id: 'delegation-1',
              parentSessionId: 'session-1',
              childSessionId: 'session-child',
              parentRunId: 'run-parent',
              agentProfileId: 'planner',
              delegatedGoal: 'Review pacing',
              contextPacketJson: JSON.stringify({
                source: 'agent-workspace',
                parentSessionId: 'session-1',
                parentAgentId: 'editor',
                parentAgentName: 'Editor Session',
                delegatedGoal: 'Review pacing',
                createdAt: 2,
                taskContract: {
                  objective: 'Review pacing',
                  specialistId: 'planner',
                  specialistName: 'Planner',
                  verificationSpec: {
                    handoffSchemaVersion: 1,
                    requireStructuredHandoff: true,
                    requireSummary: true,
                    requireEvidence: true,
                    requireOpenIssuesStatement: true,
                    minimumEvidenceCount: 1,
                  },
                  expectedDeliverables: [
                    'Break down the goal into an execution-ready plan: Review pacing',
                  ],
                  acceptanceChecklist: [
                    'Provide a parent-reviewable summary before declaring the task done.',
                  ],
                  handoffRequirement:
                    'Parent verification is required before this delegated result can be merged.',
                },
              }),
              allowedToolsDeltaJson: null,
              permissionSnapshotJson: null,
              status: 'completed',
              mergeStatus: 'pending',
              summaryMessageId: 'child-msg-1',
              resultJson: JSON.stringify({
                success: true,
                aborted: false,
                totalDuration: 800,
                iterations: 1,
                finalState: 'Suggested a shorter intro section.',
                executedSteps: 1,
                successfulSteps: 1,
                failedSteps: 0,
                preview: 'Suggested a shorter intro section.',
                recentTools: ['query_timeline'],
                recentFiles: ['src/foo.ts'],
                handoff: {
                  parseStatus: 'parsed',
                  summary: 'Suggested a shorter intro section.',
                  summaryProvided: true,
                  openIssues: [],
                  openIssuesDeclared: true,
                  evidence: [{ kind: 'tool', value: 'query_timeline' }],
                },
                autoVerification: {
                  status: 'pass',
                  summary:
                    'Automatic verification passed the delegated handoff against the stored task contract.',
                  missingRequirements: [],
                  warnings: [],
                  checkedAt: 2,
                },
                verification: {
                  verdict: 'unverified',
                  summary: 'Completed child work remains pending until parent verification.',
                  verifiedAt: null,
                  evidence: [{ kind: 'summary', value: 'Suggested a shorter intro section.' }],
                },
              }),
              errorMessage: null,
              createdAt: 2,
              updatedAt: 2,
              completedAt: 2,
            },
          ],
        },
        createDelegatedSession,
        loadDelegations,
      }));
      useAgentArtifactReviewStore.setState((state) => ({
        ...state,
        selection: {
          focus: null,
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
                parts: [{ type: 'text', content: 'Suggested a shorter intro section.' }],
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

    await user.click(screen.getByTestId('delegation-review-launch-verifier-btn'));

    expect(writeWorkspaceDocumentToBackend).toHaveBeenCalledWith(
      '.openreelio/reviews/delegation-1-verifier.md',
      expect.stringContaining('# Delegation Verification Packet'),
      true,
    );
    expect(createDelegatedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'session-1',
        parentRunId: 'run-parent',
        projectId: 'project-1',
        sequenceId: 'seq-1',
        agentProfileId: 'verifier',
      }),
    );
    expect(JSON.parse(createDelegatedSession.mock.calls[0][0].contextPacketJson as string)).toEqual(
      expect.objectContaining({
        delegatedGoal: expect.stringContaining('Verify whether the completed delegated result'),
        reviewTarget: {
          delegationId: 'delegation-1',
          childSessionId: 'session-child',
          agentProfileId: 'planner',
        },
        taskContract: expect.objectContaining({
          specialistId: 'verifier',
          specialistName: 'Verifier',
        }),
      }),
    );
    expect(loadAgentSession).toHaveBeenNthCalledWith(1, 'session-1');
    expect(loadAgentSession).toHaveBeenNthCalledWith(2, 'session-verifier');
    expect(loadSessions).toHaveBeenCalledWith('project-1');
    expect(switchSession).toHaveBeenCalledWith('session-verifier');
    expect(addSystemMessageToSession).toHaveBeenCalledTimes(2);
    expect(loadDelegations).toHaveBeenCalledWith('session-verifier');
  });

  it('does not inject verifier bootstrap messages if session switch does not land on the verifier child', async () => {
    const user = userEvent.setup();
    const createDelegatedSession = vi.fn().mockResolvedValue({
      childSession: {
        id: 'session-verifier',
        projectId: 'project-1',
      },
      delegationRecord: {
        id: 'delegation-verifier',
      },
      delegationErrorMessage: null,
    });
    const loadDelegations = vi.fn().mockResolvedValue([]);
    const loadSessions = vi.fn().mockResolvedValue(undefined);
    const switchSession = vi.fn().mockResolvedValue(undefined);
    const addSystemMessageToSession = vi.fn();
    const loadAgentSession = vi
      .fn()
      .mockResolvedValueOnce({ session: { sequenceId: 'seq-1' } })
      .mockResolvedValueOnce({ session: { sequenceId: 'seq-1' } });

    act(() => {
      useConversationStore.setState((state) => ({
        ...state,
        activeSessionId: 'session-1',
        activeProjectId: 'project-1',
        sessions: [
          {
            id: 'session-1',
            projectId: 'project-1',
            title: 'Editor Session',
            agent: 'editor',
            modelProvider: null,
            modelId: null,
            createdAt: 1,
            updatedAt: 1,
            archived: false,
            messageCount: 1,
            lastMessagePreview: 'review',
          },
          {
            id: 'session-child',
            projectId: 'project-1',
            title: 'Planner Session',
            agent: 'planner',
            modelProvider: null,
            modelId: null,
            createdAt: 2,
            updatedAt: 2,
            archived: false,
            messageCount: 1,
            lastMessagePreview: 'Suggested a shorter intro section.',
          },
        ],
        loadSessions,
        switchSession,
        addSystemMessageToSession,
      }));
      useAgentSessionStore.setState((state) => ({
        ...state,
        loadSession: loadAgentSession,
      }));
      useAgentDelegationStore.setState((state) => ({
        ...state,
        recordsBySessionId: {
          'session-1': [
            {
              id: 'delegation-1',
              parentSessionId: 'session-1',
              childSessionId: 'session-child',
              parentRunId: 'run-parent',
              agentProfileId: 'planner',
              delegatedGoal: 'Review pacing',
              contextPacketJson: JSON.stringify({
                source: 'agent-workspace',
                parentSessionId: 'session-1',
                parentAgentId: 'editor',
                parentAgentName: 'Editor Session',
                delegatedGoal: 'Review pacing',
                createdAt: 2,
                taskContract: {
                  objective: 'Review pacing',
                  specialistId: 'planner',
                  specialistName: 'Planner',
                  verificationSpec: {
                    handoffSchemaVersion: 1,
                    requireStructuredHandoff: true,
                    requireSummary: true,
                    requireEvidence: true,
                    requireOpenIssuesStatement: true,
                    minimumEvidenceCount: 1,
                  },
                  expectedDeliverables: [
                    'Break down the goal into an execution-ready plan: Review pacing',
                  ],
                  acceptanceChecklist: [
                    'Provide a parent-reviewable summary before declaring the task done.',
                  ],
                  handoffRequirement:
                    'Parent verification is required before this delegated result can be merged.',
                },
              }),
              allowedToolsDeltaJson: null,
              permissionSnapshotJson: null,
              status: 'completed',
              mergeStatus: 'pending',
              summaryMessageId: 'child-msg-1',
              resultJson: JSON.stringify({
                success: true,
                aborted: false,
                totalDuration: 800,
                iterations: 1,
                finalState: 'Suggested a shorter intro section.',
                executedSteps: 1,
                successfulSteps: 1,
                failedSteps: 0,
                preview: 'Suggested a shorter intro section.',
                recentTools: ['query_timeline'],
                recentFiles: ['src/foo.ts'],
                handoff: {
                  parseStatus: 'parsed',
                  summary: 'Suggested a shorter intro section.',
                  summaryProvided: true,
                  openIssues: [],
                  openIssuesDeclared: true,
                  evidence: [{ kind: 'tool', value: 'query_timeline' }],
                },
                autoVerification: {
                  status: 'pass',
                  summary:
                    'Automatic verification passed the delegated handoff against the stored task contract.',
                  missingRequirements: [],
                  warnings: [],
                  checkedAt: 2,
                },
                verification: {
                  verdict: 'unverified',
                  summary: 'Completed child work remains pending until parent verification.',
                  verifiedAt: null,
                  evidence: [{ kind: 'summary', value: 'Suggested a shorter intro section.' }],
                },
              }),
              errorMessage: null,
              createdAt: 2,
              updatedAt: 2,
              completedAt: 2,
            },
          ],
        },
        createDelegatedSession,
        loadDelegations,
      }));
      useAgentArtifactReviewStore.setState((state) => ({
        ...state,
        selection: {
          focus: null,
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
                parts: [{ type: 'text', content: 'Suggested a shorter intro section.' }],
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

    await user.click(screen.getByTestId('delegation-review-launch-verifier-btn'));

    expect(addSystemMessageToSession).toHaveBeenCalledTimes(2);
    expect(addSystemMessageToSession).toHaveBeenNthCalledWith(
      1,
      'session-verifier',
      expect.stringContaining('DELEGATION_HANDOFF'),
    );
    expect(loadDelegations).toHaveBeenCalledWith('session-verifier');
    expect(
      screen.getByText(
        'Verifier session was created, but the workspace could not switch into it automatically.',
      ),
    ).toBeInTheDocument();
  });

  it('applies a verifier recommendation back to the reviewed delegation handoff', async () => {
    const user = userEvent.setup();
    const updateDelegationRecord = vi.fn().mockResolvedValue({});

    act(() => {
      useAgentDelegationStore.setState((state) => ({
        ...state,
        recordsBySessionId: {
          'session-1': [
            {
              id: 'delegation-verifier-review',
              parentSessionId: 'session-1',
              childSessionId: 'session-verifier',
              parentRunId: 'run-parent',
              agentProfileId: 'verifier',
              delegatedGoal: 'Verify merge readiness',
              contextPacketJson: JSON.stringify({
                source: 'agent-workspace',
                parentSessionId: 'session-1',
                parentAgentId: 'editor',
                parentAgentName: 'Editor Session',
                delegatedGoal: 'Verify merge readiness',
                createdAt: 4,
                reviewTarget: {
                  delegationId: 'delegation-1',
                  childSessionId: 'session-child',
                  agentProfileId: 'planner',
                },
                taskContract: {
                  objective: 'Verify merge readiness',
                  specialistId: 'verifier',
                  specialistName: 'Verifier',
                  verificationSpec: {
                    handoffSchemaVersion: 1,
                    requireStructuredHandoff: true,
                    requireSummary: true,
                    requireEvidence: true,
                    requireOpenIssuesStatement: true,
                    minimumEvidenceCount: 1,
                    requiredRecommendationOptions: ['merge', 'follow_up', 'discard'],
                  },
                  expectedDeliverables: [
                    'Return exactly one recommendation: merge, follow_up, or discard.',
                  ],
                  acceptanceChecklist: [
                    'Conclude with one recommendation: merge, follow_up, or discard.',
                  ],
                  handoffRequirement:
                    'Parent verification is required before this delegated result can be merged.',
                },
              }),
              allowedToolsDeltaJson: null,
              permissionSnapshotJson: null,
              status: 'completed',
              mergeStatus: 'pending',
              summaryMessageId: 'verifier-msg-1',
              resultJson: JSON.stringify({
                success: true,
                aborted: false,
                totalDuration: 600,
                iterations: 1,
                finalState: 'Recommend follow-up.',
                executedSteps: 1,
                successfulSteps: 1,
                failedSteps: 0,
                preview: 'Recommend follow-up.',
                recentTools: [],
                recentFiles: ['.openreelio/reviews/delegation-1-verifier.md'],
                handoff: {
                  parseStatus: 'parsed',
                  recommendation: 'follow_up',
                  summary: 'The reviewed delegation still needs a structured handoff.',
                  summaryProvided: true,
                  openIssues: ['Return the final handoff in the required JSON schema.'],
                  openIssuesDeclared: true,
                  evidence: [
                    { kind: 'file', value: '.openreelio/reviews/delegation-1-verifier.md' },
                  ],
                },
                autoVerification: {
                  status: 'pass',
                  summary:
                    'Automatic verification passed the delegated handoff against the stored task contract.',
                  missingRequirements: [],
                  warnings: [],
                  checkedAt: 4,
                },
                verification: {
                  verdict: 'unverified',
                  summary: 'Completed child work remains pending until parent verification.',
                  verifiedAt: null,
                  evidence: [{ kind: 'summary', value: 'Recommend follow-up.' }],
                },
              }),
              errorMessage: null,
              createdAt: 4,
              updatedAt: 4,
              completedAt: 4,
            },
            {
              id: 'delegation-1',
              parentSessionId: 'session-1',
              childSessionId: 'session-child',
              parentRunId: 'run-parent',
              agentProfileId: 'planner',
              delegatedGoal: 'Review pacing',
              contextPacketJson: JSON.stringify({
                source: 'agent-workspace',
                parentSessionId: 'session-1',
                parentAgentId: 'editor',
                parentAgentName: 'Editor Session',
                delegatedGoal: 'Review pacing',
                createdAt: 2,
                taskContract: {
                  objective: 'Review pacing',
                  specialistId: 'planner',
                  specialistName: 'Planner',
                  verificationSpec: {
                    handoffSchemaVersion: 1,
                    requireStructuredHandoff: true,
                    requireSummary: true,
                    requireEvidence: true,
                    requireOpenIssuesStatement: true,
                    minimumEvidenceCount: 1,
                    requiredRecommendationOptions: [],
                  },
                  expectedDeliverables: [
                    'Break down the goal into an execution-ready plan: Review pacing',
                  ],
                  acceptanceChecklist: [
                    'Provide a parent-reviewable summary before declaring the task done.',
                  ],
                  handoffRequirement:
                    'Parent verification is required before this delegated result can be merged.',
                },
              }),
              allowedToolsDeltaJson: null,
              permissionSnapshotJson: null,
              status: 'completed',
              mergeStatus: 'pending',
              summaryMessageId: 'child-msg-1',
              resultJson: JSON.stringify({
                success: true,
                aborted: false,
                totalDuration: 800,
                iterations: 1,
                finalState: 'Suggested a shorter intro section.',
                executedSteps: 1,
                successfulSteps: 1,
                failedSteps: 0,
                preview: 'Suggested a shorter intro section.',
                recentTools: ['query_timeline'],
                recentFiles: ['src/foo.ts'],
                handoff: {
                  parseStatus: 'parsed',
                  summary: 'Suggested a shorter intro section.',
                  openIssues: [],
                  openIssuesDeclared: true,
                  evidence: [{ kind: 'tool', value: 'query_timeline' }],
                },
                autoVerification: {
                  status: 'pass',
                  summary:
                    'Automatic verification passed the delegated handoff against the stored task contract.',
                  missingRequirements: [],
                  warnings: [],
                  checkedAt: 2,
                },
                verification: {
                  verdict: 'unverified',
                  summary: 'Completed child work remains pending until parent verification.',
                  verifiedAt: null,
                  evidence: [{ kind: 'summary', value: 'Suggested a shorter intro section.' }],
                },
              }),
              errorMessage: null,
              createdAt: 2,
              updatedAt: 2,
              completedAt: 2,
            },
          ],
        },
        updateDelegationRecord,
      }));
      useConversationStore.setState((state) => ({
        ...state,
        sessions: [
          {
            id: 'session-1',
            projectId: 'project-1',
            title: 'Editor Session',
            agent: 'editor',
            modelProvider: null,
            modelId: null,
            createdAt: 1,
            updatedAt: 1,
            archived: false,
            messageCount: 1,
            lastMessagePreview: 'review',
          },
          {
            id: 'session-child',
            projectId: 'project-1',
            title: 'Planner Session',
            agent: 'planner',
            modelProvider: null,
            modelId: null,
            createdAt: 2,
            updatedAt: 2,
            archived: false,
            messageCount: 1,
            lastMessagePreview: 'Suggested a shorter intro section.',
          },
          {
            id: 'session-verifier',
            projectId: 'project-1',
            title: 'Verifier Session',
            agent: 'verifier',
            modelProvider: null,
            modelId: null,
            createdAt: 4,
            updatedAt: 4,
            archived: false,
            messageCount: 1,
            lastMessagePreview: 'Recommend follow-up.',
          },
        ],
      }));
      useAgentArtifactReviewStore.setState((state) => ({
        ...state,
        selection: {
          focus: null,
          projectId: 'project-1',
          conversationId: 'session-verifier',
          sourceLabel: 'Verifier Session',
          sourceAgentProfileId: 'verifier',
        },
        sourcesByConversationId: {
          'session-verifier': {
            conversationId: 'session-verifier',
            projectId: 'project-1',
            title: 'Verifier Session',
            agentProfileId: 'verifier',
            messages: [
              {
                id: 'verifier-msg-1',
                role: 'assistant',
                parts: [{ type: 'text', content: 'Recommend follow-up.' }],
                timestamp: 4,
              },
            ],
            createdAt: 4,
            updatedAt: 4,
          },
        },
      }));
    });

    render(<AgentArtifactReviewPanel />);

    expect(screen.getByText('Verifier recommendation')).toBeInTheDocument();
    expect(screen.getByText('Follow-up')).toBeInTheDocument();
    expect(screen.queryByTestId('delegation-review-verify-btn')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('delegation-review-apply-verifier-recommendation-btn'));

    expect(updateDelegationRecord).toHaveBeenCalledTimes(2);
    expect(updateDelegationRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'delegation-1',
        mergeStatus: 'pending',
      }),
    );
    expect(JSON.parse(updateDelegationRecord.mock.calls[0][0].resultJson as string)).toEqual(
      expect.objectContaining({
        verification: expect.objectContaining({
          verdict: 'partial',
          summary: expect.stringContaining('Verifier recommended follow-up.'),
        }),
      }),
    );
  });

  it('hides verifier launch for verifier-owned delegation reviews', () => {
    act(() => {
      useAgentDelegationStore.setState((state) => ({
        ...state,
        recordsBySessionId: {
          'session-1': [
            {
              id: 'delegation-verifier-review',
              parentSessionId: 'session-1',
              childSessionId: 'session-verifier',
              parentRunId: 'run-parent',
              agentProfileId: 'verifier',
              delegatedGoal: 'Verify merge readiness',
              contextPacketJson: JSON.stringify({
                source: 'agent-workspace',
                parentSessionId: 'session-1',
                parentAgentId: 'editor',
                parentAgentName: 'Editor Session',
                delegatedGoal: 'Verify merge readiness',
                createdAt: 2,
                taskContract: {
                  objective: 'Verify merge readiness',
                  specialistId: 'verifier',
                  specialistName: 'Verifier',
                  verificationSpec: {
                    handoffSchemaVersion: 1,
                    requireStructuredHandoff: true,
                    requireSummary: true,
                    requireEvidence: true,
                    requireOpenIssuesStatement: true,
                    minimumEvidenceCount: 1,
                  },
                  expectedDeliverables: [
                    'Return exactly one recommendation: merge, follow_up, or discard.',
                  ],
                  acceptanceChecklist: [
                    'Conclude with one recommendation: merge, follow_up, or discard.',
                  ],
                  handoffRequirement:
                    'Parent verification is required before this delegated result can be merged.',
                },
              }),
              allowedToolsDeltaJson: null,
              permissionSnapshotJson: null,
              status: 'completed',
              mergeStatus: 'pending',
              summaryMessageId: 'verifier-msg-1',
              resultJson: JSON.stringify({
                success: true,
                aborted: false,
                totalDuration: 800,
                iterations: 1,
                finalState: 'Recommend merge.',
                executedSteps: 1,
                successfulSteps: 1,
                failedSteps: 0,
                preview: 'Recommend merge.',
                recentTools: [],
                recentFiles: [],
                handoff: {
                  parseStatus: 'parsed',
                  summary: 'Recommend merge.',
                  summaryProvided: true,
                  openIssues: [],
                  openIssuesDeclared: true,
                  evidence: [{ kind: 'summary', value: 'Recommend merge.' }],
                },
                autoVerification: {
                  status: 'pass',
                  summary:
                    'Automatic verification passed the delegated handoff against the stored task contract.',
                  missingRequirements: [],
                  warnings: [],
                  checkedAt: 2,
                },
                verification: {
                  verdict: 'unverified',
                  summary: 'Completed child work remains pending until parent verification.',
                  verifiedAt: null,
                  evidence: [{ kind: 'summary', value: 'Recommend merge.' }],
                },
              }),
              errorMessage: null,
              createdAt: 2,
              updatedAt: 2,
              completedAt: 2,
            },
          ],
        },
      }));
      useAgentArtifactReviewStore.setState((state) => ({
        ...state,
        selection: {
          focus: null,
          projectId: 'project-1',
          conversationId: 'session-verifier',
          sourceLabel: 'Verifier Session',
          sourceAgentProfileId: 'verifier',
        },
        sourcesByConversationId: {
          'session-verifier': {
            conversationId: 'session-verifier',
            projectId: 'project-1',
            title: 'Verifier Session',
            agentProfileId: 'verifier',
            messages: [
              {
                id: 'verifier-msg-1',
                role: 'assistant',
                parts: [{ type: 'text', content: 'Recommend merge.' }],
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

    expect(screen.queryByTestId('delegation-review-launch-verifier-btn')).not.toBeInTheDocument();
  });
});
