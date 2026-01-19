/**
 * ProposalDialog Component Tests
 *
 * TDD tests for the AI proposal approval/rejection dialog.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProposalDialog, type ProposalDialogProps } from './ProposalDialog';
import type { EditScript } from '@/hooks/useAIAgent';

// Mock the logger
vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockProposal(overrides: Partial<EditScript> = {}): EditScript {
  return {
    intent: 'Cut the first 5 seconds',
    commands: [
      {
        commandType: 'SplitClip',
        params: { clipId: 'clip_001', atTimelineSec: 5 },
        description: 'Split clip at 5 seconds',
      },
    ],
    requires: [],
    qcRules: [],
    risk: {
      copyright: 'none',
      nsfw: 'none',
    },
    explanation: 'This will split the clip at the 5 second mark. You can then delete the first segment if needed.',
    ...overrides,
  };
}

function createDefaultProps(): ProposalDialogProps {
  return {
    proposal: createMockProposal(),
    isApplying: false,
    onApprove: vi.fn().mockResolvedValue({ success: true, appliedOpIds: ['op_001'], errors: [] }),
    onReject: vi.fn(),
  };
}

function renderProposalDialog(props: Partial<ProposalDialogProps> = {}) {
  const defaultProps = createDefaultProps();
  return render(<ProposalDialog {...defaultProps} {...props} />);
}

// =============================================================================
// Tests
// =============================================================================

describe('ProposalDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('renders when proposal is provided', () => {
      renderProposalDialog();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('AI Edit Proposal')).toBeInTheDocument();
    });

    it('does not render when proposal is null', () => {
      renderProposalDialog({ proposal: null });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('displays the user intent', () => {
      renderProposalDialog();
      expect(screen.getByText('"Cut the first 5 seconds"')).toBeInTheDocument();
    });

    it('displays the AI explanation', () => {
      renderProposalDialog();
      expect(
        screen.getByText(/This will split the clip at the 5 second mark/)
      ).toBeInTheDocument();
    });

    it('displays all commands', () => {
      const proposal = createMockProposal({
        commands: [
          { commandType: 'SplitClip', params: {}, description: 'Split at playhead' },
          { commandType: 'DeleteClip', params: {}, description: 'Remove first part' },
        ],
      });
      renderProposalDialog({ proposal });

      expect(screen.getByText('SplitClip')).toBeInTheDocument();
      expect(screen.getByText('DeleteClip')).toBeInTheDocument();
      expect(screen.getByText('Split at playhead')).toBeInTheDocument();
      expect(screen.getByText('Remove first part')).toBeInTheDocument();
    });

    it('displays command count', () => {
      const proposal = createMockProposal({
        commands: [
          { commandType: 'SplitClip', params: {} },
          { commandType: 'DeleteClip', params: {} },
        ],
      });
      renderProposalDialog({ proposal });

      expect(screen.getByText(/Commands to Execute \(2\)/)).toBeInTheDocument();
    });

    it('displays risk assessment badges', () => {
      const proposal = createMockProposal({
        risk: { copyright: 'low', nsfw: 'none' },
      });
      renderProposalDialog({ proposal });

      expect(screen.getByText(/Copyright: low/i)).toBeInTheDocument();
      expect(screen.getByText(/NSFW: none/i)).toBeInTheDocument();
    });

    it('shows warning for high copyright risk', () => {
      const proposal = createMockProposal({
        risk: { copyright: 'high', nsfw: 'none' },
      });
      renderProposalDialog({ proposal });

      expect(
        screen.getByText(/This proposal contains high-risk operations/)
      ).toBeInTheDocument();
    });

    it('shows warning for high nsfw risk', () => {
      const proposal = createMockProposal({
        risk: { copyright: 'none', nsfw: 'likely' },
      });
      renderProposalDialog({ proposal });

      expect(
        screen.getByText(/This proposal contains high-risk operations/)
      ).toBeInTheDocument();
    });
  });

  describe('Command Icons', () => {
    it('displays correct icon for InsertClip', () => {
      const proposal = createMockProposal({
        commands: [{ commandType: 'InsertClip', params: {} }],
      });
      renderProposalDialog({ proposal });
      expect(screen.getByText('➕')).toBeInTheDocument();
    });

    it('displays correct icon for SplitClip', () => {
      const proposal = createMockProposal({
        commands: [{ commandType: 'SplitClip', params: {} }],
      });
      renderProposalDialog({ proposal });
      expect(screen.getByText('✂️')).toBeInTheDocument();
    });

    it('displays correct icon for DeleteClip', () => {
      const proposal = createMockProposal({
        commands: [{ commandType: 'DeleteClip', params: {} }],
      });
      renderProposalDialog({ proposal });
      expect(screen.getByText('🗑️')).toBeInTheDocument();
    });

    it('displays correct icon for TrimClip', () => {
      const proposal = createMockProposal({
        commands: [{ commandType: 'TrimClip', params: {} }],
      });
      renderProposalDialog({ proposal });
      expect(screen.getByText('📐')).toBeInTheDocument();
    });

    it('displays correct icon for MoveClip', () => {
      const proposal = createMockProposal({
        commands: [{ commandType: 'MoveClip', params: {} }],
      });
      renderProposalDialog({ proposal });
      expect(screen.getByText('↔️')).toBeInTheDocument();
    });
  });

  describe('Action Buttons', () => {
    it('renders Approve button', () => {
      renderProposalDialog();
      expect(screen.getByRole('button', { name: /Approve/i })).toBeInTheDocument();
    });

    it('renders Reject button', () => {
      renderProposalDialog();
      expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    });

    it('renders Modify button when onModify is provided', () => {
      const onModify = vi.fn();
      renderProposalDialog({ onModify });
      expect(screen.getByRole('button', { name: 'Modify' })).toBeInTheDocument();
    });

    it('does not render Modify button when onModify is not provided', () => {
      renderProposalDialog();
      expect(screen.queryByRole('button', { name: 'Modify' })).not.toBeInTheDocument();
    });
  });

  describe('Button States', () => {
    it('disables buttons when isApplying is true', () => {
      renderProposalDialog({ isApplying: true });

      expect(screen.getByRole('button', { name: /Applying/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
    });

    it('shows loading state on Approve button when applying', () => {
      renderProposalDialog({ isApplying: true });
      expect(screen.getByText('Applying...')).toBeInTheDocument();
    });

    it('disables Approve button when no commands exist', () => {
      const proposal = createMockProposal({ commands: [] });
      renderProposalDialog({ proposal });

      expect(screen.getByRole('button', { name: /Approve/i })).toBeDisabled();
    });
  });

  describe('User Interactions', () => {
    it('calls onApprove when Approve button is clicked', async () => {
      const user = userEvent.setup();
      const onApprove = vi.fn().mockResolvedValue({ success: true });
      renderProposalDialog({ onApprove });

      const approveButton = screen.getByRole('button', { name: /Approve/i });
      await user.click(approveButton);

      expect(onApprove).toHaveBeenCalled();
    });

    it('calls onReject when Reject button is clicked', async () => {
      const user = userEvent.setup();
      const onReject = vi.fn();
      renderProposalDialog({ onReject });

      const rejectButton = screen.getByRole('button', { name: 'Reject' });
      await user.click(rejectButton);

      expect(onReject).toHaveBeenCalled();
    });

    it('calls onModify when Modify button is clicked', async () => {
      const user = userEvent.setup();
      const onModify = vi.fn();
      renderProposalDialog({ onModify });

      const modifyButton = screen.getByRole('button', { name: 'Modify' });
      await user.click(modifyButton);

      expect(onModify).toHaveBeenCalled();
    });
  });

  describe('Keyboard Navigation', () => {
    it('calls onApprove when Enter is pressed', async () => {
      const onApprove = vi.fn().mockResolvedValue({ success: true });
      renderProposalDialog({ onApprove });

      const dialog = screen.getByRole('dialog');
      fireEvent.keyDown(dialog, { key: 'Enter' });

      await waitFor(() => {
        expect(onApprove).toHaveBeenCalled();
      });
    });

    it('calls onReject when Escape is pressed', () => {
      const onReject = vi.fn();
      renderProposalDialog({ onReject });

      const dialog = screen.getByRole('dialog');
      fireEvent.keyDown(dialog, { key: 'Escape' });

      expect(onReject).toHaveBeenCalled();
    });

    it('does not call onApprove on Enter when isApplying', () => {
      const onApprove = vi.fn();
      renderProposalDialog({ onApprove, isApplying: true });

      const dialog = screen.getByRole('dialog');
      fireEvent.keyDown(dialog, { key: 'Enter' });

      expect(onApprove).not.toHaveBeenCalled();
    });

    it('does not call onApprove on Enter when no commands', () => {
      const onApprove = vi.fn();
      const proposal = createMockProposal({ commands: [] });
      renderProposalDialog({ proposal, onApprove });

      const dialog = screen.getByRole('dialog');
      fireEvent.keyDown(dialog, { key: 'Enter' });

      expect(onApprove).not.toHaveBeenCalled();
    });
  });

  describe('Accessibility', () => {
    it('has correct ARIA attributes', () => {
      renderProposalDialog();
      const dialog = screen.getByRole('dialog');

      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby', 'proposal-title');
    });

    it('has title with correct id', () => {
      renderProposalDialog();
      const title = screen.getByRole('heading', { name: 'AI Edit Proposal' });
      expect(title).toHaveAttribute('id', 'proposal-title');
    });

    it('displays keyboard shortcut hints', () => {
      renderProposalDialog();
      expect(screen.getByText('Enter')).toBeInTheDocument();
      expect(screen.getByText(/to approve/i)).toBeInTheDocument();
      expect(screen.getByText('Esc')).toBeInTheDocument();
      expect(screen.getByText(/to reject/i)).toBeInTheDocument();
    });
  });

  describe('Error Handling', () => {
    it('handles error when onApprove fails', async () => {
      const onApprove = vi.fn().mockRejectedValue(new Error('Apply failed'));

      const user = userEvent.setup();
      renderProposalDialog({ onApprove });

      const approveButton = screen.getByRole('button', { name: /Approve/i });
      await user.click(approveButton);

      // The component should handle the error gracefully without crashing
      await waitFor(() => {
        expect(onApprove).toHaveBeenCalled();
      });

      // Dialog should still be rendered (not crashed)
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  describe('Risk Badge Colors', () => {
    it('shows green for no risk', () => {
      const proposal = createMockProposal({
        risk: { copyright: 'none', nsfw: 'none' },
      });
      renderProposalDialog({ proposal });

      const copyrightBadge = screen.getByText(/Copyright: none/i);
      expect(copyrightBadge).toHaveClass('bg-green-900/50');
    });

    it('shows yellow for low risk', () => {
      const proposal = createMockProposal({
        risk: { copyright: 'low', nsfw: 'none' },
      });
      renderProposalDialog({ proposal });

      const copyrightBadge = screen.getByText(/Copyright: low/i);
      expect(copyrightBadge).toHaveClass('bg-yellow-900/50');
    });

    it('shows orange for medium risk', () => {
      const proposal = createMockProposal({
        risk: { copyright: 'medium', nsfw: 'none' },
      });
      renderProposalDialog({ proposal });

      const copyrightBadge = screen.getByText(/Copyright: medium/i);
      expect(copyrightBadge).toHaveClass('bg-orange-900/50');
    });

    it('shows red for high risk', () => {
      const proposal = createMockProposal({
        risk: { copyright: 'high', nsfw: 'none' },
      });
      renderProposalDialog({ proposal });

      const copyrightBadge = screen.getByText(/Copyright: high/i);
      expect(copyrightBadge).toHaveClass('bg-red-900/50');
    });
  });
});
