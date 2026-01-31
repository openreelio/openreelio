/**
 * Bin Store Tests
 *
 * TDD: Tests for bin/folder state management.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useBinStore } from './binStore';
import type { Bin, BinColor } from '@/types';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockBin(overrides: Partial<Bin> & { id: string }): Bin {
  return {
    name: `Bin ${overrides.id}`,
    parentId: null,
    color: 'gray' as BinColor,
    createdAt: '2024-01-01T00:00:00Z',
    expanded: true,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('binStore', () => {
  beforeEach(() => {
    // Reset store before each test
    useBinStore.setState({
      bins: new Map(),
      selectedBinId: null,
      editingBinId: null,
    });
  });

  describe('initial state', () => {
    it('should have empty bins', () => {
      const state = useBinStore.getState();
      expect(state.bins.size).toBe(0);
    });

    it('should have null selected bin', () => {
      const state = useBinStore.getState();
      expect(state.selectedBinId).toBeNull();
    });

    it('should have null editing bin', () => {
      const state = useBinStore.getState();
      expect(state.editingBinId).toBeNull();
    });
  });

  describe('setBins', () => {
    it('should set bins from array', () => {
      const bins = [
        createMockBin({ id: 'bin1' }),
        createMockBin({ id: 'bin2' }),
      ];

      useBinStore.getState().setBins(bins);

      const state = useBinStore.getState();
      expect(state.bins.size).toBe(2);
      expect(state.bins.get('bin1')).toBeDefined();
      expect(state.bins.get('bin2')).toBeDefined();
    });
  });

  describe('createBin', () => {
    it('should create a new bin', () => {
      const { createBin } = useBinStore.getState();

      const newBin = createBin('New Folder', null);

      const state = useBinStore.getState();
      expect(state.bins.size).toBe(1);
      expect(state.bins.get(newBin.id)).toBeDefined();
      expect(state.bins.get(newBin.id)?.name).toBe('New Folder');
    });

    it('should create a bin with parent', () => {
      const { createBin } = useBinStore.getState();

      const parentBin = createBin('Parent', null);
      const childBin = createBin('Child', parentBin.id);

      const state = useBinStore.getState();
      expect(state.bins.get(childBin.id)?.parentId).toBe(parentBin.id);
    });

    it('should create a bin with specified color', () => {
      const { createBin } = useBinStore.getState();

      const bin = createBin('Colored', null, 'blue');

      const state = useBinStore.getState();
      expect(state.bins.get(bin.id)?.color).toBe('blue');
    });
  });

  describe('renameBin', () => {
    it('should rename an existing bin', () => {
      const { createBin, renameBin } = useBinStore.getState();

      const bin = createBin('Old Name', null);
      renameBin(bin.id, 'New Name');

      const state = useBinStore.getState();
      expect(state.bins.get(bin.id)?.name).toBe('New Name');
    });

    it('should not fail for non-existent bin', () => {
      const { renameBin } = useBinStore.getState();

      expect(() => renameBin('nonexistent', 'Name')).not.toThrow();
    });
  });

  describe('deleteBin', () => {
    it('should delete a bin', () => {
      const { createBin, deleteBin } = useBinStore.getState();

      const bin = createBin('To Delete', null);
      deleteBin(bin.id);

      const state = useBinStore.getState();
      expect(state.bins.has(bin.id)).toBe(false);
    });

    it('should delete child bins recursively', () => {
      const { createBin, deleteBin } = useBinStore.getState();

      const parent = createBin('Parent', null);
      const child = createBin('Child', parent.id);
      const grandchild = createBin('Grandchild', child.id);

      deleteBin(parent.id);

      const state = useBinStore.getState();
      expect(state.bins.has(parent.id)).toBe(false);
      expect(state.bins.has(child.id)).toBe(false);
      expect(state.bins.has(grandchild.id)).toBe(false);
    });

    it('should clear selection if deleted bin was selected', () => {
      const { createBin, deleteBin, selectBin } = useBinStore.getState();

      const bin = createBin('Selected', null);
      selectBin(bin.id);
      deleteBin(bin.id);

      const state = useBinStore.getState();
      expect(state.selectedBinId).toBeNull();
    });
  });

  describe('moveBin', () => {
    it('should move bin to new parent', () => {
      const { createBin, moveBin } = useBinStore.getState();

      const parent1 = createBin('Parent 1', null);
      const parent2 = createBin('Parent 2', null);
      const child = createBin('Child', parent1.id);

      moveBin(child.id, parent2.id);

      const state = useBinStore.getState();
      expect(state.bins.get(child.id)?.parentId).toBe(parent2.id);
    });

    it('should move bin to root', () => {
      const { createBin, moveBin } = useBinStore.getState();

      const parent = createBin('Parent', null);
      const child = createBin('Child', parent.id);

      moveBin(child.id, null);

      const state = useBinStore.getState();
      expect(state.bins.get(child.id)?.parentId).toBeNull();
    });

    it('should not allow moving to self', () => {
      const { createBin, moveBin } = useBinStore.getState();

      const bin = createBin('Bin', null);
      moveBin(bin.id, bin.id);

      const state = useBinStore.getState();
      expect(state.bins.get(bin.id)?.parentId).toBeNull();
    });

    it('should not allow moving to descendant', () => {
      const { createBin, moveBin } = useBinStore.getState();

      const parent = createBin('Parent', null);
      const child = createBin('Child', parent.id);

      moveBin(parent.id, child.id);

      const state = useBinStore.getState();
      expect(state.bins.get(parent.id)?.parentId).toBeNull();
    });
  });

  describe('selectBin', () => {
    it('should select a bin', () => {
      const { createBin, selectBin } = useBinStore.getState();

      const bin = createBin('Bin', null);
      selectBin(bin.id);

      const state = useBinStore.getState();
      expect(state.selectedBinId).toBe(bin.id);
    });

    it('should select null for root', () => {
      const { createBin, selectBin } = useBinStore.getState();

      const bin = createBin('Bin', null);
      selectBin(bin.id);
      selectBin(null);

      const state = useBinStore.getState();
      expect(state.selectedBinId).toBeNull();
    });
  });

  describe('toggleExpand', () => {
    it('should toggle bin expansion', () => {
      const { createBin, toggleExpand } = useBinStore.getState();

      const bin = createBin('Bin', null);
      const initialExpanded = useBinStore.getState().bins.get(bin.id)?.expanded;

      toggleExpand(bin.id);

      const state = useBinStore.getState();
      expect(state.bins.get(bin.id)?.expanded).toBe(!initialExpanded);
    });
  });

  describe('setBinColor', () => {
    it('should change bin color', () => {
      const { createBin, setBinColor } = useBinStore.getState();

      const bin = createBin('Bin', null);
      setBinColor(bin.id, 'red');

      const state = useBinStore.getState();
      expect(state.bins.get(bin.id)?.color).toBe('red');
    });
  });

  describe('startEditing / cancelEditing', () => {
    it('should set editing bin id', () => {
      const { createBin, startEditing } = useBinStore.getState();

      const bin = createBin('Bin', null);
      startEditing(bin.id);

      const state = useBinStore.getState();
      expect(state.editingBinId).toBe(bin.id);
    });

    it('should clear editing bin id', () => {
      const { createBin, startEditing, cancelEditing } = useBinStore.getState();

      const bin = createBin('Bin', null);
      startEditing(bin.id);
      cancelEditing();

      const state = useBinStore.getState();
      expect(state.editingBinId).toBeNull();
    });
  });

  describe('getBinsArray', () => {
    it('should return array of bins', () => {
      const { createBin } = useBinStore.getState();

      createBin('Bin 1', null);
      createBin('Bin 2', null);

      const binsArray = useBinStore.getState().getBinsArray();

      expect(binsArray).toHaveLength(2);
    });
  });
});
