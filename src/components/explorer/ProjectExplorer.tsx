/**
 * ProjectExplorer Component
 *
 * Project explorer panel with asset management.
 */

import { useState, useCallback, useRef, useMemo, type KeyboardEvent, type ChangeEvent } from 'react';
import {
  Plus,
  Search,
  X,
  Film,
  Music,
  Image as ImageIcon,
  LayoutList,
  LayoutGrid,
} from 'lucide-react';
import { useProjectStore } from '@/stores';
import { AssetList, type Asset, type ViewMode } from './AssetList';
import type { AssetKind } from './AssetItem';

// =============================================================================
// Types
// =============================================================================

type FilterType = 'all' | AssetKind;

interface FilterTab {
  key: FilterType;
  label: string;
  icon?: React.ReactNode;
}

// =============================================================================
// Component
// =============================================================================

export function ProjectExplorer() {
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Store
  const { assets, isLoading, selectedAssetId, selectAsset, importAsset, removeAsset } =
    useProjectStore();

  // Local state
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleSearchChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
    searchInputRef.current?.focus();
  }, []);

  const handleFilterChange = useCallback((newFilter: FilterType) => {
    setFilter(newFilter);
  }, []);

  const handleAssetSelect = useCallback(
    (assetId: string) => {
      selectAsset(assetId);
    },
    [selectAsset]
  );

  const handleImport = useCallback(() => {
    importAsset();
  }, [importAsset]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ctrl+F to focus search
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }

      // Delete to remove selected asset
      if (e.key === 'Delete' && selectedAssetId) {
        removeAsset(selectedAssetId);
      }
    },
    [selectedAssetId, removeAsset]
  );

  // ===========================================================================
  // Filter Tabs
  // ===========================================================================

  const filterTabs: FilterTab[] = useMemo(
    () => [
      { key: 'all', label: 'All' },
      { key: 'video', label: 'Video', icon: <Film className="w-3 h-3" /> },
      { key: 'audio', label: 'Audio', icon: <Music className="w-3 h-3" /> },
      { key: 'image', label: 'Image', icon: <ImageIcon className="w-3 h-3" /> },
    ],
    []
  );

  // ===========================================================================
  // Empty State Message
  // ===========================================================================

  const emptyMessage = assets.length === 0 ? 'Import media to get started' : 'No assets';

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div
      data-testid="project-explorer"
      className="flex flex-col h-full bg-gray-800 text-white"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-gray-700">
        <h2 className="text-sm font-semibold">Project</h2>
        <button
          data-testid="import-button"
          className="p-1.5 rounded hover:bg-gray-700 transition-colors"
          onClick={handleImport}
          aria-label="Import asset"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Search */}
      <div className="p-2 border-b border-gray-700">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            ref={searchInputRef}
            data-testid="asset-search"
            type="text"
            placeholder="Search assets..."
            value={searchQuery}
            onChange={handleSearchChange}
            className="w-full pl-8 pr-8 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-primary-500"
          />
          {searchQuery && (
            <button
              data-testid="search-clear"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-gray-600"
              onClick={handleClearSearch}
              aria-label="Clear search"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Filter Tabs and View Mode */}
      <div className="flex items-center justify-between p-2 border-b border-gray-700">
        <div className="flex gap-1">
          {filterTabs.map((tab) => (
            <button
              key={tab.key}
              data-testid={`filter-${tab.key}`}
              className={`
                flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors
                ${filter === tab.key ? 'bg-primary-500 text-white' : 'hover:bg-gray-700 text-gray-300'}
              `}
              onClick={() => handleFilterChange(tab.key)}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        <div className="flex gap-1">
          <button
            data-testid="view-mode-list"
            className={`p-1 rounded transition-colors ${viewMode === 'list' ? 'bg-gray-600' : 'hover:bg-gray-700'}`}
            onClick={() => setViewMode('list')}
            aria-label="List view"
          >
            <LayoutList className="w-4 h-4" />
          </button>
          <button
            data-testid="view-mode-grid"
            className={`p-1 rounded transition-colors ${viewMode === 'grid' ? 'bg-gray-600' : 'hover:bg-gray-700'}`}
            onClick={() => setViewMode('grid')}
            aria-label="Grid view"
          >
            <LayoutGrid className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Asset List */}
      <div className="flex-1 overflow-y-auto p-2">
        {assets.length === 0 && !isLoading ? (
          <div data-testid="asset-list-empty" className="flex flex-col items-center justify-center h-full text-gray-400">
            <Plus className="w-12 h-12 mb-2 opacity-50" />
            <p className="text-sm">{emptyMessage}</p>
          </div>
        ) : (
          <AssetList
            assets={assets as Asset[]}
            isLoading={isLoading}
            selectedAssetId={selectedAssetId}
            filter={filter}
            searchQuery={searchQuery}
            viewMode={viewMode}
            onSelect={handleAssetSelect}
          />
        )}
      </div>
    </div>
  );
}
