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
});
