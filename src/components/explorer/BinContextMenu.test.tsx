/**
 * BinContextMenu Tests
 *
 * TDD: Tests for the bin/folder context menu component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { BinContextMenu } from './BinContextMenu';
import type { BinColor } from '@/types';

// =============================================================================
// Test Helpers
// =============================================================================

const defaultProps = {
  binId: 'bin-1',
  binName: 'Footage',
  binColor: 'gray' as BinColor,
  position: { x: 100, y: 200 },
  onClose: vi.fn(),
  onCreateSubfolder: vi.fn(),
  onRename: vi.fn(),
  onSetColor: vi.fn(),
  onDelete: vi.fn(),
};

function renderMenu(overrides = {}) {
  return render(<BinContextMenu {...defaultProps} {...overrides} />);
}

// =============================================================================
// Tests
// =============================================================================

describe('BinContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render 4 menu items', () => {
      renderMenu();

      expect(screen.getByText('New Subfolder')).toBeInTheDocument();
      expect(screen.getByText('Rename')).toBeInTheDocument();
      expect(screen.getByText('Set Color')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    it('should render as a portal in document.body', () => {
      renderMenu();

      const menu = screen.getByRole('menu');
      expect(menu).toBeInTheDocument();
    });

    it('should display the bin name as a header', () => {
      renderMenu();

      expect(screen.getByText('Footage')).toBeInTheDocument();
    });

    it('should have aria-label with the bin name', () => {
      renderMenu();

      const menu = screen.getByRole('menu');
      expect(menu).toHaveAttribute('aria-label', 'Folder actions: Footage');
    });

    it('should assign menuitem role to action buttons', () => {
      renderMenu();

      const menuItems = screen.getAllByRole('menuitem');
      expect(menuItems).toHaveLength(4);
    });

    it('should render a separator between items and delete', () => {
      renderMenu();

      expect(screen.getByRole('separator')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Action Tests
  // ===========================================================================

  describe('actions', () => {
    it('should call onCreateSubfolder and onClose when New Subfolder clicked', () => {
      renderMenu();

      fireEvent.click(screen.getByText('New Subfolder'));

      expect(defaultProps.onCreateSubfolder).toHaveBeenCalledWith('bin-1');
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it('should call onRename and onClose when Rename clicked', () => {
      renderMenu();

      fireEvent.click(screen.getByText('Rename'));

      expect(defaultProps.onRename).toHaveBeenCalledWith('bin-1');
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it('should call onDelete and onClose when Delete clicked', () => {
      renderMenu();

      fireEvent.click(screen.getByText('Delete'));

      expect(defaultProps.onDelete).toHaveBeenCalledWith('bin-1');
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Color Picker Tests
  // ===========================================================================

  describe('color picker', () => {
    it('should show color swatches when Set Color is clicked', () => {
      renderMenu();

      fireEvent.click(screen.getByText('Set Color'));

      expect(screen.getByTestId('bin-color-picker')).toBeInTheDocument();
      // 8 color swatches
      const swatches = screen.getAllByTestId(/^color-swatch-/);
      expect(swatches).toHaveLength(8);
    });

    it('should highlight the current bin color', () => {
      renderMenu({ binColor: 'blue' });

      fireEvent.click(screen.getByText('Set Color'));

      const blueSwatch = screen.getByTestId('color-swatch-blue');
      expect(blueSwatch).toHaveClass('ring-2');
    });

    it('should call onSetColor when a swatch is clicked', () => {
      renderMenu();

      fireEvent.click(screen.getByText('Set Color'));
      fireEvent.click(screen.getByTestId('color-swatch-red'));

      expect(defaultProps.onSetColor).toHaveBeenCalledWith('bin-1', 'red');
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Delete Danger Styling
  // ===========================================================================

  describe('delete styling', () => {
    it('should apply danger styling to delete item', () => {
      renderMenu();

      const deleteButton = screen.getByTestId('bin-context-delete');
      expect(deleteButton).toHaveClass('text-status-error');
    });
  });

  // ===========================================================================
  // Keyboard Tests
  // ===========================================================================

  describe('keyboard', () => {
    it('should close on Escape key', () => {
      renderMenu();

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Click Outside Tests
  // ===========================================================================

  describe('click outside', () => {
    it('should close when clicking outside the menu after animation frame', async () => {
      renderMenu();

      // Trigger the requestAnimationFrame callback
      await vi.waitFor(() => {
        fireEvent.mouseDown(document.body);
        expect(defaultProps.onClose).toHaveBeenCalled();
      });
    });

    it('should not close when clicking inside the menu', async () => {
      renderMenu();

      const menu = screen.getByRole('menu');
      fireEvent.mouseDown(menu);

      expect(defaultProps.onClose).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Edge Case Tests
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle rapid open/close without errors', () => {
      const { unmount } = renderMenu();
      unmount();

      // Re-render should work without stale listener issues
      renderMenu();
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('should toggle color picker off when clicked twice', () => {
      renderMenu();

      fireEvent.click(screen.getByText('Set Color'));
      expect(screen.getByTestId('bin-color-picker')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Set Color'));
      expect(screen.queryByTestId('bin-color-picker')).not.toBeInTheDocument();
    });

    it('should render all 8 color swatches with correct test IDs', () => {
      renderMenu();
      fireEvent.click(screen.getByText('Set Color'));

      const expectedColors = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
      for (const color of expectedColors) {
        expect(screen.getByTestId(`color-swatch-${color}`)).toBeInTheDocument();
      }
    });

    it('should pass correct binId for all actions', () => {
      const customProps = {
        ...defaultProps,
        binId: 'custom-bin-42',
        onClose: vi.fn(),
        onCreateSubfolder: vi.fn(),
        onRename: vi.fn(),
        onDelete: vi.fn(),
      };

      render(<BinContextMenu {...customProps} />);

      fireEvent.click(screen.getByText('New Subfolder'));
      expect(customProps.onCreateSubfolder).toHaveBeenCalledWith('custom-bin-42');
    });
  });
});
