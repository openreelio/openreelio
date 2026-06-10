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
  type DragEvent,
} from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { Search, X, FolderPlus, RefreshCw, Upload } from 'lucide-react';
import { useProjectStore, useWorkspaceStore } from '@/stores';
import { useTranscriptionWithIndexing } from '@/hooks';
import { useFileOperations } from '@/hooks/useFileOperations';
import { commands, type TranscriptionModelDto } from '@/bindings';
import { createLogger } from '@/services/logger';
import { FileTree } from './FileTree';
import { FileTreeContextMenu } from './FileTreeContextMenu';
import { ProxyQueuePanel } from './ProxyQueuePanel';
import { assetNeedsProxy, type FileTreeEntry, type AssetKind } from '@/types';
import { ConfirmDialog } from '@/components/ui';
import {
  TranscriptionDialog,
  type TranscriptionOptions,
  type AssetData,
} from '@/components/features/transcription';

const logger = createLogger('ProjectExplorer');
const SOURCE_MONITOR_SUPPORTED_KINDS = new Set<AssetKind>(['video', 'audio']);
const WORKSPACE_ENTRY_PATH_SELECTOR = '[data-workspace-entry-path]';
const DUPLICATE_EXTERNAL_DROP_WINDOW_MS = 1500;
const IMPORT_DIALOG_MEDIA_EXTENSIONS = [
  '3g2',
  '3gp',
  'aac',
  'aif',
  'aifc',
  'aiff',
  'avi',
  'bmp',
  'caf',
  'flac',
  'gif',
  'heic',
  'heif',
  'jpeg',
  'jpg',
  'm4a',
  'm4v',
  'mkv',
  'mov',
  'mp3',
  'mp4',
  'mxf',
  'oga',
  'ogg',
  'opus',
  'png',
  'srt',
  'tif',
  'tiff',
  'wav',
  'webm',
  'webp',
  'wmv',
];

export interface ProjectExplorerProps {
  /** Insert the selected workspace asset into the active sequence. */
  onAddToTimeline?: (entry: FileTreeEntry) => void | Promise<void>;
}

function canLoadIntoSourceMonitor(kind: AssetKind | undefined): boolean {
  return kind !== undefined && SOURCE_MONITOR_SUPPORTED_KINDS.has(kind);
}

function nativeDropPositionToClientPosition(position: { x: number; y: number }): {
  x: number;
  y: number;
} {
  const scaleFactor =
    typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
      ? window.devicePixelRatio || 1
      : 1;

  return {
    x: position.x / scaleFactor,
    y: position.y / scaleFactor,
  };
}

function getParentDirectory(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const separatorIndex = normalized.lastIndexOf('/');
  return separatorIndex > 0 ? normalized.slice(0, separatorIndex) : '';
}

function isPointInsideElement(element: HTMLElement, clientX: number, clientY: number): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  return (
    clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
  );
}

function resolveExternalDropTargetDir(
  rootElement: HTMLElement | null,
  clientX: number,
  clientY: number,
  fallbackTarget?: EventTarget | null,
): string | null {
  if (!rootElement) {
    return null;
  }

  const fallbackElement =
    fallbackTarget instanceof Element && rootElement.contains(fallbackTarget)
      ? fallbackTarget
      : null;
  if (!fallbackElement && !isPointInsideElement(rootElement, clientX, clientY)) {
    return null;
  }

  const pointElement =
    typeof document !== 'undefined' && typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(clientX, clientY)
      : null;

  const candidateElement =
    pointElement instanceof Element && rootElement.contains(pointElement)
      ? pointElement
      : fallbackElement;

  const entryElement = candidateElement?.closest(WORKSPACE_ENTRY_PATH_SELECTOR);
  if (!(entryElement instanceof HTMLElement)) {
    return '';
  }

  const relativePath = entryElement.dataset.workspaceEntryPath;
  if (!relativePath) {
    return '';
  }

  return entryElement.dataset.workspaceEntryDirectory === 'true'
    ? relativePath
    : getParentDirectory(relativePath);
}

function hasExternalFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files');
}

function isLikelyAbsoluteLocalPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

function getDataTransferFilePaths(dataTransfer: DataTransfer): string[] {
  return Array.from(dataTransfer.files)
    .map((file) => (file as File & { path?: string }).path)
    .filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
    .filter(isLikelyAbsoluteLocalPath);
}

