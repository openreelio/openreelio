/**
 * ApprovalDialog Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ApprovalDialog } from './ApprovalDialog';

describe('ApprovalDialog', () => {
  const defaultProps = {
    isOpen: true,
    toolName: 'delete_clip',
    description: 'Delete the selected clip from the timeline',
    riskLevel: 'high' as const,
    onApprove: vi.fn(),
    onReject: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render when open', () => {
      render(<ApprovalDialog {...defaultProps} />);

      expect(screen.getByTestId('approval-dialog')).toBeInTheDocument();
    });

    it('should not render when closed', () => {
      render(<ApprovalDialog {...defaultProps} isOpen={false} />);

      expect(screen.queryByTestId('approval-dialog')).not.toBeInTheDocument();
    });

    it('should display tool name', () => {
      render(<ApprovalDialog {...defaultProps} />);

      expect(screen.getByText('delete_clip')).toBeInTheDocument();
    });

    it('should display description', () => {
      render(<ApprovalDialog {...defaultProps} />);

      expect(
        screen.getByText('Delete the selected clip from the timeline')
      ).toBeInTheDocument();
    });

    it('should display risk level badge', () => {
      render(<ApprovalDialog {...defaultProps} />);

      expect(screen.getByText('High Risk')).toBeInTheDocument();
    });

    it('should display arguments when provided', () => {
      render(
        <ApprovalDialog
          {...defaultProps}
          args={{ clipId: 'clip_001', trackId: 'track_001' }}
        />
      );

      expect(screen.getByText(/clipId/)).toBeInTheDocument();
      expect(screen.getByText(/clip_001/)).toBeInTheDocument();
    });
  });

  describe('risk level styling', () => {
    it('should show correct color for low risk', () => {
      render(<ApprovalDialog {...defaultProps} riskLevel="low" />);

      expect(screen.getByText('Low Risk')).toBeInTheDocument();
    });

    it('should show correct color for medium risk', () => {
      render(<ApprovalDialog {...defaultProps} riskLevel="medium" />);

      expect(screen.getByText('Medium Risk')).toBeInTheDocument();
    });

    it('should show correct color for high risk', () => {
      render(<ApprovalDialog {...defaultProps} riskLevel="high" />);

      expect(screen.getByText('High Risk')).toBeInTheDocument();
    });
  });

  describe('interactions', () => {
    it('should call onApprove when approve button clicked', () => {
      render(<ApprovalDialog {...defaultProps} />);

      fireEvent.click(screen.getByTestId('approve-button'));

      expect(defaultProps.onApprove).toHaveBeenCalled();
    });

    it('should call onReject when reject button clicked', () => {
      render(<ApprovalDialog {...defaultProps} />);

      fireEvent.click(screen.getByTestId('reject-button'));

      expect(defaultProps.onReject).toHaveBeenCalledWith('User rejected');
    });

    it('should call onReject when backdrop clicked', () => {
      render(<ApprovalDialog {...defaultProps} />);

      fireEvent.click(screen.getByTestId('dialog-backdrop'));

      expect(defaultProps.onReject).toHaveBeenCalledWith('User dismissed');
    });

    it('should call onDismiss when backdrop clicked if provided', () => {
      const onDismiss = vi.fn();
      render(<ApprovalDialog {...defaultProps} onDismiss={onDismiss} />);

      fireEvent.click(screen.getByTestId('dialog-backdrop'));

      expect(onDismiss).toHaveBeenCalled();
      expect(defaultProps.onReject).not.toHaveBeenCalled();
    });

    it('should call onReject when Escape key pressed', () => {
      render(<ApprovalDialog {...defaultProps} />);

      fireEvent.keyDown(screen.getByTestId('approval-dialog'), {
        key: 'Escape',
      });

      expect(defaultProps.onReject).toHaveBeenCalledWith('User dismissed');
    });
  });

  describe('loading state', () => {
    it('should show loading spinner when loading', () => {
      render(<ApprovalDialog {...defaultProps} isLoading={true} />);

      expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    });

    it('should disable buttons when loading', () => {
      render(<ApprovalDialog {...defaultProps} isLoading={true} />);

      expect(screen.getByTestId('approve-button')).toBeDisabled();
      expect(screen.getByTestId('reject-button')).toBeDisabled();
    });
  });

  describe('accessibility', () => {
    it('should have correct role', () => {
      render(<ApprovalDialog {...defaultProps} />);

      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });

    it('should have aria-modal attribute', () => {
      render(<ApprovalDialog {...defaultProps} />);

      expect(screen.getByRole('alertdialog')).toHaveAttribute(
        'aria-modal',
        'true'
      );
    });

    it('should have aria-labelledby attribute', () => {
      render(<ApprovalDialog {...defaultProps} />);

      expect(screen.getByRole('alertdialog')).toHaveAttribute(
        'aria-labelledby'
      );
    });
  });
});
