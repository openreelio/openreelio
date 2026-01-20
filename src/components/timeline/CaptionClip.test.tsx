/**
 * CaptionClip Component Tests
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CaptionClip } from './CaptionClip';
import type { Caption, CaptionColor } from '@/types';

// =============================================================================
// Test Data
// =============================================================================

const createTestCaption = (overrides?: Partial<Caption>): Caption => ({
  id: 'caption_001',
  startSec: 0,
  endSec: 5,
  text: 'Hello world',
  ...overrides,
});

// =============================================================================
// Tests
// =============================================================================

describe('CaptionClip', () => {
  describe('Rendering', () => {
    it('renders caption text', () => {
      const caption = createTestCaption({ text: 'Test caption text' });
      render(<CaptionClip caption={caption} zoom={100} selected={false} />);

      expect(screen.getByText('Test caption text')).toBeInTheDocument();
    });

    it('truncates long text with ellipsis', () => {
      const longText =
        'This is a very long caption text that should be truncated because it exceeds the maximum preview length';
      const caption = createTestCaption({ text: longText });
      render(<CaptionClip caption={caption} zoom={100} selected={false} />);

      // Text should be truncated (50 chars max)
      const displayedText = screen.getByText(/This is a very long caption/);
      expect(displayedText.textContent?.length).toBeLessThan(longText.length);
    });

    it('shows speaker name when provided', () => {
      const caption = createTestCaption({
        text: 'Hello',
        speaker: 'John',
      });
      render(<CaptionClip caption={caption} zoom={100} selected={false} />);

      expect(screen.getByText('John')).toBeInTheDocument();
    });

    it('does not show speaker badge when not provided', () => {
      const caption = createTestCaption({ speaker: undefined });
      render(<CaptionClip caption={caption} zoom={100} selected={false} />);

      expect(screen.queryByText('John')).not.toBeInTheDocument();
    });

    it('calculates correct position and width from timing', () => {
      const caption = createTestCaption({
        startSec: 2,
        endSec: 7,
      });
      const zoom = 100; // 100px per second

      render(<CaptionClip caption={caption} zoom={zoom} selected={false} />);

      const clipElement = screen.getByTestId('caption-clip-caption_001');
      expect(clipElement).toHaveStyle({ left: '200px' }); // 2s * 100px/s
      expect(clipElement).toHaveStyle({ width: '500px' }); // 5s * 100px/s
    });

    it('enforces minimum width', () => {
      const caption = createTestCaption({
        startSec: 0,
        endSec: 0.1,
      });
      const zoom = 10; // 10px per second -> 1px width

      render(<CaptionClip caption={caption} zoom={zoom} selected={false} />);

      const clipElement = screen.getByTestId('caption-clip-caption_001');
      // Should be at least 20px (MIN_CLIP_WIDTH_PX)
      const width = parseInt(clipElement.style.width);
      expect(width).toBeGreaterThanOrEqual(20);
    });
  });

  describe('Selection', () => {
    it('applies selected styling when selected', () => {
      const caption = createTestCaption();
      render(<CaptionClip caption={caption} zoom={100} selected={true} />);

      const clipElement = screen.getByTestId('caption-clip-caption_001');
      expect(clipElement.className).toContain('ring-2');
      expect(clipElement.className).toContain('ring-primary-400');
    });

    it('does not apply selected styling when not selected', () => {
      const caption = createTestCaption();
      render(<CaptionClip caption={caption} zoom={100} selected={false} />);

      const clipElement = screen.getByTestId('caption-clip-caption_001');
      expect(clipElement.className).not.toContain('ring-2');
    });
  });

  describe('Click Handling', () => {
    it('calls onClick with caption id and modifiers', () => {
      const onClick = vi.fn();
      const caption = createTestCaption({ id: 'test_caption' });

      render(<CaptionClip caption={caption} zoom={100} selected={false} onClick={onClick} />);

      const clipElement = screen.getByTestId('caption-clip-test_caption');
      fireEvent.click(clipElement);

      expect(onClick).toHaveBeenCalledWith('test_caption', expect.objectContaining({
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
      }));
    });

    it('passes modifier keys correctly', () => {
      const onClick = vi.fn();
      const caption = createTestCaption();

      render(<CaptionClip caption={caption} zoom={100} selected={false} onClick={onClick} />);

      const clipElement = screen.getByTestId('caption-clip-caption_001');
      fireEvent.click(clipElement, { ctrlKey: true, shiftKey: true });

      expect(onClick).toHaveBeenCalledWith(
        'caption_001',
        expect.objectContaining({
          ctrlKey: true,
          shiftKey: true,
        })
      );
    });

    it('does not call onClick when disabled', () => {
      const onClick = vi.fn();
      const caption = createTestCaption();

      render(
        <CaptionClip caption={caption} zoom={100} selected={false} onClick={onClick} disabled={true} />
      );

      const clipElement = screen.getByTestId('caption-clip-caption_001');
      fireEvent.click(clipElement);

      expect(onClick).not.toHaveBeenCalled();
    });

    it('calls onDoubleClick when double-clicked', () => {
      const onDoubleClick = vi.fn();
      const caption = createTestCaption({ id: 'dbl_click_caption' });

      render(
        <CaptionClip
          caption={caption}
          zoom={100}
          selected={false}
          onDoubleClick={onDoubleClick}
        />
      );

      const clipElement = screen.getByTestId('caption-clip-dbl_click_caption');
      fireEvent.doubleClick(clipElement);

      expect(onDoubleClick).toHaveBeenCalledWith('dbl_click_caption');
    });
  });

  describe('Disabled State', () => {
    it('applies disabled styling', () => {
      const caption = createTestCaption();
      render(<CaptionClip caption={caption} zoom={100} selected={false} disabled={true} />);

      const clipElement = screen.getByTestId('caption-clip-caption_001');
      expect(clipElement.className).toContain('opacity-50');
      expect(clipElement.className).toContain('cursor-not-allowed');
    });
  });

  describe('Speaker Colors', () => {
    it('uses provided speaker color', () => {
      const caption = createTestCaption({ speaker: 'Alice' });
      const speakerColor: CaptionColor = { r: 255, g: 0, b: 0, a: 255 };

      render(
        <CaptionClip
          caption={caption}
          zoom={100}
          selected={false}
          speakerColor={speakerColor}
        />
      );

      const clipElement = screen.getByTestId('caption-clip-caption_001');
      // Browser normalizes rgba(255, 0, 0, 1) to rgb(255, 0, 0)
      expect(clipElement.style.backgroundColor).toMatch(/rgb\(255,\s*0,\s*0\)/);
    });

    it('generates consistent color from speaker name', () => {
      const caption1 = createTestCaption({ id: 'c1', speaker: 'Bob' });
      const caption2 = createTestCaption({ id: 'c2', speaker: 'Bob' });

      const { rerender } = render(
        <CaptionClip caption={caption1} zoom={100} selected={false} />
      );
      const clip1Element = screen.getByTestId('caption-clip-c1');
      const color1 = clip1Element.style.backgroundColor;

      rerender(<CaptionClip caption={caption2} zoom={100} selected={false} />);
      const clip2Element = screen.getByTestId('caption-clip-c2');
      const color2 = clip2Element.style.backgroundColor;

      // Same speaker name should produce same color
      expect(color1).toBe(color2);
    });
  });

  describe('Tooltip', () => {
    it('shows full caption text in title attribute', () => {
      const longText = 'This is the full caption text that will be shown on hover';
      const caption = createTestCaption({ text: longText });

      render(<CaptionClip caption={caption} zoom={100} selected={false} />);

      const clipElement = screen.getByTestId('caption-clip-caption_001');
      expect(clipElement).toHaveAttribute('title', longText);
    });
  });
});
