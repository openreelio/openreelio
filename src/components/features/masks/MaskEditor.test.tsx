/**
 * MaskEditor Component Tests
 *
 * TDD: RED phase - Writing tests first
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MaskEditor } from './MaskEditor';
import type { Mask } from '@/types';

// =============================================================================
// Mocks
// =============================================================================

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// =============================================================================
// Test Fixtures
// =============================================================================

const createMockMask = (id: string): Mask => ({
  id,
  name: `Mask ${id}`,
  shape: {
    type: 'rectangle',
    x: 0.5,
    y: 0.5,
    width: 0.4,
    height: 0.3,
    cornerRadius: 0,
    rotation: 0,
  },
  inverted: false,
  feather: 0,
  opacity: 1,
  expansion: 0,
  blendMode: 'add',
  enabled: true,
  locked: false,
});

// =============================================================================
// Test Suite
// =============================================================================

describe('MaskEditor', () => {
  const defaultProps = {
    clipId: 'clip-123',
    effectId: 'effect-456',
    sequenceId: 'seq-789',
    trackId: 'track-001',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue({ success: true, createdIds: ['mask-new'] });
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render the mask editor', () => {
      render(<MaskEditor {...defaultProps} />);

      expect(screen.getByTestId('mask-editor')).toBeInTheDocument();
    });

    it('should render toolbar with shape tools', () => {
      render(<MaskEditor {...defaultProps} />);

      expect(screen.getByTestId('mask-shape-tools')).toBeInTheDocument();
    });

    it('should render mask canvas', () => {
      render(<MaskEditor {...defaultProps} />);

      expect(screen.getByTestId('mask-canvas')).toBeInTheDocument();
    });

    it('should render mask list', () => {
      render(<MaskEditor {...defaultProps} />);

      expect(screen.getByTestId('mask-list')).toBeInTheDocument();
    });

    it('should render with initial masks', () => {
      const initialMasks = [createMockMask('mask-1'), createMockMask('mask-2')];

      render(<MaskEditor {...defaultProps} initialMasks={initialMasks} />);

      expect(screen.getByTestId('mask-item-mask-1')).toBeInTheDocument();
      expect(screen.getByTestId('mask-item-mask-2')).toBeInTheDocument();
    });

    it('should render property panel when mask is selected', () => {
      const initialMasks = [createMockMask('mask-1')];

      render(<MaskEditor {...defaultProps} initialMasks={initialMasks} />);

      // Select mask
      fireEvent.click(screen.getByTestId('mask-item-mask-1'));

      expect(screen.getByTestId('mask-property-panel')).toBeInTheDocument();
    });

    it('should not render property panel when no mask is selected', () => {
      const initialMasks = [createMockMask('mask-1')];

      render(<MaskEditor {...defaultProps} initialMasks={initialMasks} />);

      // Property panel should not be visible without selection
      expect(screen.queryByTestId('mask-property-panel')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Tool Selection Tests
  // ===========================================================================

  describe('tool selection', () => {
    it('should change active tool when clicking tool button', () => {
      render(<MaskEditor {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /ellipse/i }));

      // Ellipse tool should be active (highlighted)
      const ellipseButton = screen.getByRole('button', { name: /ellipse/i });
      expect(ellipseButton).toHaveClass('bg-blue-600');
    });
  });

  // ===========================================================================
  // Add Mask Tests
  // ===========================================================================

  describe('add mask', () => {
    it('should add mask via toolbar add button', async () => {
      render(<MaskEditor {...defaultProps} />);

      // Click add button in mask list
      fireEvent.click(screen.getByRole('button', { name: /add mask/i }));

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
          commandType: 'AddMask',
          payload: expect.any(Object),
        });
      });
    });
  });

  // ===========================================================================
  // Selection Tests
  // ===========================================================================

  describe('selection', () => {
    it('should select mask when clicking in list', () => {
      const initialMasks = [createMockMask('mask-1')];

      render(<MaskEditor {...defaultProps} initialMasks={initialMasks} />);

      fireEvent.click(screen.getByTestId('mask-item-mask-1'));

      // Should show property panel for selected mask
      expect(screen.getByTestId('mask-property-panel')).toBeInTheDocument();
    });

    it('should deselect when clicking selected mask again', () => {
      const initialMasks = [createMockMask('mask-1')];

      render(<MaskEditor {...defaultProps} initialMasks={initialMasks} />);

      // Select
      fireEvent.click(screen.getByTestId('mask-item-mask-1'));
      expect(screen.getByTestId('mask-property-panel')).toBeInTheDocument();

      // Deselect
      fireEvent.click(screen.getByTestId('mask-item-mask-1'));
      expect(screen.queryByTestId('mask-property-panel')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Property Editing Tests
  // ===========================================================================

  describe('property editing', () => {
    it('should update mask name', async () => {
      const initialMasks = [createMockMask('mask-1')];

      render(<MaskEditor {...defaultProps} initialMasks={initialMasks} />);

      // Select mask
      fireEvent.click(screen.getByTestId('mask-item-mask-1'));

      // Change name
      const nameInput = screen.getByLabelText(/name/i);
      fireEvent.change(nameInput, { target: { value: 'New Name' } });

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
          commandType: 'UpdateMask',
          payload: expect.objectContaining({
            maskId: 'mask-1',
            name: 'New Name',
          }),
        });
      });
    });

    it('should update mask feather', async () => {
      const initialMasks = [createMockMask('mask-1')];

      render(<MaskEditor {...defaultProps} initialMasks={initialMasks} />);

      // Select mask
      fireEvent.click(screen.getByTestId('mask-item-mask-1'));

      // Change feather
      const featherSlider = screen.getByLabelText(/feather/i);
      fireEvent.change(featherSlider, { target: { value: '0.5' } });

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
          commandType: 'UpdateMask',
          payload: expect.objectContaining({
            maskId: 'mask-1',
            feather: 0.5,
          }),
        });
      });
    });
  });

  // ===========================================================================
  // Visibility/Lock Toggle Tests
  // ===========================================================================

  describe('visibility and lock toggles', () => {
    it('should toggle mask visibility', async () => {
      const initialMasks = [createMockMask('mask-1')];

      render(<MaskEditor {...defaultProps} initialMasks={initialMasks} />);

      // Toggle visibility via list
      const visibilityButton = screen
        .getByTestId('mask-item-mask-1')
        .querySelector('[aria-label="Toggle visibility"]');
      if (visibilityButton) {
        fireEvent.click(visibilityButton);
      }

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
          commandType: 'UpdateMask',
          payload: expect.objectContaining({
            maskId: 'mask-1',
            enabled: false,
          }),
        });
      });
    });

    it('should toggle mask lock', async () => {
      const initialMasks = [createMockMask('mask-1')];

      render(<MaskEditor {...defaultProps} initialMasks={initialMasks} />);

      // Toggle lock via list
      const lockButton = screen
        .getByTestId('mask-item-mask-1')
        .querySelector('[aria-label="Toggle lock"]');
      if (lockButton) {
        fireEvent.click(lockButton);
      }

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
          commandType: 'UpdateMask',
          payload: expect.objectContaining({
            maskId: 'mask-1',
            locked: true,
          }),
        });
      });
    });
  });

  // ===========================================================================
  // Delete Tests
  // ===========================================================================

  describe('delete mask', () => {
    it('should delete selected mask via toolbar', async () => {
      const initialMasks = [createMockMask('mask-1')];

      render(<MaskEditor {...defaultProps} initialMasks={initialMasks} />);

      // Select mask
      fireEvent.click(screen.getByTestId('mask-item-mask-1'));

      // Delete via toolbar
      fireEvent.click(screen.getByRole('button', { name: /delete/i }));

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
          commandType: 'RemoveMask',
          payload: expect.objectContaining({
            maskId: 'mask-1',
          }),
        });
      });
    });
  });

  // ===========================================================================
  // Disabled State Tests
  // ===========================================================================

  describe('disabled state', () => {
    it('should disable all interactions when disabled', () => {
      const initialMasks = [createMockMask('mask-1')];

      render(<MaskEditor {...defaultProps} initialMasks={initialMasks} disabled />);

      // Tool buttons should be disabled
      const toolButtons = screen.getByTestId('mask-shape-tools').querySelectorAll('button');
      toolButtons.forEach((button) => {
        expect(button).toBeDisabled();
      });
    });
  });

  // ===========================================================================
  // Error State Tests
  // ===========================================================================

  describe('error handling', () => {
    it('should display error message', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Operation failed'));

      render(<MaskEditor {...defaultProps} />);

      // Trigger an operation that will fail
      fireEvent.click(screen.getByRole('button', { name: /add mask/i }));

      await waitFor(() => {
        expect(screen.getByText(/operation failed/i)).toBeInTheDocument();
      });
    });

    it('should allow dismissing error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Operation failed'));

      render(<MaskEditor {...defaultProps} />);

      // Trigger error
      fireEvent.click(screen.getByRole('button', { name: /add mask/i }));

      await waitFor(() => {
        expect(screen.getByText(/operation failed/i)).toBeInTheDocument();
      });

      // Dismiss error
      const dismissButton = screen.getByRole('button', { name: /dismiss/i });
      fireEvent.click(dismissButton);

      expect(screen.queryByText(/operation failed/i)).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Layout Tests
  // ===========================================================================

  describe('layout', () => {
    it('should support compact layout', () => {
      render(<MaskEditor {...defaultProps} compact />);

      expect(screen.getByTestId('mask-editor')).toHaveClass('compact');
    });

    it('should apply custom className', () => {
      render(<MaskEditor {...defaultProps} className="custom-class" />);

      expect(screen.getByTestId('mask-editor')).toHaveClass('custom-class');
    });
  });
});
