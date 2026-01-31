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
const mockUseAssetImport = vi.fn();

vi.mock('@/stores', () => ({
  useProjectStore: (...args: unknown[]) => mockUseProjectStore(...args),
  useBinStore: (...args: unknown[]) => mockUseBinStore(...args),
}));

vi.mock('@/hooks', () => ({
  useAssetImport: () => mockUseAssetImport(),
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
    mockUseAssetImport.mockReturnValue({
      importFiles: vi.fn(),
      importFromUris: vi.fn(),
      isImporting: false,
      error: null,
      clearError: vi.fn(),
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

    it('should render header with title', () => {
      render(<ProjectExplorer />);
      expect(screen.getByText('Project')).toBeInTheDocument();
    });

    it('should render import button', () => {
      render(<ProjectExplorer />);
      expect(screen.getByTestId('import-button')).toBeInTheDocument();
      expect(screen.getByLabelText('Import asset')).toBeInTheDocument();
    });

    it('should render search input', () => {
      render(<ProjectExplorer />);
      expect(screen.getByTestId('asset-search')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Search assets...')).toBeInTheDocument();
    });

    it('should render filter tabs', () => {
      render(<ProjectExplorer />);
      expect(screen.getByTestId('filter-all')).toBeInTheDocument();
      expect(screen.getByTestId('filter-video')).toBeInTheDocument();
      expect(screen.getByTestId('filter-audio')).toBeInTheDocument();
      expect(screen.getByTestId('filter-image')).toBeInTheDocument();
    });

    it('should render asset list', () => {
      render(<ProjectExplorer />);
      expect(screen.getByTestId('asset-list')).toBeInTheDocument();
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

      render(<ProjectExplorer />);
      expect(screen.getByTestId('asset-list-loading')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Search Tests
  // ===========================================================================

  describe('search', () => {
    it('should filter assets when typing in search', () => {
      render(<ProjectExplorer />);

      const searchInput = screen.getByTestId('asset-search');
      fireEvent.change(searchInput, { target: { value: 'video' } });

      expect(screen.getAllByTestId('asset-item')).toHaveLength(1);
      expect(screen.getByText('video1.mp4')).toBeInTheDocument();
    });

    it('should clear search when clear button clicked', () => {
      render(<ProjectExplorer />);

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
      render(<ProjectExplorer />);

      fireEvent.click(screen.getByTestId('filter-video'));

      expect(screen.getAllByTestId('asset-item')).toHaveLength(1);
      expect(screen.getByText('video1.mp4')).toBeInTheDocument();
    });

    it('should filter by audio when audio tab clicked', () => {
      render(<ProjectExplorer />);

      fireEvent.click(screen.getByTestId('filter-audio'));

      expect(screen.getAllByTestId('asset-item')).toHaveLength(1);
      expect(screen.getByText('audio1.mp3')).toBeInTheDocument();
    });

    it('should show all assets when all tab clicked', () => {
      render(<ProjectExplorer />);

      // First filter by video
      fireEvent.click(screen.getByTestId('filter-video'));
      // Then click all
      fireEvent.click(screen.getByTestId('filter-all'));

      expect(screen.getAllByTestId('asset-item')).toHaveLength(3);
    });

    it('should highlight active filter tab', () => {
      render(<ProjectExplorer />);

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

      render(<ProjectExplorer />);

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

      render(<ProjectExplorer />);

      const items = screen.getAllByTestId('asset-item');
      expect(items[0]).toHaveClass('bg-primary-500/20');
      expect(items[1]).not.toHaveClass('bg-primary-500/20');
      expect(items[2]).not.toHaveClass('bg-primary-500/20');
    });
  });

  // ===========================================================================
  // Import Tests
  // ===========================================================================

  describe('import', () => {
    it('should call importFiles when import button clicked', () => {
      const importFiles = vi.fn();
      mockUseAssetImport.mockReturnValue({
        importFiles,
        importFromUris: vi.fn(),
        isImporting: false,
        error: null,
        clearError: vi.fn(),
      });

      render(<ProjectExplorer />);

      fireEvent.click(screen.getByTestId('import-button'));
      expect(importFiles).toHaveBeenCalled();
    });

    it('should disable import button when importing', () => {
      mockUseAssetImport.mockReturnValue({
        importFiles: vi.fn(),
        importFromUris: vi.fn(),
        isImporting: true,
        error: null,
        clearError: vi.fn(),
      });

      render(<ProjectExplorer />);

      expect(screen.getByTestId('import-button')).toBeDisabled();
    });

    it('should show error message when import fails', () => {
      mockUseAssetImport.mockReturnValue({
        importFiles: vi.fn(),
        importFromUris: vi.fn(),
        isImporting: false,
        error: '1 file(s) failed to import',
        clearError: vi.fn(),
      });

      render(<ProjectExplorer />);

      expect(screen.getByTestId('import-error')).toBeInTheDocument();
      expect(screen.getByText('1 file(s) failed to import')).toBeInTheDocument();
    });

    it('should call clearError when dismiss button clicked', () => {
      const clearError = vi.fn();
      mockUseAssetImport.mockReturnValue({
        importFiles: vi.fn(),
        importFromUris: vi.fn(),
        isImporting: false,
        error: 'Some error',
        clearError,
      });

      render(<ProjectExplorer />);

      fireEvent.click(screen.getByLabelText('Dismiss error'));
      expect(clearError).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // View Mode Tests
  // ===========================================================================

  describe('view modes', () => {
    it('should toggle between list and grid view', () => {
      render(<ProjectExplorer />);

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
        assets: [],
        isLoading: false,
        selectedAssetId: null,
        selectAsset: vi.fn(),
        removeAsset: vi.fn(),
      });

      render(<ProjectExplorer />);
      expect(screen.getByTestId('asset-list-empty')).toBeInTheDocument();
    });

    it('should show import prompt in empty state', () => {
      mockUseProjectStore.mockReturnValue({
        assets: [],
        isLoading: false,
        selectedAssetId: null,
        selectAsset: vi.fn(),
        removeAsset: vi.fn(),
      });

      render(<ProjectExplorer />);
      expect(screen.getByText('Import media to get started')).toBeInTheDocument();
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

    it('should show confirm dialog on Delete key when asset selected', () => {
      mockUseProjectStore.mockReturnValue({
        assets: mockAssets,
        isLoading: false,
        selectedAssetId: 'asset_001',
        selectAsset: vi.fn(),
        removeAsset: vi.fn(),
      });

      render(<ProjectExplorer />);

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

      render(<ProjectExplorer />);

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

      render(<ProjectExplorer />);

      const explorer = screen.getByTestId('project-explorer');
      fireEvent.keyDown(explorer, { key: 'Delete' });

      // Click cancel button
      fireEvent.click(screen.getByTestId('cancel-button'));

      expect(removeAsset).not.toHaveBeenCalled();
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Drag and Drop Tests
  // ===========================================================================

  describe('drag and drop', () => {
    it('should show drop zone on drag enter with files', () => {
      render(<ProjectExplorer />);

      const explorer = screen.getByTestId('project-explorer');
      const dataTransfer = {
        types: ['Files'],
      };
      fireEvent.dragEnter(explorer, { dataTransfer });

      expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
    });

    it('should hide drop zone on drag leave', () => {
      render(<ProjectExplorer />);

      const explorer = screen.getByTestId('project-explorer');
      const dataTransfer = {
        types: ['Files'],
      };
      fireEvent.dragEnter(explorer, { dataTransfer });
      fireEvent.dragLeave(explorer);

      expect(screen.queryByTestId('drop-zone')).not.toBeInTheDocument();
    });

    it('should call importFromUris on file drop', () => {
      const importFromUris = vi.fn();
      mockUseAssetImport.mockReturnValue({
        importFiles: vi.fn(),
        importFromUris,
        isImporting: false,
        error: null,
        clearError: vi.fn(),
      });

      render(<ProjectExplorer />);

      const explorer = screen.getByTestId('project-explorer');

      // Create a mock file drop event
      const mockFile = new File(['content'], 'video.mp4', { type: 'video/mp4' });
      const dataTransfer = {
        files: [mockFile],
        types: ['Files'],
      };

      fireEvent.drop(explorer, { dataTransfer });

      // Note: The component needs to extract paths from files
      // This test verifies that drop events are handled
      expect(importFromUris).toHaveBeenCalled();
    });

    it('should hide drop zone after drop', () => {
      const importFromUris = vi.fn();
      mockUseAssetImport.mockReturnValue({
        importFiles: vi.fn(),
        importFromUris,
        isImporting: false,
        error: null,
        clearError: vi.fn(),
      });

      render(<ProjectExplorer />);

      const explorer = screen.getByTestId('project-explorer');
      const enterDataTransfer = {
        types: ['Files'],
      };
      fireEvent.dragEnter(explorer, { dataTransfer: enterDataTransfer });

      const mockFile = new File(['content'], 'video.mp4', { type: 'video/mp4' });
      const dropDataTransfer = {
        files: [mockFile],
        types: ['Files'],
      };

      fireEvent.drop(explorer, { dataTransfer: dropDataTransfer });

      expect(screen.queryByTestId('drop-zone')).not.toBeInTheDocument();
    });
  });
});
