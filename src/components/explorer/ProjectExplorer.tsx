/**
 * ProjectExplorer Component
 *
 * Project explorer panel with asset management.
 */

import {
  useState,
  useCallback,
  useRef,
  useMemo,
  type KeyboardEvent,
  type ChangeEvent,
  type MouseEvent,
} from 'react';
import {
  Plus,
  Search,
  X,
  Film,
  Music,
  Image as ImageIcon,
  LayoutList,
  LayoutGrid,
  FolderPlus,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Package,
  RefreshCw,
} from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useProjectStore, useBinStore, useWorkspaceStore } from '@/stores';
import { useTranscriptionWithIndexing, useBinOperations } from '@/hooks';
import { createLogger } from '@/services/logger';
import { refreshProjectState } from '@/utils/stateRefreshHelper';
import { normalizeFileUriToPath } from '@/utils/uri';
import { BinTree } from './BinTree';
import { AssetList, type Asset, type ViewMode } from './AssetList';
import { FileTree } from './FileTree';
import type { AssetKind, AssetData } from './AssetItem';
import type { Asset as ProjectAsset, FileTreeEntry } from '@/types';
import { ConfirmDialog } from '@/components/ui';
import {
  AssetContextMenu,
  TranscriptionDialog,
  type TranscriptionOptions,
} from '@/components/features/transcription';

// =============================================================================
// Types
// =============================================================================

type ExplorerTab = 'files' | 'assets';

type FilterType = 'all' | AssetKind;

interface FilterTab {
  key: FilterType;
  label: string;
  icon?: React.ReactNode;
}

function safeDecodeURIComponent(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

function toTauriAssetUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    return pathOrUrl;
  }

  if (pathOrUrl.startsWith('asset://')) {
    return pathOrUrl;
  }

  if (pathOrUrl.startsWith('file://')) {
    return convertFileSrc(normalizeFileUriToPath(pathOrUrl));
  }

  return convertFileSrc(safeDecodeURIComponent(pathOrUrl));
}

const logger = createLogger('ProjectExplorer');

// =============================================================================
// Component
// =============================================================================

