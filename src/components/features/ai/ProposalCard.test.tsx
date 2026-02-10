/**
 * ProposalCard Component Tests
 *
 * TDD tests for the inline proposal card with approve/reject actions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProposalCard } from './ProposalCard';
import type { AIProposal } from '@/stores/aiStore';

// =============================================================================
// Mocks
// =============================================================================

const mockApproveProposal = vi.fn();
const mockRejectProposal = vi.fn();

vi.mock('@/stores/aiStore', () => ({
  useAIStore: (selector: (state: unknown) => unknown) => {
    const state = {
      approveProposal: mockApproveProposal,
      rejectProposal: mockRejectProposal,
    };
    return selector(state);
  },
}));

// =============================================================================
// Test Data
// =============================================================================

const createMockProposal = (overrides: Partial<AIProposal> = {}): AIProposal => ({
  id: 'proposal_001',
  editScript: {
    intent: 'Cut the first 5 seconds',
    commands: [
      {
        commandType: 'TrimClip',
        params: { startTime: 0, endTime: 5 },
        description: 'Trim clip from 0 to 5 seconds',
      },
    ],
    requires: [],
    qcRules: [],
    risk: { copyright: 'none', nsfw: 'none' },
    explanation: 'I will trim the first 5 seconds from the selected clip.',
  },
  status: 'pending',
  createdAt: new Date().toISOString(),
  ...overrides,
});

// =============================================================================
// Tests
// =============================================================================

describe('ProposalCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApproveProposal.mockResolvedValue(undefined);
  });

  describe('Rendering', () => {
    it('renders with test id', () => {
      render(<ProposalCard proposal={createMockProposal()} />);
      expect(screen.getByTestId('proposal-card')).toBeInTheDocument();
    });

    it('displays command count', () => {
      render(<ProposalCard proposal={createMockProposal()} />);
      expect(screen.getByText('1 command')).toBeInTheDocument();
    });

    it('displays plural for multiple commands', () => {
      const proposal = createMockProposal({
        editScript: {
          ...createMockProposal().editScript,
          commands: [
            { commandType: 'TrimClip', params: {} },
            { commandType: 'DeleteClip', params: {} },
          ],
        },
      });
      render(<ProposalCard proposal={proposal} />);
      expect(screen.getByText('2 commands')).toBeInTheDocument();
    });

    it('displays explanation', () => {
      render(<ProposalCard proposal={createMockProposal()} />);
      expect(
        screen.getByText('I will trim the first 5 seconds from the selected clip.')
      ).toBeInTheDocument();
    });

    it('displays status badge', () => {
      render(<ProposalCard proposal={createMockProposal()} />);
      expect(screen.getByText('Pending')).toBeInTheDocument();
    });
  });

  describe('Expand/Collapse', () => {
    it('shows details button', () => {
      render(<ProposalCard proposal={createMockProposal()} />);
      expect(screen.getByText('Show details')).toBeInTheDocument();
    });

    it('expands to show command details', async () => {
      const user = userEvent.setup();
      render(<ProposalCard proposal={createMockProposal()} />);

      await user.click(screen.getByText('Show details'));

      expect(screen.getByText('TrimClip')).toBeInTheDocument();
      expect(screen.getByText('Trim clip from 0 to 5 seconds')).toBeInTheDocument();
      expect(screen.getByText('Show less')).toBeInTheDocument();
    });

    it('collapses when Show less clicked', async () => {
      const user = userEvent.setup();
      render(<ProposalCard proposal={createMockProposal()} />);

      await user.click(screen.getByText('Show details'));
      expect(screen.getByText('TrimClip')).toBeInTheDocument();

      await user.click(screen.getByText('Show less'));
      expect(screen.queryByText('TrimClip')).not.toBeInTheDocument();
    });
  });

  describe('Actions - Pending', () => {
    it('shows approve and reject buttons when pending', () => {
      render(<ProposalCard proposal={createMockProposal()} />);
      expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    });

    it('calls approveProposal when approve clicked', async () => {
      const user = userEvent.setup();
      render(<ProposalCard proposal={createMockProposal()} />);

      await user.click(screen.getByRole('button', { name: 'Approve' }));

      await waitFor(() => {
        expect(mockApproveProposal).toHaveBeenCalledWith('proposal_001');
      });
    });

    it('calls rejectProposal when reject clicked', async () => {
      const user = userEvent.setup();
      render(<ProposalCard proposal={createMockProposal()} />);

      await user.click(screen.getByRole('button', { name: 'Reject' }));

      expect(mockRejectProposal).toHaveBeenCalledWith('proposal_001');
    });

    it('shows error message when approve fails', async () => {
      mockApproveProposal.mockRejectedValue(new Error('IPC command failed'));

      const user = userEvent.setup();
      render(<ProposalCard proposal={createMockProposal()} />);

      await user.click(screen.getByRole('button', { name: 'Approve' }));

      await waitFor(() => {
        expect(screen.getByText('IPC command failed')).toBeInTheDocument();
      });
      // Button should revert from "Applying..." back to "Approve"
      expect(screen.getByRole('button', { name: 'Approve' })).not.toBeDisabled();
    });

    it('clears error on retry after failure', async () => {
      mockApproveProposal.mockRejectedValueOnce(new Error('First attempt failed'));
      mockApproveProposal.mockResolvedValueOnce(undefined);

      const user = userEvent.setup();
      render(<ProposalCard proposal={createMockProposal()} />);

      // First click — fails
      await user.click(screen.getByRole('button', { name: 'Approve' }));
      await waitFor(() => {
        expect(screen.getByText('First attempt failed')).toBeInTheDocument();
      });

      // Second click — succeeds, error should clear
      await user.click(screen.getByRole('button', { name: 'Approve' }));
      await waitFor(() => {
        expect(screen.queryByText('First attempt failed')).not.toBeInTheDocument();
      });
    });

    it('shows loading state while applying', async () => {
      mockApproveProposal.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      const user = userEvent.setup();
      render(<ProposalCard proposal={createMockProposal()} />);

      await user.click(screen.getByRole('button', { name: 'Approve' }));

      expect(screen.getByText('Applying...')).toBeInTheDocument();
    });
  });

  describe('Status Variations', () => {
    it('hides action buttons when applied', () => {
      const proposal = createMockProposal({ status: 'applied' });
      render(<ProposalCard proposal={proposal} />);

      expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
      expect(screen.getByText('Applied')).toBeInTheDocument();
    });

    it('hides action buttons when rejected', () => {
      const proposal = createMockProposal({ status: 'rejected' });
      render(<ProposalCard proposal={proposal} />);

      expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
      expect(screen.getByText('Rejected')).toBeInTheDocument();
    });

    it('shows error message when failed', () => {
      const proposal = createMockProposal({
        status: 'failed',
        error: 'Failed to execute command',
      });
      render(<ProposalCard proposal={proposal} />);

      expect(screen.getByText('Failed to execute command')).toBeInTheDocument();
      expect(screen.getByText('Failed')).toBeInTheDocument();
    });
  });

  describe('Risk Badge', () => {
    it('does not show risk badge when no risk', () => {
      render(<ProposalCard proposal={createMockProposal()} />);
      expect(screen.queryByText('Warning')).not.toBeInTheDocument();
      expect(screen.queryByText('High Risk')).not.toBeInTheDocument();
    });

    it('shows warning badge for low/medium risk', () => {
      const proposal = createMockProposal({
        editScript: {
          ...createMockProposal().editScript,
          risk: { copyright: 'low', nsfw: 'none' },
        },
      });
      render(<ProposalCard proposal={proposal} />);
      expect(screen.getByText('Warning')).toBeInTheDocument();
    });

    it('shows high risk badge for high risk', () => {
      const proposal = createMockProposal({
        editScript: {
          ...createMockProposal().editScript,
          risk: { copyright: 'high', nsfw: 'none' },
        },
      });
      render(<ProposalCard proposal={proposal} />);
      expect(screen.getByText('High Risk')).toBeInTheDocument();
    });
  });
});
