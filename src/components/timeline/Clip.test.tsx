/**
 * Clip Component Tests
 *
 * Tests for the timeline clip component.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Clip } from './Clip';
import type { Clip as ClipType } from '@/types';

// =============================================================================
// Test Data
// =============================================================================

const mockClip: ClipType = {
  id: 'clip_001',
  assetId: 'asset_001',
  range: { sourceInSec: 0, sourceOutSec: 10 },
  place: { timelineInSec: 5, durationSec: 10 },
  transform: {
    position: { x: 0.5, y: 0.5 },
    scale: { x: 1, y: 1 },
    rotationDeg: 0,
    anchor: { x: 0.5, y: 0.5 },
  },
  opacity: 1,
  speed: 1,
  effects: [],
  audio: { volumeDb: 0, pan: 0, muted: false },
  label: 'Test Clip',
};

// =============================================================================
// Tests
// =============================================================================

describe('Clip', () => {
  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render clip with label', () => {
      render(<Clip clip={mockClip} zoom={100} selected={false} />);
      expect(screen.getByText('Test Clip')).toBeInTheDocument();
    });

    it('should position clip correctly based on timeline position and zoom', () => {
      const { container } = render(<Clip clip={mockClip} zoom={100} selected={false} />);
      const clipElement = container.firstChild as HTMLElement;

      // At 5 seconds with zoom 100px/sec = 500px left position
      expect(clipElement).toHaveStyle({ left: '500px' });
    });

    it('should have width based on clip duration and zoom', () => {
      const { container } = render(<Clip clip={mockClip} zoom={100} selected={false} />);
      const clipElement = container.firstChild as HTMLElement;

      // Duration is 10 seconds (sourceOutSec - sourceInSec) * zoom 100 = 1000px
      expect(clipElement).toHaveStyle({ width: '1000px' });
    });

    it('should show selected state', () => {
      const { container } = render(<Clip clip={mockClip} zoom={100} selected={true} />);
      const clipElement = container.firstChild as HTMLElement;

      expect(clipElement).toHaveClass('ring-2');
    });
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  describe('interactions', () => {
    it('should call onClick when clicked with modifier keys', () => {
      const onClick = vi.fn();
      render(<Clip clip={mockClip} zoom={100} selected={false} onClick={onClick} />);

      fireEvent.click(screen.getByTestId('clip-clip_001'));
      expect(onClick).toHaveBeenCalledWith('clip_001', {
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
      });
    });

    it('should call onDoubleClick when double-clicked', () => {
      const onDoubleClick = vi.fn();
      render(<Clip clip={mockClip} zoom={100} selected={false} onDoubleClick={onDoubleClick} />);

      fireEvent.doubleClick(screen.getByTestId('clip-clip_001'));
      expect(onDoubleClick).toHaveBeenCalledWith('clip_001');
    });

    it('should not respond to clicks when disabled', () => {
      const onClick = vi.fn();
      render(<Clip clip={mockClip} zoom={100} selected={false} onClick={onClick} disabled />);

      fireEvent.click(screen.getByTestId('clip-clip_001'));
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Styling Tests
  // ===========================================================================

  describe('styling', () => {
    it('should apply custom color when provided', () => {
      const clipWithColor = { ...mockClip, color: { r: 255, g: 0, b: 0 } };
      const { container } = render(<Clip clip={clipWithColor} zoom={100} selected={false} />);
      const clipElement = container.firstChild as HTMLElement;

      expect(clipElement.style.backgroundColor).toContain('rgb(255, 0, 0)');
    });

    it('should show effects indicator when clip has effects', () => {
      const clipWithEffects = { ...mockClip, effects: ['effect_001'] };
      render(<Clip clip={clipWithEffects} zoom={100} selected={false} />);

      expect(screen.getByTestId('effects-indicator')).toBeInTheDocument();
    });

    it('should show speed indicator when speed is not 1x', () => {
      const slowClip = { ...mockClip, speed: 0.5 };
      render(<Clip clip={slowClip} zoom={100} selected={false} />);

      expect(screen.getByTestId('speed-indicator')).toBeInTheDocument();
      expect(screen.getByText('0.5x')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Resize Handles Tests
  // ===========================================================================

  describe('resize handles', () => {
    it('should show resize handles when selected', () => {
      render(<Clip clip={mockClip} zoom={100} selected={true} />);

      expect(screen.getByTestId('resize-handle-left')).toBeInTheDocument();
      expect(screen.getByTestId('resize-handle-right')).toBeInTheDocument();
    });

    it('should always show resize handles for better UX', () => {
      // Resize handles are now always visible (with different styling when selected)
      render(<Clip clip={mockClip} zoom={100} selected={false} />);

      expect(screen.getByTestId('resize-handle-left')).toBeInTheDocument();
      expect(screen.getByTestId('resize-handle-right')).toBeInTheDocument();
    });
  });
});
