/**
 * PlanPartRenderer Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanPartRenderer } from './PlanPartRenderer';
import type { PlanPart } from '@/agents/engine/core/conversation';

const mockPlanPart: PlanPart = {
  type: 'plan',
  plan: {
    goal: 'Split the clip at 5 seconds',
    steps: [
      {
        id: 'step-1',
        tool: 'split_clip',
        args: { position: 5 },
        description: 'Split the selected clip',
        riskLevel: 'low',
        estimatedDuration: 100,
      },
      {
        id: 'step-2',
        tool: 'select_clip',
        args: { clipId: 'clip-1' },
        description: 'Select the new clip',
        riskLevel: 'medium',
        estimatedDuration: 50,
      },
    ],
    estimatedTotalDuration: 150,
    requiresApproval: true,
    rollbackStrategy: 'Undo the split',
  },
  status: 'proposed',
};

describe('PlanPartRenderer', () => {
  it('should render the plan with goal', () => {
    render(<PlanPartRenderer part={mockPlanPart} />);

    expect(screen.getByTestId('plan-part')).toBeInTheDocument();
    expect(screen.getByText('Split the clip at 5 seconds')).toBeInTheDocument();
  });

  it('should show step count', () => {
    render(<PlanPartRenderer part={mockPlanPart} />);

    expect(screen.getByText('2 steps')).toBeInTheDocument();
  });

  it('should show status label', () => {
    render(<PlanPartRenderer part={mockPlanPart} />);

    expect(screen.getByText('Proposed')).toBeInTheDocument();
  });

  it('should show approve/reject buttons when proposed', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(<PlanPartRenderer part={mockPlanPart} onApprove={onApprove} onReject={onReject} />);

    expect(screen.getByTestId('plan-approve-btn')).toBeInTheDocument();
    expect(screen.getByTestId('plan-reject-btn')).toBeInTheDocument();
  });

  it('should call onApprove when approve button clicked', async () => {
    const onApprove = vi.fn();
    const user = userEvent.setup();
    render(<PlanPartRenderer part={mockPlanPart} onApprove={onApprove} />);

    await user.click(screen.getByTestId('plan-approve-btn'));

    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('should call onReject when reject button clicked', async () => {
    const onReject = vi.fn();
    const user = userEvent.setup();
    render(<PlanPartRenderer part={mockPlanPart} onReject={onReject} />);

    await user.click(screen.getByTestId('plan-reject-btn'));

    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('should not show buttons when status is approved', () => {
    const approvedPart: PlanPart = { ...mockPlanPart, status: 'approved' };
    render(<PlanPartRenderer part={approvedPart} onApprove={vi.fn()} onReject={vi.fn()} />);

    expect(screen.queryByTestId('plan-approve-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('plan-reject-btn')).not.toBeInTheDocument();
  });

  it('should display step descriptions', () => {
    render(<PlanPartRenderer part={mockPlanPart} />);

    expect(screen.getByText('Split the selected clip')).toBeInTheDocument();
    expect(screen.getByText('Select the new clip')).toBeInTheDocument();
  });
});
