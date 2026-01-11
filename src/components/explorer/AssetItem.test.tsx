/**
 * AssetItem Component Tests
 *
 * Tests for individual asset item display in the project explorer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AssetItem, type AssetItemProps } from './AssetItem';

// =============================================================================
// Tests
// =============================================================================

describe('AssetItem', () => {
  const defaultAsset: AssetItemProps['asset'] = {
    id: 'asset_001',
    name: 'sample-video.mp4',
    kind: 'video',
    duration: 120,
    thumbnail: undefined,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render asset item container', () => {
      render(<AssetItem asset={defaultAsset} />);
      expect(screen.getByTestId('asset-item')).toBeInTheDocument();
    });

    it('should display asset name', () => {
      render(<AssetItem asset={defaultAsset} />);
      expect(screen.getByText('sample-video.mp4')).toBeInTheDocument();
    });

    it('should display video icon for video assets', () => {
      render(<AssetItem asset={defaultAsset} />);
      expect(screen.getByTestId('asset-icon-video')).toBeInTheDocument();
    });

    it('should display audio icon for audio assets', () => {
      const audioAsset = { ...defaultAsset, kind: 'audio' as const, name: 'music.mp3' };
      render(<AssetItem asset={audioAsset} />);
      expect(screen.getByTestId('asset-icon-audio')).toBeInTheDocument();
    });

    it('should display image icon for image assets', () => {
      const imageAsset = { ...defaultAsset, kind: 'image' as const, name: 'photo.jpg' };
      render(<AssetItem asset={imageAsset} />);
      expect(screen.getByTestId('asset-icon-image')).toBeInTheDocument();
    });

    it('should display formatted duration for video/audio', () => {
      render(<AssetItem asset={defaultAsset} />);
      // 120 seconds = 2:00
      expect(screen.getByTestId('asset-duration')).toHaveTextContent('2:00');
    });

    it('should not display duration for images', () => {
      const imageAsset = { ...defaultAsset, kind: 'image' as const, duration: undefined };
      render(<AssetItem asset={imageAsset} />);
      expect(screen.queryByTestId('asset-duration')).not.toBeInTheDocument();
    });

    it('should display thumbnail when available', () => {
      const assetWithThumb = { ...defaultAsset, thumbnail: '/thumbs/001.jpg' };
      render(<AssetItem asset={assetWithThumb} />);
      const thumbnail = screen.getByTestId('asset-thumbnail');
      expect(thumbnail).toHaveAttribute('src', '/thumbs/001.jpg');
    });
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  describe('interactions', () => {
    it('should call onClick when clicked', () => {
      const onClick = vi.fn();
      render(<AssetItem asset={defaultAsset} onClick={onClick} />);

      fireEvent.click(screen.getByTestId('asset-item'));
      expect(onClick).toHaveBeenCalledWith(defaultAsset);
    });

    it('should call onDoubleClick when double clicked', () => {
      const onDoubleClick = vi.fn();
      render(<AssetItem asset={defaultAsset} onDoubleClick={onDoubleClick} />);

      fireEvent.doubleClick(screen.getByTestId('asset-item'));
      expect(onDoubleClick).toHaveBeenCalledWith(defaultAsset);
    });

    it('should show selected state when isSelected is true', () => {
      render(<AssetItem asset={defaultAsset} isSelected />);

      const item = screen.getByTestId('asset-item');
      expect(item).toHaveClass('bg-primary-500/20');
    });

    it('should call onContextMenu when right-clicked', () => {
      const onContextMenu = vi.fn();
      render(<AssetItem asset={defaultAsset} onContextMenu={onContextMenu} />);

      fireEvent.contextMenu(screen.getByTestId('asset-item'));
      expect(onContextMenu).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Drag and Drop Tests
  // ===========================================================================

  describe('drag and drop', () => {
    it('should be draggable', () => {
      render(<AssetItem asset={defaultAsset} />);

      const item = screen.getByTestId('asset-item');
      expect(item).toHaveAttribute('draggable', 'true');
    });

    it('should call onDragStart when drag starts', () => {
      const onDragStart = vi.fn();
      render(<AssetItem asset={defaultAsset} onDragStart={onDragStart} />);

      fireEvent.dragStart(screen.getByTestId('asset-item'));
      expect(onDragStart).toHaveBeenCalledWith(defaultAsset);
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('accessibility', () => {
    it('should have proper role', () => {
      render(<AssetItem asset={defaultAsset} />);
      expect(screen.getByRole('button')).toBeInTheDocument();
    });

    it('should have aria-selected when selected', () => {
      render(<AssetItem asset={defaultAsset} isSelected />);
      expect(screen.getByRole('button')).toHaveAttribute('aria-selected', 'true');
    });

    it('should have accessible name', () => {
      render(<AssetItem asset={defaultAsset} />);
      expect(screen.getByLabelText('sample-video.mp4')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Duration Formatting Tests
  // ===========================================================================

  describe('duration formatting', () => {
    it('should format seconds correctly', () => {
      const asset = { ...defaultAsset, duration: 45 };
      render(<AssetItem asset={asset} />);
      expect(screen.getByTestId('asset-duration')).toHaveTextContent('0:45');
    });

    it('should format minutes correctly', () => {
      const asset = { ...defaultAsset, duration: 185 };
      render(<AssetItem asset={asset} />);
      // 185 seconds = 3:05
      expect(screen.getByTestId('asset-duration')).toHaveTextContent('3:05');
    });

    it('should format hours correctly', () => {
      const asset = { ...defaultAsset, duration: 3725 };
      render(<AssetItem asset={asset} />);
      // 3725 seconds = 1:02:05
      expect(screen.getByTestId('asset-duration')).toHaveTextContent('1:02:05');
    });
  });
});
