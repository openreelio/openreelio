/**
 * BinTree Tests
 *
 * TDD: Tests for the bin/folder tree navigation component.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { BinTree } from './BinTree';
import type { Bin, Asset, BinColor } from '@/types';

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

function createMockAsset(overrides: Partial<Asset> & { id: string }): Asset {
  return {
    kind: 'video',
    name: `Asset ${overrides.id}`,
    uri: `/path/to/${overrides.id}`,
    hash: 'abc123',
    fileSize: 1000,
    importedAt: '2024-01-01T00:00:00Z',
    license: {
      source: 'user',
      licenseType: 'unknown',
      allowedUse: [],
    },
    tags: [],
    proxyStatus: 'notNeeded',
    binId: null,
    ...overrides,
  };
}

// =============================================================================
// Rendering Tests
// =============================================================================

describe('BinTree', () => {
  describe('rendering', () => {
    it('should render the bin tree container', () => {
      render(<BinTree bins={[]} assets={[]} />);

      expect(screen.getByTestId('bin-tree')).toBeInTheDocument();
    });

    it('should show empty message when no bins', () => {
      render(<BinTree bins={[]} assets={[]} />);

      expect(screen.getByText('No folders')).toBeInTheDocument();
    });

    it('should render bins', () => {
      const bins = [
        createMockBin({ id: 'bin1', name: 'Footage' }),
        createMockBin({ id: 'bin2', name: 'Audio' }),
      ];

      render(<BinTree bins={bins} assets={[]} />);

      expect(screen.getByText('Footage')).toBeInTheDocument();
      expect(screen.getByText('Audio')).toBeInTheDocument();
    });

    it('should render root item for navigating to root', () => {
      const bins = [createMockBin({ id: 'bin1' })];

      render(<BinTree bins={bins} assets={[]} showRoot={true} />);

      expect(screen.getByTestId('bin-tree-root')).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(<BinTree bins={[]} assets={[]} className="custom-class" />);

      expect(screen.getByTestId('bin-tree')).toHaveClass('custom-class');
    });
  });

  // ===========================================================================
  // Hierarchy Tests
  // ===========================================================================

  describe('hierarchy', () => {
    it('should render nested bins', () => {
      const bins = [
        createMockBin({ id: 'parent', name: 'Parent', expanded: true }),
        createMockBin({ id: 'child', name: 'Child', parentId: 'parent' }),
      ];

      render(<BinTree bins={bins} assets={[]} />);

      expect(screen.getByText('Parent')).toBeInTheDocument();
      expect(screen.getByText('Child')).toBeInTheDocument();
    });

    it('should hide children when parent is collapsed', () => {
      const bins = [
        createMockBin({ id: 'parent', name: 'Parent', expanded: false }),
        createMockBin({ id: 'child', name: 'Child', parentId: 'parent' }),
      ];

      render(<BinTree bins={bins} assets={[]} />);

      expect(screen.getByText('Parent')).toBeInTheDocument();
      expect(screen.queryByText('Child')).not.toBeInTheDocument();
    });

    it('should show children when parent is expanded', () => {
      const bins = [
        createMockBin({ id: 'parent', name: 'Parent', expanded: true }),
        createMockBin({ id: 'child', name: 'Child', parentId: 'parent' }),
      ];

      render(<BinTree bins={bins} assets={[]} />);

      expect(screen.getByText('Parent')).toBeInTheDocument();
      expect(screen.getByText('Child')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Selection Tests
  // ===========================================================================

  describe('selection', () => {
    it('should highlight selected bin', () => {
      const bins = [createMockBin({ id: 'bin1', name: 'Bin 1' })];

      render(<BinTree bins={bins} assets={[]} selectedBinId="bin1" />);

      const binItem = screen.getByTestId('bin-item-bin1');
      expect(binItem).toHaveClass('bg-primary-500/20');
    });

    it('should call onSelectBin when bin is clicked', () => {
      const onSelectBin = vi.fn();
      const bins = [createMockBin({ id: 'bin1' })];

      render(<BinTree bins={bins} assets={[]} onSelectBin={onSelectBin} />);

      fireEvent.click(screen.getByTestId('bin-item-bin1'));

      expect(onSelectBin).toHaveBeenCalledWith('bin1');
    });

    it('should call onSelectBin with null when root is clicked', () => {
      const onSelectBin = vi.fn();
      const bins = [createMockBin({ id: 'bin1' })];

      render(<BinTree bins={bins} assets={[]} showRoot={true} onSelectBin={onSelectBin} />);

      fireEvent.click(screen.getByTestId('bin-tree-root'));

      expect(onSelectBin).toHaveBeenCalledWith(null);
    });
  });

  // ===========================================================================
  // Expand/Collapse Tests
  // ===========================================================================

  describe('expand/collapse', () => {
    it('should call onToggleExpand when expand icon clicked', () => {
      const onToggleExpand = vi.fn();
      const bins = [
        createMockBin({ id: 'parent', expanded: false }),
        createMockBin({ id: 'child', parentId: 'parent' }),
      ];

      render(<BinTree bins={bins} assets={[]} onToggleExpand={onToggleExpand} />);

      const expandIcon = screen.getByTestId('bin-expand-icon');
      fireEvent.click(expandIcon);

      expect(onToggleExpand).toHaveBeenCalledWith('parent');
    });
  });

  // ===========================================================================
  // Asset Count Tests
  // ===========================================================================

  describe('asset counts', () => {
    it('should display asset count for bins with assets', () => {
      const bins = [createMockBin({ id: 'bin1' })];
      const assets = [
        createMockAsset({ id: 'asset1', binId: 'bin1' }),
        createMockAsset({ id: 'asset2', binId: 'bin1' }),
      ];

      render(<BinTree bins={bins} assets={assets} />);

      expect(screen.getByTestId('bin-asset-count')).toHaveTextContent('2');
    });

    it('should not display asset count for empty bins', () => {
      const bins = [createMockBin({ id: 'bin1' })];

      render(<BinTree bins={bins} assets={[]} />);

      expect(screen.queryByTestId('bin-asset-count')).not.toBeInTheDocument();
    });

    it('should include descendant assets in parent bin count', () => {
      const bins = [
        createMockBin({ id: 'parent', name: 'Parent' }),
        createMockBin({ id: 'child', name: 'Child', parentId: 'parent' }),
      ];
      const assets = [
        createMockAsset({ id: 'asset_parent', binId: 'parent' }),
        createMockAsset({ id: 'asset_child', binId: 'child' }),
      ];

      render(<BinTree bins={bins} assets={assets} />);

      const parentItem = screen.getByTestId('bin-item-parent');
      expect(within(parentItem).getByTestId('bin-asset-count')).toHaveTextContent('2');
    });

    it('should show all assets in root badge', () => {
      const bins = [createMockBin({ id: 'bin1', name: 'Footage' })];
      const assets = [
        createMockAsset({ id: 'asset_root', binId: null }),
        createMockAsset({ id: 'asset_in_bin', binId: 'bin1' }),
      ];

      render(<BinTree bins={bins} assets={assets} showRoot={true} />);

      const root = screen.getByTestId('bin-tree-root');
      expect(within(root).getByText('2')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Create Bin Tests
  // ===========================================================================

  describe('create bin', () => {
    it('should show create bin button', () => {
      render(<BinTree bins={[]} assets={[]} onCreateBin={vi.fn()} />);

      expect(screen.getByTestId('create-bin-button')).toBeInTheDocument();
    });

    it('should call onCreateBin when button clicked', () => {
      const onCreateBin = vi.fn();

      render(<BinTree bins={[]} assets={[]} onCreateBin={onCreateBin} />);

      fireEvent.click(screen.getByTestId('create-bin-button'));

      expect(onCreateBin).toHaveBeenCalledWith(null); // Create at root
    });

    it('should not show create button when onCreateBin not provided', () => {
      render(<BinTree bins={[]} assets={[]} />);

      expect(screen.queryByTestId('create-bin-button')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Context Menu Tests
  // ===========================================================================

  describe('context menu', () => {
    it('should call onContextMenu when bin is right-clicked', () => {
      const onContextMenu = vi.fn();
      const bins = [createMockBin({ id: 'bin1' })];

      render(<BinTree bins={bins} assets={[]} onContextMenu={onContextMenu} />);

      fireEvent.contextMenu(screen.getByTestId('bin-item-bin1'));

      expect(onContextMenu).toHaveBeenCalledWith('bin1', expect.any(Object));
    });
  });

  // ===========================================================================
  // Inline Editing Tests
  // ===========================================================================

  describe('inline editing', () => {
    it('should show input when bin is being edited', () => {
      const bins = [createMockBin({ id: 'bin1' })];

      render(<BinTree bins={bins} assets={[]} editingBinId="bin1" />);

      expect(screen.getByTestId('bin-name-input')).toBeInTheDocument();
    });

    it('should call onRenameBin when editing completes', () => {
      const onRenameBin = vi.fn();
      const bins = [createMockBin({ id: 'bin1', name: 'Old Name' })];

      render(<BinTree bins={bins} assets={[]} editingBinId="bin1" onRenameBin={onRenameBin} />);

      const input = screen.getByTestId('bin-name-input');
      fireEvent.change(input, { target: { value: 'New Name' } });
      fireEvent.blur(input);

      expect(onRenameBin).toHaveBeenCalledWith('bin1', 'New Name');
    });
  });

  // ===========================================================================
  // Drag and Drop Tests
  // ===========================================================================

  describe('drag and drop', () => {
    it('should call onMoveBin when bin dropped on another', () => {
      const onMoveBin = vi.fn();
      const bins = [createMockBin({ id: 'bin1' }), createMockBin({ id: 'bin2' })];

      render(<BinTree bins={bins} assets={[]} onMoveBin={onMoveBin} />);

      const bin1 = screen.getByTestId('bin-item-bin1');
      const bin2 = screen.getByTestId('bin-item-bin2');

      // Start dragging bin1
      fireEvent.dragStart(bin1, {
        dataTransfer: { setData: vi.fn() },
      });

      // Drop on bin2
      fireEvent.drop(bin2, {
        dataTransfer: { getData: () => 'bin1' },
      });

      expect(onMoveBin).toHaveBeenCalledWith('bin1', 'bin2');
    });

    it('should call onMoveAssetToBin when asset dropped on bin', () => {
      const onMoveAssetToBin = vi.fn();
      const bins = [createMockBin({ id: 'bin1' })];

      render(<BinTree bins={bins} assets={[]} onMoveAssetToBin={onMoveAssetToBin} />);

      const bin1 = screen.getByTestId('bin-item-bin1');

      // Drop asset on bin
      fireEvent.drop(bin1, {
        dataTransfer: {
          getData: (type: string) => {
            if (type === 'application/x-asset-id') return 'asset1';
            return '';
          },
        },
      });

      expect(onMoveAssetToBin).toHaveBeenCalledWith('asset1', 'bin1');
    });

    it('should call onMoveAssetToBin with null when dropped on root', () => {
      const onMoveAssetToBin = vi.fn();
      const bins = [createMockBin({ id: 'bin1' })];

      render(
        <BinTree bins={bins} assets={[]} showRoot={true} onMoveAssetToBin={onMoveAssetToBin} />,
      );

      const root = screen.getByTestId('bin-tree-root');

      fireEvent.drop(root, {
        dataTransfer: {
          getData: (type: string) => {
            if (type === 'application/x-asset-id') return 'asset1';
            return '';
          },
        },
      });

      expect(onMoveAssetToBin).toHaveBeenCalledWith('asset1', null);
    });
  });

  // ===========================================================================
  // Sorting Tests
  // ===========================================================================

  describe('sorting', () => {
    it('should sort bins alphabetically by default', () => {
      const bins = [
        createMockBin({ id: 'bin1', name: 'Zebra' }),
        createMockBin({ id: 'bin2', name: 'Apple' }),
        createMockBin({ id: 'bin3', name: 'Mango' }),
      ];

      render(<BinTree bins={bins} assets={[]} />);

      const items = screen.getAllByTestId(/^bin-item-/);
      expect(within(items[0]).getByText('Apple')).toBeInTheDocument();
      expect(within(items[1]).getByText('Mango')).toBeInTheDocument();
      expect(within(items[2]).getByText('Zebra')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Edge Case & Destructive Tests
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle deeply nested hierarchy (3+ levels)', () => {
      const bins = [
        createMockBin({ id: 'root', name: 'Root', expanded: true }),
        createMockBin({ id: 'child', name: 'Child', parentId: 'root', expanded: true }),
        createMockBin({ id: 'grandchild', name: 'Grandchild', parentId: 'child' }),
      ];

      render(<BinTree bins={bins} assets={[]} />);

      expect(screen.getByText('Root')).toBeInTheDocument();
      expect(screen.getByText('Child')).toBeInTheDocument();
      expect(screen.getByText('Grandchild')).toBeInTheDocument();
    });

    it('should aggregate asset counts across deep nesting', () => {
      const bins = [
        createMockBin({ id: 'root', name: 'Root', expanded: true }),
        createMockBin({ id: 'child', name: 'Child', parentId: 'root', expanded: true }),
        createMockBin({ id: 'grandchild', name: 'Grandchild', parentId: 'child' }),
      ];
      const assets = [
        createMockAsset({ id: 'a1', binId: 'root' }),
        createMockAsset({ id: 'a2', binId: 'child' }),
        createMockAsset({ id: 'a3', binId: 'grandchild' }),
      ];

      render(<BinTree bins={bins} assets={assets} />);

      // Root should show 3 (1 direct + 1 child + 1 grandchild)
      const rootItem = screen.getByTestId('bin-item-root');
      expect(within(rootItem).getByTestId('bin-asset-count')).toHaveTextContent('3');
    });

    it('should handle bins with no name gracefully', () => {
      const bins = [createMockBin({ id: 'bin1', name: '' })];

      render(<BinTree bins={bins} assets={[]} />);

      // Should still render the bin item even with empty name
      expect(screen.getByTestId('bin-item-bin1')).toBeInTheDocument();
    });

    it('should handle large number of bins', () => {
      const bins = Array.from({ length: 50 }, (_, i) =>
        createMockBin({ id: `bin-${i}`, name: `Bin ${i}` }),
      );

      render(<BinTree bins={bins} assets={[]} />);

      expect(screen.getAllByTestId(/^bin-item-/)).toHaveLength(50);
    });

    it('should handle orphaned bins (parent does not exist)', () => {
      const bins = [createMockBin({ id: 'orphan', name: 'Orphan', parentId: 'nonexistent' })];

      // Should not crash; orphan is rendered at root level by buildBinTree
      expect(() => render(<BinTree bins={bins} assets={[]} />)).not.toThrow();
    });

    it('should show root asset count including unassigned assets', () => {
      const bins = [createMockBin({ id: 'bin1' })];
      const assets = [
        createMockAsset({ id: 'unassigned1', binId: null }),
        createMockAsset({ id: 'unassigned2', binId: null }),
        createMockAsset({ id: 'inBin', binId: 'bin1' }),
      ];

      render(<BinTree bins={bins} assets={assets} showRoot />);

      const root = screen.getByTestId('bin-tree-root');
      // Root should count all assets: 2 unassigned + 1 in bin
      expect(within(root).getByText('3')).toBeInTheDocument();
    });

    it('should not allow dropping a bin on itself', () => {
      const onMoveBin = vi.fn();
      const bins = [createMockBin({ id: 'bin1' })];

      render(<BinTree bins={bins} assets={[]} onMoveBin={onMoveBin} />);

      const bin1 = screen.getByTestId('bin-item-bin1');

      fireEvent.dragStart(bin1, {
        dataTransfer: { setData: vi.fn() },
      });

      fireEvent.drop(bin1, {
        dataTransfer: { getData: () => 'bin1' },
      });

      expect(onMoveBin).not.toHaveBeenCalled();
    });

    it('should handle drag events when dataTransfer.getData throws', () => {
      const onMoveBin = vi.fn();
      const bins = [createMockBin({ id: 'bin1' })];

      render(<BinTree bins={bins} assets={[]} onMoveBin={onMoveBin} />);

      const bin1 = screen.getByTestId('bin-item-bin1');

      // getData throwing should be caught gracefully
      expect(() => {
        fireEvent.drop(bin1, {
          dataTransfer: {
            getData: () => {
              throw new Error('Security restriction');
            },
          },
        });
      }).not.toThrow();

      expect(onMoveBin).not.toHaveBeenCalled();
    });
  });
});
