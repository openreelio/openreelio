/**
 * ProjectExplorer Component Tests
 *
 * Tests for the unified filesystem-first project explorer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ProjectExplorer } from './ProjectExplorer';
import type { FileTreeEntry } from '@/types';

// =============================================================================
// Mocks
// =============================================================================

const mockUseProjectStore = vi.fn();
const mockScanWorkspace = vi.fn();
const mockCreateFolder = vi.fn().mockResolvedValue(undefined);
const mockRenameFile = vi.fn().mockResolvedValue(undefined);
const mockDeleteFile = vi.fn().mockResolvedValue(undefined);
const mockRevealInExplorer = vi.fn().mockResolvedValue(undefined);
const mockClipboardWriteText = vi.fn().mockResolvedValue(undefined);

const mockFileTree: FileTreeEntry[] = [
  {
    relativePath: 'footage',
    name: 'footage',
    isDirectory: true,
    children: [
      {
        relativePath: 'footage/video1.mp4',
        name: 'video1.mp4',
        isDirectory: false,
        kind: 'video',
        fileSize: 1024 * 1024 * 50,
        assetId: 'asset_001',
        children: [],
      },
    ],
  },
  {
    relativePath: 'audio1.mp3',
    name: 'audio1.mp3',
    isDirectory: false,
    kind: 'audio',
    fileSize: 1024 * 1024 * 5,
    assetId: 'asset_002',
    children: [],
  },
  {
    relativePath: 'image1.jpg',
    name: 'image1.jpg',
    isDirectory: false,
    kind: 'image',
    fileSize: 1024 * 512,
    assetId: 'asset_003',
    children: [],
  },
];

vi.mock('@/stores', () => ({
  useProjectStore: (...args: unknown[]) => mockUseProjectStore(...args),
  useWorkspaceStore: (selector: (state: unknown) => unknown) => {
    const state = {
      fileTree: mockFileTree,
      isScanning: false,
      scanWorkspace: mockScanWorkspace,
    };
    return selector(state);
  },
}));

vi.mock('@/hooks', () => ({
  useTranscriptionWithIndexing: () => ({
    transcribeAndIndex: vi.fn(),
    transcriptionState: {
      isTranscribing: false,
      progress: 0,
      error: null,
      result: null,
    },
  }),
}));

vi.mock('@/hooks/useFileOperations', () => ({
  useFileOperations: () => ({
    createFolder: mockCreateFolder,
    renameFile: mockRenameFile,
    deleteFile: mockDeleteFile,
    revealInExplorer: mockRevealInExplorer,
    moveFile: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    time: vi.fn(),
    timeEnd: vi.fn(),
  }),
}));

// =============================================================================
// Tests
// =============================================================================

describe('ProjectExplorer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockClipboardWriteText },
      configurable: true,
    });
    mockCreateFolder.mockResolvedValue(undefined);
    mockRenameFile.mockResolvedValue(undefined);
    mockDeleteFile.mockResolvedValue(undefined);
    mockRevealInExplorer.mockResolvedValue(undefined);
    mockUseProjectStore.mockReturnValue({
      assets: new Map(),
      isLoading: false,
      selectedAssetId: null,
      selectAsset: vi.fn(),
      removeAsset: vi.fn(),
    });
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render project explorer container', () => {
      render(<ProjectExplorer />);
      expect(screen.getByTestId('project-explorer')).toBeInTheDocument();
    });

    it('should render header with Explorer title', () => {
      render(<ProjectExplorer />);
      expect(screen.getByText('Explorer')).toBeInTheDocument();
    });

    it('should render create folder button', () => {
      render(<ProjectExplorer />);
      expect(screen.getByTestId('create-folder-button')).toBeInTheDocument();
    });

    it('should render scan workspace button', () => {
      render(<ProjectExplorer />);
      expect(screen.getByTestId('scan-workspace-button')).toBeInTheDocument();
    });

    it('should render search input', () => {
      render(<ProjectExplorer />);
      expect(screen.getByTestId('asset-search')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Search files...')).toBeInTheDocument();
    });

    it('should render file tree entries', () => {
      render(<ProjectExplorer />);
      expect(screen.getByText('footage')).toBeInTheDocument();
      expect(screen.getByText('audio1.mp3')).toBeInTheDocument();
      expect(screen.getByText('image1.jpg')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Search Tests
  // ===========================================================================

  describe('search', () => {
    it('should filter tree when typing in search', () => {
      render(<ProjectExplorer />);

      const searchInput = screen.getByTestId('asset-search');
      fireEvent.change(searchInput, { target: { value: 'audio' } });

      expect(screen.getByText('audio1.mp3')).toBeInTheDocument();
      expect(screen.queryByText('image1.jpg')).not.toBeInTheDocument();
    });

    it('should clear search when clear button clicked', () => {
      render(<ProjectExplorer />);

      const searchInput = screen.getByTestId('asset-search');
      fireEvent.change(searchInput, { target: { value: 'audio' } });

      const clearButton = screen.getByTestId('search-clear');
      fireEvent.click(clearButton);

      expect(screen.getByText('audio1.mp3')).toBeInTheDocument();
      expect(screen.getByText('image1.jpg')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Keyboard Navigation Tests
  // ===========================================================================

  describe('keyboard navigation', () => {
    it('should focus search on Ctrl+F', () => {
      render(<ProjectExplorer />);

      const explorer = screen.getByTestId('project-explorer');
      fireEvent.keyDown(explorer, { key: 'f', ctrlKey: true });

      expect(screen.getByTestId('asset-search')).toHaveFocus();
    });
  });

  // ===========================================================================
  // Scan Tests
  // ===========================================================================

  describe('workspace scan', () => {
    it('should call scanWorkspace when scan button clicked', () => {
      render(<ProjectExplorer />);

      fireEvent.click(screen.getByTestId('scan-workspace-button'));
      expect(mockScanWorkspace).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Create Folder Tests
  // ===========================================================================

  describe('create folder', () => {
    it('should call createFolder when header button clicked', () => {
      render(<ProjectExplorer />);

      fireEvent.click(screen.getByTestId('create-folder-button'));
      expect(mockCreateFolder).toHaveBeenCalledWith('New Folder');
    });
  });

  describe('file context menu actions', () => {
    it('should rename a file from context menu using the rename dialog', async () => {
      render(<ProjectExplorer />);

      const audioFileRow = screen.getByTitle('audio1.mp3');
      fireEvent.contextMenu(audioFileRow);

      fireEvent.click(screen.getByText('Rename'));

      const renameInput = screen.getByTestId('rename-input');
      fireEvent.change(renameInput, { target: { value: 'audio-renamed.mp3' } });
      fireEvent.click(screen.getByTestId('rename-confirm-button'));

      await waitFor(() => {
        expect(mockRenameFile).toHaveBeenCalledWith('audio1.mp3', 'audio-renamed.mp3');
      });
    });

    it('should open transcription dialog from file context menu', () => {
      render(<ProjectExplorer />);

      const audioFileRow = screen.getByTitle('audio1.mp3');
      fireEvent.contextMenu(audioFileRow);

      fireEvent.click(screen.getByText('Transcribe'));

      const dialog = screen.getByTestId('transcription-dialog');
      expect(dialog).toBeInTheDocument();
      expect(within(dialog).getByText('audio1.mp3')).toBeInTheDocument();
    });

    it('should copy relative path from file context menu', async () => {
      render(<ProjectExplorer />);

      const audioFileRow = screen.getByTitle('audio1.mp3');
      fireEvent.contextMenu(audioFileRow);

      fireEvent.click(screen.getByText('Copy Path'));

      await waitFor(() => {
        expect(mockClipboardWriteText).toHaveBeenCalledWith('audio1.mp3');
      });
    });
  });
});
