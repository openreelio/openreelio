/**
 * CommandPalette Component Integration Tests
 *
 * BDD-style tests following Testing Trophy methodology.
 * Tests user-facing behavior, not implementation details.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CommandPalette } from './CommandPalette';
import type { UseCommandPaletteReturn } from '@/hooks/useCommandPalette';
import type { PaletteAction } from '@/stores/commandPaletteStore';

// =============================================================================
// Test Helpers
// =============================================================================

function createAction(overrides: Partial<PaletteAction> & { id: string; label: string }): PaletteAction {
  return {
    category: 'Edit',
    execute: vi.fn(),
    enabled: true,
    ...overrides,
  };
}

function createPaletteReturn(overrides: Partial<UseCommandPaletteReturn> = {}): UseCommandPaletteReturn {
  return {
    isOpen: true,
    searchQuery: '',
    selectedIndex: 0,
    filteredActions: [],
    recentActions: [],
    open: vi.fn(),
    close: vi.fn(),
    setSearchQuery: vi.fn(),
    setSelectedIndex: vi.fn(),
    executeAction: vi.fn(),
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('CommandPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering
  // ===========================================================================

  describe('rendering', () => {
    it('should not render when closed', () => {
      const palette = createPaletteReturn({ isOpen: false });
      render(<CommandPalette palette={palette} />);

      expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
    });

    it('should render modal overlay when open', () => {
      const palette = createPaletteReturn({ isOpen: true });
      render(<CommandPalette palette={palette} />);

      expect(screen.getByTestId('command-palette')).toBeInTheDocument();
      expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    });

    it('should render search input with placeholder', () => {
      const palette = createPaletteReturn();
      render(<CommandPalette palette={palette} />);

      const input = screen.getByTestId('command-palette-input');
      expect(input).toBeInTheDocument();
      expect(input).toHaveAttribute('placeholder', 'Type a command...');
    });

    it('should render action count in footer', () => {
      const actions = [
        createAction({ id: 'a1', label: 'Undo' }),
        createAction({ id: 'a2', label: 'Redo' }),
      ];
      const palette = createPaletteReturn({ filteredActions: actions });
      render(<CommandPalette palette={palette} />);

      expect(screen.getByText('2 commands')).toBeInTheDocument();
    });

    it('should render singular "command" for single action', () => {
      const actions = [createAction({ id: 'a1', label: 'Undo' })];
      const palette = createPaletteReturn({ filteredActions: actions });
      render(<CommandPalette palette={palette} />);

      expect(screen.getByText('1 command')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Action List Display
  // ===========================================================================

  describe('action list', () => {
    it('should display all filtered actions with labels', () => {
      const actions = [
        createAction({ id: 'edit.undo', label: 'Undo', category: 'Edit' }),
        createAction({ id: 'edit.redo', label: 'Redo', category: 'Edit' }),
        createAction({ id: 'view.zoom-in', label: 'Zoom In Timeline', category: 'View' }),
      ];
      const palette = createPaletteReturn({ filteredActions: actions });
      render(<CommandPalette palette={palette} />);

      expect(screen.getByText('Undo')).toBeInTheDocument();
      expect(screen.getByText('Redo')).toBeInTheDocument();
      expect(screen.getByText('Zoom In Timeline')).toBeInTheDocument();
    });

    it('should display keyboard shortcuts next to actions', () => {
      const actions = [
        createAction({ id: 'edit.undo', label: 'Undo', shortcut: 'Ctrl+Z' }),
        createAction({ id: 'edit.save', label: 'Save', shortcut: 'Ctrl+S' }),
      ];
      const palette = createPaletteReturn({ filteredActions: actions });
      render(<CommandPalette palette={palette} />);

      expect(screen.getByText('Ctrl+Z')).toBeInTheDocument();
      expect(screen.getByText('Ctrl+S')).toBeInTheDocument();
    });

    it('should display category labels for actions', () => {
      const actions = [
        createAction({ id: 'edit.undo', label: 'Undo', category: 'Edit' }),
        createAction({ id: 'tool.select', label: 'Selection Tool', category: 'Tools' }),
      ];
      const palette = createPaletteReturn({ filteredActions: actions });
      render(<CommandPalette palette={palette} />);

      expect(screen.getByText('Edit')).toBeInTheDocument();
      expect(screen.getByText('Tools')).toBeInTheDocument();
    });

    it('should show empty state when no actions match', () => {
      const palette = createPaletteReturn({ filteredActions: [], searchQuery: 'xyz' });
      render(<CommandPalette palette={palette} />);

      expect(screen.getByTestId('command-palette-empty')).toBeInTheDocument();
      expect(screen.getByText('No matching commands')).toBeInTheDocument();
    });

    it('should highlight the selected action', () => {
      const actions = [
        createAction({ id: 'a1', label: 'First' }),
        createAction({ id: 'a2', label: 'Second' }),
        createAction({ id: 'a3', label: 'Third' }),
      ];
      const palette = createPaletteReturn({ filteredActions: actions, selectedIndex: 1 });
      render(<CommandPalette palette={palette} />);

      const secondAction = screen.getByTestId('palette-action-a2');
      expect(secondAction).toHaveAttribute('aria-selected', 'true');

      const firstAction = screen.getByTestId('palette-action-a1');
      expect(firstAction).toHaveAttribute('aria-selected', 'false');
    });

    it('should expose a real active-descendant target for assistive tech', () => {
      const actions = [
        createAction({ id: 'a1', label: 'First' }),
        createAction({ id: 'a2', label: 'Second' }),
      ];
      const palette = createPaletteReturn({ filteredActions: actions, selectedIndex: 1 });
      render(<CommandPalette palette={palette} />);

      const input = screen.getByTestId('command-palette-input');
      expect(input).toHaveAttribute('aria-activedescendant', 'palette-action-a2');
      expect(document.getElementById('palette-action-a2')).toBe(
        screen.getByTestId('palette-action-a2'),
      );
    });
  });

  // ===========================================================================
  // Recent Actions
  // ===========================================================================

  describe('recent actions', () => {
    it('should show recent actions section when there are recents and no search query', () => {
      const actions = [createAction({ id: 'a1', label: 'Undo' })];
      const recent = [createAction({ id: 'a1', label: 'Undo' })];
      const palette = createPaletteReturn({
        filteredActions: actions,
        recentActions: recent,
        searchQuery: '',
      });
      render(<CommandPalette palette={palette} />);

      expect(screen.getByText('Recent')).toBeInTheDocument();
    });

    it('should not duplicate recent actions in the main results list', () => {
      const action = createAction({ id: 'a1', label: 'Undo' });
      const palette = createPaletteReturn({
        filteredActions: [action, createAction({ id: 'a2', label: 'Redo' })],
        recentActions: [action],
        searchQuery: '',
      });
      render(<CommandPalette palette={palette} />);

      expect(screen.getAllByText('Undo')).toHaveLength(1);
      expect(screen.getByText('Redo')).toBeInTheDocument();
    });

    it('should highlight a recent action when selectedIndex points to it', () => {
      const action = createAction({ id: 'a1', label: 'Undo' });
      const palette = createPaletteReturn({
        filteredActions: [action, createAction({ id: 'a2', label: 'Redo' })],
        recentActions: [action],
        selectedIndex: 0,
      });
      render(<CommandPalette palette={palette} />);

      expect(screen.getByTestId('palette-action-a1')).toHaveAttribute('aria-selected', 'true');
    });

    it('should not show recent actions section when search query is active', () => {
      const actions = [createAction({ id: 'a1', label: 'Undo' })];
      const palette = createPaletteReturn({
        filteredActions: actions,
        recentActions: [],
        searchQuery: 'undo',
      });
      render(<CommandPalette palette={palette} />);

      expect(screen.queryByText('Recent')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Search Input
  // ===========================================================================

  describe('search input', () => {
    it('should call setSearchQuery when typing', () => {
      const setSearchQuery = vi.fn();
      const palette = createPaletteReturn({ setSearchQuery });
      render(<CommandPalette palette={palette} />);

      const input = screen.getByTestId('command-palette-input');
      fireEvent.change(input, { target: { value: 'split' } });

      expect(setSearchQuery).toHaveBeenCalledWith('split');
    });
  });

  // ===========================================================================
  // Keyboard Navigation
  // ===========================================================================

  describe('keyboard navigation', () => {
    it('should close palette when Escape is pressed', () => {
      const close = vi.fn();
      const palette = createPaletteReturn({ close });
      render(<CommandPalette palette={palette} />);

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

      expect(close).toHaveBeenCalledTimes(1);
    });

    it('should move selection down when ArrowDown is pressed', () => {
      const setSelectedIndex = vi.fn();
      const actions = [
        createAction({ id: 'a1', label: 'First' }),
        createAction({ id: 'a2', label: 'Second' }),
      ];
      const palette = createPaletteReturn({
        filteredActions: actions,
        selectedIndex: 0,
        setSelectedIndex,
      });
      render(<CommandPalette palette={palette} />);

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' });

      expect(setSelectedIndex).toHaveBeenCalledWith(1);
    });

    it('should wrap selection to top when ArrowDown at end', () => {
      const setSelectedIndex = vi.fn();
      const actions = [
        createAction({ id: 'a1', label: 'First' }),
        createAction({ id: 'a2', label: 'Second' }),
      ];
      const palette = createPaletteReturn({
        filteredActions: actions,
        selectedIndex: 1,
        setSelectedIndex,
      });
      render(<CommandPalette palette={palette} />);

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' });

      expect(setSelectedIndex).toHaveBeenCalledWith(0);
    });

    it('should move selection up when ArrowUp is pressed', () => {
      const setSelectedIndex = vi.fn();
      const actions = [
        createAction({ id: 'a1', label: 'First' }),
        createAction({ id: 'a2', label: 'Second' }),
      ];
      const palette = createPaletteReturn({
        filteredActions: actions,
        selectedIndex: 1,
        setSelectedIndex,
      });
      render(<CommandPalette palette={palette} />);

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowUp' });

      expect(setSelectedIndex).toHaveBeenCalledWith(0);
    });

    it('should wrap selection to bottom when ArrowUp at top', () => {
      const setSelectedIndex = vi.fn();
      const actions = [
        createAction({ id: 'a1', label: 'First' }),
        createAction({ id: 'a2', label: 'Second' }),
      ];
      const palette = createPaletteReturn({
        filteredActions: actions,
        selectedIndex: 0,
        setSelectedIndex,
      });
      render(<CommandPalette palette={palette} />);

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowUp' });

      expect(setSelectedIndex).toHaveBeenCalledWith(1);
    });

    it('should execute selected action when Enter is pressed', () => {
      const executeAction = vi.fn();
      const actions = [
        createAction({ id: 'edit.undo', label: 'Undo' }),
        createAction({ id: 'edit.redo', label: 'Redo' }),
      ];
      const palette = createPaletteReturn({
        filteredActions: actions,
        selectedIndex: 0,
        executeAction,
      });
      render(<CommandPalette palette={palette} />);

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });

      expect(executeAction).toHaveBeenCalledWith('edit.undo');
    });

    it('should execute the selected recent action when Enter is pressed', () => {
      const executeAction = vi.fn();
      const recent = createAction({ id: 'recent', label: 'Recent Action' });
      const palette = createPaletteReturn({
        filteredActions: [createAction({ id: 'a1', label: 'First' })],
        recentActions: [recent],
        selectedIndex: 0,
        executeAction,
      });
      render(<CommandPalette palette={palette} />);

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });

      expect(executeAction).toHaveBeenCalledWith('recent');
    });

    it('should not move selection when ArrowUp is pressed with no actions', () => {
      const setSelectedIndex = vi.fn();
      const palette = createPaletteReturn({
        filteredActions: [],
        recentActions: [],
        setSelectedIndex,
      });
      render(<CommandPalette palette={palette} />);

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowUp' });

      expect(setSelectedIndex).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Mouse Interaction
  // ===========================================================================

  describe('mouse interaction', () => {
    it('should execute action when clicked', () => {
      const executeAction = vi.fn();
      const actions = [createAction({ id: 'edit.undo', label: 'Undo' })];
      const palette = createPaletteReturn({ filteredActions: actions, executeAction });
      render(<CommandPalette palette={palette} />);

      fireEvent.click(screen.getByTestId('palette-action-edit.undo'));

      expect(executeAction).toHaveBeenCalledWith('edit.undo');
    });

    it('should close when overlay is clicked', () => {
      const close = vi.fn();
      const palette = createPaletteReturn({ close });
      render(<CommandPalette palette={palette} />);

      // Click the overlay (not the dialog box)
      const overlay = screen.getByTestId('command-palette');
      fireEvent.click(overlay, { target: overlay });

      expect(close).toHaveBeenCalledTimes(1);
    });

    it('should update selected index on hover', () => {
      const setSelectedIndex = vi.fn();
      const actions = [
        createAction({ id: 'a1', label: 'First' }),
        createAction({ id: 'a2', label: 'Second' }),
      ];
      const palette = createPaletteReturn({
        filteredActions: actions,
        setSelectedIndex,
      });
      render(<CommandPalette palette={palette} />);

      fireEvent.mouseEnter(screen.getByTestId('palette-action-a2'));

      expect(setSelectedIndex).toHaveBeenCalledWith(1);
    });
  });

  // ===========================================================================
  // Accessibility
  // ===========================================================================

  describe('accessibility', () => {
    it('should have proper ARIA attributes for dialog', () => {
      const palette = createPaletteReturn();
      render(<CommandPalette palette={palette} />);

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-label', 'Command Palette');
    });

    it('should have combobox role on search input', () => {
      const palette = createPaletteReturn();
      render(<CommandPalette palette={palette} />);

      const input = screen.getByRole('combobox');
      expect(input).toHaveAttribute('aria-expanded', 'true');
      expect(input).toHaveAttribute('aria-controls', 'command-palette-list');
    });

    it('should have listbox role on action list', () => {
      const palette = createPaletteReturn();
      render(<CommandPalette palette={palette} />);

      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    it('should set aria-selected on the highlighted action', () => {
      const actions = [
        createAction({ id: 'a1', label: 'First' }),
        createAction({ id: 'a2', label: 'Second' }),
      ];
      const palette = createPaletteReturn({ filteredActions: actions, selectedIndex: 1 });
      render(<CommandPalette palette={palette} />);

      expect(screen.getByTestId('palette-action-a2')).toHaveAttribute('aria-selected', 'true');
    });
  });
});
