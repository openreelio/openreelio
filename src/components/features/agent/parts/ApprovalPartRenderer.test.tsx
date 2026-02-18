/**
 * ApprovalPartRenderer Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApprovalPartRenderer } from './ApprovalPartRenderer';
import type { ApprovalPart } from '@/agents/engine/core/conversation';

const basePlan = {
  goal: 'Execute the editing plan',
  steps: [],
  estimatedTotalDuration: 100,
  requiresApproval: true,
  rollbackStrategy: 'Undo all',
};

describe('ApprovalPartRenderer', () => {
  it('should render pending approval', () => {
    const part: ApprovalPart = {
      type: 'approval',
      plan: basePlan,
      status: 'pending',
    };
    render(<ApprovalPartRenderer part={part} />);

    expect(screen.getByTestId('approval-part')).toBeInTheDocument();
    expect(screen.getByText('Awaiting Approval')).toBeInTheDocument();
  });

  it('should show approve/reject buttons when pending', () => {
    const part: ApprovalPart = {
      type: 'approval',
      plan: basePlan,
      status: 'pending',
    };
    render(<ApprovalPartRenderer part={part} onApprove={vi.fn()} onReject={vi.fn()} />);

    expect(screen.getByTestId('approval-approve-btn')).toBeInTheDocument();
    expect(screen.getByTestId('approval-reject-btn')).toBeInTheDocument();
  });

  it('should not show buttons when approved', () => {
    const part: ApprovalPart = {
      type: 'approval',
      plan: basePlan,
      status: 'approved',
    };
    render(<ApprovalPartRenderer part={part} onApprove={vi.fn()} onReject={vi.fn()} />);

    expect(screen.queryByTestId('approval-approve-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('approval-reject-btn')).not.toBeInTheDocument();
  });

  it('should call onApprove when approve clicked', async () => {
    const onApprove = vi.fn();
    const part: ApprovalPart = {
      type: 'approval',
      plan: basePlan,
      status: 'pending',
    };
    const user = userEvent.setup();
    render(<ApprovalPartRenderer part={part} onApprove={onApprove} />);

    await user.click(screen.getByTestId('approval-approve-btn'));

    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('should call onReject when reject clicked', async () => {
    const onReject = vi.fn();
    const part: ApprovalPart = {
      type: 'approval',
      plan: basePlan,
      status: 'pending',
    };
    const user = userEvent.setup();
    render(<ApprovalPartRenderer part={part} onReject={onReject} />);

    // First click shows the feedback textarea
    await user.click(screen.getByTestId('approval-reject-btn'));
    expect(onReject).not.toHaveBeenCalled();
    expect(screen.getByTestId('approval-feedback-input')).toBeInTheDocument();

    // Use "Reject without feedback" to complete the rejection flow
    await user.click(screen.getByTestId('approval-reject-no-feedback-btn'));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('should show reason when provided', () => {
    const part: ApprovalPart = {
      type: 'approval',
      plan: basePlan,
      status: 'rejected',
      reason: 'Too risky',
    };
    render(<ApprovalPartRenderer part={part} />);

    expect(screen.getByText(/Too risky/)).toBeInTheDocument();
  });

  it('should apply custom className', () => {
    const part: ApprovalPart = {
      type: 'approval',
      plan: basePlan,
      status: 'pending',
    };
    render(<ApprovalPartRenderer part={part} className="custom" />);

    expect(screen.getByTestId('approval-part')).toHaveClass('custom');
  });
});