export function ProjectExplorer() {
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Explorer tab: Files (workspace file tree) or Assets (registered assets)
  const [activeTab, setActiveTab] = useState<ExplorerTab>('files');

  // Workspace store
  const fileTree = useWorkspaceStore((state) => state.fileTree);
  const isScanning = useWorkspaceStore((state) => state.isScanning);
  const registeringPathCounts = useWorkspaceStore((state) => state.registeringPathCounts);
  const scanWorkspace = useWorkspaceStore((state) => state.scanWorkspace);
  const registerFile = useWorkspaceStore((state) => state.registerFile);

  // Store
  const { assets, isLoading, selectedAssetId, selectAsset, removeAsset } = useProjectStore();

  // Bin Store (UI state only)
  const { selectedBinId, editingBinId, selectBin, toggleExpand, cancelEditing, getBinsArray } =
    useBinStore();

  // Bin Operations (persisted to backend)
  const {
    createBin: createBinAsync,
    renameBin: renameBinAsync,
    moveBin: moveBinAsync,
    moveAssetToBin: moveAssetToBinAsync,
  } = useBinOperations();

  // Bin tree visibility state
  const [showBinTree, setShowBinTree] = useState(true);

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
      .filter((asset: ProjectAsset) => {
        // Filter by selected bin (null means root, undefined or missing binId goes to root)
        const assetBinId = asset.binId ?? null;
        if (selectedBinId !== null && assetBinId !== selectedBinId) {
          return false;
        }
        if (selectedBinId === null && assetBinId !== null) {
          return false;
        }
        return true;
      })
      .map((asset: ProjectAsset): Asset | null => {
        if (asset.kind !== 'video' && asset.kind !== 'audio' && asset.kind !== 'image') {
          return null;
        }

        // Convert thumbnail path to Tauri asset protocol URL
        // Backend now returns raw file paths for local assets
        let thumbnail: string | undefined;
        if (asset.thumbnailUrl) {
          thumbnail = toTauriAssetUrl(asset.thumbnailUrl);
        }

        return {
          id: asset.id,
          name: asset.name,
          kind: asset.kind,
          ...(asset.durationSec != null ? { duration: asset.durationSec } : {}),
          ...(thumbnail != null ? { thumbnail } : {}),
          ...(asset.video != null
            ? { resolution: { width: asset.video.width, height: asset.video.height } }
            : {}),
          ...(asset.fileSize != null ? { fileSize: asset.fileSize } : {}),
        };
      })
      .filter((asset): asset is Asset => asset !== null);
  }, [assets, selectedBinId]);

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
    [selectAsset],
  );

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
    [selectedAssetId],
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
    [transcriptionAsset, transcribeAndIndex],
  );

  const handleTranscriptionCancel = useCallback(() => {
    setTranscriptionAsset(null);
  }, []);

  // ===========================================================================
  // Bin Handlers
  // ===========================================================================

  const handleSelectBin = useCallback(
    (binId: string | null) => {
      selectBin(binId);
    },
    [selectBin],
  );

  const handleCreateBin = useCallback(
    (parentId: string | null) => {
      // Fire and forget - backend handles persistence, state syncs automatically
      createBinAsync('New Folder', parentId).catch((error) => {
        logger.error('Failed to create bin', { parentId, error });
      });
    },
    [createBinAsync],
  );

  const handleRenameBin = useCallback(
    (binId: string, newName: string) => {
      // Fire and forget - backend handles persistence, state syncs automatically
      renameBinAsync(binId, newName).catch((error) => {
        logger.error('Failed to rename bin', { binId, newName, error });
      });
    },
    [renameBinAsync],
  );

  const handleMoveBin = useCallback(
    (binId: string, newParentId: string | null) => {
      moveBinAsync(binId, newParentId).catch((error) => {
        logger.error('Failed to move bin', { binId, newParentId, error });
      });
    },
    [moveBinAsync],
  );

  const handleMoveAssetToBin = useCallback(
    (assetId: string, binId: string | null) => {
      moveAssetToBinAsync(assetId, binId).catch((error) => {
        logger.error('Failed to move asset to bin', { assetId, binId, error });
      });
    },
    [moveAssetToBinAsync],
  );

  const handleToggleBinTree = useCallback(() => {
    setShowBinTree((prev) => !prev);
  }, []);

  // Convert assets Map to array for BinTree
  const assetsArray = useMemo(() => Array.from(assets.values()), [assets]);

  // Get bins array for BinTree
  const binsArray = getBinsArray();

  // ===========================================================================
  // Workspace Handlers
  // ===========================================================================

  const handleScanWorkspace = useCallback(() => {
    void scanWorkspace();
  }, [scanWorkspace]);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleWorkspaceFileClick = useCallback((_entry: FileTreeEntry) => {
    // Select in UI - could show info panel later
  }, []);

  const handleWorkspaceFileDoubleClick = useCallback(
    async (entry: FileTreeEntry) => {
      if (entry.isDirectory) {
        return;
      }

      const result = await registerFile(entry.relativePath);
      if (!result) {
        return;
      }

      if (!result.alreadyRegistered || !useProjectStore.getState().assets.has(result.assetId)) {
        try {
          const freshState = await refreshProjectState();
          useProjectStore.setState((draft) => {
            draft.assets = freshState.assets;
          });
        } catch (error) {
          logger.warn('Failed to refresh assets after workspace registration', {
            relativePath: entry.relativePath,
            assetId: result.assetId,
            error,
          });
        }
      }

      selectAsset(result.assetId);
    },
    [registerFile, selectAsset],
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
    [],
  );

  // ===========================================================================
  // Empty State Message
  // ===========================================================================

  const emptyMessage =
    assetList.length === 0 ? 'Scan workspace and register files to get started' : 'No assets';

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
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-editor-border">
        <h2 className="text-sm font-semibold text-editor-text">Project</h2>
        <div className="flex items-center gap-1">
          {activeTab === 'files' ? (
            <button
              data-testid="scan-workspace-button"
              className={`p-1.5 rounded transition-colors ${isScanning ? 'opacity-50 cursor-not-allowed' : 'hover:bg-surface-active'}`}
              onClick={handleScanWorkspace}
              disabled={isScanning}
              aria-label={isScanning ? 'Scanning...' : 'Scan workspace'}
              title="Scan workspace"
            >
              <RefreshCw className={`w-4 h-4 ${isScanning ? 'animate-spin' : ''}`} />
            </button>
          ) : (
            <>
              <button
                data-testid="create-folder-button"
                className="p-1.5 rounded transition-colors hover:bg-surface-active"
                onClick={() => handleCreateBin(selectedBinId)}
                aria-label="Create folder"
                title="Create folder"
              >
                <FolderPlus className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tab Toggle: Files / Assets */}
      <div className="flex border-b border-editor-border">
        <button
          data-testid="tab-files"
          className={`flex items-center gap-1.5 flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            activeTab === 'files'
              ? 'text-primary-400 border-b-2 border-primary-400 bg-surface-active/50'
              : 'text-text-secondary hover:text-editor-text hover:bg-surface-active'
          }`}
          onClick={() => setActiveTab('files')}
        >
          <FolderOpen className="w-3.5 h-3.5" />
          Files
        </button>
        <button
          data-testid="tab-assets"
          className={`flex items-center gap-1.5 flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            activeTab === 'assets'
              ? 'text-primary-400 border-b-2 border-primary-400 bg-surface-active/50'
              : 'text-text-secondary hover:text-editor-text hover:bg-surface-active'
          }`}
          onClick={() => setActiveTab('assets')}
        >
          <Package className="w-3.5 h-3.5" />
          Assets
        </button>
      </div>

      {/* Files Tab: Workspace File Tree */}
      {activeTab === 'files' && (
        <div className="flex-1 overflow-y-auto">
          <FileTree
            entries={fileTree}
            isScanning={isScanning}
            registeringPathCounts={registeringPathCounts}
            onScan={handleScanWorkspace}
            onFileClick={handleWorkspaceFileClick}
            onFileDoubleClick={handleWorkspaceFileDoubleClick}
          />
        </div>
      )}

      {/* Assets Tab: Existing asset management UI */}
      {activeTab === 'assets' && (
        <>
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

          {/* Bins Section */}
          <div className="border-b border-editor-border">
            {/* Bins Header */}
            <button
              data-testid="bins-toggle"
              className="flex items-center justify-between w-full p-2 text-xs font-medium text-editor-text-muted hover:bg-surface-active transition-colors"
              onClick={handleToggleBinTree}
              aria-expanded={showBinTree}
            >
              <span className="flex items-center gap-1">
                {showBinTree ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
                Folders
              </span>
              <span className="text-xs text-text-secondary">{binsArray.length}</span>
            </button>

            {/* Bin Tree */}
            {showBinTree && (
              <div className="max-h-40 overflow-y-auto">
                <BinTree
                  bins={binsArray}
                  assets={assetsArray}
                  selectedBinId={selectedBinId}
                  editingBinId={editingBinId}
                  showRoot
                  onSelectBin={handleSelectBin}
                  onToggleExpand={toggleExpand}
                  onCreateBin={handleCreateBin}
                  onRenameBin={handleRenameBin}
                  onCancelEdit={cancelEditing}
                  onMoveBin={handleMoveBin}
                  onMoveAssetToBin={handleMoveAssetToBin}
                />
              </div>
            )}
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
              <div
                data-testid="asset-list-empty"
                className="flex flex-col items-center justify-center h-full text-text-secondary"
              >
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
        </>
      )}

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
