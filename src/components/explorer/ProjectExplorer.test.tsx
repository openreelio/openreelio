/**
 * ProjectExplorer Component Tests
 *
 * Regression tests for source monitor routing from explorer selections.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Asset, FileTreeEntry } from '@/types';

const workspaceGateway = vi.hoisted(() => ({
  importExternalFilesToWorkspaceFromBackend: vi.fn(),
  fetchWorkspaceTreeFromBackend: vi.fn(),
}));

const mockState = vi.hoisted(() => ({
  scanWorkspace: vi.fn(),
  importExternalFiles: vi.fn(),
  selectAsset: vi.fn(),
  executeCommand: vi.fn(),
  relinkAsset: vi.fn(),
  generateProxyForAsset: vi.fn(),
  cancelProxyForAsset: vi.fn(),
  useOriginalMedia: vi.fn(),
  openDialog: vi.fn(),
  setSourceAsset: vi.fn(),
  createFolder: vi.fn(),
  renameFile: vi.fn(),
  deleteFile: vi.fn(),
  revealInExplorer: vi.fn(),
  transcribeAndIndex: vi.fn(),
  getTranscriptionStatus: vi.fn(),
  downloadTranscriptionModel: vi.fn(),
  fileTree: [] as FileTreeEntry[],
  assets: new Map<string, Asset>(),
  scanWarning: null as string | null,
}));

vi.mock('@/stores', () => ({
  useWorkspaceStore: (selector?: (state: unknown) => unknown) => {
    const state = {
      fileTree: mockState.fileTree,
      isScanning: false,
      scanWorkspace: mockState.scanWorkspace,
      importExternalFiles: mockState.importExternalFiles,
      scanWarning: mockState.scanWarning,
    };
    return typeof selector === 'function' ? selector(state) : state;
  },
  useProjectStore: (selector?: (state: unknown) => unknown) => {
    const state = {
      assets: mockState.assets,
      selectAsset: mockState.selectAsset,
      executeCommand: mockState.executeCommand,
      relinkAsset: mockState.relinkAsset,
      proxyJobIdsByAssetId: {},
      generateProxyForAsset: mockState.generateProxyForAsset,
      cancelProxyForAsset: mockState.cancelProxyForAsset,
      useOriginalMedia: mockState.useOriginalMedia,
      activeSequenceId: null,
      sequences: new Map(),
    };
    return typeof selector === 'function' ? selector(state) : state;
  },
}));

vi.mock('@/hooks', () => ({
  useTranscriptionWithIndexing: () => ({
    transcribeAndIndex: mockState.transcribeAndIndex,
    getTranscriptionStatus: mockState.getTranscriptionStatus,
    downloadTranscriptionModel: mockState.downloadTranscriptionModel,
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

vi.mock('@/hooks/useJobs', () => ({
  useJobs: () => ({
    jobs: [],
    stats: null,
    isLoading: false,
    error: null,
    submitJob: vi.fn(),
    cancelJob: vi.fn(),
    getJob: vi.fn(),
    refreshJobs: vi.fn(),
    refreshStats: vi.fn(),
  }),
}));

vi.mock('@/bindings', () => ({
  commands: {
    setSourceAsset: mockState.setSourceAsset,
    getTranscriptionStatus: mockState.getTranscriptionStatus,
    downloadWhisperModel: mockState.downloadTranscriptionModel,
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));

// The real workspace store is driven directly by one test below, so its only
// boundary - the Tauri gateway - is what gets mocked, not the store itself.
vi.mock('@/services/workspaceGateway', () => ({
  importExternalFilesToWorkspaceFromBackend:
    workspaceGateway.importExternalFilesToWorkspaceFromBackend,
  fetchWorkspaceTreeFromBackend: workspaceGateway.fetchWorkspaceTreeFromBackend,
  scanWorkspaceFromBackend: vi.fn(),
  createFolderInBackend: vi.fn(),
  renameFileInBackend: vi.fn(),
  moveFileInBackend: vi.fn(),
  deleteFileInBackend: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: mockState.openDialog,
}));

vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    time: vi.fn(),
    timeEnd: vi.fn(),
  }),
}));

vi.mock('./FileTree', () => ({
  FileTree: ({
    entries,
    onFileClick,
    onFileDoubleClick,
    onContextMenu,
  }: {
    entries: FileTreeEntry[];
    onFileClick?: (entry: FileTreeEntry) => void;
    onFileDoubleClick?: (entry: FileTreeEntry) => void;
    onContextMenu?: (event: ReactMouseEvent, entry: FileTreeEntry) => void;
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
          onContextMenu={(event) => onContextMenu?.(event, entry)}
        >
          {entry.name}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('./FileTreeContextMenu', () => ({
  FileTreeContextMenu: ({
    entry,
    onRelinkAsset,
  }: {
    entry: FileTreeEntry;
    onRelinkAsset?: (entry: FileTreeEntry) => void;
  }) => (
    <button type="button" data-testid="context-relink" onClick={() => onRelinkAsset?.(entry)}>
      Relink
    </button>
  ),
}));

vi.mock('@/components/ui', () => ({
  ConfirmDialog: () => null,
}));

vi.mock('@/components/features/transcription', () => ({
  TranscriptionDialog: () => null,
}));

import { ProjectExplorer } from './ProjectExplorer';
import { useWorkspaceStore } from '@/stores/workspaceStore';

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

function createAsset(id: string, kind: Asset['kind'], overrides: Partial<Asset> = {}): Asset {
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
    ...overrides,
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
    mockState.scanWarning = null;
    mockState.createFolder.mockResolvedValue(undefined);
    mockState.renameFile.mockResolvedValue(undefined);
    mockState.deleteFile.mockResolvedValue(undefined);
    mockState.revealInExplorer.mockResolvedValue(undefined);
    mockState.relinkAsset.mockResolvedValue(undefined);
    mockState.generateProxyForAsset.mockResolvedValue(undefined);
    mockState.cancelProxyForAsset.mockResolvedValue(undefined);
    mockState.useOriginalMedia.mockResolvedValue(undefined);
    mockState.openDialog.mockResolvedValue(null);
    mockState.importExternalFiles.mockResolvedValue({
      importedFiles: [],
      failedFiles: [],
    });
    useWorkspaceStore.getState().reset();
    workspaceGateway.fetchWorkspaceTreeFromBackend.mockResolvedValue([]);
    mockState.getTranscriptionStatus.mockResolvedValue({
      featureAvailable: true,
      ready: true,
      modelsDir: '/models/whisper',
      defaultModel: 'base',
      installedCount: 1,
      models: [
        {
          id: 'base',
          displayName: 'Base',
          filename: 'ggml-base.bin',
          installed: true,
          path: '/models/whisper/ggml-base.bin',
          sizeBytes: 1,
          isDefault: true,
          recommended: true,
          downloadUrl: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
          estimatedSizeBytes: 148000000,
          source: 'ggerganov/whisper.cpp',
          license: 'MIT',
        },
      ],
    });
    mockState.downloadTranscriptionModel.mockResolvedValue({
      id: 'base',
      displayName: 'Base',
      filename: 'ggml-base.bin',
      installed: true,
      path: '/models/whisper/ggml-base.bin',
      sizeBytes: 1,
      isDefault: true,
      recommended: true,
      downloadUrl: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
      estimatedSizeBytes: 148000000,
      source: 'ggerganov/whisper.cpp',
      license: 'MIT',
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

  it('should bulk import files from the header picker and show a summary', async () => {
    mockState.openDialog.mockResolvedValue([
      '/Users/test/Desktop/a.mp4',
      '/Users/test/Desktop/b.wav',
      '/Users/test/Desktop/broken.mov',
    ]);
    mockState.importExternalFiles.mockResolvedValue({
      importedFiles: [
        {
          sourcePath: '/Users/test/Desktop/a.mp4',
          relativePath: 'a.mp4',
          name: 'a.mp4',
          kind: 'video',
          fileSize: 100,
          assetId: 'asset-a',
          alreadyInWorkspace: false,
        },
        {
          sourcePath: '/Users/test/Desktop/b.wav',
          relativePath: 'b.wav',
          name: 'b.wav',
          kind: 'audio',
          fileSize: 50,
          assetId: 'asset-b',
          alreadyInWorkspace: false,
        },
      ],
      failedFiles: [
        {
          sourcePath: '/Users/test/Desktop/broken.mov',
          message: 'Cannot read file',
        },
      ],
    });

    render(<ProjectExplorer />);

    fireEvent.click(screen.getByTestId('import-files-button'));

    await waitFor(() => {
      expect(mockState.openDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          multiple: true,
          title: 'Import Media Files',
        }),
      );
    });

    await waitFor(() => {
      expect(mockState.importExternalFiles).toHaveBeenCalledWith(
        [
          '/Users/test/Desktop/a.mp4',
          '/Users/test/Desktop/b.wav',
          '/Users/test/Desktop/broken.mov',
        ],
        undefined,
      );
    });
    expect(screen.getByTestId('import-status')).toHaveTextContent('Imported 2/3 files; 1 failed');
  });

  it('should report a drop as failed when the backend could not measure the files', async () => {
    // The backend copies a file it cannot probe into the workspace but does not
    // register it as an asset, so it comes back as a failure rather than an
    // import. Counting it as imported would tell the user a file landed that
    // nothing in the app can actually use yet.
    //
    // The real store action runs here, with only the Tauri gateway mocked: a
    // drop where nothing landed is exactly the case a store that threw would
    // turn into a generic error, hiding the per-file reason below.
    const backendMessage =
      "'unreachable.mp4' was copied but could not be measured: FFprobe could not be launched, or returned nothing readable; it registers on the next scan";
    workspaceGateway.importExternalFilesToWorkspaceFromBackend.mockResolvedValue({
      importedFiles: [],
      failedFiles: [
        {
          sourcePath: '/Users/test/Desktop/unreachable.mp4',
          message: backendMessage,
        },
      ],
    });
    mockState.importExternalFiles.mockImplementation((sourcePaths: string[], targetDir?: string) =>
      useWorkspaceStore.getState().importExternalFiles(sourcePaths, targetDir),
    );
    mockState.openDialog.mockResolvedValue(['/Users/test/Desktop/unreachable.mp4']);

    render(<ProjectExplorer />);

    fireEvent.click(screen.getByTestId('import-files-button'));

    await waitFor(() => {
      expect(screen.getByTestId('import-status')).toHaveTextContent('Imported 0/1 files; 1 failed');
    });
    expect(screen.getByTestId('import-status')).toHaveTextContent(backendMessage);
  });

  it('should surface the warning when a scan left files unmeasured', async () => {
    mockState.scanWarning =
      '2 files could not be measured: FFprobe could not be launched, or returned nothing readable, so they are not available as media yet. Check FFmpeg is installed, then scan again.';

    render(<ProjectExplorer />);

    expect(screen.getByTestId('workspace-scan-warning')).toHaveTextContent(
      'FFprobe could not be launched, or returned nothing readable',
    );
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

  it('should keep the explorer surface simple while search narrows files', () => {
    mockState.fileTree = [
      createFileEntry({
        relativePath: 'footage/interview.mp4',
        name: 'interview.mp4',
        kind: 'video',
        assetId: 'video-1',
      }),
      createFileEntry({
        relativePath: 'footage/music.wav',
        name: 'music.wav',
        kind: 'audio',
        assetId: 'audio-1',
      }),
    ];

    render(<ProjectExplorer />);

    expect(screen.queryByText(/registered/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Explorer filters')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('asset-search'), { target: { value: 'music' } });

    expect(screen.getByRole('button', { name: 'music.wav' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'interview.mp4' })).not.toBeInTheDocument();
  });

  it('should report the failure in the status line when relinking an asset fails', async () => {
    mockState.fileTree = [
      createFileEntry({
        relativePath: 'footage/interview.mp4',
        name: 'interview.mp4',
        kind: 'video',
        assetId: 'video-1',
      }),
    ];
    mockState.assets = new Map([['video-1', createAsset('video-1', 'video')]]);
    mockState.openDialog.mockResolvedValue('/Users/test/Desktop/replacement.mp4');
    mockState.relinkAsset.mockRejectedValue(
      new Error('FFprobe could not be run: Failed to run ffprobe for replacement.mp4 (os error 2)'),
    );

    render(<ProjectExplorer />);

    fireEvent.contextMenu(screen.getByRole('button', { name: 'interview.mp4' }));
    fireEvent.click(screen.getByTestId('context-relink'));

    await waitFor(() => {
      expect(mockState.relinkAsset).toHaveBeenCalledWith(
        'video-1',
        '/Users/test/Desktop/replacement.mp4',
      );
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/FFmpeg is not installed/i);
  });

  it('should request proxy generation automatically for high-resolution video assets', async () => {
    mockState.assets = new Map([
      [
        'video-1',
        createAsset('video-1', 'video', {
          video: {
            width: 3840,
            height: 2160,
            fps: { num: 30, den: 1 },
            codec: 'h264',
            hasAlpha: false,
          },
        }),
      ],
    ]);

    render(<ProjectExplorer />);

    await waitFor(() => {
      expect(mockState.generateProxyForAsset).toHaveBeenCalledWith('video-1');
    });
  });
});
