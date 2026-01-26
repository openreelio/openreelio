/**
 * AssetList Component
 *
 * Displays a list of assets in the project explorer.
 */

import { useMemo, useCallback, type MouseEvent } from 'react';
import { AssetItem, type AssetData, type AssetKind } from './AssetItem';

// =============================================================================
// Types
// =============================================================================

export type Asset = AssetData;

export type ViewMode = 'list' | 'grid';
export type SortBy = 'name' | 'date' | 'duration' | 'kind';
export type SortOrder = 'asc' | 'desc';

export interface AssetListProps {
  /** Assets to display */
  assets: Asset[];
  /** Loading state */
  isLoading?: boolean;
  /** Single selected asset ID */
  selectedAssetId?: string | null;
  /** Multiple selected asset IDs (for multi-select mode) */
  selectedAssetIds?: string[];
  /** Enable multi-selection */
  multiSelect?: boolean;
  /** Filter by asset type */
  filter?: AssetKind | 'all';
  /** Search query */
  searchQuery?: string;
  /** View mode */
  viewMode?: ViewMode;
  /** Sort field */
  sortBy?: SortBy;
  /** Sort order */
  sortOrder?: SortOrder;
  /** Selection handler */
  onSelect?: (assetId: string) => void;
  /** Drag start handler */
  onAssetDragStart?: (asset: Asset) => void;
  /** Context menu handler */
  onContextMenu?: (event: MouseEvent, asset: Asset) => void;
}

// =============================================================================
// Component
// =============================================================================

export function AssetList({
  assets,
  isLoading = false,
  selectedAssetId,
  selectedAssetIds = [],
  multiSelect = false,
  filter = 'all',
  searchQuery = '',
  viewMode = 'list',
  sortBy = 'name',
  sortOrder = 'asc',
  onSelect,
  onAssetDragStart,
  onContextMenu,
}: AssetListProps) {
  // ===========================================================================
  // Filtered and Sorted Assets
  // ===========================================================================

  const filteredAssets = useMemo(() => {
    let result = [...assets];

    // Filter by type
    if (filter !== 'all') {
      result = result.filter((a) => a.kind === filter);
    }

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter((a) => a.name.toLowerCase().includes(query));
    }

    // Sort
    result.sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'date':
          // Date sorting requires a date field - fallback to name if not available
          comparison = a.name.localeCompare(b.name);
          break;
        case 'duration':
          comparison = (a.duration || 0) - (b.duration || 0);
          break;
        case 'kind':
          comparison = a.kind.localeCompare(b.kind);
          break;
        default:
          comparison = a.name.localeCompare(b.name);
      }

      return sortOrder === 'desc' ? -comparison : comparison;
    });

    return result;
  }, [assets, filter, searchQuery, sortBy, sortOrder]);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleAssetClick = useCallback(
    (asset: Asset) => {
      onSelect?.(asset.id);
    },
    [onSelect]
  );

  const handleDragStart = useCallback(
    (asset: Asset) => {
      onAssetDragStart?.(asset);
    },
    [onAssetDragStart]
  );

  const handleContextMenu = useCallback(
    (event: MouseEvent, asset: Asset) => {
      onContextMenu?.(event, asset);
    },
    [onContextMenu]
  );

  // ===========================================================================
  // Selection Check
  // ===========================================================================

  const isSelected = useCallback(
    (assetId: string): boolean => {
      if (multiSelect) {
        return selectedAssetIds.includes(assetId);
      }
      return assetId === selectedAssetId;
    },
    [multiSelect, selectedAssetId, selectedAssetIds]
  );

  // ===========================================================================
  // Render Loading
  // ===========================================================================

  if (isLoading) {
    return (
      <div data-testid="asset-list-loading" className="flex items-center justify-center p-8">
        <div className="flex flex-col items-center gap-2 text-text-secondary">
          <div className="w-6 h-6 border-2 border-text-secondary border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">Loading assets...</span>
        </div>
      </div>
    );
  }

  // ===========================================================================
  // Render Empty
  // ===========================================================================

  if (filteredAssets.length === 0) {
    return (
      <div data-testid="asset-list-empty" className="flex items-center justify-center p-8">
        <div className="text-center text-text-secondary">
          <div className="text-sm">No assets</div>
        </div>
      </div>
    );
  }

  // ===========================================================================
  // Render List
  // ===========================================================================

  return (
    <div
      data-testid="asset-list"
      className={`
        ${viewMode === 'grid' ? 'grid grid-cols-2 gap-2' : 'flex flex-col gap-1'}
      `}
    >
      {filteredAssets.map((asset) => (
        <AssetItem
          key={asset.id}
          asset={asset}
          isSelected={isSelected(asset.id)}
          onClick={handleAssetClick}
          onDragStart={handleDragStart}
          onContextMenu={(e) => handleContextMenu(e, asset)}
        />
      ))}
    </div>
  );
}
