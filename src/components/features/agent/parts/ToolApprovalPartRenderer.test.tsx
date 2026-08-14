import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToolApprovalPartRenderer } from './ToolApprovalPartRenderer';
import type { ToolApprovalPart } from '@/agents/engine/core/conversation';

const pendingPart: ToolApprovalPart = {
  type: 'tool_approval',
  stepId: 'approval-1',
  tool: 'OpenReelio edit',
  args: { commandType: 'CreateTrack', sequenceId: 'seq_1' },
  description: 'Add a B-roll track through the OpenReelio command log.',
  riskLevel: 'medium',
  status: 'pending',
};

describe('ToolApprovalPartRenderer', () => {
  it('renders approval details collapsed by default', async () => {
    const user = userEvent.setup();
    render(<ToolApprovalPartRenderer part={pendingPart} />);

    expect(screen.getByTestId('tool-approval-part')).toBeInTheDocument();
    expect(screen.getByText('OpenReelio edit')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-approval-details')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('tool-approval-details-toggle'));

    expect(screen.getByTestId('tool-approval-details')).toHaveTextContent('commandType');
  });

  it('keeps approval actions accessible', async () => {
    const user = userEvent.setup();
    const onAllow = vi.fn();
    const onAllowAlways = vi.fn();
    const onDeny = vi.fn();

    render(
      <ToolApprovalPartRenderer
        part={pendingPart}
        onAllow={onAllow}
        onAllowAlways={onAllowAlways}
        onDeny={onDeny}
      />,
    );

    await user.click(screen.getByTestId('tool-approval-allow-btn'));
    await user.click(screen.getByTestId('tool-approval-allow-always-btn'));
    await user.click(screen.getByTestId('tool-approval-deny-btn'));

    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(onAllowAlways).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it('renders resolved approvals as compact status rows without action buttons', () => {
    render(<ToolApprovalPartRenderer part={{ ...pendingPart, status: 'approved' }} />);

    expect(screen.getByText('Allowed')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-approval-allow-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tool-approval-deny-btn')).not.toBeInTheDocument();
  });

  it('names the steps a batch approval would run', () => {
    render(
      <ToolApprovalPartRenderer
        part={{
          ...pendingPart,
          tool: 'execute_plan',
          args: {
            steps: [
              { id: 's1', toolName: 'delete_clip', params: {} },
              { id: 's2', toolName: 'delete_clip', params: {} },
              { id: 's3', toolName: 'add_marker', params: {} },
            ],
          },
        }}
      />,
    );

    expect(screen.getByTestId('tool-approval-batch-steps')).toHaveTextContent(
      'delete_clip x2, add_marker',
    );
  });

  it('shows no batch summary for an ordinary tool call', () => {
    render(<ToolApprovalPartRenderer part={pendingPart} />);

    expect(screen.queryByTestId('tool-approval-batch-steps')).not.toBeInTheDocument();
  });
});
