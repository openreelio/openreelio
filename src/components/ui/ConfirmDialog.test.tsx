/**
 * ConfirmDialog Component Tests
 *
 * TDD: Tests for confirmation dialog component
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  const defaultProps = {
    isOpen: true,
    title: 'Confirm Action',
    message: 'Are you sure you want to proceed?',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render when isOpen is true', () => {
      render(<ConfirmDialog {...defaultProps} />);

      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    });

    it('should not render when isOpen is false', () => {
      render(<ConfirmDialog {...defaultProps} isOpen={false} />);

      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });

    it('should display title', () => {
      render(<ConfirmDialog {...defaultProps} />);

      expect(screen.getByText('Confirm Action')).toBeInTheDocument();
    });

    it('should display message', () => {
      render(<ConfirmDialog {...defaultProps} />);

      expect(screen.getByText('Are you sure you want to proceed?')).toBeInTheDocument();
    });

    it('should render confirm button', () => {
      render(<ConfirmDialog {...defaultProps} />);

      expect(screen.getByTestId('confirm-button')).toBeInTheDocument();
    });

    it('should render cancel button', () => {
      render(<ConfirmDialog {...defaultProps} />);

      expect(screen.getByTestId('cancel-button')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Button Labels Tests
  // ===========================================================================

  describe('button labels', () => {
    it('should display default confirm label', () => {
      render(<ConfirmDialog {...defaultProps} />);

      expect(screen.getByTestId('confirm-button')).toHaveTextContent('Confirm');
    });

    it('should display default cancel label', () => {
      render(<ConfirmDialog {...defaultProps} />);

      expect(screen.getByTestId('cancel-button')).toHaveTextContent('Cancel');
    });

    it('should display custom confirm label', () => {
      render(<ConfirmDialog {...defaultProps} confirmLabel="Delete" />);

      expect(screen.getByTestId('confirm-button')).toHaveTextContent('Delete');
    });

    it('should display custom cancel label', () => {
      render(<ConfirmDialog {...defaultProps} cancelLabel="Keep" />);

      expect(screen.getByTestId('cancel-button')).toHaveTextContent('Keep');
    });
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  describe('interactions', () => {
    it('should call onConfirm when confirm button is clicked', () => {
      const onConfirm = vi.fn();
      render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />);

      fireEvent.click(screen.getByTestId('confirm-button'));

      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('should call onCancel when cancel button is clicked', () => {
      const onCancel = vi.fn();
      render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />);

      fireEvent.click(screen.getByTestId('cancel-button'));

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('should call onCancel when backdrop is clicked', () => {
      const onCancel = vi.fn();
      render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />);

      fireEvent.click(screen.getByTestId('dialog-backdrop'));

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('should call onCancel when Escape key is pressed', () => {
      const onCancel = vi.fn();
      render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />);

      fireEvent.keyDown(screen.getByTestId('confirm-dialog'), { key: 'Escape' });

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('should not close on backdrop click when closeOnBackdrop is false', () => {
      const onCancel = vi.fn();
      render(<ConfirmDialog {...defaultProps} onCancel={onCancel} closeOnBackdrop={false} />);

      fireEvent.click(screen.getByTestId('dialog-backdrop'));

      expect(onCancel).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Variant Tests
  // ===========================================================================

  describe('variants', () => {
    it('should apply danger variant styling to confirm button', () => {
      render(<ConfirmDialog {...defaultProps} variant="danger" />);

      expect(screen.getByTestId('confirm-button')).toHaveClass('bg-red-600');
    });

    it('should apply warning variant styling to confirm button', () => {
      render(<ConfirmDialog {...defaultProps} variant="warning" />);

      expect(screen.getByTestId('confirm-button')).toHaveClass('bg-yellow-600');
    });

    it('should apply default variant styling', () => {
      render(<ConfirmDialog {...defaultProps} />);

      expect(screen.getByTestId('confirm-button')).toHaveClass('bg-primary-600');
    });
  });

  // ===========================================================================
  // Loading State Tests
  // ===========================================================================

  describe('loading state', () => {
    it('should disable buttons when isLoading is true', () => {
      render(<ConfirmDialog {...defaultProps} isLoading />);

      expect(screen.getByTestId('confirm-button')).toBeDisabled();
      expect(screen.getByTestId('cancel-button')).toBeDisabled();
    });

    it('should show loading indicator on confirm button', () => {
      render(<ConfirmDialog {...defaultProps} isLoading />);

      expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('accessibility', () => {
    it('should have proper role for dialog', () => {
      render(<ConfirmDialog {...defaultProps} />);

      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('should have aria-modal attribute', () => {
      render(<ConfirmDialog {...defaultProps} />);

      expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    });

    it('should have aria-labelledby pointing to title', () => {
      render(<ConfirmDialog {...defaultProps} />);

      const dialog = screen.getByRole('dialog');
      const titleId = dialog.getAttribute('aria-labelledby');
      expect(document.getElementById(titleId!)).toHaveTextContent('Confirm Action');
    });
  });
});
