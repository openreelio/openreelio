/**
 * Bin Utilities
 *
 * Functions for managing bins (folders) in the Project Explorer.
 * Handles tree building, path resolution, and hierarchy operations.
 */

import type { Bin, BinId, BinColor, Asset } from '@/types';

// =============================================================================
// Types
// =============================================================================

/** Bin node in a tree structure */
export interface BinTreeNode {
  id: BinId;
  name: string;
  parentId: BinId | null;
  color: BinColor;
  createdAt: string;
  expanded?: boolean;
  children: BinTreeNode[];
}

/** Flattened bin with depth information for rendering */
export interface FlattenedBin {
  bin: BinTreeNode;
  depth: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Available bin colors */
export const BIN_COLORS: readonly BinColor[] = [
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
] as const;

/** CSS classes for bin colors */
export const BIN_COLOR_CLASSES: Record<BinColor, { bg: string; text: string; border: string }> = {
  gray: { bg: 'bg-gray-500', text: 'text-gray-500', border: 'border-gray-500' },
  red: { bg: 'bg-red-500', text: 'text-red-500', border: 'border-red-500' },
  orange: { bg: 'bg-orange-500', text: 'text-orange-500', border: 'border-orange-500' },
  yellow: { bg: 'bg-yellow-500', text: 'text-yellow-500', border: 'border-yellow-500' },
  green: { bg: 'bg-green-500', text: 'text-green-500', border: 'border-green-500' },
  blue: { bg: 'bg-blue-500', text: 'text-blue-500', border: 'border-blue-500' },
  purple: { bg: 'bg-purple-500', text: 'text-purple-500', border: 'border-purple-500' },
  pink: { bg: 'bg-pink-500', text: 'text-pink-500', border: 'border-pink-500' },
};

// =============================================================================
// Tree Building
// =============================================================================

/**
 * Builds a hierarchical tree structure from a flat list of bins.
 *
 * @param bins - Flat array of bins
 * @returns Array of root-level BinTreeNodes with nested children
 */
export function buildBinTree(bins: Bin[]): BinTreeNode[] {
  if (bins.length === 0) return [];

  // Create a map for quick lookup
  const binMap = new Map<BinId, BinTreeNode>();
  const rootNodes: BinTreeNode[] = [];

  // First pass: create tree nodes without children
  for (const bin of bins) {
    binMap.set(bin.id, {
      id: bin.id,
      name: bin.name,
      parentId: bin.parentId,
      color: bin.color,
      createdAt: bin.createdAt,
      expanded: bin.expanded,
      children: [],
    });
  }

  // Second pass: build the tree structure
  for (const bin of bins) {
    const node = binMap.get(bin.id)!;

    if (bin.parentId === null) {
      // Root level bin
      rootNodes.push(node);
    } else {
      // Child bin - find parent
      const parent = binMap.get(bin.parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        // Orphan bin (parent not found) - treat as root
        rootNodes.push(node);
      }
    }
  }

  return rootNodes;
}

/**
 * Flattens a bin tree into a list with depth information for rendering.
 *
 * @param tree - Array of root BinTreeNodes
 * @param depth - Current depth (internal use)
 * @returns Flattened array with depth info
 */
export function flattenBinTree(tree: BinTreeNode[], depth: number = 0): FlattenedBin[] {
  const result: FlattenedBin[] = [];

  for (const node of tree) {
    result.push({ bin: node, depth });
    if (node.children.length > 0) {
      result.push(...flattenBinTree(node.children, depth + 1));
    }
  }

  return result;
}

// =============================================================================
// Path Operations
// =============================================================================

/**
 * Gets the full path of bins from root to the specified bin.
 *
 * @param binId - Target bin ID (null for root)
 * @param bins - Map of all bins
 * @returns Array of bins from root to target (inclusive)
 */
export function getBinPath(binId: BinId | null, bins: Map<BinId, Bin>): Bin[] {
  if (binId === null) return [];

  const path: Bin[] = [];
  let currentId: BinId | null = binId;

  while (currentId !== null) {
    const bin = bins.get(currentId);
    if (!bin) break;
    path.unshift(bin);
    currentId = bin.parentId;
  }

  return path;
}

/**
 * Gets all ancestor bin IDs for a given bin.
 *
 * @param binId - Target bin ID
 * @param bins - Map of all bins
 * @returns Set of ancestor bin IDs (not including the bin itself)
 */
export function getBinAncestors(binId: BinId, bins: Map<BinId, Bin>): Set<BinId> {
  const ancestors = new Set<BinId>();
  const bin = bins.get(binId);

  if (!bin) return ancestors;

  let currentId = bin.parentId;
  while (currentId !== null) {
    ancestors.add(currentId);
    const parent = bins.get(currentId);
    if (!parent) break;
    currentId = parent.parentId;
  }

  return ancestors;
}

/**
 * Gets all descendant bin IDs for a given bin.
 *
 * @param binId - Target bin ID
 * @param bins - Array of all bins
 * @returns Set of descendant bin IDs (not including the bin itself)
 */
export function getBinDescendants(binId: BinId, bins: Bin[]): Set<BinId> {
  const descendants = new Set<BinId>();
  const toProcess = [binId];

  while (toProcess.length > 0) {
    const currentId = toProcess.pop()!;
    const children = bins.filter((b) => b.parentId === currentId);

    for (const child of children) {
      descendants.add(child.id);
      toProcess.push(child.id);
    }
  }

  return descendants;
}

// =============================================================================
// Child Operations
// =============================================================================

/**
 * Gets direct children of a bin.
 *
 * @param parentId - Parent bin ID (null for root level)
 * @param bins - Array of all bins
 * @returns Array of direct child bins
 */
export function getBinChildren(parentId: BinId | null, bins: Bin[]): Bin[] {
  return bins.filter((bin) => bin.parentId === parentId);
}

// =============================================================================
// Asset Operations
// =============================================================================

/**
 * Gets all assets in a specific bin.
 *
 * @param binId - Target bin ID (null for root level assets)
 * @param assets - Array of all assets
 * @returns Array of assets in the bin
 */
export function getAssetsInBin(binId: BinId | null, assets: Asset[]): Asset[] {
  if (binId === null) {
    // Root level - assets with no bin or null/undefined binId
    return assets.filter((asset) => asset.binId === null || asset.binId === undefined);
  }
  return assets.filter((asset) => asset.binId === binId);
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Checks if a bin can be moved to a new parent.
 * Prevents moving a bin into itself or its descendants.
 *
 * @param binId - Bin to move
 * @param newParentId - New parent bin ID (null for root)
 * @param bins - Map of all bins
 * @returns true if the move is valid
 */
export function canMoveBinTo(
  binId: BinId,
  newParentId: BinId | null,
  bins: Map<BinId, Bin>
): boolean {
  // Can always move to root
  if (newParentId === null) return true;

  // Cannot move to self
  if (binId === newParentId) return false;

  // Cannot move to a descendant
  const binsArray = Array.from(bins.values());
  const descendants = getBinDescendants(binId, binsArray);

  return !descendants.has(newParentId);
}

// =============================================================================
// Sorting
// =============================================================================

/**
 * Sorts bins alphabetically by name (case-insensitive).
 *
 * @param bins - Array of bins to sort
 * @returns New sorted array
 */
export function sortBins(bins: Bin[]): Bin[] {
  return [...bins].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Gets the default bin color for new bins.
 */
export function getDefaultBinColor(): BinColor {
  return 'gray';
}

/**
 * Generates a unique bin name to avoid duplicates.
 *
 * @param baseName - Base name for the bin
 * @param existingNames - Set of existing bin names at the same level
 * @returns Unique name (e.g., "New Folder", "New Folder (2)", etc.)
 */
export function generateUniqueBinName(baseName: string, existingNames: Set<string>): string {
  if (!existingNames.has(baseName)) {
    return baseName;
  }

  let counter = 2;
  let newName = `${baseName} (${counter})`;

  while (existingNames.has(newName)) {
    counter++;
    newName = `${baseName} (${counter})`;
  }

  return newName;
}
