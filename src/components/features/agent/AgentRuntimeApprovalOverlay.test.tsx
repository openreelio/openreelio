import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentRuntimeApprovalOverlay } from './AgentRuntimeApprovalOverlay';

const noop = vi.fn();

describe('AgentRuntimeApprovalOverlay', () => {
  it('renders a blocking approval popup for tool permission requests', async () => {
    const onAllow = vi.fn();
    render(
      <AgentRuntimeApprovalOverlay
        pendingPlan={null}
        pendingToolPermissionRequest={{
          id: 'codex:openreelio-plan:1',
          tool: 'OpenReelio plan apply',
          args: { planId: 'shorts-cleanup-v1' },
          description: 'Apply the shorts cleanup edit.',
          riskLevel: 'medium',
        }}
        onApprove={noop}
        onReject={noop}
        onToolAllow={onAllow}
        onToolAllowAlways={noop}
        onToolDeny={noop}
      />,
    );

    const overlay = screen.getByTestId('agent-runtime-approval-overlay');
    expect(overlay).toBeInTheDocument();
    expect(overlay).toHaveClass('bottom-2');
    expect(overlay).not.toHaveClass('inset-0');
    expect(screen.getByRole('dialog', { name: 'Agent approval request' })).toBeInTheDocument();
    expect(screen.getByTestId('tool-approval-part')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('tool-approval-allow-btn'));

    expect(onAllow).toHaveBeenCalledTimes(1);
  });
});
