/**
 * ProjectExplorer Component Tests
 *
 * Regression tests for source monitor routing from explorer selections.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Asset, FileTreeEntry } from '@/types';

const mockState = vi.hoisted(() => ({
  scanWorkspace: vi.fn(),
  importExternalFiles: vi.fn(),
  selectAsset: vi.fn(),
  executeCommand: vi.fn(),
  setSourceAsset: vi.fn(),
  createFolder: vi.fn(),
  renameFile: vi.fn(),
  deleteFile: vi.fn(),
  revealInExplorer: vi.fn(),
  transcribeAndIndex: vi.fn(),
  fileTree: [] as FileTreeEntry[],
  assets: new Map<string, Asset>(),
}));

vi.mock('@/stores', () => ({
  useWorkspaceStore: (selector?: (state: unknown) => unknown) => {
    const state = {
      fileTree: mockState.fileTree,
      isScanning: false,
      scanWorkspace: mockState.scanWorkspace,
      importExternalFiles: mockState.importExternalFiles,
    };
    return typeof selector === 'function' ? selector(state) : state;
  },
  useProjectStore: (selector?: (state: unknown) => unknown) => {
    const state = {
      assets: mockState.assets,
      selectAsset: mockState.selectAsset,
      executeCommand: mockState.executeCommand,
      activeSequenceId: null,
      sequences: new Map(),
    };
    return typeof selector === 'function' ? selector(state) : state;
  },
}));

vi.mock('@/hooks', () => ({
  useTranscriptionWithIndexing: () => ({
    transcribeAndIndex: mockState.transcribeAndIndex,
    transcriptionState: { isTranscribing: false },
  }),
}));

vi.mock('@/hooks/useFileOperations', () => ({
  useFileOperations: () => ({
    createFolder: mockState.createFolder,
    renameFile: mockState.renameFile,
    deleteFile: mockState.deleteFile,
    revealInExplorer: mockState.revealInExplorer,
  }),
}));

vi.mock('@/bindings', () => ({
  commands: {
    setSourceAsset: mockState.setSourceAsset,
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
}));

vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('./FileTree', () => ({
  FileTree: ({
    entries,
    onFileClick,
    onFileDoubleClick,
  }: {
    entries: FileTreeEntry[];
    onFileClick?: (entry: FileTreeEntry) => void;
    onFileDoubleClick?: (entry: FileTreeEntry) => void;
  }) => (
    <div data-testid="file-tree">
      {entries.map((entry) => (
        <button
          key={entry.relativePath}
          type="button"
          data-workspace-entry-path={entry.relativePath}
          data-workspace-entry-directory={entry.isDirectory ? 'true' : 'false'}
          onClick={() => onFileClick?.(entry)}
          onDoubleClick={() => onFileDoubleClick?.(entry)}
        >
          {entry.name}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('./FileTreeContextMenu', () => ({
  FileTreeContextMenu: () => null,
}));

vi.mock('@/components/ui', () => ({
  ConfirmDialog: () => null,
}));

vi.mock('@/components/features/transcription', () => ({
  TranscriptionDialog: () => null,
}));

import { ProjectExplorer } from './ProjectExplorer';

function createFileEntry(overrides: Partial<FileTreeEntry>): FileTreeEntry {
  return {
    relativePath: 'media/test.mp4',
    name: 'test.mp4',
    isDirectory: false,
    kind: 'video',
    assetId: 'asset-1',
    children: [],
    ...overrides,
  };
}

function createAsset(id: string, kind: Asset['kind']): Asset {
  return {
    id,
    kind,
    name: `${id}.${kind}`,
    uri: `/tmp/${id}`,
    hash: `${id}-hash`,
    fileSize: 1,
    importedAt: '2026-03-16T00:00:00.000Z',
    license: {
      source: 'user',
      licenseType: 'royalty_free',
      allowedUse: [],
    },
    tags: [],
    proxyStatus: 'notNeeded',
  };
}

function mockElementBounds(element: HTMLElement): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 500,
    bottom: 500,
    width: 500,
    height: 500,
    toJSON: () => ({}),
  } as DOMRect);
}

describe('ProjectExplorer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.fileTree = [];
    mockState.assets = new Map();
    mockState.createFolder.mockResolvedValue(undefined);
    mockState.renameFile.mockResolvedValue(undefined);
    mockState.deleteFile.mockResolvedValue(undefined);
    mockState.revealInExplorer.mockResolvedValue(undefined);
    mockState.importExternalFiles.mockResolvedValue({
      importedFiles: [],
      failedFiles: [],
    });
    mockState.setSourceAsset.mockResolvedValue({
      status: 'ok',
      data: {
        assetId: null,
        inPoint: null,
        outPoint: null,
        playheadSec: 0,
        markedDuration: null,
      },
    });
  });

  it('should load previewable assets into the source monitor on click', () => {
    mockState.fileTree = [
      createFileEntry({
        relativePath: 'media/source.mp4',
        name: 'source.mp4',
        kind: 'video',
        assetId: 'video-1',
      }),
    ];
    mockState.assets = new Map([['video-1', createAsset('video-1', 'video')]]);

    render(<ProjectExplorer />);

    fireEvent.click(screen.getByRole('button', { name: 'source.mp4' }));

    expect(mockState.selectAsset).toHaveBeenCalledWith('video-1');
    expect(mockState.setSourceAsset).toHaveBeenCalledWith({ assetId: 'video-1' });
  });

  it('should not load unsupported assets into the source monitor on click', () => {
    mockState.fileTree = [
      createFileEntry({
        relativePath: 'media/still.png',
        name: 'still.png',
        kind: 'image',
        assetId: 'image-1',
      }),
    ];
    mockState.assets = new Map([['image-1', createAsset('image-1', 'image')]]);

    render(<ProjectExplorer />);

    fireEvent.click(screen.getByRole('button', { name: 'still.png' }));

    expect(mockState.selectAsset).toHaveBeenCalledWith('image-1');
    expect(mockState.setSourceAsset).not.toHaveBeenCalled();
  });

  it('should add an asset to the timeline on double click when a handler is provided', () => {
    const onAddToTimeline = vi.fn();
    const entry = createFileEntry({
      relativePath: 'audio/voice.wav',
      name: 'voice.wav',
      kind: 'audio',
      assetId: 'audio-1',
    });
    mockState.fileTree = [entry];
    mockState.assets = new Map([['audio-1', createAsset('audio-1', 'audio')]]);

    render(<ProjectExplorer onAddToTimeline={onAddToTimeline} />);

    fireEvent.doubleClick(screen.getByRole('button', { name: 'voice.wav' }));

    expect(mockState.selectAsset).toHaveBeenCalledWith('audio-1');
    expect(onAddToTimeline).toHaveBeenCalledWith(entry);
  });

  it('should create a unique root folder name from the header action', () => {
    mockState.fileTree = [
      createFileEntry({
        relativePath: 'New Folder',
        name: 'New Folder',
        isDirectory: true,
        assetId: undefined,
        kind: undefined,
        children: [],
      }),
    ];

    render(<ProjectExplorer />);

    fireEvent.click(screen.getByTestId('create-folder-button'));

    expect(mockState.createFolder).toHaveBeenCalledWith('New Folder 1');
  });

  it('should import externally dropped files into the workspace root', async () => {
    render(<ProjectExplorer />);
    const explorer = screen.getByTestId('project-explorer');
    mockElementBounds(explorer);

    const droppedFile = new File(['media'], 'drop.mp4', { type: 'video/mp4' });
    Object.defineProperty(droppedFile, 'path', {
      value: '/Users/test/Desktop/drop.mp4',
      configurable: true,
    });

    fireEvent.drop(explorer, {
      dataTransfer: {
        types: ['Files'],
        files: [droppedFile],
        dropEffect: 'none',
      },
      clientX: 10,
      clientY: 10,
    });

    await waitFor(() => {
      expect(mockState.importExternalFiles).toHaveBeenCalledWith(
        ['/Users/test/Desktop/drop.mp4'],
        undefined,
      );
    });
  });

  it('should import externally dropped files into a hovered folder', async () => {
    mockState.fileTree = [
      createFileEntry({
        relativePath: 'footage',
        name: 'footage',
        isDirectory: true,
        assetId: undefined,
        kind: undefined,
        children: [],
      }),
    ];

    render(<ProjectExplorer />);
    mockElementBounds(screen.getByTestId('project-explorer'));

    const droppedFile = new File(['media'], 'drop.mp4', { type: 'video/mp4' });
    Object.defineProperty(droppedFile, 'path', {
      value: '/Users/test/Desktop/drop.mp4',
      configurable: true,
    });

    fireEvent.drop(screen.getByRole('button', { name: 'footage' }), {
      dataTransfer: {
        types: ['Files'],
        files: [droppedFile],
        dropEffect: 'none',
      },
      clientX: 10,
      clientY: 10,
    });

    await waitFor(() => {
      expect(mockState.importExternalFiles).toHaveBeenCalledWith(
        ['/Users/test/Desktop/drop.mp4'],
        'footage',
      );
    });
  });
});
