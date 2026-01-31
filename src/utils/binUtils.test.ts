/**
 * Bin Utilities Tests
 *
 * TDD: Tests for bin/folder management utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  buildBinTree,
  getBinPath,
  getBinChildren,
  getBinAncestors,
  getAssetsInBin,
  canMoveBinTo,
  sortBins,
  flattenBinTree,
  BIN_COLORS,
  getDefaultBinColor,
} from './binUtils';
import type { Bin, Asset, BinId } from '@/types';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockBin(overrides: Partial<Bin> & { id: string }): Bin {
  return {
    name: `Bin ${overrides.id}`,
    parentId: null,
    color: 'gray',
    createdAt: '2024-01-01T00:00:00Z',
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
// buildBinTree Tests
// =============================================================================

describe('buildBinTree', () => {
  it('should return empty array for empty input', () => {
    const result = buildBinTree([]);
    expect(result).toEqual([]);
  });

  it('should return flat list when all bins are at root', () => {
    const bins = [
      createMockBin({ id: 'bin1', parentId: null }),
      createMockBin({ id: 'bin2', parentId: null }),
    ];

    const result = buildBinTree(bins);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('bin1');
    expect(result[0].children).toEqual([]);
    expect(result[1].id).toBe('bin2');
    expect(result[1].children).toEqual([]);
  });

  it('should nest child bins under parent', () => {
    const bins = [
      createMockBin({ id: 'parent', parentId: null }),
      createMockBin({ id: 'child1', parentId: 'parent' }),
      createMockBin({ id: 'child2', parentId: 'parent' }),
    ];

    const result = buildBinTree(bins);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('parent');
    expect(result[0].children).toHaveLength(2);
    expect(result[0].children[0].id).toBe('child1');
    expect(result[0].children[1].id).toBe('child2');
  });

  it('should handle deeply nested bins', () => {
    const bins = [
      createMockBin({ id: 'level1', parentId: null }),
      createMockBin({ id: 'level2', parentId: 'level1' }),
      createMockBin({ id: 'level3', parentId: 'level2' }),
    ];

    const result = buildBinTree(bins);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('level1');
    expect(result[0].children[0].id).toBe('level2');
    expect(result[0].children[0].children[0].id).toBe('level3');
  });

  it('should handle bins with missing parents as root bins', () => {
    const bins = [
      createMockBin({ id: 'orphan', parentId: 'nonexistent' }),
    ];

    const result = buildBinTree(bins);

    // Orphan bins should be treated as root level
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('orphan');
  });
});

// =============================================================================
// getBinPath Tests
// =============================================================================

describe('getBinPath', () => {
  it('should return empty array for root level', () => {
    const bins = new Map<BinId, Bin>();
    const result = getBinPath(null, bins);
    expect(result).toEqual([]);
  });

  it('should return single bin for top-level bin', () => {
    const bin = createMockBin({ id: 'bin1', parentId: null });
    const bins = new Map<BinId, Bin>([['bin1', bin]]);

    const result = getBinPath('bin1', bins);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('bin1');
  });

  it('should return full path for nested bin', () => {
    const parent = createMockBin({ id: 'parent', parentId: null, name: 'Parent' });
    const child = createMockBin({ id: 'child', parentId: 'parent', name: 'Child' });
    const grandchild = createMockBin({ id: 'grandchild', parentId: 'child', name: 'Grandchild' });
    const bins = new Map<BinId, Bin>([
      ['parent', parent],
      ['child', child],
      ['grandchild', grandchild],
    ]);

    const result = getBinPath('grandchild', bins);

    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('Parent');
    expect(result[1].name).toBe('Child');
    expect(result[2].name).toBe('Grandchild');
  });
});

// =============================================================================
// getBinChildren Tests
// =============================================================================

describe('getBinChildren', () => {
  it('should return empty array when no children', () => {
    const bins = [
      createMockBin({ id: 'bin1', parentId: null }),
    ];

    const result = getBinChildren('bin1', bins);

    expect(result).toEqual([]);
  });

  it('should return direct children only', () => {
    const bins = [
      createMockBin({ id: 'parent', parentId: null }),
      createMockBin({ id: 'child1', parentId: 'parent' }),
      createMockBin({ id: 'child2', parentId: 'parent' }),
      createMockBin({ id: 'grandchild', parentId: 'child1' }),
    ];

    const result = getBinChildren('parent', bins);

    expect(result).toHaveLength(2);
    expect(result.map((b) => b.id)).toContain('child1');
    expect(result.map((b) => b.id)).toContain('child2');
    expect(result.map((b) => b.id)).not.toContain('grandchild');
  });

  it('should return root bins when parentId is null', () => {
    const bins = [
      createMockBin({ id: 'root1', parentId: null }),
      createMockBin({ id: 'root2', parentId: null }),
      createMockBin({ id: 'child', parentId: 'root1' }),
    ];

    const result = getBinChildren(null, bins);

    expect(result).toHaveLength(2);
    expect(result.map((b) => b.id)).toContain('root1');
    expect(result.map((b) => b.id)).toContain('root2');
  });
});

// =============================================================================
// getBinAncestors Tests
// =============================================================================

describe('getBinAncestors', () => {
  it('should return empty set for root bin', () => {
    const bin = createMockBin({ id: 'root', parentId: null });
    const bins = new Map<BinId, Bin>([['root', bin]]);

    const result = getBinAncestors('root', bins);

    expect(result.size).toBe(0);
  });

  it('should return all ancestors', () => {
    const grandparent = createMockBin({ id: 'gp', parentId: null });
    const parent = createMockBin({ id: 'p', parentId: 'gp' });
    const child = createMockBin({ id: 'c', parentId: 'p' });
    const bins = new Map<BinId, Bin>([
      ['gp', grandparent],
      ['p', parent],
      ['c', child],
    ]);

    const result = getBinAncestors('c', bins);

    expect(result.size).toBe(2);
    expect(result.has('gp')).toBe(true);
    expect(result.has('p')).toBe(true);
    expect(result.has('c')).toBe(false);
  });
});

// =============================================================================
// getAssetsInBin Tests
// =============================================================================

describe('getAssetsInBin', () => {
  it('should return empty array when no assets', () => {
    const result = getAssetsInBin('bin1', []);
    expect(result).toEqual([]);
  });

  it('should return assets in specific bin', () => {
    const assets = [
      createMockAsset({ id: 'asset1', binId: 'bin1' }),
      createMockAsset({ id: 'asset2', binId: 'bin1' }),
      createMockAsset({ id: 'asset3', binId: 'bin2' }),
    ];

    const result = getAssetsInBin('bin1', assets);

    expect(result).toHaveLength(2);
    expect(result.map((a) => a.id)).toContain('asset1');
    expect(result.map((a) => a.id)).toContain('asset2');
  });

  it('should return root assets when binId is null', () => {
    const assets = [
      createMockAsset({ id: 'asset1', binId: null }),
      createMockAsset({ id: 'asset2', binId: undefined }),
      createMockAsset({ id: 'asset3', binId: 'bin1' }),
    ];

    const result = getAssetsInBin(null, assets);

    expect(result).toHaveLength(2);
    expect(result.map((a) => a.id)).toContain('asset1');
    expect(result.map((a) => a.id)).toContain('asset2');
  });
});

// =============================================================================
// canMoveBinTo Tests
// =============================================================================

describe('canMoveBinTo', () => {
  it('should allow moving to root', () => {
    const bin = createMockBin({ id: 'bin1', parentId: null });
    const bins = new Map<BinId, Bin>([['bin1', bin]]);

    const result = canMoveBinTo('bin1', null, bins);

    expect(result).toBe(true);
  });

  it('should prevent moving to self', () => {
    const bin = createMockBin({ id: 'bin1', parentId: null });
    const bins = new Map<BinId, Bin>([['bin1', bin]]);

    const result = canMoveBinTo('bin1', 'bin1', bins);

    expect(result).toBe(false);
  });

  it('should prevent moving to descendant', () => {
    const parent = createMockBin({ id: 'parent', parentId: null });
    const child = createMockBin({ id: 'child', parentId: 'parent' });
    const grandchild = createMockBin({ id: 'grandchild', parentId: 'child' });
    const bins = new Map<BinId, Bin>([
      ['parent', parent],
      ['child', child],
      ['grandchild', grandchild],
    ]);

    // Cannot move parent into child (its descendant)
    expect(canMoveBinTo('parent', 'child', bins)).toBe(false);
    expect(canMoveBinTo('parent', 'grandchild', bins)).toBe(false);
  });

  it('should allow moving to non-descendant', () => {
    const bin1 = createMockBin({ id: 'bin1', parentId: null });
    const bin2 = createMockBin({ id: 'bin2', parentId: null });
    const bins = new Map<BinId, Bin>([
      ['bin1', bin1],
      ['bin2', bin2],
    ]);

    const result = canMoveBinTo('bin1', 'bin2', bins);

    expect(result).toBe(true);
  });
});

// =============================================================================
// sortBins Tests
// =============================================================================

describe('sortBins', () => {
  it('should sort bins alphabetically by name', () => {
    const bins = [
      createMockBin({ id: 'bin1', name: 'Zebra' }),
      createMockBin({ id: 'bin2', name: 'Apple' }),
      createMockBin({ id: 'bin3', name: 'Mango' }),
    ];

    const result = sortBins(bins);

    expect(result[0].name).toBe('Apple');
    expect(result[1].name).toBe('Mango');
    expect(result[2].name).toBe('Zebra');
  });

  it('should handle case-insensitive sorting', () => {
    const bins = [
      createMockBin({ id: 'bin1', name: 'zebra' }),
      createMockBin({ id: 'bin2', name: 'Apple' }),
    ];

    const result = sortBins(bins);

    expect(result[0].name).toBe('Apple');
    expect(result[1].name).toBe('zebra');
  });
});

// =============================================================================
// flattenBinTree Tests
// =============================================================================

describe('flattenBinTree', () => {
  it('should return empty array for empty tree', () => {
    const result = flattenBinTree([]);
    expect(result).toEqual([]);
  });

  it('should flatten nested structure with depth info', () => {
    const bins = [
      createMockBin({ id: 'parent', parentId: null }),
      createMockBin({ id: 'child', parentId: 'parent' }),
    ];
    const tree = buildBinTree(bins);

    const result = flattenBinTree(tree);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ bin: expect.objectContaining({ id: 'parent' }), depth: 0 });
    expect(result[1]).toEqual({ bin: expect.objectContaining({ id: 'child' }), depth: 1 });
  });
});

// =============================================================================
// Constants Tests
// =============================================================================

describe('BIN_COLORS', () => {
  it('should have all bin color options', () => {
    expect(BIN_COLORS).toContain('gray');
    expect(BIN_COLORS).toContain('red');
    expect(BIN_COLORS).toContain('orange');
    expect(BIN_COLORS).toContain('yellow');
    expect(BIN_COLORS).toContain('green');
    expect(BIN_COLORS).toContain('blue');
    expect(BIN_COLORS).toContain('purple');
    expect(BIN_COLORS).toContain('pink');
  });
});

describe('getDefaultBinColor', () => {
  it('should return a valid bin color', () => {
    const color = getDefaultBinColor();
    expect(BIN_COLORS).toContain(color);
  });
});
