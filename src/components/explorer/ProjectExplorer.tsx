/**
 * ProjectExplorer Component
 *
 * Project explorer panel with asset management.
 */

import { useState, useCallback, useRef, useMemo, type KeyboardEvent, type ChangeEvent, type MouseEvent } from 'react';
import {
  Plus,
  Search,
  X,
  Film,
  Music,
  Image as ImageIcon,
  LayoutList,
  LayoutGrid,
  AlertCircle,
  Upload,
} from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useProjectStore } from '@/stores';
import { useAssetImport, useTranscriptionWithIndexing } from '@/hooks';
import { AssetList, type Asset, type ViewMode } from './AssetList';
import type { AssetKind, AssetData } from './AssetItem';
import type { Asset as ProjectAsset } from '@/types';
import { ConfirmDialog } from '@/components/ui';
import { AssetContextMenu, TranscriptionDialog, type TranscriptionOptions } from '@/components/features/transcription';

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
  const { assets, isLoading, selectedAssetId, selectAsset, removeAsset } =
    useProjectStore();

  // Asset import hook
  const { importFiles, importFromUris, isImporting, error: importError, clearError } = useAssetImport();

  // Drag-and-drop state
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  // Delete confirmation state
  const [assetToDelete, setAssetToDelete] = useState<string | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    asset: AssetData;
    position: { x: number; y: number };
  } | null>(null);

  // Transcription dialog state
  const [transcriptionAsset, setTranscriptionAsset] = useState<AssetData | null>(null);

  // Transcription hook
  const { transcribeAndIndex, transcriptionState } = useTranscriptionWithIndexing();
  const isTranscribing = transcriptionState.isTranscribing;

  // Track which assets are being transcribed
  const [transcribingAssets, setTranscribingAssets] = useState<Set<string>>(new Set());

  const assetList = useMemo<Asset[]>(() => {
    return Array.from(assets.values())
      .map((asset: ProjectAsset): Asset | null => {
        if (asset.kind !== 'video' && asset.kind !== 'audio' && asset.kind !== 'image') {
          return null;
        }

        // Convert thumbnail path to Tauri asset protocol URL
        // Backend now returns raw file paths for local assets
        let thumbnail: string | undefined;
        if (asset.thumbnailUrl) {
          if (asset.thumbnailUrl.startsWith('http://') || asset.thumbnailUrl.startsWith('https://')) {
            thumbnail = asset.thumbnailUrl;
          } else {
            // Raw file path - convert to Tauri asset protocol
            thumbnail = convertFileSrc(asset.thumbnailUrl);
          }
        }

        return {
          id: asset.id,
          name: asset.name,
          kind: asset.kind,
          ...(asset.durationSec != null ? { duration: asset.durationSec } : {}),
          ...(thumbnail != null ? { thumbnail } : {}),
          ...(asset.video != null ? { resolution: { width: asset.video.width, height: asset.video.height } } : {}),
          ...(asset.fileSize != null ? { fileSize: asset.fileSize } : {}),
        };
      })
      .filter((asset): asset is Asset => asset !== null);
  }, [assets]);

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
    void importFiles();
  }, [importFiles]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ctrl+F to focus search
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }

      // Delete to show confirmation dialog
      if (e.key === 'Delete' && selectedAssetId) {
        setAssetToDelete(selectedAssetId);
      }
    },
    [selectedAssetId]
  );

  const handleConfirmDelete = useCallback(() => {
    if (assetToDelete) {
      void removeAsset(assetToDelete);
      setAssetToDelete(null);
    }
  }, [assetToDelete, removeAsset]);

  const handleCancelDelete = useCallback(() => {
    setAssetToDelete(null);
  }, []);

  // ===========================================================================
  // Context Menu Handlers
  // ===========================================================================

  const handleAssetContextMenu = useCallback((event: MouseEvent, asset: AssetData) => {
    event.preventDefault();
    setContextMenu({
      asset,
      position: { x: event.clientX, y: event.clientY },
    });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleContextTranscribe = useCallback((asset: AssetData) => {
    setTranscriptionAsset(asset);
  }, []);

  const handleContextDelete = useCallback((asset: AssetData) => {
    setAssetToDelete(asset.id);
  }, []);

  // ===========================================================================
  // Transcription Handlers
  // ===========================================================================

  const handleTranscriptionConfirm = useCallback(
    async (options: TranscriptionOptions) => {
      if (!transcriptionAsset) return;

      const assetId = transcriptionAsset.id;
      setTranscriptionAsset(null);

      // Track transcribing asset
      setTranscribingAssets((prev) => new Set(prev).add(assetId));

      try {
        await transcribeAndIndex(assetId, {
          language: options.language === 'auto' ? undefined : options.language,
        });
      } finally {
        setTranscribingAssets((prev) => {
          const next = new Set(prev);
          next.delete(assetId);
          return next;
        });
      }
    },
    [transcriptionAsset, transcribeAndIndex]
  );

  const handleTranscriptionCancel = useCallback(() => {
    setTranscriptionAsset(null);
  }, []);

  // ===========================================================================
  // Drag and Drop Handlers
  // ===========================================================================

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragging(false);

      const files = e.dataTransfer.files;
      if (files.length > 0) {
        // Extract file paths - in Tauri, dropped files have a path property
        // In web context, we need to use the webkitRelativePath or name
        const paths: string[] = [];
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          // Tauri provides the full path via the path property (extended File)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const filePath = (file as any).path || file.name;
          paths.push(filePath);
        }
        void importFromUris(paths);
      }
    },
    [importFromUris]
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

  const emptyMessage = assetList.length === 0 ? 'Import media to get started' : 'No assets';

  // ===========================================================================
  // Asset to Delete Name
  // ===========================================================================

  const assetToDeleteName = useMemo(() => {
    if (!assetToDelete) return '';
    const asset = assets.get(assetToDelete);
    return asset?.name ?? '';
  }, [assetToDelete, assets]);

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div
      data-testid="project-explorer"
      className="flex flex-col h-full bg-editor-sidebar text-editor-text relative"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop Zone Overlay */}
      {isDragging && (
        <div
          data-testid="drop-zone"
          className="absolute inset-0 z-50 bg-primary-500/20 border-2 border-dashed border-primary-500 flex items-center justify-center pointer-events-none"
        >
          <div className="flex flex-col items-center gap-2 text-primary-400">
            <Upload className="w-12 h-12" />
            <p className="text-sm font-medium">Drop files to import</p>
          </div>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-editor-border">
        <h2 className="text-sm font-semibold text-editor-text">Project</h2>
        <button
          data-testid="import-button"
          className={`p-1.5 rounded transition-colors ${isImporting ? 'opacity-50 cursor-not-allowed' : 'hover:bg-surface-active'}`}
          onClick={handleImport}
          disabled={isImporting}
          aria-label={isImporting ? 'Importing...' : 'Import asset'}
        >
          {isImporting ? (
            <div className="w-4 h-4 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
          ) : (
            <Plus className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Import Error */}
      {importError && (
        <div
          data-testid="import-error"
          className="flex items-center gap-2 p-2 m-2 text-xs bg-red-900/50 text-red-300 border border-red-800 rounded"
        >
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1">{importError}</span>
          <button
            onClick={clearError}
            className="p-0.5 hover:bg-red-800 rounded"
            aria-label="Dismiss error"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Search */}
      <div className="p-2 border-b border-editor-border">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary" />
          <input
            ref={searchInputRef}
            data-testid="asset-search"
            type="text"
            placeholder="Search assets..."
            value={searchQuery}
            onChange={handleSearchChange}
            className="w-full pl-8 pr-8 py-1.5 text-sm bg-surface-active border border-border-default rounded text-editor-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus/50"
          />
          {searchQuery && (
            <button
              data-testid="search-clear"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-surface-highest"
              onClick={handleClearSearch}
              aria-label="Clear search"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Filter Tabs and View Mode */}
      <div className="flex items-center justify-between p-2 border-b border-editor-border">
        <div className="flex gap-1 flex-wrap">
          {filterTabs.map((tab) => (
            <button
              key={tab.key}
              data-testid={`filter-${tab.key}`}
              className={`
                flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors
                ${filter === tab.key ? 'bg-primary-500 text-white' : 'hover:bg-surface-active text-text-secondary'}
              `}
              onClick={() => handleFilterChange(tab.key)}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        <div className="flex gap-1 flex-shrink-0">
          <button
            data-testid="view-mode-list"
            className={`p-1 rounded transition-colors ${viewMode === 'list' ? 'bg-surface-highest' : 'hover:bg-surface-active'}`}
            onClick={() => setViewMode('list')}
            aria-label="List view"
          >
            <LayoutList className="w-4 h-4" />
          </button>
          <button
            data-testid="view-mode-grid"
            className={`p-1 rounded transition-colors ${viewMode === 'grid' ? 'bg-surface-highest' : 'hover:bg-surface-active'}`}
            onClick={() => setViewMode('grid')}
            aria-label="Grid view"
          >
            <LayoutGrid className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Asset List */}
      <div className="flex-1 overflow-y-auto p-2">
        {assetList.length === 0 && !isLoading ? (
          <div data-testid="asset-list-empty" className="flex flex-col items-center justify-center h-full text-text-secondary">
            <Plus className="w-12 h-12 mb-2 opacity-50" />
            <p className="text-sm">{emptyMessage}</p>
          </div>
        ) : (
          <AssetList
            assets={assetList}
            isLoading={isLoading}
            selectedAssetId={selectedAssetId}
            filter={filter}
            searchQuery={searchQuery}
            viewMode={viewMode}
            onSelect={handleAssetSelect}
            onContextMenu={handleAssetContextMenu}
          />
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={assetToDelete !== null}
        title="Delete Asset"
        message={`Are you sure you want to delete "${assetToDeleteName}"? This action cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />

      {/* Asset Context Menu */}
      {contextMenu && (
        <AssetContextMenu
          asset={contextMenu.asset}
          isOpen={true}
          position={contextMenu.position}
          onTranscribe={handleContextTranscribe}
          onDelete={handleContextDelete}
          onClose={handleCloseContextMenu}
          isTranscribing={transcribingAssets.has(contextMenu.asset.id)}
        />
      )}

      {/* Transcription Dialog */}
      {transcriptionAsset && (
        <TranscriptionDialog
          asset={transcriptionAsset}
          isOpen={true}
          onConfirm={handleTranscriptionConfirm}
          onCancel={handleTranscriptionCancel}
          isProcessing={isTranscribing}
        />
      )}
    </div>
  );
}
