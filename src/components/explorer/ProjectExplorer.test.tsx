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

vi.mock('@/stores', () => ({
  useProjectStore: (...args: unknown[]) => mockUseProjectStore(...args),
}));

const mockAssets: Asset[] = [
  { id: 'asset_001', name: 'video1.mp4', kind: 'video', duration: 120 },
  { id: 'asset_002', name: 'audio1.mp3', kind: 'audio', duration: 180 },
  { id: 'asset_003', name: 'image1.jpg', kind: 'image' },
];

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
      importAsset: vi.fn(),
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
        assets: [],
        isLoading: true,
        selectedAssetId: null,
        selectAsset: vi.fn(),
        importAsset: vi.fn(),
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
        importAsset: vi.fn(),
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
        importAsset: vi.fn(),
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
    it('should call importAsset when import button clicked', () => {
      const importAsset = vi.fn();
      mockUseProjectStore.mockReturnValue({
        assets: mockAssets,
        isLoading: false,
        selectedAssetId: null,
        selectAsset: vi.fn(),
        importAsset,
        removeAsset: vi.fn(),
      });

      render(<ProjectExplorer />);

      fireEvent.click(screen.getByTestId('import-button'));
      expect(importAsset).toHaveBeenCalled();
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
        importAsset: vi.fn(),
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
        importAsset: vi.fn(),
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

    it('should call removeAsset on Delete key when asset selected', () => {
      const removeAsset = vi.fn();
      mockUseProjectStore.mockReturnValue({
        assets: mockAssets,
        isLoading: false,
        selectedAssetId: 'asset_001',
        selectAsset: vi.fn(),
        importAsset: vi.fn(),
        removeAsset,
      });

      render(<ProjectExplorer />);

      const explorer = screen.getByTestId('project-explorer');
      fireEvent.keyDown(explorer, { key: 'Delete' });

      expect(removeAsset).toHaveBeenCalledWith('asset_001');
    });
  });
});
