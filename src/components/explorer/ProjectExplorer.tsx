/**
 * ProjectExplorer Component
 *
 * Unified filesystem-first project explorer.
 * Shows a single tree view of the project workspace.
 */

import {
  useState,
  useCallback,
  useRef,
  useMemo,
  useEffect,
  type KeyboardEvent,
  type ChangeEvent,
  type MouseEvent,
} from 'react';
import { Search, X, FolderPlus, RefreshCw } from 'lucide-react';
import { useProjectStore, useWorkspaceStore } from '@/stores';
import { useTranscriptionWithIndexing } from '@/hooks';
import { useFileOperations } from '@/hooks/useFileOperations';
import { createLogger } from '@/services/logger';
import { FileTree } from './FileTree';
import { FileTreeContextMenu } from './FileTreeContextMenu';
import type { FileTreeEntry } from '@/types';
import { ConfirmDialog } from '@/components/ui';
import {
  TranscriptionDialog,
  type TranscriptionOptions,
  type AssetData,
} from '@/components/features/transcription';

const logger = createLogger('ProjectExplorer');

export function ProjectExplorer() {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Workspace store
  const fileTree = useWorkspaceStore((state) => state.fileTree);
  const isScanning = useWorkspaceStore((state) => state.isScanning);
  const scanWorkspace = useWorkspaceStore((state) => state.scanWorkspace);

  // Project store
  const { assets, selectAsset } = useProjectStore();

  // File operations
  const { createFolder, renameFile, deleteFile, revealInExplorer } = useFileOperations();

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<FileTreeEntry | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    entry: FileTreeEntry;
    position: { x: number; y: number };
  } | null>(null);

  // Transcription dialog state
  const [transcriptionAsset, setTranscriptionAsset] = useState<AssetData | null>(null);
  const { transcribeAndIndex, transcriptionState } = useTranscriptionWithIndexing();
  const isTranscribing = transcriptionState.isTranscribing;
  const [transcribingAssets, setTranscribingAssets] = useState<Set<string>>(new Set());

  // Search
  const [searchQuery, setSearchQuery] = useState('');

  // Rename state
  const [renamingEntry, setRenamingEntry] = useState<FileTreeEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    if (renamingEntry) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingEntry]);

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

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.ctrlKey && e.key === 'f') {
      e.preventDefault();
      searchInputRef.current?.focus();
    }
  }, []);

  const handleScanWorkspace = useCallback(() => {
    void scanWorkspace();
  }, [scanWorkspace]);

  const handleFileClick = useCallback(
    (entry: FileTreeEntry) => {
      if (!entry.isDirectory && entry.assetId) {
        selectAsset(entry.assetId);
      }
    },
    [selectAsset],
  );

  const handleFileDoubleClick = useCallback(
    (entry: FileTreeEntry) => {
      if (!entry.isDirectory && entry.assetId) {
        selectAsset(entry.assetId);
      }
    },
    [selectAsset],
  );

  // ===========================================================================
  // Context Menu
  // ===========================================================================

  const handleContextMenu = useCallback((event: MouseEvent, entry: FileTreeEntry) => {
    event.preventDefault();
    setContextMenu({ entry, position: { x: event.clientX, y: event.clientY } });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // ===========================================================================
  // File Operations via Context Menu
  // ===========================================================================

  const handleCreateFolder = useCallback(
    (parentPath: string) => {
      const folderName = 'New Folder';
      const fullPath = parentPath ? `${parentPath}/${folderName}` : folderName;
      createFolder(fullPath).catch((error) => {
        logger.error('Failed to create folder', { error });
      });
    },
    [createFolder],
  );

  const handleRename = useCallback((entry: FileTreeEntry) => {
    setRenamingEntry(entry);
    setRenameValue(entry.name);
  }, []);

  const handleRenameConfirm = useCallback(async () => {
    if (renamingEntry && renameValue.trim() && renameValue !== renamingEntry.name) {
      try {
        await renameFile(renamingEntry.relativePath, renameValue.trim());
      } catch (error) {
        logger.error('Failed to rename', { error });
        return;
      }
    }
    setRenamingEntry(null);
    setRenameValue('');
  }, [renamingEntry, renameValue, renameFile]);

  const handleRenameCancel = useCallback(() => {
    setRenamingEntry(null);
    setRenameValue('');
  }, []);

  const handleDelete = useCallback((entry: FileTreeEntry) => {
    setDeleteTarget(entry);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (deleteTarget) {
      try {
        await deleteFile(deleteTarget.relativePath);
      } catch (error) {
        logger.error('Failed to delete', { error });
        return;
      }
      setDeleteTarget(null);
    }
  }, [deleteTarget, deleteFile]);

  const handleCancelDelete = useCallback(() => {
    setDeleteTarget(null);
  }, []);

  const handleRevealInExplorer = useCallback(
    (relativePath: string) => {
      void revealInExplorer(relativePath);
    },
    [revealInExplorer],
  );

  const handleCopyPath = useCallback((relativePath: string) => {
    void (async () => {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(relativePath);
          return;
        }

        if (typeof document !== 'undefined') {
          const input = document.createElement('textarea');
          input.value = relativePath;
          input.setAttribute('readonly', 'true');
          input.style.position = 'fixed';
          input.style.opacity = '0';
          document.body.appendChild(input);
          input.focus();
          input.select();
          const copied = document.execCommand('copy');
          document.body.removeChild(input);

          if (copied) {
            return;
          }
        }

        logger.warn('Copy path failed: clipboard API unavailable', { relativePath });
      } catch (error) {
        logger.warn('Copy path failed', { relativePath, error });
      }
    })();
  }, []);

  const handleAddToTimeline = useCallback(
    (entry: FileTreeEntry) => {
      if (entry.assetId) {
        selectAsset(entry.assetId);
      }
    },
    [selectAsset],
  );

  // ===========================================================================
  // Transcription Handlers
  // ===========================================================================

  const handleContextTranscribe = useCallback(
    (entry: FileTreeEntry) => {
      if (
        entry.isDirectory ||
        !entry.assetId ||
        (entry.kind !== 'video' && entry.kind !== 'audio')
      ) {
        return;
      }

      const asset = assets.get(entry.assetId);
      setTranscriptionAsset({
        id: entry.assetId,
        name: entry.name,
        kind: entry.kind,
        duration: asset?.durationSec,
        thumbnail: asset?.thumbnailUrl,
        resolution: asset?.video
          ? {
              width: asset.video.width,
              height: asset.video.height,
            }
          : undefined,
        fileSize: entry.fileSize ?? asset?.fileSize,
        importedAt: asset?.importedAt,
      });
    },
    [assets],
  );

  const handleTranscriptionConfirm = useCallback(
    async (options: TranscriptionOptions) => {
      if (!transcriptionAsset) return;
      const assetId = transcriptionAsset.id;
      setTranscriptionAsset(null);
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
  // Filtered Tree
  // ===========================================================================

  const filteredTree = useMemo(() => {
    if (!searchQuery.trim()) return fileTree;
    const query = searchQuery.toLowerCase();

    function filterEntries(entries: FileTreeEntry[]): FileTreeEntry[] {
      return entries
        .map((entry) => {
          if (entry.isDirectory) {
            const filteredChildren = filterEntries(entry.children);
            if (filteredChildren.length > 0) {
              return { ...entry, children: filteredChildren };
            }
            return null;
          }
          return entry.name.toLowerCase().includes(query) ? entry : null;
        })
        .filter((e): e is FileTreeEntry => e !== null);
    }

    return filterEntries(fileTree);
  }, [fileTree, searchQuery]);

  // Header create folder handler
  const handleHeaderCreateFolder = useCallback(() => {
    handleCreateFolder('');
  }, [handleCreateFolder]);

  const renameTrimmedValue = renameValue.trim();
  const isRenameConfirmDisabled =
    renamingEntry == null ||
    renameTrimmedValue.length === 0 ||
    renameTrimmedValue === renamingEntry.name;

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
        <h2 className="text-sm font-semibold text-editor-text">Explorer</h2>
        <div className="flex items-center gap-1">
          <button
            data-testid="create-folder-button"
            className="p-1.5 rounded transition-colors hover:bg-surface-active"
            onClick={handleHeaderCreateFolder}
            aria-label="Create folder"
            title="Create folder"
          >
            <FolderPlus className="w-4 h-4" />
          </button>
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
        </div>
      </div>

      {/* Search */}
      <div className="p-2 border-b border-editor-border">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary" />
          <input
            ref={searchInputRef}
            data-testid="asset-search"
            type="text"
            placeholder="Search files..."
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

      {/* File Tree */}
      <div className="flex-1 overflow-y-auto">
        <FileTree
          entries={filteredTree}
          isScanning={isScanning}
          onScan={handleScanWorkspace}
          onFileClick={handleFileClick}
          onFileDoubleClick={handleFileDoubleClick}
          onContextMenu={handleContextMenu}
        />
      </div>

      {/* Rename Dialog */}
      {renamingEntry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-surface-overlay backdrop-blur-sm"
            onClick={handleRenameCancel}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-dialog-title"
            className="relative z-10 w-[calc(100%-2rem)] max-w-md mx-4 bg-surface-elevated rounded-lg shadow-xl p-6 border border-border-default"
          >
            <h2 id="rename-dialog-title" className="text-lg font-semibold text-text-primary mb-2">
              Rename {renamingEntry.isDirectory ? 'Folder' : 'File'}
            </h2>
            <p className="text-text-secondary mb-4 break-words">
              Enter a new name for "{renamingEntry.name}":
            </p>
            <input
              ref={renameInputRef}
              data-testid="rename-input"
              type="text"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (!isRenameConfirmDisabled) {
                    handleRenameConfirm();
                  }
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  handleRenameCancel();
                }
              }}
              className="w-full px-3 py-2 text-sm bg-surface-active border border-border-default rounded text-editor-text placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus/50"
              placeholder="New name"
            />
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3 mt-6">
              <button
                data-testid="rename-cancel-button"
                type="button"
                className="px-4 py-2 text-sm font-medium text-text-secondary bg-surface-active rounded hover:bg-surface-highest transition-colors"
                onClick={handleRenameCancel}
              >
                Cancel
              </button>
              <button
                data-testid="rename-confirm-button"
                type="button"
                className="px-4 py-2 text-sm font-medium text-white rounded transition-colors bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleRenameConfirm}
                disabled={isRenameConfirmDisabled}
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title={`Delete ${deleteTarget?.isDirectory ? 'Folder' : 'File'}`}
        message={`Are you sure you want to delete "${deleteTarget?.name ?? ''}"? ${deleteTarget?.isDirectory ? 'All contents will be moved to trash.' : 'The file will be moved to trash.'}`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />

      {/* File Context Menu */}
      {contextMenu && (
        <FileTreeContextMenu
          entry={contextMenu.entry}
          position={contextMenu.position}
          onClose={handleCloseContextMenu}
          onCreateFolder={handleCreateFolder}
          onRename={handleRename}
          onDelete={handleDelete}
          onRevealInExplorer={handleRevealInExplorer}
          onCopyPath={handleCopyPath}
          onAddToTimeline={handleAddToTimeline}
          onTranscribe={handleContextTranscribe}
          isTranscribing={
            contextMenu.entry.assetId != null && transcribingAssets.has(contextMenu.entry.assetId)
          }
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