type NativeDragDropEvent = {
  payload:
    | { type: 'drop'; paths: string[]; position: { x: number; y: number } }
    | { type: 'enter'; paths: string[]; position: { x: number; y: number } }
    | { type: 'over'; position: { x: number; y: number } }
    | { type: 'leave' };
};

interface ImportStatus {
  kind: 'importing' | 'success' | 'warning' | 'error';
  message: string;
}

async function selectExternalImportFiles(): Promise<string[]> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    multiple: true,
    directory: false,
    title: 'Import Media Files',
    filters: [{ name: 'Media Files', extensions: IMPORT_DIALOG_MEDIA_EXTENSIONS }],
  });

  if (selected == null) {
    return [];
  }

  return Array.isArray(selected) ? selected : [selected];
}

async function selectReplacementAssetFile(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    multiple: false,
    directory: false,
    title: 'Choose Replacement Media',
    filters: [{ name: 'Media Files', extensions: IMPORT_DIALOG_MEDIA_EXTENSIONS }],
  });

  if (selected == null || Array.isArray(selected)) {
    return null;
  }

  return selected;
}

function createWorkspaceRootEntry(children: FileTreeEntry[]): FileTreeEntry {
  return {
    relativePath: '',
    name: 'Workspace',
    isDirectory: true,
    children,
  };
}

function findDirectoryEntries(entries: FileTreeEntry[], relativePath: string): FileTreeEntry[] {
  if (!relativePath) {
    return entries;
  }

  for (const entry of entries) {
    if (entry.isDirectory && entry.relativePath === relativePath) {
      return entry.children;
    }

    if (entry.isDirectory) {
      const result = findDirectoryEntries(entry.children, relativePath);
      if (result.length > 0) {
        return result;
      }
    }
  }

  return [];
}

function getUniqueFolderName(entries: FileTreeEntry[], baseName = 'New Folder'): string {
  const existingNames = new Set(
    entries.filter((entry) => entry.isDirectory).map((entry) => entry.name.toLowerCase()),
  );

  if (!existingNames.has(baseName.toLowerCase())) {
    return baseName;
  }

  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (!existingNames.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return `${baseName} ${Date.now()}`;
}

interface CaptionSegmentPayload {
  startSec: number;
  endSec: number;
  text: string;
}

function buildCaptionSegmentPayloads(
  segments: Array<{ startTime: number; endTime: number; text: string }>,
): CaptionSegmentPayload[] {
  const payloads: CaptionSegmentPayload[] = [];

  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) {
      continue;
    }

    const startSec = Math.max(0, segment.startTime);
    const endSec = Math.max(startSec + 0.01, segment.endTime);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
      continue;
    }

    payloads.push({
      startSec,
      endSec,
      text,
    });
  }

  return payloads;
}

