/**
 * ProjectExplorer Component Tests
 *
 * Tests for the project explorer panel with asset management.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectExplorer } from './ProjectExplorer';
import type { Asset } from './AssetList';

// =============================================================================
// Mocks
// =============================================================================

const mockUseProjectStore = vi.fn();
const mockUseBinStore = vi.fn();
const mockConvertFileSrc = vi.fn((path: string) => `asset://${path}`);

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => mockConvertFileSrc(path),
}));

vi.mock('@/stores', () => ({
  useProjectStore: (...args: unknown[]) => mockUseProjectStore(...args),
  useBinStore: (...args: unknown[]) => mockUseBinStore(...args),
  useWorkspaceStore: (selector: (state: unknown) => unknown) => {
    const state = {
      fileTree: [],
      isScanning: false,
      registeringPathCounts: {},
      scanWorkspace: vi.fn(),
      registerFile: vi.fn(),
    };
    return selector(state);
  },
}));

vi.mock('@/hooks', () => ({
  useBinOperations: () => ({
    createBin: vi.fn(),
    renameBin: vi.fn(),
    deleteBin: vi.fn(),
    moveBin: vi.fn(),
    setBinColor: vi.fn(),
    moveAssetToBin: vi.fn(),
  }),
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

const mockAssetsArray: Asset[] = [
  { id: 'asset_001', name: 'video1.mp4', kind: 'video', duration: 120 },
  { id: 'asset_002', name: 'audio1.mp3', kind: 'audio', duration: 180 },
  { id: 'asset_003', name: 'image1.jpg', kind: 'image' },
];

// Create a Map from the array for proper store mocking
const mockAssets = new Map(
  mockAssetsArray.map((asset) => [
    asset.id,
    { ...asset, uri: `/path/to/${asset.name}`, durationSec: asset.duration },
  ]),
);

// =============================================================================
// Tests
// =============================================================================

function renderProjectExplorer() {
  render(<ProjectExplorer />);
  fireEvent.click(screen.getByTestId('tab-assets'));
}

describe('ProjectExplorer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseProjectStore.mockReturnValue({
      assets: mockAssets,
      isLoading: false,
      selectedAssetId: null,
      selectAsset: vi.fn(),
      removeAsset: vi.fn(),
    });
    mockUseBinStore.mockReturnValue({
      bins: {},
      selectedBinId: null,
      editingBinId: null,
      selectBin: vi.fn(),
      createBin: vi.fn(),
      renameBin: vi.fn(),
      toggleExpand: vi.fn(),
      cancelEditing: vi.fn(),
      getBinsArray: vi.fn(() => []),
    });
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render project explorer container', () => {
      renderProjectExplorer();
      expect(screen.getByTestId('project-explorer')).toBeInTheDocument();
    });

    it('should render header with title', () => {
      renderProjectExplorer();
      expect(screen.getByText('Project')).toBeInTheDocument();
    });

    it('should not render legacy import button', () => {
      renderProjectExplorer();
      expect(screen.queryByTestId('import-button')).not.toBeInTheDocument();
    });

    it('should render workspace scan button in files tab', () => {
      render(<ProjectExplorer />);
      expect(screen.getByTestId('scan-workspace-button')).toBeInTheDocument();
    });

    it('should render search input', () => {
      renderProjectExplorer();
      expect(screen.getByTestId('asset-search')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Search assets...')).toBeInTheDocument();
    });

    it('should render filter tabs', () => {
      renderProjectExplorer();
      expect(screen.getByTestId('filter-all')).toBeInTheDocument();
      expect(screen.getByTestId('filter-video')).toBeInTheDocument();
      expect(screen.getByTestId('filter-audio')).toBeInTheDocument();
      expect(screen.getByTestId('filter-image')).toBeInTheDocument();
    });

    it('should render asset list', () => {
      renderProjectExplorer();
      expect(screen.getByTestId('asset-list')).toBeInTheDocument();
    });

    it('should not reconvert asset:// thumbnail URLs', () => {
      const assets = new Map([
        [
          'asset_001',
          {
            id: 'asset_001',
            name: 'video1.mp4',
            kind: 'video',
            uri: '/path/to/video1.mp4',
            durationSec: 120,
            thumbnailUrl: 'asset://localhost/C%3A%5Cthumbs%5C001.jpg',
          },
        ],
      ]);

      mockUseProjectStore.mockReturnValue({
        assets,
        isLoading: false,
        selectedAssetId: null,
        selectAsset: vi.fn(),
        removeAsset: vi.fn(),
      });

      renderProjectExplorer();

      const thumbnail = screen.getByTestId('asset-thumbnail');
      expect(thumbnail).toHaveAttribute('src', 'asset://localhost/C%3A%5Cthumbs%5C001.jpg');
      expect(mockConvertFileSrc).not.toHaveBeenCalled();
    });

    it('should decode encoded local thumbnail paths before conversion', () => {
      const assets = new Map([
        [
          'asset_001',
          {
            id: 'asset_001',
            name: 'video1.mp4',
            kind: 'video',
            uri: '/path/to/video1.mp4',
            durationSec: 120,
            thumbnailUrl: 'C%3A%5Cthumbs%5C001.jpg',
          },
        ],
      ]);

      mockUseProjectStore.mockReturnValue({
        assets,
        isLoading: false,
        selectedAssetId: null,
        selectAsset: vi.fn(),
        removeAsset: vi.fn(),
      });

      renderProjectExplorer();

      expect(mockConvertFileSrc).toHaveBeenCalled();
      const convertedInput = mockConvertFileSrc.mock.calls[0][0] as string;
      expect(convertedInput.includes('%')).toBe(false);
      expect(convertedInput.includes('thumbs')).toBe(true);
    });
  });

  // ===========================================================================
  // Loading State Tests
  // ===========================================================================

  describe('loading state', () => {
    it('should show loading state', () => {
      mockUseProjectStore.mockReturnValue({
        assets: new Map(),
        isLoading: true,
        selectedAssetId: null,
        selectAsset: vi.fn(),
        removeAsset: vi.fn(),
      });

      renderProjectExplorer();
      expect(screen.getByTestId('asset-list-loading')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Search Tests
  // ===========================================================================

  describe('search', () => {
    it('should filter assets when typing in search', () => {
      renderProjectExplorer();

      const searchInput = screen.getByTestId('asset-search');
      fireEvent.change(searchInput, { target: { value: 'video' } });

      expect(screen.getAllByTestId('asset-item')).toHaveLength(1);
      expect(screen.getByText('video1.mp4')).toBeInTheDocument();
    });

    it('should clear search when clear button clicked', () => {
      renderProjectExplorer();

      const searchInput = screen.getByTestId('asset-search');
      fireEvent.change(searchInput, { target: { value: 'video' } });

      const clearButton = screen.getByTestId('search-clear');
      fireEvent.click(clearButton);

      expect(screen.getAllByTestId('asset-item')).toHaveLength(3);
    });
  });

  // ===========================================================================
  // Filter Tests
  // ===========================================================================

  describe('filtering', () => {
    it('should filter by video when video tab clicked', () => {
      renderProjectExplorer();

      fireEvent.click(screen.getByTestId('filter-video'));

      expect(screen.getAllByTestId('asset-item')).toHaveLength(1);
      expect(screen.getByText('video1.mp4')).toBeInTheDocument();
    });

    it('should filter by audio when audio tab clicked', () => {
      renderProjectExplorer();

      fireEvent.click(screen.getByTestId('filter-audio'));

      expect(screen.getAllByTestId('asset-item')).toHaveLength(1);
      expect(screen.getByText('audio1.mp3')).toBeInTheDocument();
    });

    it('should show all assets when all tab clicked', () => {
      renderProjectExplorer();

      // First filter by video
      fireEvent.click(screen.getByTestId('filter-video'));
      // Then click all
      fireEvent.click(screen.getByTestId('filter-all'));

      expect(screen.getAllByTestId('asset-item')).toHaveLength(3);
    });

    it('should highlight active filter tab', () => {
      renderProjectExplorer();

      fireEvent.click(screen.getByTestId('filter-video'));

      expect(screen.getByTestId('filter-video')).toHaveClass('bg-primary-500');
    });
  });

  // ===========================================================================
  // Selection Tests
  // ===========================================================================

  describe('selection', () => {
    it('should call selectAsset when asset clicked', () => {
      const selectAsset = vi.fn();
      mockUseProjectStore.mockReturnValue({
        assets: mockAssets,
        isLoading: false,
        selectedAssetId: null,
        selectAsset,
        removeAsset: vi.fn(),
      });

      renderProjectExplorer();

      fireEvent.click(screen.getByText('video1.mp4'));
      expect(selectAsset).toHaveBeenCalledWith('asset_001');
    });

    it('should highlight selected asset', () => {
      // Note: Assets are sorted by name ascending, so order is:
      // audio1.mp3 (asset_002), image1.jpg (asset_003), video1.mp4 (asset_001)
      mockUseProjectStore.mockReturnValue({
        assets: mockAssets,
        isLoading: false,
        selectedAssetId: 'asset_002', // Select first item in sorted order
        selectAsset: vi.fn(),
        removeAsset: vi.fn(),
      });

      renderProjectExplorer();

      const items = screen.getAllByTestId('asset-item');
      expect(items[0]).toHaveClass('bg-primary-500/20');
      expect(items[1]).not.toHaveClass('bg-primary-500/20');
      expect(items[2]).not.toHaveClass('bg-primary-500/20');
    });
  });

  // ===========================================================================
  // View Mode Tests
  // ===========================================================================

  describe('view modes', () => {
    it('should toggle between list and grid view', () => {
      renderProjectExplorer();

      // Default is list view
      expect(screen.getByTestId('asset-list')).toHaveClass('flex-col');

      // Click grid view button
      fireEvent.click(screen.getByTestId('view-mode-grid'));
      expect(screen.getByTestId('asset-list')).toHaveClass('grid');

      // Click list view button
      fireEvent.click(screen.getByTestId('view-mode-list'));
      expect(screen.getByTestId('asset-list')).toHaveClass('flex-col');
    });
  });

  // ===========================================================================
  // Empty State Tests
  // ===========================================================================

  describe('empty state', () => {
    it('should show empty state when no assets', () => {
      mockUseProjectStore.mockReturnValue({
        assets: new Map(),
        isLoading: false,
        selectedAssetId: null,
        selectAsset: vi.fn(),
        removeAsset: vi.fn(),
      });

      renderProjectExplorer();
      expect(screen.getByTestId('asset-list-empty')).toBeInTheDocument();
    });

    it('should show workspace prompt in empty state', () => {
      mockUseProjectStore.mockReturnValue({
        assets: new Map(),
        isLoading: false,
        selectedAssetId: null,
        selectAsset: vi.fn(),
        removeAsset: vi.fn(),
      });

      renderProjectExplorer();
      expect(
        screen.getByText('Scan workspace and register files to get started'),
      ).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Keyboard Navigation Tests
  // ===========================================================================

  describe('keyboard navigation', () => {
    it('should focus search on Ctrl+F', () => {
      renderProjectExplorer();

      const explorer = screen.getByTestId('project-explorer');
      fireEvent.keyDown(explorer, { key: 'f', ctrlKey: true });

      expect(screen.getByTestId('asset-search')).toHaveFocus();
    });

    it('should show confirm dialog on Delete key when asset selected', () => {
      mockUseProjectStore.mockReturnValue({
        assets: mockAssets,
        isLoading: false,
        selectedAssetId: 'asset_001',
        selectAsset: vi.fn(),
        removeAsset: vi.fn(),
      });

      renderProjectExplorer();

      const explorer = screen.getByTestId('project-explorer');
      fireEvent.keyDown(explorer, { key: 'Delete' });

      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
      expect(screen.getByText(/delete.*video1\.mp4/i)).toBeInTheDocument();
    });

    it('should call removeAsset when confirmed in delete dialog', () => {
      const removeAsset = vi.fn();
      mockUseProjectStore.mockReturnValue({
        assets: mockAssets,
        isLoading: false,
        selectedAssetId: 'asset_001',
        selectAsset: vi.fn(),
        removeAsset,
      });

      renderProjectExplorer();

      const explorer = screen.getByTestId('project-explorer');
      fireEvent.keyDown(explorer, { key: 'Delete' });

      // Click confirm button
      fireEvent.click(screen.getByTestId('confirm-button'));

      expect(removeAsset).toHaveBeenCalledWith('asset_001');
    });

    it('should close dialog without removing when cancelled', () => {
      const removeAsset = vi.fn();
      mockUseProjectStore.mockReturnValue({
        assets: mockAssets,
        isLoading: false,
        selectedAssetId: 'asset_001',
        selectAsset: vi.fn(),
        removeAsset,
      });

      renderProjectExplorer();

      const explorer = screen.getByTestId('project-explorer');
      fireEvent.keyDown(explorer, { key: 'Delete' });

      // Click cancel button
      fireEvent.click(screen.getByTestId('cancel-button'));

      expect(removeAsset).not.toHaveBeenCalled();
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
  });
});
