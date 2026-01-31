/**
 * BinItem Tests
 *
 * TDD: Tests for the individual bin/folder display component.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BinItem } from './BinItem';
import type { BinColor } from '@/types';

// =============================================================================
// Test Helpers
// =============================================================================

const defaultProps = {
  id: 'bin-1',
  name: 'Test Bin',
  color: 'blue' as BinColor,
  depth: 0,
  expanded: false,
  hasChildren: false,
  assetCount: 0,
  isSelected: false,
};

// =============================================================================
// Rendering Tests
// =============================================================================

describe('BinItem', () => {
  describe('rendering', () => {
    it('should render the bin item', () => {
      render(<BinItem {...defaultProps} />);

      expect(screen.getByTestId('bin-item-bin-1')).toBeInTheDocument();
    });

    it('should display bin name', () => {
      render(<BinItem {...defaultProps} name="My Folder" />);

      expect(screen.getByText('My Folder')).toBeInTheDocument();
    });

    it('should display folder icon', () => {
      render(<BinItem {...defaultProps} />);

      expect(screen.getByTestId('bin-folder-icon')).toBeInTheDocument();
    });

    it('should show asset count badge when assets exist', () => {
      render(<BinItem {...defaultProps} assetCount={5} />);

      expect(screen.getByTestId('bin-asset-count')).toHaveTextContent('5');
    });

    it('should not show asset count badge when empty', () => {
      render(<BinItem {...defaultProps} assetCount={0} />);

      expect(screen.queryByTestId('bin-asset-count')).not.toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(<BinItem {...defaultProps} className="custom-class" />);

      expect(screen.getByTestId('bin-item-bin-1')).toHaveClass('custom-class');
    });
  });

  // ===========================================================================
  // Depth/Indentation Tests
  // ===========================================================================

  describe('depth indentation', () => {
    it('should have no indentation at depth 0', () => {
      render(<BinItem {...defaultProps} depth={0} />);

      const item = screen.getByTestId('bin-item-bin-1');
      expect(item).toHaveStyle({ paddingLeft: '8px' }); // Base padding
    });

    it('should increase indentation with depth', () => {
      render(<BinItem {...defaultProps} depth={2} />);

      const item = screen.getByTestId('bin-item-bin-1');
      // Base padding (8px) + depth * indent (2 * 16px = 32px) = 40px
      expect(item).toHaveStyle({ paddingLeft: '40px' });
    });
  });

  // ===========================================================================
  // Expand/Collapse Tests
  // ===========================================================================

  describe('expand/collapse', () => {
    it('should show expand icon when has children and collapsed', () => {
      render(<BinItem {...defaultProps} hasChildren={true} expanded={false} />);

      expect(screen.getByTestId('bin-expand-icon')).toBeInTheDocument();
      expect(screen.getByTestId('bin-expand-icon')).toHaveAttribute('data-expanded', 'false');
    });

    it('should show collapse icon when has children and expanded', () => {
      render(<BinItem {...defaultProps} hasChildren={true} expanded={true} />);

      expect(screen.getByTestId('bin-expand-icon')).toHaveAttribute('data-expanded', 'true');
    });

    it('should not show expand icon when no children', () => {
      render(<BinItem {...defaultProps} hasChildren={false} />);

      expect(screen.queryByTestId('bin-expand-icon')).not.toBeInTheDocument();
    });

    it('should call onToggleExpand when expand icon clicked', () => {
      const onToggleExpand = vi.fn();
      render(
        <BinItem
          {...defaultProps}
          hasChildren={true}
          onToggleExpand={onToggleExpand}
        />
      );

      fireEvent.click(screen.getByTestId('bin-expand-icon'));

      expect(onToggleExpand).toHaveBeenCalledWith('bin-1');
    });
  });

  // ===========================================================================
  // Selection Tests
  // ===========================================================================

  describe('selection', () => {
    it('should apply selected styling when selected', () => {
      render(<BinItem {...defaultProps} isSelected={true} />);

      expect(screen.getByTestId('bin-item-bin-1')).toHaveClass('bg-primary-500/20');
    });

    it('should not apply selected styling when not selected', () => {
      render(<BinItem {...defaultProps} isSelected={false} />);

      expect(screen.getByTestId('bin-item-bin-1')).not.toHaveClass('bg-primary-500/20');
    });

    it('should call onSelect when clicked', () => {
      const onSelect = vi.fn();
      render(<BinItem {...defaultProps} onSelect={onSelect} />);

      fireEvent.click(screen.getByTestId('bin-item-bin-1'));

      expect(onSelect).toHaveBeenCalledWith('bin-1');
    });

    it('should call onSelect on double-click to enter bin', () => {
      const onDoubleClick = vi.fn();
      render(<BinItem {...defaultProps} onDoubleClick={onDoubleClick} />);

      fireEvent.doubleClick(screen.getByTestId('bin-item-bin-1'));

      expect(onDoubleClick).toHaveBeenCalledWith('bin-1');
    });
  });

  // ===========================================================================
  // Color Tests
  // ===========================================================================

  describe('color styling', () => {
    it('should apply blue color styling', () => {
      render(<BinItem {...defaultProps} color="blue" />);

      const icon = screen.getByTestId('bin-folder-icon');
      expect(icon).toHaveClass('text-blue-500');
    });

    it('should apply red color styling', () => {
      render(<BinItem {...defaultProps} color="red" />);

      const icon = screen.getByTestId('bin-folder-icon');
      expect(icon).toHaveClass('text-red-500');
    });

    it('should apply green color styling', () => {
      render(<BinItem {...defaultProps} color="green" />);

      const icon = screen.getByTestId('bin-folder-icon');
      expect(icon).toHaveClass('text-green-500');
    });

    it('should apply gray color styling', () => {
      render(<BinItem {...defaultProps} color="gray" />);

      const icon = screen.getByTestId('bin-folder-icon');
      expect(icon).toHaveClass('text-gray-500');
    });
  });

  // ===========================================================================
  // Context Menu Tests
  // ===========================================================================

  describe('context menu', () => {
    it('should call onContextMenu on right-click', () => {
      const onContextMenu = vi.fn();
      render(<BinItem {...defaultProps} onContextMenu={onContextMenu} />);

      fireEvent.contextMenu(screen.getByTestId('bin-item-bin-1'));

      expect(onContextMenu).toHaveBeenCalledWith(
        'bin-1',
        expect.objectContaining({ type: 'contextmenu' })
      );
    });
  });

  // ===========================================================================
  // Drag and Drop Tests
  // ===========================================================================

  describe('drag and drop', () => {
    it('should be draggable', () => {
      render(<BinItem {...defaultProps} />);

      const item = screen.getByTestId('bin-item-bin-1');
      expect(item).toHaveAttribute('draggable', 'true');
    });

    it('should call onDragStart when dragging starts', () => {
      const onDragStart = vi.fn();
      render(<BinItem {...defaultProps} onDragStart={onDragStart} />);

      fireEvent.dragStart(screen.getByTestId('bin-item-bin-1'));

      expect(onDragStart).toHaveBeenCalledWith('bin-1', expect.anything());
    });

    it('should show drop indicator when dragging over', () => {
      render(<BinItem {...defaultProps} isDropTarget={true} />);

      expect(screen.getByTestId('bin-item-bin-1')).toHaveClass('ring-2');
      expect(screen.getByTestId('bin-item-bin-1')).toHaveClass('ring-primary-500');
    });

    it('should call onDrop when item dropped', () => {
      const onDrop = vi.fn();
      render(<BinItem {...defaultProps} onDrop={onDrop} />);

      fireEvent.drop(screen.getByTestId('bin-item-bin-1'));

      expect(onDrop).toHaveBeenCalledWith('bin-1', expect.anything());
    });
  });

  // ===========================================================================
  // Editing Tests
  // ===========================================================================

  describe('inline editing', () => {
    it('should show input when isEditing is true', () => {
      render(<BinItem {...defaultProps} isEditing={true} />);

      expect(screen.getByTestId('bin-name-input')).toBeInTheDocument();
      expect(screen.queryByText('Test Bin')).not.toBeInTheDocument();
    });

    it('should call onRename when editing completes', () => {
      const onRename = vi.fn();
      render(<BinItem {...defaultProps} isEditing={true} onRename={onRename} />);

      const input = screen.getByTestId('bin-name-input');
      fireEvent.change(input, { target: { value: 'New Name' } });
      fireEvent.blur(input);

      expect(onRename).toHaveBeenCalledWith('bin-1', 'New Name');
    });

    it('should call onRename on Enter key', () => {
      const onRename = vi.fn();
      render(<BinItem {...defaultProps} isEditing={true} onRename={onRename} />);

      const input = screen.getByTestId('bin-name-input');
      fireEvent.change(input, { target: { value: 'New Name' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onRename).toHaveBeenCalledWith('bin-1', 'New Name');
    });

    it('should call onCancelEdit on Escape key', () => {
      const onCancelEdit = vi.fn();
      render(<BinItem {...defaultProps} isEditing={true} onCancelEdit={onCancelEdit} />);

      const input = screen.getByTestId('bin-name-input');
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(onCancelEdit).toHaveBeenCalled();
    });
  });
});
