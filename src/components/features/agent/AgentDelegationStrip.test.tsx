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
          statusLabel: 'Running',
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
          },
          onReview,
          onReturnToParent,
        }}
      />,
    );

    expect(screen.getByText('Delegated Session')).toBeInTheDocument();
    expect(screen.getByText('From Editor Session')).toBeInTheDocument();
    expect(screen.getByText('Latest result: Suggested a faster cold open.')).toBeInTheDocument();
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
    expect(screen.getByText('800ms')).toBeInTheDocument();

    await user.click(screen.getByTestId('agent-delegated-child-review-delegation-1'));

    expect(onReview).toHaveBeenCalledTimes(1);
  });
});
