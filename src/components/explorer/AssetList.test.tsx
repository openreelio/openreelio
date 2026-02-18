/**
 * AssetList Component Tests
 *
 * Tests for the asset list display in the project explorer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AssetList, type Asset } from './AssetList';

// =============================================================================
// Tests
// =============================================================================

describe('AssetList', () => {
  const mockAssets: Asset[] = [
    { id: 'asset_001', name: 'video1.mp4', kind: 'video', duration: 120 },
    { id: 'asset_002', name: 'audio1.mp3', kind: 'audio', duration: 180 },
    { id: 'asset_003', name: 'image1.jpg', kind: 'image' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render asset list container', () => {
      render(<AssetList assets={mockAssets} />);
      expect(screen.getByTestId('asset-list')).toBeInTheDocument();
    });

    it('should render all assets', () => {
      render(<AssetList assets={mockAssets} />);
      expect(screen.getAllByTestId('asset-item')).toHaveLength(3);
    });

    it('should display asset names', () => {
      render(<AssetList assets={mockAssets} />);
      expect(screen.getByText('video1.mp4')).toBeInTheDocument();
      expect(screen.getByText('audio1.mp3')).toBeInTheDocument();
      expect(screen.getByText('image1.jpg')).toBeInTheDocument();
    });

    it('should show empty state when no assets', () => {
      render(<AssetList assets={[]} />);
      expect(screen.getByTestId('asset-list-empty')).toBeInTheDocument();
      expect(screen.getByText('No assets')).toBeInTheDocument();
    });

    it('should show loading state when loading', () => {
      render(<AssetList assets={[]} isLoading />);
      expect(screen.getByTestId('asset-list-loading')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Selection Tests
  // ===========================================================================

  describe('selection', () => {
    it('should highlight selected asset', () => {
      // Note: Default sorting is by name ascending, so order is:
      // audio1.mp3 (asset_002), image1.jpg (asset_003), video1.mp4 (asset_001)
      render(<AssetList assets={mockAssets} selectedAssetId="asset_002" />);

      const items = screen.getAllByTestId('asset-item');
      // First item (audio1.mp3) should be selected
      expect(items[0]).toHaveClass('bg-primary-500/20');
      // Other items should not be selected
      expect(items[1]).not.toHaveClass('bg-primary-500/20');
      expect(items[2]).not.toHaveClass('bg-primary-500/20');
    });

    it('should call onSelect when asset clicked', () => {
      const onSelect = vi.fn();
      render(<AssetList assets={mockAssets} onSelect={onSelect} />);

      fireEvent.click(screen.getByText('video1.mp4'));
      expect(onSelect).toHaveBeenCalledWith('asset_001');
    });

    it('should support multi-selection', () => {
      // Note: Default sorting is by name ascending, so order is:
      // audio1.mp3 (asset_002), image1.jpg (asset_003), video1.mp4 (asset_001)
      render(
        <AssetList
          assets={mockAssets}
          selectedAssetIds={['asset_002', 'asset_003']}
          multiSelect
        />
      );

      const items = screen.getAllByTestId('asset-item');
      // First item (audio1.mp3 / asset_002) should be selected
      expect(items[0]).toHaveClass('bg-primary-500/20');
      // Second item (image1.jpg / asset_003) should be selected
      expect(items[1]).toHaveClass('bg-primary-500/20');
      // Third item (video1.mp4 / asset_001) should NOT be selected
      expect(items[2]).not.toHaveClass('bg-primary-500/20');
    });
  });

  // ===========================================================================
  // Filtering Tests
  // ===========================================================================

  describe('filtering', () => {
    it('should filter by asset type', () => {
      render(<AssetList assets={mockAssets} filter="video" />);

      expect(screen.getAllByTestId('asset-item')).toHaveLength(1);
      expect(screen.getByText('video1.mp4')).toBeInTheDocument();
    });

    it('should filter by search query', () => {
      render(<AssetList assets={mockAssets} searchQuery="audio" />);

      expect(screen.getAllByTestId('asset-item')).toHaveLength(1);
      expect(screen.getByText('audio1.mp3')).toBeInTheDocument();
    });

    it('should show empty state when filter matches nothing', () => {
      render(<AssetList assets={mockAssets} filter="video" searchQuery="nonexistent" />);

      expect(screen.getByTestId('asset-list-empty')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // View Mode Tests
  // ===========================================================================

  describe('view modes', () => {
    it('should render in list view by default', () => {
      render(<AssetList assets={mockAssets} />);
      expect(screen.getByTestId('asset-list')).toHaveClass('flex-col');
    });

    it('should render in grid view when specified', () => {
      render(<AssetList assets={mockAssets} viewMode="grid" />);
      expect(screen.getByTestId('asset-list')).toHaveClass('grid');
    });
  });

  // ===========================================================================
  // Sorting Tests
  // ===========================================================================

  describe('sorting', () => {
    it('should sort by name ascending by default', () => {
      render(<AssetList assets={mockAssets} sortBy="name" sortOrder="asc" />);

      const items = screen.getAllByTestId('asset-item');
      expect(items[0]).toHaveTextContent('audio1.mp3');
      expect(items[1]).toHaveTextContent('image1.jpg');
      expect(items[2]).toHaveTextContent('video1.mp4');
    });

    it('should sort by name descending', () => {
      render(<AssetList assets={mockAssets} sortBy="name" sortOrder="desc" />);

      const items = screen.getAllByTestId('asset-item');
      expect(items[0]).toHaveTextContent('video1.mp4');
      expect(items[2]).toHaveTextContent('audio1.mp3');
    });

    it('should sort by date using importedAt field', () => {
      const datedAssets = [
        { ...mockAssets[0], importedAt: '2024-03-01T00:00:00Z' },
        { ...mockAssets[1], importedAt: '2024-01-01T00:00:00Z' },
        { ...mockAssets[2], importedAt: '2024-02-01T00:00:00Z' },
      ];

      render(<AssetList assets={datedAssets} sortBy="date" sortOrder="asc" />);

      const items = screen.getAllByTestId('asset-item');
      expect(items[0]).toHaveTextContent('audio1.mp3');
      expect(items[1]).toHaveTextContent('image1.jpg');
      expect(items[2]).toHaveTextContent('video1.mp4');
    });

    it('should sort by date descending', () => {
      const datedAssets = [
        { ...mockAssets[0], importedAt: '2024-03-01T00:00:00Z' },
        { ...mockAssets[1], importedAt: '2024-01-01T00:00:00Z' },
        { ...mockAssets[2], importedAt: '2024-02-01T00:00:00Z' },
      ];

      render(<AssetList assets={datedAssets} sortBy="date" sortOrder="desc" />);

      const items = screen.getAllByTestId('asset-item');
      expect(items[0]).toHaveTextContent('video1.mp4');
      expect(items[1]).toHaveTextContent('image1.jpg');
      expect(items[2]).toHaveTextContent('audio1.mp3');
    });
  });

  // ===========================================================================
  // Drag and Drop Tests
  // ===========================================================================

  describe('drag and drop', () => {
    it('should call onAssetDragStart when asset drag starts', () => {
      const onAssetDragStart = vi.fn();
      render(<AssetList assets={mockAssets} onAssetDragStart={onAssetDragStart} />);

      fireEvent.dragStart(screen.getAllByTestId('asset-item')[0]);
      expect(onAssetDragStart).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Context Menu Tests
  // ===========================================================================

  describe('context menu', () => {
    it('should call onContextMenu when right-clicked', () => {
      const onContextMenu = vi.fn();
      render(<AssetList assets={mockAssets} onContextMenu={onContextMenu} />);

      fireEvent.contextMenu(screen.getAllByTestId('asset-item')[0]);
      expect(onContextMenu).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Edge Case & Destructive Tests
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle empty search query (show all)', () => {
      render(<AssetList assets={mockAssets} searchQuery="" />);

      expect(screen.getAllByTestId('asset-item')).toHaveLength(3);
    });

    it('should handle search with no results', () => {
      render(<AssetList assets={mockAssets} searchQuery="nonexistent-file-xyz" />);

      expect(screen.getByTestId('asset-list-empty')).toBeInTheDocument();
    });

    it('should handle case-insensitive search', () => {
      render(<AssetList assets={mockAssets} searchQuery="VIDEO" />);

      expect(screen.getAllByTestId('asset-item')).toHaveLength(1);
      expect(screen.getByText('video1.mp4')).toBeInTheDocument();
    });

    it('should handle single asset', () => {
      render(<AssetList assets={[mockAssets[0]]} />);

      expect(screen.getAllByTestId('asset-item')).toHaveLength(1);
    });

    it('should handle assets with undefined importedAt for date sorting', () => {
      const undatedAssets = [
        { ...mockAssets[0] },
        { ...mockAssets[1], importedAt: '2024-01-01T00:00:00Z' },
      ];

      // Should not crash when sorting by date with missing dates
      expect(() => {
        render(<AssetList assets={undatedAssets} sortBy="date" sortOrder="asc" />);
      }).not.toThrow();
    });

    it('should display default empty message when no assets', () => {
      render(<AssetList assets={[]} />);

      expect(screen.getByText('No assets')).toBeInTheDocument();
    });

    it('should handle rapid filter changes without errors', () => {
      const { rerender } = render(<AssetList assets={mockAssets} filter="video" />);

      rerender(<AssetList assets={mockAssets} filter="audio" />);
      expect(screen.getAllByTestId('asset-item')).toHaveLength(1);

      rerender(<AssetList assets={mockAssets} filter="image" />);
      expect(screen.getAllByTestId('asset-item')).toHaveLength(1);

      rerender(<AssetList assets={mockAssets} />);
      expect(screen.getAllByTestId('asset-item')).toHaveLength(3);
    });
  });
});