export function ProjectExplorer({ onAddToTimeline }: ProjectExplorerProps = {}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const lastExternalDropRef = useRef<{ key: string; timestampMs: number } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Workspace store
  const fileTree = useWorkspaceStore((state) => state.fileTree);
  const isScanning = useWorkspaceStore((state) => state.isScanning);
  const scanWorkspace = useWorkspaceStore((state) => state.scanWorkspace);
  const importExternalFiles = useWorkspaceStore((state) => state.importExternalFiles);

  // Project store
  const {
    assets,
    selectAsset,
    executeCommand,
    activeSequenceId,
    sequences,
    relinkAsset,
    proxyJobIdsByAssetId,
    generateProxyForAsset,
  } = useProjectStore();

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
  const {
    transcribeAndIndex,
    transcriptionState,
    getTranscriptionStatus,
    downloadTranscriptionModel,
  } = useTranscriptionWithIndexing();
  const isTranscribing = transcriptionState.isTranscribing;
  const [transcribingAssets, setTranscribingAssets] = useState<Set<string>>(new Set());
  const [availableTranscriptionModels, setAvailableTranscriptionModels] = useState<string[]>([]);
  const [transcriptionModels, setTranscriptionModels] = useState<TranscriptionModelDto[]>([]);
  const [transcriptionModelStatusMessage, setTranscriptionModelStatusMessage] = useState<
    string | null
  >(null);
  const [installingTranscriptionModel, setInstallingTranscriptionModel] = useState<string | null>(
    null,
  );
  const [transcriptionInstallProgress, setTranscriptionInstallProgress] = useState<number | null>(
    null,
  );

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const isImporting = importStatus?.kind === 'importing';
  const autoProxyRequestedAssetIdsRef = useRef<Set<string>>(new Set());

  // Rename state
  const [renamingEntry, setRenamingEntry] = useState<FileTreeEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    if (renamingEntry) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingEntry]);

  useEffect(() => {
    for (const asset of assets.values()) {
      if (
        !asset.missing &&
        asset.proxyStatus === 'notNeeded' &&
        assetNeedsProxy(asset) &&
        !autoProxyRequestedAssetIdsRef.current.has(asset.id)
      ) {
        autoProxyRequestedAssetIdsRef.current.add(asset.id);
        void generateProxyForAsset(asset.id).catch((error) => {
          logger.warn('Automatic proxy generation failed', { assetId: asset.id, error });
        });
      }
    }
  }, [assets, generateProxyForAsset]);

  const applyTranscriptionStatus = useCallback(
    (status: Awaited<ReturnType<typeof getTranscriptionStatus>>) => {
      if (!status) {
        setTranscriptionModels([]);
        setAvailableTranscriptionModels([]);
        setTranscriptionModelStatusMessage('Unable to read local transcription model status.');
        return;
      }

      const installedModels = status.models
        .filter((model) => model.installed)
        .map((model) => model.id);
      setTranscriptionModels(status.models);
      setAvailableTranscriptionModels(installedModels);

      if (!status.featureAvailable) {
        setTranscriptionModelStatusMessage(
          'This OpenReelio build does not include local Whisper transcription.',
        );
      } else if (installedModels.length === 0) {
        setTranscriptionModelStatusMessage('No installed Whisper model was found.');
      } else {
        setTranscriptionModelStatusMessage(null);
      }
    },
    [],
  );

  const refreshTranscriptionStatus = useCallback(async (): Promise<void> => {
    const status = await getTranscriptionStatus();
    applyTranscriptionStatus(status);
  }, [applyTranscriptionStatus, getTranscriptionStatus]);

  useEffect(() => {
    if (!transcriptionAsset) {
      setAvailableTranscriptionModels([]);
      setTranscriptionModels([]);
      setTranscriptionModelStatusMessage(null);
      setInstallingTranscriptionModel(null);
      setTranscriptionInstallProgress(null);
      return;
    }

    let cancelled = false;
    setAvailableTranscriptionModels([]);
    setTranscriptionModels([]);
    setTranscriptionModelStatusMessage('Checking installed Whisper models...');

    void getTranscriptionStatus()
      .then((status) => {
        if (cancelled) return;
        applyTranscriptionStatus(status);
      })
      .catch((error) => {
        if (cancelled) return;
        logger.warn('Failed to load transcription model status', { error });
        setTranscriptionModels([]);
        setAvailableTranscriptionModels([]);
        setTranscriptionModelStatusMessage('Unable to read local transcription model status.');
      });

    return () => {
      cancelled = true;
    };
  }, [transcriptionAsset, getTranscriptionStatus, applyTranscriptionStatus]);

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

  const importFilesToTarget = useCallback(
    async (sourcePaths: string[], targetDir: string | undefined, source: 'picker' | 'drop') => {
      if (sourcePaths.length === 0) {
        return;
      }

      setImportStatus({
        kind: 'importing',
        message: `Importing ${sourcePaths.length.toLocaleString()} file${sourcePaths.length === 1 ? '' : 's'}...`,
      });

      try {
        const result = await importExternalFiles(sourcePaths, targetDir || undefined);
        const importedCount = result.importedFiles.length;
        const failedCount = result.failedFiles.length;
        const totalCount = importedCount + failedCount || sourcePaths.length;

        setImportStatus({
          kind: failedCount > 0 ? 'warning' : 'success',
          message:
            importedCount === 0 && failedCount === 0
              ? 'No new files imported'
              : failedCount > 0
                ? `Imported ${importedCount.toLocaleString()}/${totalCount.toLocaleString()} files; ${failedCount.toLocaleString()} failed`
                : `Imported ${importedCount.toLocaleString()} file${importedCount === 1 ? '' : 's'}`,
        });

        logger.info(
          source === 'picker'
            ? 'External files imported from file picker'
            : 'External files imported into workspace',
          {
            importedCount,
            failedCount,
            targetDir: targetDir || null,
          },
        );
      } catch (error) {
        setImportStatus({
          kind: 'error',
          message: `Import failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        logger.error(
          source === 'picker'
            ? 'Failed to import files from picker'
            : 'Failed to import external file drop',
          { error },
        );
      }
    },
    [importExternalFiles],
  );

  const handleImportExternalFilesToTarget = useCallback(
    async (targetDir: string) => {
      try {
        const sourcePaths = await selectExternalImportFiles();
        await importFilesToTarget(sourcePaths, targetDir || undefined, 'picker');
      } catch (error) {
        setImportStatus({
          kind: 'error',
          message: `Import failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        logger.error('Failed to select files for import', { error });
      }
    },
    [importFilesToTarget],
  );

  const handleImportFilesForEntry = useCallback(
    (entry: FileTreeEntry) => {
      const targetDir = entry.isDirectory
        ? entry.relativePath
        : getParentDirectory(entry.relativePath);
      void handleImportExternalFilesToTarget(targetDir);
    },
    [handleImportExternalFilesToTarget],
  );

  const handleExternalFileDropPaths = useCallback(
    async (
      sourcePaths: string[],
      clientX: number,
      clientY: number,
      fallbackTarget?: EventTarget | null,
    ) => {
      const targetDir = resolveExternalDropTargetDir(
        rootRef.current,
        clientX,
        clientY,
        fallbackTarget,
      );

      if (targetDir === null) {
        return;
      }

      if (sourcePaths.length === 0) {
        logger.warn('External file drop did not include readable absolute paths');
        return;
      }

      const dropKey = `${targetDir}\n${sourcePaths.join('\n')}`;
      const now = Date.now();
      if (
        lastExternalDropRef.current?.key === dropKey &&
        now - lastExternalDropRef.current.timestampMs < DUPLICATE_EXTERNAL_DROP_WINDOW_MS
      ) {
        return;
      }
      lastExternalDropRef.current = {
        key: dropKey,
        timestampMs: now,
      };

      await importFilesToTarget(sourcePaths, targetDir || undefined, 'drop');
    },
    [importFilesToTarget],
  );

  const handleNativeDragDropEvent = useCallback(
    (event: NativeDragDropEvent) => {
      const { payload } = event;
      if (payload.type !== 'drop' || payload.paths.length === 0) {
        return;
      }

      logger.debug('Native file drop event received', {
        pathCount: payload.paths.length,
        position: payload.position,
      });

      const clientPosition = nativeDropPositionToClientPosition(payload.position);
      void handleExternalFileDropPaths(payload.paths, clientPosition.x, clientPosition.y);
    },
    [handleExternalFileDropPaths],
  );

  useEffect(() => {
    if (!isTauri()) {
      return undefined;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const unlistenFns: Array<() => void> = [];
      const errors: unknown[] = [];

      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        unlistenFns.push(await getCurrentWebview().onDragDropEvent(handleNativeDragDropEvent));
      } catch (error) {
        errors.push(error);
      }

      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        unlistenFns.push(await getCurrentWindow().onDragDropEvent(handleNativeDragDropEvent));
      } catch (error) {
        errors.push(error);
      }

      if (unlistenFns.length === 0) {
        throw errors[0] ?? new Error('No native drag/drop listener could be attached');
      }

      unlisten = () => {
        for (const unlistenFn of unlistenFns) {
          unlistenFn();
        }
      };

      logger.info('Native file drop listeners attached', {
        listenerCount: unlistenFns.length,
      });

      if (disposed && unlisten) {
        unlisten();
        unlisten = null;
      }
    })().catch((error) => {
      logger.error('Failed to attach native file drop listener', { error });
    });

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
    };
  }, [handleNativeDragDropEvent]);

  const handleExternalDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasExternalFiles(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleExternalDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!hasExternalFiles(event.dataTransfer)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const sourcePaths = getDataTransferFilePaths(event.dataTransfer);
      void handleExternalFileDropPaths(sourcePaths, event.clientX, event.clientY, event.target);
    },
    [handleExternalFileDropPaths],
  );

  const handleFileClick = useCallback(
    (entry: FileTreeEntry) => {
      if (!entry.isDirectory && entry.assetId) {
        selectAsset(entry.assetId);
        const assetKind = assets.get(entry.assetId)?.kind ?? entry.kind;
        if (canLoadIntoSourceMonitor(assetKind)) {
          // Load previewable source assets into the source monitor on selection.
          void commands.setSourceAsset({ assetId: entry.assetId }).catch(() => {
            // IPC failure is non-critical; asset selection still works.
          });
        }
      }
    },
    [assets, selectAsset],
  );

  const handleFileDoubleClick = useCallback(
    (entry: FileTreeEntry) => {
      if (!entry.isDirectory && entry.assetId) {
        selectAsset(entry.assetId);
        if (onAddToTimeline) {
          void Promise.resolve(onAddToTimeline(entry)).catch((error) => {
            logger.error('Failed to add file to timeline from double click', {
              error,
              relativePath: entry.relativePath,
            });
          });
        }
      }
    },
    [onAddToTimeline, selectAsset],
  );

  // ===========================================================================
  // Context Menu
  // ===========================================================================

  const handleContextMenu = useCallback((event: MouseEvent, entry: FileTreeEntry) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ entry, position: { x: event.clientX, y: event.clientY } });
  }, []);

  const handleWorkspaceRootContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target;
      if (target instanceof Element && target.closest(WORKSPACE_ENTRY_PATH_SELECTOR)) {
        return;
      }

      event.preventDefault();
      setContextMenu({
        entry: createWorkspaceRootEntry(fileTree),
        position: { x: event.clientX, y: event.clientY },
      });
    },
    [fileTree],
  );

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // ===========================================================================
  // File Operations via Context Menu
  // ===========================================================================

  const handleCreateFolder = useCallback(
    (parentPath: string) => {
      const folderName = getUniqueFolderName(findDirectoryEntries(fileTree, parentPath));
      const fullPath = parentPath ? `${parentPath}/${folderName}` : folderName;
      createFolder(fullPath).catch((error) => {
        logger.error('Failed to create folder', { error });
      });
    },
    [createFolder, fileTree],
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

  const handleRelinkAsset = useCallback(
    (entry: FileTreeEntry) => {
      const assetId = entry.assetId;
      if (!assetId) return;

      void (async () => {
        const selectedPath = await selectReplacementAssetFile();
        if (!selectedPath) return;

        try {
          await relinkAsset(assetId, selectedPath);
          logger.info('Asset relinked', {
            assetId,
            relativePath: entry.relativePath,
          });
        } catch (error) {
          logger.error('Failed to relink asset', {
            assetId,
            relativePath: entry.relativePath,
            error,
          });
        }
      })();
    },
    [relinkAsset],
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
        if (onAddToTimeline) {
          void Promise.resolve(onAddToTimeline(entry)).catch((error) => {
            logger.error('Failed to add file to timeline from context menu', {
              error,
              relativePath: entry.relativePath,
            });
          });
        }
      }
    },
    [onAddToTimeline, selectAsset],
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
        const result = await transcribeAndIndex(assetId, {
          language: options.language === 'auto' ? undefined : options.language,
          model: options.model,
          skipIndexing: !options.indexForSearch,
        });

        if (!options.addToTimeline || !result || result.segments.length === 0) {
          return;
        }

        const activeSequence = activeSequenceId ? sequences.get(activeSequenceId) : undefined;
        if (!activeSequence) {
          logger.warn('Transcription complete, but no active sequence is available for captions', {
            assetId,
          });
          return;
        }

        const captionSegments = buildCaptionSegmentPayloads(result.segments);
        if (captionSegments.length === 0) {
          return;
        }

        let captionTrackId = activeSequence.tracks.find((track) => track.kind === 'caption')?.id;
        if (!captionTrackId) {
          const trackCreationResult = await executeCommand({
            type: 'CreateTrack',
            payload: {
              sequenceId: activeSequence.id,
              kind: 'caption',
              name: 'Captions',
            },
          });
          captionTrackId = trackCreationResult.createdIds[0];
        }

        if (!captionTrackId) {
          logger.warn('Unable to resolve caption track for transcription insertion', {
            assetId,
            sequenceId: activeSequence.id,
          });
          return;
        }

        await executeCommand({
          type: 'ImportGeneratedCaptions',
          payload: {
            sequenceId: activeSequence.id,
            trackId: captionTrackId,
            segments: captionSegments,
          },
        });
      } finally {
        setTranscribingAssets((prev) => {
          const next = new Set(prev);
          next.delete(assetId);
          return next;
        });
      }
    },
    [transcriptionAsset, transcribeAndIndex, activeSequenceId, sequences, executeCommand],
  );

  const handleTranscriptionCancel = useCallback(() => {
    setTranscriptionAsset(null);
  }, []);

  const handleInstallTranscriptionModel = useCallback(
    async (modelId: string) => {
      setInstallingTranscriptionModel(modelId);
      setTranscriptionInstallProgress(null);
      setTranscriptionModelStatusMessage(null);

      const installed = await downloadTranscriptionModel(modelId, {
        onProgress: (progress) => {
          setTranscriptionInstallProgress(progress.percent ?? null);
        },
      });

      if (!installed) {
        setTranscriptionModelStatusMessage(`Failed to install Whisper model '${modelId}'.`);
      }

      await refreshTranscriptionStatus();
      setInstallingTranscriptionModel(null);
      setTranscriptionInstallProgress(null);
    },
    [downloadTranscriptionModel, refreshTranscriptionStatus],
  );

  // ===========================================================================
  // Filtered Tree
  // ===========================================================================

  const filteredTree = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return fileTree;

    function filterEntries(entries: FileTreeEntry[]): FileTreeEntry[] {
      return entries
        .map((entry) => {
          if (entry.isDirectory) {
            const filteredChildren = filterEntries(entry.children);
            const directoryMatchesQuery = entry.name.toLowerCase().includes(query);
            if (filteredChildren.length > 0 || directoryMatchesQuery) {
              return { ...entry, children: filteredChildren };
            }
            return null;
          }

          const matchesQuery =
            query.length === 0 ||
            entry.name.toLowerCase().includes(query) ||
            entry.relativePath.toLowerCase().includes(query);
          return matchesQuery ? entry : null;
        })
        .filter((e): e is FileTreeEntry => e !== null);
    }

    return filterEntries(fileTree);
  }, [fileTree, searchQuery]);

  // Header create folder handler
  const handleHeaderCreateFolder = useCallback(() => {
    handleCreateFolder('');
  }, [handleCreateFolder]);

  const handleHeaderImportFiles = useCallback(() => {
    void handleImportExternalFilesToTarget('');
  }, [handleImportExternalFilesToTarget]);

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
      ref={rootRef}
      data-testid="project-explorer"
      data-workspace-drop-root="true"
      className="flex flex-col h-full bg-editor-sidebar text-editor-text relative"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onDragEnter={handleExternalDragOver}
      onDragOver={handleExternalDragOver}
      onDrop={handleExternalDrop}
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
            data-testid="import-files-button"
            className={`p-1.5 rounded transition-colors ${isImporting ? 'opacity-50 cursor-not-allowed' : 'hover:bg-surface-active'}`}
            onClick={handleHeaderImportFiles}
            disabled={isImporting}
            aria-label={isImporting ? 'Importing files...' : 'Import files'}
            title="Import files"
          >
            <Upload className="w-4 h-4" />
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

      {importStatus && (
        <div
          data-testid="import-status"
          className={`border-b border-editor-border px-3 py-2 text-xs ${
            importStatus.kind === 'error'
              ? 'text-red-400'
              : importStatus.kind === 'warning'
                ? 'text-amber-300'
                : importStatus.kind === 'success'
                  ? 'text-emerald-300'
                  : 'text-editor-text-muted'
          }`}
          role={importStatus.kind === 'error' ? 'alert' : 'status'}
        >
          {importStatus.message}
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

      <ProxyQueuePanel assets={assets} proxyJobIdsByAssetId={proxyJobIdsByAssetId} />

      {/* File Tree */}
      <div
        className="flex-1 overflow-y-auto"
        data-workspace-drop-root="true"
        onContextMenu={handleWorkspaceRootContextMenu}
      >
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
          onImportFiles={handleImportFilesForEntry}
          onRelinkAsset={handleRelinkAsset}
          onReplaceAsset={handleRelinkAsset}
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
          availableModels={availableTranscriptionModels}
          models={transcriptionModels}
          modelStatusMessage={transcriptionModelStatusMessage ?? undefined}
          onInstallModel={handleInstallTranscriptionModel}
          installingModel={installingTranscriptionModel}
          installProgress={transcriptionInstallProgress}
          isProcessing={isTranscribing}
        />
      )}
    </div>
  );
}
