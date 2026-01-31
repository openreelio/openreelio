/**
 * BinTree Component
 *
 * Tree view for bin/folder navigation in the Project Explorer.
 * Displays hierarchical folder structure with expand/collapse,
 * drag-drop, and inline editing support.
 *
 * Features:
 * - Hierarchical tree view
 * - Expand/collapse folders
 * - Asset counts per folder
 * - Drag-drop bins and assets
 * - Inline bin renaming
 * - Create new bins
 * - Root navigation
 */

import { memo, useMemo, useCallback, useState } from 'react';
import { FolderPlus, Home } from 'lucide-react';
import { BinItem } from './BinItem';
import {
  buildBinTree,
  getAssetsInBin,
  sortBins,
  type BinTreeNode,
} from '@/utils/binUtils';
import type { Bin, BinId, Asset } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface BinTreeProps {
  /** Array of all bins */
  bins: Bin[];
  /** Array of all assets (for counting) */
  assets: Asset[];
  /** Currently selected bin ID (null = root) */
  selectedBinId?: BinId | null;
  /** Bin ID being edited (for inline rename) */
  editingBinId?: BinId | null;
  /** Whether to show the root item */
  showRoot?: boolean;
  /** Callback when a bin is selected */
  onSelectBin?: (binId: BinId | null) => void;
  /** Callback when a bin is double-clicked */
  onDoubleClickBin?: (binId: BinId) => void;
  /** Callback to toggle bin expand/collapse */
  onToggleExpand?: (binId: BinId) => void;
  /** Callback for context menu */
  onContextMenu?: (binId: BinId, event: React.MouseEvent) => void;
  /** Callback to create a new bin */
  onCreateBin?: (parentId: BinId | null) => void;
  /** Callback to rename a bin */
  onRenameBin?: (binId: BinId, newName: string) => void;
  /** Callback when editing is cancelled */
  onCancelEdit?: () => void;
  /** Callback to move a bin to a new parent */
  onMoveBin?: (binId: BinId, newParentId: BinId | null) => void;
  /** Callback to move an asset to a bin */
  onMoveAssetToBin?: (assetId: string, binId: BinId | null) => void;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

export const BinTree = memo(function BinTree({
  bins,
  assets,
  selectedBinId,
  editingBinId,
  showRoot = false,
  onSelectBin,
  onDoubleClickBin,
  onToggleExpand,
  onContextMenu,
  onCreateBin,
  onRenameBin,
  onCancelEdit,
  onMoveBin,
  onMoveAssetToBin,
  className = '',
}: BinTreeProps) {
  const [draggedBinId, setDraggedBinId] = useState<BinId | null>(null);
  const [dropTargetId, setDropTargetId] = useState<BinId | null>(null);

  // Build tree structure from flat bins
  const sortedBins = useMemo(() => sortBins(bins), [bins]);
  const tree = useMemo(() => buildBinTree(sortedBins), [sortedBins]);

  // Calculate asset counts for each bin
  const assetCounts = useMemo(() => {
    const counts = new Map<BinId | null, number>();

    // Count root assets
    counts.set(null, getAssetsInBin(null, assets).length);

    // Count assets in each bin
    for (const bin of bins) {
      counts.set(bin.id, getAssetsInBin(bin.id, assets).length);
    }

    return counts;
  }, [bins, assets]);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleRootClick = useCallback(() => {
    onSelectBin?.(null);
  }, [onSelectBin]);

  const handleDragStart = useCallback((binId: BinId, event: React.DragEvent) => {
    setDraggedBinId(binId);
    event.dataTransfer.setData('application/x-bin-id', binId);
    event.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((binId: BinId, event: React.DragEvent) => {
    event.preventDefault();

    // Check if dragging a bin
    const draggedBin = event.dataTransfer.types.includes('application/x-bin-id');
    const draggedAsset = event.dataTransfer.types.includes('application/x-asset-id');

    if (draggedBin || draggedAsset) {
      // Don't allow dropping on self
      if (draggedBinId !== binId) {
        setDropTargetId(binId);
        event.dataTransfer.dropEffect = 'move';
      }
    }
  }, [draggedBinId]);

  const handleDragLeave = useCallback(() => {
    setDropTargetId(null);
  }, []);

  const handleDrop = useCallback(
    (binId: BinId, event: React.DragEvent) => {
      event.preventDefault();
      setDraggedBinId(null);
      setDropTargetId(null);

      // Check for bin drop
      const droppedBinId = event.dataTransfer.getData('application/x-bin-id');
      if (droppedBinId && droppedBinId !== binId) {
        onMoveBin?.(droppedBinId, binId);
        return;
      }

      // Check for asset drop
      const droppedAssetId = event.dataTransfer.getData('application/x-asset-id');
      if (droppedAssetId) {
        onMoveAssetToBin?.(droppedAssetId, binId);
      }
    },
    [onMoveBin, onMoveAssetToBin]
  );

  // ===========================================================================
  // Recursive Render
  // ===========================================================================

  const renderBinNode = useCallback(
    (node: BinTreeNode, depth: number): React.ReactNode => {
      const hasChildren = node.children.length > 0;
      const isExpanded = node.expanded ?? true;

      return (
        <div key={node.id}>
          <BinItem
            id={node.id}
            name={node.name}
            color={node.color}
            depth={depth}
            expanded={isExpanded}
            hasChildren={hasChildren}
            assetCount={assetCounts.get(node.id) ?? 0}
            isSelected={selectedBinId === node.id}
            isEditing={editingBinId === node.id}
            isDropTarget={dropTargetId === node.id}
            onSelect={onSelectBin}
            onDoubleClick={onDoubleClickBin}
            onToggleExpand={onToggleExpand}
            onContextMenu={onContextMenu}
            onRename={onRenameBin}
            onCancelEdit={onCancelEdit}
            onDragStart={handleDragStart}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          />
          {isExpanded &&
            node.children.map((child) => renderBinNode(child, depth + 1))}
        </div>
      );
    },
    [
      selectedBinId,
      editingBinId,
      dropTargetId,
      assetCounts,
      onSelectBin,
      onDoubleClickBin,
      onToggleExpand,
      onContextMenu,
      onRenameBin,
      onCancelEdit,
      handleDragStart,
      handleDrop,
      handleDragOver,
      handleDragLeave,
    ]
  );

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div data-testid="bin-tree" className={`flex flex-col ${className}`}>
      {/* Header with Create Button */}
      {onCreateBin && (
        <div className="flex items-center justify-between px-2 py-1 border-b border-editor-border">
          <span className="text-xs font-medium text-editor-text-muted">Folders</span>
          <button
            data-testid="create-bin-button"
            className="p-1 rounded hover:bg-surface-active text-editor-text-muted hover:text-editor-text"
            onClick={() => onCreateBin(selectedBinId ?? null)}
            aria-label="Create folder"
            title="Create folder"
          >
            <FolderPlus className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Tree Content */}
      <div className="flex-1 overflow-y-auto py-1">
        {/* Root Item */}
        {showRoot && (
          <div
            data-testid="bin-tree-root"
            className={`
              flex items-center gap-2 px-2 py-1 cursor-pointer
              transition-colors
              ${selectedBinId === null ? 'bg-primary-500/20' : 'hover:bg-surface-active'}
            `}
            onClick={handleRootClick}
          >
            <Home className="w-4 h-4 text-editor-text-muted" />
            <span className="text-sm text-editor-text">All Assets</span>
            {assetCounts.get(null) !== undefined && assetCounts.get(null)! > 0 && (
              <span className="px-1.5 py-0.5 text-[10px] font-medium bg-surface-highest text-editor-text-muted rounded-full">
                {assetCounts.get(null)}
              </span>
            )}
          </div>
        )}

        {/* Bins */}
        {bins.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-sm text-editor-text-muted">
            No folders
          </div>
        ) : (
          tree.map((node) => renderBinNode(node, 0))
        )}
      </div>
    </div>
  );
});

export default BinTree;
