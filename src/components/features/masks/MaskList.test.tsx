/**
 * MaskList Component Tests
 *
 * TDD tests for mask list display and selection.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MaskList } from './MaskList';
import type { Mask } from '@/types';

// Test data
const createTestMask = (id: string, name: string): Mask => ({
  id,
  name,
  shape: { type: 'rectangle', x: 0.5, y: 0.5, width: 0.3, height: 0.2, cornerRadius: 0, rotation: 0 },
  inverted: false,
  feather: 0.1,
  opacity: 1.0,
  expansion: 0,
  blendMode: 'add',
  enabled: true,
  locked: false,
});

describe('MaskList', () => {
  // ==========================================================================
  // Rendering Tests
  // ==========================================================================

  describe('rendering', () => {
    it('renders empty state when no masks', () => {
      const onSelect = vi.fn();
      render(<MaskList masks={[]} selectedId={null} onSelect={onSelect} />);

      expect(screen.getByText(/No masks/i)).toBeInTheDocument();
    });

    it('renders list of masks', () => {
      const masks = [
        createTestMask('mask-1', 'Mask 1'),
        createTestMask('mask-2', 'Mask 2'),
      ];
      const onSelect = vi.fn();

      render(<MaskList masks={masks} selectedId={null} onSelect={onSelect} />);

      expect(screen.getByText('Mask 1')).toBeInTheDocument();
      expect(screen.getByText('Mask 2')).toBeInTheDocument();
    });

    it('shows mask shape icon', () => {
      const masks = [createTestMask('mask-1', 'Mask 1')];
      const onSelect = vi.fn();

      render(<MaskList masks={masks} selectedId={null} onSelect={onSelect} />);

      expect(screen.getByTestId('mask-icon-rectangle')).toBeInTheDocument();
    });

    it('highlights selected mask', () => {
      const masks = [
        createTestMask('mask-1', 'Mask 1'),
        createTestMask('mask-2', 'Mask 2'),
      ];
      const onSelect = vi.fn();

      render(<MaskList masks={masks} selectedId="mask-1" onSelect={onSelect} />);

      const selectedItem = screen.getByTestId('mask-item-mask-1');
      expect(selectedItem).toHaveClass('bg-blue-600');
    });

    it('shows disabled indicator for disabled masks', () => {
      const mask = createTestMask('mask-1', 'Disabled Mask');
      mask.enabled = false;
      const onSelect = vi.fn();

      render(<MaskList masks={[mask]} selectedId={null} onSelect={onSelect} />);

      const item = screen.getByTestId('mask-item-mask-1');
      expect(item).toHaveClass('opacity-50');
    });

    it('shows lock indicator for locked masks', () => {
      const mask = createTestMask('mask-1', 'Locked Mask');
      mask.locked = true;
      const onSelect = vi.fn();

      render(<MaskList masks={[mask]} selectedId={null} onSelect={onSelect} />);

      expect(screen.getByTestId('lock-icon-mask-1')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // Selection Tests
  // ==========================================================================

  describe('selection', () => {
    it('calls onSelect when mask is clicked', async () => {
      const user = userEvent.setup();
      const masks = [createTestMask('mask-1', 'Mask 1')];
      const onSelect = vi.fn();

      render(<MaskList masks={masks} selectedId={null} onSelect={onSelect} />);

      await user.click(screen.getByText('Mask 1'));
      expect(onSelect).toHaveBeenCalledWith('mask-1');
    });

    it('calls onSelect with null when clicking selected mask', async () => {
      const user = userEvent.setup();
      const masks = [createTestMask('mask-1', 'Mask 1')];
      const onSelect = vi.fn();

      render(<MaskList masks={masks} selectedId="mask-1" onSelect={onSelect} />);

      await user.click(screen.getByText('Mask 1'));
      expect(onSelect).toHaveBeenCalledWith(null);
    });
  });

  // ==========================================================================
  // Action Tests
  // ==========================================================================

  describe('actions', () => {
    it('calls onAdd when add button clicked', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onAdd = vi.fn();

      render(
        <MaskList
          masks={[]}
          selectedId={null}
          onSelect={onSelect}
          onAdd={onAdd}
        />
      );

      const addBtn = screen.getByRole('button', { name: /Add Mask/i });
      await user.click(addBtn);
      expect(onAdd).toHaveBeenCalled();
    });

    it('calls onDelete when delete button clicked', async () => {
      const user = userEvent.setup();
      const masks = [createTestMask('mask-1', 'Mask 1')];
      const onSelect = vi.fn();
      const onDelete = vi.fn();

      render(
        <MaskList
          masks={masks}
          selectedId="mask-1"
          onSelect={onSelect}
          onDelete={onDelete}
        />
      );

      const deleteBtn = screen.getByRole('button', { name: /Delete/i });
      await user.click(deleteBtn);
      expect(onDelete).toHaveBeenCalledWith('mask-1');
    });

    it('calls onToggleEnabled when visibility toggled', async () => {
      const user = userEvent.setup();
      const masks = [createTestMask('mask-1', 'Mask 1')];
      const onSelect = vi.fn();
      const onToggleEnabled = vi.fn();

      render(
        <MaskList
          masks={masks}
          selectedId={null}
          onSelect={onSelect}
          onToggleEnabled={onToggleEnabled}
        />
      );

      const toggleBtn = screen.getByRole('button', { name: /Toggle visibility/i });
      await user.click(toggleBtn);
      expect(onToggleEnabled).toHaveBeenCalledWith('mask-1', false);
    });

    it('calls onToggleLocked when lock toggled', async () => {
      const user = userEvent.setup();
      const masks = [createTestMask('mask-1', 'Mask 1')];
      const onSelect = vi.fn();
      const onToggleLocked = vi.fn();

      render(
        <MaskList
          masks={masks}
          selectedId={null}
          onSelect={onSelect}
          onToggleLocked={onToggleLocked}
        />
      );

      const lockBtn = screen.getByRole('button', { name: /Toggle lock/i });
      await user.click(lockBtn);
      expect(onToggleLocked).toHaveBeenCalledWith('mask-1', true);
    });
  });

  // ==========================================================================
  // Disabled State Tests
  // ==========================================================================

  describe('disabled state', () => {
    it('disables all actions when disabled', () => {
      const onSelect = vi.fn();
      const onAdd = vi.fn();

      render(
        <MaskList
          masks={[]}
          selectedId={null}
          onSelect={onSelect}
          onAdd={onAdd}
          disabled={true}
        />
      );

      const addBtn = screen.getByRole('button', { name: /Add Mask/i });
      expect(addBtn).toBeDisabled();
    });
  });
});
