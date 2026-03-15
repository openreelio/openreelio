/**
 * ProjectExplorer Component Tests
 *
 * Regression tests for source monitor routing from explorer selections.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Asset, FileTreeEntry } from '@/types';

const mockState = vi.hoisted(() => ({
  scanWorkspace: vi.fn(),
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

vi.mock('@/services/logger', () => ({
  createLogger: () => ({
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

describe('ProjectExplorer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.fileTree = [];
    mockState.assets = new Map();
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
});
