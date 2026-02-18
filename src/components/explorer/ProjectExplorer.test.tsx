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
const mockConvertFileSrc = vi.fn((path: string) => `asset://${path}`);

// Bin store mock state (shared between destructuring and selector calls)
let mockBinStoreState: Record<string, unknown> = {};

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => mockConvertFileSrc(path),
}));

vi.mock('@/stores', () => ({
  useProjectStore: (...args: unknown[]) => mockUseProjectStore(...args),
  useBinStore: (...args: unknown[]) => {
    // Called with selector function: useBinStore((state) => state.bins)
    if (typeof args[0] === 'function') {
      return (args[0] as (state: Record<string, unknown>) => unknown)(mockBinStoreState);
    }
    // Called without args: destructuring
    return mockBinStoreState;
  },
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

const mockCreateBin = vi.fn().mockResolvedValue('new-bin-id');
const mockDeleteBin = vi.fn().mockResolvedValue(undefined);
const mockRenameBin = vi.fn().mockResolvedValue(undefined);
const mockMoveBin = vi.fn().mockResolvedValue(undefined);
const mockSetBinColor = vi.fn().mockResolvedValue(undefined);
const mockMoveAssetToBin = vi.fn().mockResolvedValue(undefined);

vi.mock('@/hooks', () => ({
  useBinOperations: () => ({
    createBin: mockCreateBin,
    renameBin: mockRenameBin,
    deleteBin: mockDeleteBin,
    moveBin: mockMoveBin,
    setBinColor: mockSetBinColor,
    moveAssetToBin: mockMoveAssetToBin,
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
    // Re-establish mock resolved values after clearAllMocks wipes them
    mockCreateBin.mockResolvedValue('new-bin-id');
    mockDeleteBin.mockResolvedValue(undefined);
    mockRenameBin.mockResolvedValue(undefined);
    mockMoveBin.mockResolvedValue(undefined);
    mockSetBinColor.mockResolvedValue(undefined);
    mockMoveAssetToBin.mockResolvedValue(undefined);
    mockUseProjectStore.mockReturnValue({
      assets: mockAssets,
      isLoading: false,
      selectedAssetId: null,
      selectAsset: vi.fn(),
      removeAsset: vi.fn(),
    });
    mockBinStoreState = {
      bins: new Map(),
      selectedBinId: null,
      editingBinId: null,
      selectBin: vi.fn(),
      createBin: vi.fn(),
      renameBin: vi.fn(),
      toggleExpand: vi.fn(),
      cancelEditing: vi.fn(),
      startEditing: vi.fn(),
    };
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

    it('should render selected folder summary', () => {
      renderProjectExplorer();
      expect(screen.getByTestId('selected-folder-label')).toHaveTextContent('All Assets');
      expect(screen.getByTestId('selected-folder-asset-count')).toHaveTextContent('3');
    });

    it('should hide legacy type filter controls', () => {
      renderProjectExplorer();
      expect(screen.queryByTestId('filter-all')).not.toBeInTheDocument();
      expect(screen.queryByTestId('filter-video')).not.toBeInTheDocument();
      expect(screen.queryByTestId('filter-audio')).not.toBeInTheDocument();
      expect(screen.queryByTestId('filter-image')).not.toBeInTheDocument();
    });

    it('should render asset list', () => {
      renderProjectExplorer();
      expect(screen.getByTestId('asset-list')).toBeInTheDocument();
    });

    it('should show all assets at root even when assets belong to folders', () => {
      const assets = new Map([
        [
          'asset_root',
          {
            id: 'asset_root',
            name: 'root.mp4',
            kind: 'video',
            uri: '/path/to/root.mp4',
            durationSec: 10,
          },
        ],
        [
          'asset_bin',
          {
            id: 'asset_bin',
            name: 'bin.mp4',
            kind: 'video',
            uri: '/path/to/bin.mp4',
            durationSec: 20,
            binId: 'bin_parent',
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

      mockBinStoreState = {
        ...mockBinStoreState,
        bins: new Map([
          [
            'bin_parent',
            {
              id: 'bin_parent',
              name: 'Parent',
              parentId: null,
              color: 'gray',
              createdAt: '2024-01-01T00:00:00.000Z',
            },
          ],
        ]),
      };

      renderProjectExplorer();

      expect(screen.getByText('root.mp4')).toBeInTheDocument();
      expect(screen.getByText('bin.mp4')).toBeInTheDocument();
    });

    it('should include descendant folder assets when a parent folder is selected', () => {
      const assets = new Map([
        [
          'asset_parent',
          {
            id: 'asset_parent',
            name: 'parent.mp4',
            kind: 'video',
            uri: '/path/to/parent.mp4',
            durationSec: 20,
            binId: 'bin_parent',
          },
        ],
        [
          'asset_child',
          {
            id: 'asset_child',
            name: 'child.mp4',
            kind: 'video',
            uri: '/path/to/child.mp4',
            durationSec: 30,
            binId: 'bin_child',
          },
        ],
        [
          'asset_other',
          {
            id: 'asset_other',
            name: 'other.mp4',
            kind: 'video',
            uri: '/path/to/other.mp4',
            durationSec: 40,
            binId: 'bin_other',
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

      mockBinStoreState = {
        ...mockBinStoreState,
        selectedBinId: 'bin_parent',
        bins: new Map([
          [
            'bin_parent',
            {
              id: 'bin_parent',
              name: 'Parent',
              parentId: null,
              color: 'gray',
              createdAt: '2024-01-01T00:00:00.000Z',
            },
          ],
          [
            'bin_child',
            {
              id: 'bin_child',
              name: 'Child',
              parentId: 'bin_parent',
              color: 'gray',
              createdAt: '2024-01-01T00:00:00.000Z',
            },
          ],
          [
            'bin_other',
            {
              id: 'bin_other',
              name: 'Other',
              parentId: null,
              color: 'gray',
              createdAt: '2024-01-01T00:00:00.000Z',
            },
          ],
        ]),
      };

      renderProjectExplorer();

      expect(screen.getByText('parent.mp4')).toBeInTheDocument();
      expect(screen.getByText('child.mp4')).toBeInTheDocument();
      expect(screen.queryByText('other.mp4')).not.toBeInTheDocument();
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

    it('should clear selected asset when switching to another folder scope', () => {
      const selectAsset = vi.fn();
      const assets = new Map([
        [
          'asset_in_other_bin',
          {
            id: 'asset_in_other_bin',
            name: 'other.mp4',
            kind: 'video',
            uri: '/path/to/other.mp4',
            durationSec: 20,
            binId: 'bin_other',
          },
        ],
      ]);

      mockUseProjectStore.mockReturnValue({
        assets,
        isLoading: false,
        selectedAssetId: 'asset_in_other_bin',
        selectAsset,
        removeAsset: vi.fn(),
      });

      mockBinStoreState = {
        ...mockBinStoreState,
        selectedBinId: 'bin_current',
        bins: new Map([
          [
            'bin_current',
            {
              id: 'bin_current',
              name: 'Current',
              parentId: null,
              color: 'gray',
              createdAt: '2024-01-01T00:00:00.000Z',
            },
          ],
          [
            'bin_other',
            {
              id: 'bin_other',
              name: 'Other',
              parentId: null,
              color: 'gray',
              createdAt: '2024-01-01T00:00:00.000Z',
            },
          ],
        ]),
      };

      renderProjectExplorer();

      expect(selectAsset).toHaveBeenCalledWith(null);
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

  // ===========================================================================
  // Bin Context Menu Tests
  // ===========================================================================

  describe('bin context menu', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      // Re-establish mock resolved values after clearAllMocks
      mockCreateBin.mockResolvedValue('new-bin-id');
      mockDeleteBin.mockResolvedValue(undefined);
      mockRenameBin.mockResolvedValue(undefined);
      mockMoveBin.mockResolvedValue(undefined);
      mockSetBinColor.mockResolvedValue(undefined);
      mockMoveAssetToBin.mockResolvedValue(undefined);
      mockUseProjectStore.mockReturnValue({
        assets: mockAssets,
        isLoading: false,
        selectedAssetId: null,
        selectAsset: vi.fn(),
        removeAsset: vi.fn(),
      });
      mockBinStoreState = {
        bins: new Map([
          [
            'bin_1',
            {
              id: 'bin_1',
              name: 'Footage',
              parentId: null,
              color: 'blue',
              createdAt: '2024-01-01T00:00:00.000Z',
              expanded: true,
            },
          ],
        ]),
        selectedBinId: null,
        editingBinId: null,
        selectBin: vi.fn(),
        createBin: vi.fn(),
        renameBin: vi.fn(),
        toggleExpand: vi.fn(),
        cancelEditing: vi.fn(),
        startEditing: vi.fn(),
      };
    });

    it('should show bin delete confirmation dialog when delete is triggered', () => {
      renderProjectExplorer();

      // Right-click on bin to open context menu
      const binItem = screen.getByTestId('bin-item-bin_1');
      fireEvent.contextMenu(binItem);

      // Click Delete in context menu
      fireEvent.click(screen.getByText('Delete'));

      // Confirmation dialog should appear
      expect(screen.getByText('Delete Folder')).toBeInTheDocument();
      expect(screen.getByText(/delete.*Footage/i)).toBeInTheDocument();
    });

    it('should cancel bin delete when Cancel is clicked', () => {
      renderProjectExplorer();

      const binItem = screen.getByTestId('bin-item-bin_1');
      fireEvent.contextMenu(binItem);
      fireEvent.click(screen.getByText('Delete'));

      // Click Cancel
      fireEvent.click(screen.getByTestId('cancel-button'));

      // Dialog should close
      expect(screen.queryByText('Delete Folder')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Tab Navigation Tests
  // ===========================================================================

  describe('tab navigation', () => {
    it('should default to files tab', () => {
      render(<ProjectExplorer />);
      expect(screen.getByTestId('tab-files')).toBeInTheDocument();
      expect(screen.getByTestId('scan-workspace-button')).toBeInTheDocument();
    });

    it('should switch to assets tab when clicked', () => {
      render(<ProjectExplorer />);
      fireEvent.click(screen.getByTestId('tab-assets'));
      expect(screen.getByTestId('asset-search')).toBeInTheDocument();
    });

    it('should switch back to files tab from assets tab', () => {
      render(<ProjectExplorer />);
      fireEvent.click(screen.getByTestId('tab-assets'));
      fireEvent.click(screen.getByTestId('tab-files'));
      expect(screen.getByTestId('scan-workspace-button')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Edge Case & Destructive Tests
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle folder toggle collapse/expand', () => {
      renderProjectExplorer();

      const binsToggle = screen.getByTestId('bins-toggle');
      expect(binsToggle).toHaveAttribute('aria-expanded', 'true');

      fireEvent.click(binsToggle);
      expect(binsToggle).toHaveAttribute('aria-expanded', 'false');

      fireEvent.click(binsToggle);
      expect(binsToggle).toHaveAttribute('aria-expanded', 'true');
    });

    it('should show folder-specific empty message when bin is selected', () => {
      mockUseProjectStore.mockReturnValue({
        assets: new Map(),
        isLoading: false,
        selectedAssetId: null,
        selectAsset: vi.fn(),
        removeAsset: vi.fn(),
      });

      mockBinStoreState = {
        ...mockBinStoreState,
        selectedBinId: 'some-bin',
        bins: new Map([
          [
            'some-bin',
            {
              id: 'some-bin',
              name: 'Empty Folder',
              parentId: null,
              color: 'gray',
              createdAt: '2024-01-01T00:00:00.000Z',
            },
          ],
        ]),
      };

      renderProjectExplorer();
      expect(screen.getByText('No assets in this folder')).toBeInTheDocument();
    });

    it('should handle Delete key without selected asset (no-op)', () => {
      const removeAsset = vi.fn();
      mockUseProjectStore.mockReturnValue({
        assets: mockAssets,
        isLoading: false,
        selectedAssetId: null,
        selectAsset: vi.fn(),
        removeAsset,
      });

      renderProjectExplorer();

      const explorer = screen.getByTestId('project-explorer');
      fireEvent.keyDown(explorer, { key: 'Delete' });

      // No confirm dialog should appear
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });

    it('should handle case-insensitive search', () => {
      renderProjectExplorer();

      const searchInput = screen.getByTestId('asset-search');
      fireEvent.change(searchInput, { target: { value: 'VIDEO' } });

      expect(screen.getAllByTestId('asset-item')).toHaveLength(1);
      expect(screen.getByText('video1.mp4')).toBeInTheDocument();
    });

    it('should show create folder button in assets tab header', () => {
      renderProjectExplorer();
      expect(screen.getByTestId('create-folder-button')).toBeInTheDocument();
    });

    it('should call createBin when create folder button clicked', () => {
      renderProjectExplorer();

      fireEvent.click(screen.getByTestId('create-folder-button'));
      expect(mockCreateBin).toHaveBeenCalledWith('New Folder', null);
    });
  });
});
