import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentDelegationStrip } from './AgentDelegationStrip';

describe('AgentDelegationStrip', () => {
  it('renders delegated-from context and return action', async () => {
    const user = userEvent.setup();
    const onReturnToParent = vi.fn();
    const onReview = vi.fn();

    render(
      <AgentDelegationStrip
        delegatedFrom={{
          parentLabel: 'Editor Session',
          delegatedGoal: 'Review the pacing and propose cuts.',
          delegationStatus: 'completed',
          mergeStatus: 'pending',
          statusLabel: 'Completed',
          resultPreview: 'Suggested a faster cold open.',
          result: {
            success: true,
            aborted: false,
            totalDuration: 1200,
            iterations: 2,
            finalState: 'Suggested a faster cold open.',
            executedSteps: 3,
            successfulSteps: 3,
            failedSteps: 0,
            preview: 'Suggested a faster cold open.',
            recentTools: ['query_timeline'],
            recentFiles: ['src/foo.ts'],
            handoff: {
              parseStatus: 'missing',
              recommendation: null,
              summary: 'Suggested a faster cold open.',
              summaryProvided: false,
              openIssues: [],
              openIssuesDeclared: false,
              evidence: [
                { kind: 'summary', value: 'Suggested a faster cold open.' },
                { kind: 'tool', value: 'query_timeline' },
              ],
            },
            autoVerification: {
              status: 'needs_follow_up',
              summary:
                'Automatic verification needs follow-up because the delegated handoff was not returned in the required structured format.',
              missingRequirements: [
                'Return a final DELEGATION_HANDOFF JSON block.',
                'Declare open issues explicitly, even when none remain.',
              ],
              warnings: [],
              checkedAt: 1,
            },
            verification: {
              verdict: 'unverified',
              summary: 'Completed child work remains pending until parent verification.',
              verifiedAt: null,
              evidence: [
                { kind: 'summary', value: 'Suggested a faster cold open.' },
                { kind: 'tool', value: 'query_timeline' },
              ],
            },
          },
          onReview,
          onReturnToParent,
        }}
      />,
    );

    expect(screen.getByText('Delegated Session')).toBeInTheDocument();
    expect(screen.getByText('From Editor Session')).toBeInTheDocument();
    expect(screen.getByText('Latest result: Suggested a faster cold open.')).toBeInTheDocument();
    expect(screen.getByText('Needs verification')).toBeInTheDocument();
    expect(screen.getByText('1.2s')).toBeInTheDocument();
    expect(screen.getByText('2 iter')).toBeInTheDocument();
    expect(screen.getByText('3 steps')).toBeInTheDocument();
    expect(screen.getByText('query_timeline')).toBeInTheDocument();
    expect(screen.getByText('src/foo.ts')).toBeInTheDocument();

    await user.click(screen.getByTestId('agent-delegation-review-btn'));

    expect(onReview).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('agent-delegation-return-btn'));

    expect(onReturnToParent).toHaveBeenCalledTimes(1);
  });

  it('renders delegated child shortcuts for the parent session', async () => {
    const user = userEvent.setup();
    const onReview = vi.fn();
    render(
      <AgentDelegationStrip
        delegatedChildren={[
          {
            id: 'delegation-1',
            label: 'Planner: Review pacing',
            delegatedGoal: 'Review pacing',
            delegationStatus: 'completed',
            mergeStatus: 'merged',
            statusLabel: 'Completed',
            resultPreview: 'Suggested a shorter intro section.',
            result: {
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
              recentFiles: [],
              handoff: {
                parseStatus: 'parsed',
                recommendation: null,
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
                checkedAt: 10,
              },
              verification: {
                verdict: 'pass',
                summary: 'Verified by parent review and ready to merge.',
                verifiedAt: 10,
                evidence: [{ kind: 'tool', value: 'query_timeline' }],
              },
            },
            onOpen: () => {},
            onReview,
          },
        ]}
      />,
    );

    expect(screen.getByText('Delegated Specialists')).toBeInTheDocument();
    expect(screen.getByTestId('agent-delegated-child-delegation-1')).toHaveTextContent(
      'Suggested a shorter intro section.',
    );
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('800ms')).toBeInTheDocument();

    await user.click(screen.getByTestId('agent-delegated-child-review-delegation-1'));

    expect(onReview).toHaveBeenCalledTimes(1);
  });
});
