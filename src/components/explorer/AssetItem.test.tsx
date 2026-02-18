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

    it('should include asset id in custom drag payload', () => {
      render(<AssetItem asset={defaultAsset} />);

      const setData = vi.fn();
      const item = screen.getByTestId('asset-item');

      fireEvent.dragStart(item, {
        dataTransfer: {
          setData,
          effectAllowed: 'copyMove',
        },
      });

      expect(setData).toHaveBeenCalledWith('application/x-asset-id', 'asset_001');
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

  // ===========================================================================
  // Resolution Display Tests
  // ===========================================================================

  describe('resolution display', () => {
    it('should display resolution for video assets', () => {
      const videoAsset = { ...defaultAsset, resolution: { width: 1920, height: 1080 } };
      render(<AssetItem asset={videoAsset} />);
      expect(screen.getByTestId('asset-resolution')).toHaveTextContent('1920x1080');
    });

    it('should display resolution for image assets', () => {
      const imageAsset = {
        ...defaultAsset,
        kind: 'image' as const,
        duration: undefined,
        resolution: { width: 3840, height: 2160 },
      };
      render(<AssetItem asset={imageAsset} />);
      expect(screen.getByTestId('asset-resolution')).toHaveTextContent('3840x2160');
    });

    it('should not display resolution for audio assets', () => {
      const audioAsset = { ...defaultAsset, kind: 'audio' as const };
      render(<AssetItem asset={audioAsset} />);
      expect(screen.queryByTestId('asset-resolution')).not.toBeInTheDocument();
    });

    it('should not display resolution when not provided', () => {
      render(<AssetItem asset={defaultAsset} />);
      expect(screen.queryByTestId('asset-resolution')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // File Size Display Tests
  // ===========================================================================

  describe('file size display', () => {
    it('should display file size in KB for small files', () => {
      const asset = { ...defaultAsset, fileSize: 512000 }; // 500 KB
      render(<AssetItem asset={asset} />);
      expect(screen.getByTestId('asset-filesize')).toHaveTextContent('500 KB');
    });

    it('should display file size in MB for medium files', () => {
      const asset = { ...defaultAsset, fileSize: 15728640 }; // 15 MB
      render(<AssetItem asset={asset} />);
      expect(screen.getByTestId('asset-filesize')).toHaveTextContent('15.0 MB');
    });

    it('should display file size in GB for large files', () => {
      const asset = { ...defaultAsset, fileSize: 2147483648 }; // 2 GB
      render(<AssetItem asset={asset} />);
      expect(screen.getByTestId('asset-filesize')).toHaveTextContent('2.0 GB');
    });

    it('should not display file size when not provided', () => {
      render(<AssetItem asset={defaultAsset} />);
      expect(screen.queryByTestId('asset-filesize')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Keyboard Interaction Tests
  // ===========================================================================

  describe('keyboard interactions', () => {
    it('should call onClick when Enter is pressed', () => {
      const onClick = vi.fn();
      render(<AssetItem asset={defaultAsset} onClick={onClick} />);

      fireEvent.keyDown(screen.getByTestId('asset-item'), { key: 'Enter' });
      expect(onClick).toHaveBeenCalledWith(defaultAsset);
    });

    it('should call onClick when Space is pressed', () => {
      const onClick = vi.fn();
      render(<AssetItem asset={defaultAsset} onClick={onClick} />);

      fireEvent.keyDown(screen.getByTestId('asset-item'), { key: ' ' });
      expect(onClick).toHaveBeenCalledWith(defaultAsset);
    });

    it('should not call onClick for other keys', () => {
      const onClick = vi.fn();
      render(<AssetItem asset={defaultAsset} onClick={onClick} />);

      fireEvent.keyDown(screen.getByTestId('asset-item'), { key: 'Escape' });
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Edge Case Tests
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle zero duration', () => {
      const asset = { ...defaultAsset, duration: 0 };
      render(<AssetItem asset={asset} />);
      expect(screen.getByTestId('asset-duration')).toHaveTextContent('0:00');
    });

    it('should handle very long duration', () => {
      const asset = { ...defaultAsset, duration: 86400 }; // 24 hours
      render(<AssetItem asset={asset} />);
      expect(screen.getByTestId('asset-duration')).toHaveTextContent('24:00:00');
    });

    it('should handle very long filename', () => {
      const longName = 'a'.repeat(200) + '.mp4';
      const asset = { ...defaultAsset, name: longName };
      render(<AssetItem asset={asset} />);
      expect(screen.getByText(longName)).toBeInTheDocument();
    });

    it('should handle special characters in filename', () => {
      const specialName = 'video (1) [final] #2.mp4';
      const asset = { ...defaultAsset, name: specialName };
      render(<AssetItem asset={asset} />);
      expect(screen.getByText(specialName)).toBeInTheDocument();
    });

    it('should handle zero file size', () => {
      const asset = { ...defaultAsset, fileSize: 0 };
      render(<AssetItem asset={asset} />);
      expect(screen.getByTestId('asset-filesize')).toHaveTextContent('0 B');
    });

    it('should not call handlers when no callbacks provided', () => {
      render(<AssetItem asset={defaultAsset} />);

      // Should not throw when clicking without handlers
      expect(() => {
        fireEvent.click(screen.getByTestId('asset-item'));
        fireEvent.doubleClick(screen.getByTestId('asset-item'));
        fireEvent.contextMenu(screen.getByTestId('asset-item'));
      }).not.toThrow();
    });
  });

  // ===========================================================================
  // Metadata Layout Tests
  // ===========================================================================

  describe('metadata layout', () => {
    it('should display duration and resolution separated by bullet', () => {
      const asset = {
        ...defaultAsset,
        duration: 120,
        resolution: { width: 1920, height: 1080 },
      };
      render(<AssetItem asset={asset} />);

      const metadata = screen.getByTestId('asset-metadata');
      expect(metadata).toBeInTheDocument();
      expect(screen.getByTestId('asset-duration')).toBeInTheDocument();
      expect(screen.getByTestId('asset-resolution')).toBeInTheDocument();
    });

    it('should display all metadata for complete video asset', () => {
      const asset = {
        ...defaultAsset,
        duration: 300,
        resolution: { width: 1920, height: 1080 },
        fileSize: 52428800, // 50 MB
      };
      render(<AssetItem asset={asset} />);

      expect(screen.getByTestId('asset-duration')).toHaveTextContent('5:00');
      expect(screen.getByTestId('asset-resolution')).toHaveTextContent('1920x1080');
      expect(screen.getByTestId('asset-filesize')).toHaveTextContent('50.0 MB');
    });
  });
});
