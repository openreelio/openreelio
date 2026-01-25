/**
 * CaptionTrack Component Tests
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CaptionTrack } from './CaptionTrack';
import type { CaptionTrack as CaptionTrackType, Caption } from '@/types';
import { DEFAULT_CAPTION_STYLE, DEFAULT_CAPTION_POSITION } from '@/types';

// =============================================================================
// Test Data
// =============================================================================

const createTestCaption = (overrides?: Partial<Caption>): Caption => ({
  id: `caption_${Math.random().toString(36).slice(2, 8)}`,
  startSec: 0,
  endSec: 5,
  text: 'Test caption',
  ...overrides,
});

const createTestTrack = (overrides?: Partial<CaptionTrackType>): CaptionTrackType => ({
  id: 'track_001',
  name: 'Subtitles',
  language: 'en',
  visible: true,
  locked: false,
  captions: [],
  defaultStyle: DEFAULT_CAPTION_STYLE,
  defaultPosition: DEFAULT_CAPTION_POSITION,
  ...overrides,
});

// =============================================================================
// Tests
// =============================================================================

describe('CaptionTrack', () => {
  describe('Track Header', () => {
    it('renders track name', () => {
      const track = createTestTrack({ name: 'My Subtitles' });
      render(<CaptionTrack track={track} zoom={100} />);

      expect(screen.getByText('My Subtitles')).toBeInTheDocument();
    });

    it('renders language display name', () => {
      const track = createTestTrack({ language: 'ko' });
      render(<CaptionTrack track={track} zoom={100} />);

      expect(screen.getByText('Korean')).toBeInTheDocument();
    });

    it('renders uppercase language code for unknown languages', () => {
      const track = createTestTrack({ language: 'xyz' });
      render(<CaptionTrack track={track} zoom={100} />);

      expect(screen.getByText('XYZ')).toBeInTheDocument();
    });

    it('renders caption track icon', () => {
      const track = createTestTrack();
      render(<CaptionTrack track={track} zoom={100} />);

      const header = screen.getByTestId('caption-track-header');
      expect(header).toBeInTheDocument();
    });
  });

  describe('Track Controls', () => {
    it('calls onLockToggle when lock button clicked', () => {
      const onLockToggle = vi.fn();
      const track = createTestTrack({ id: 'track_lock_test' });

      render(<CaptionTrack track={track} zoom={100} onLockToggle={onLockToggle} />);

      const lockButton = screen.getByTestId('caption-lock-button');
      fireEvent.click(lockButton);

      expect(onLockToggle).toHaveBeenCalledWith('track_lock_test');
    });

    it('calls onVisibilityToggle when visibility button clicked', () => {
      const onVisibilityToggle = vi.fn();
      const track = createTestTrack({ id: 'track_vis_test' });

      render(<CaptionTrack track={track} zoom={100} onVisibilityToggle={onVisibilityToggle} />);

      const visButton = screen.getByTestId('caption-visibility-button');
      fireEvent.click(visButton);

      expect(onVisibilityToggle).toHaveBeenCalledWith('track_vis_test');
    });

    it('calls onTrackClick when header is clicked', () => {
      const onTrackClick = vi.fn();
      const track = createTestTrack({ id: 'track_click_test' });

      render(<CaptionTrack track={track} zoom={100} onTrackClick={onTrackClick} />);

      const header = screen.getByTestId('caption-track-header');
      fireEvent.click(header);

      expect(onTrackClick).toHaveBeenCalledWith('track_click_test');
    });

    it('does not propagate click from controls to header', () => {
      const onTrackClick = vi.fn();
      const onLockToggle = vi.fn();
      const track = createTestTrack();

      render(
        <CaptionTrack
          track={track}
          zoom={100}
          onTrackClick={onTrackClick}
          onLockToggle={onLockToggle}
        />
      );

      const lockButton = screen.getByTestId('caption-lock-button');
      fireEvent.click(lockButton);

      expect(onLockToggle).toHaveBeenCalled();
      expect(onTrackClick).not.toHaveBeenCalled();
    });
  });

  describe('Track Content', () => {
    it('renders empty state when no captions', () => {
      const track = createTestTrack({ captions: [] });
      render(<CaptionTrack track={track} zoom={100} />);

      expect(screen.getByText('No captions')).toBeInTheDocument();
    });

    it('renders captions', () => {
      const captions = [
        createTestCaption({ id: 'c1', text: 'First caption' }),
        createTestCaption({ id: 'c2', text: 'Second caption', startSec: 5, endSec: 10 }),
      ];
      const track = createTestTrack({ captions });

      render(<CaptionTrack track={track} zoom={100} />);

      expect(screen.getByText('First caption')).toBeInTheDocument();
      expect(screen.getByText('Second caption')).toBeInTheDocument();
    });

    it('applies reduced opacity when track is hidden', () => {
      const track = createTestTrack({ visible: false });
      render(<CaptionTrack track={track} zoom={100} />);

      const content = screen.getByTestId('caption-track-content');
      expect(content.className).toContain('opacity-50');
    });

    it('does not apply reduced opacity when visible', () => {
      const track = createTestTrack({ visible: true });
      render(<CaptionTrack track={track} zoom={100} />);

      const content = screen.getByTestId('caption-track-content');
      expect(content.className).not.toContain('opacity-50');
    });
  });

  describe('Caption Interaction', () => {
    it('calls onCaptionClick when caption is clicked', () => {
      const onCaptionClick = vi.fn();
      const captions = [createTestCaption({ id: 'clickable_caption' })];
      const track = createTestTrack({ captions });

      render(<CaptionTrack track={track} zoom={100} onCaptionClick={onCaptionClick} />);

      const caption = screen.getByTestId('caption-clip-clickable_caption');
      fireEvent.click(caption);

      expect(onCaptionClick).toHaveBeenCalledWith('clickable_caption', expect.any(Object));
    });

    it('calls onCaptionDoubleClick when caption is double-clicked', () => {
      const onCaptionDoubleClick = vi.fn();
      const captions = [createTestCaption({ id: 'dbl_caption' })];
      const track = createTestTrack({ captions });

      render(
        <CaptionTrack track={track} zoom={100} onCaptionDoubleClick={onCaptionDoubleClick} />
      );

      const caption = screen.getByTestId('caption-clip-dbl_caption');
      fireEvent.doubleClick(caption);

      expect(onCaptionDoubleClick).toHaveBeenCalledWith('dbl_caption');
    });

    it('disables caption interaction when track is locked', () => {
      const onCaptionClick = vi.fn();
      const captions = [createTestCaption({ id: 'locked_caption' })];
      const track = createTestTrack({ captions, locked: true });

      render(<CaptionTrack track={track} zoom={100} onCaptionClick={onCaptionClick} />);

      const caption = screen.getByTestId('caption-clip-locked_caption');
      fireEvent.click(caption);

      expect(onCaptionClick).not.toHaveBeenCalled();
    });
  });

  describe('Selection', () => {
    it('marks selected captions', () => {
      const captions = [
        createTestCaption({ id: 'selected_caption' }),
        createTestCaption({ id: 'unselected_caption', startSec: 5, endSec: 10 }),
      ];
      const track = createTestTrack({ captions });

      render(
        <CaptionTrack track={track} zoom={100} selectedCaptionIds={['selected_caption']} />
      );

      const selected = screen.getByTestId('caption-clip-selected_caption');
      const unselected = screen.getByTestId('caption-clip-unselected_caption');

      expect(selected.className).toContain('ring-2');
      expect(unselected.className).not.toContain('ring-2');
    });
  });

  describe('Virtualization', () => {
    it('only renders visible captions based on scroll position', () => {
      // Create many captions spread across timeline
      const captions = Array.from({ length: 100 }, (_, i) =>
        createTestCaption({
          id: `caption_${i}`,
          startSec: i * 10,
          endSec: i * 10 + 5,
          text: `Caption ${i}`,
        })
      );
      const track = createTestTrack({ captions });

      render(
        <CaptionTrack
          track={track}
          zoom={100}
          scrollX={0}
          viewportWidth={500}
          duration={1000}
        />
      );

      // Should render only captions visible in viewport + buffer
      // At zoom=100, viewport shows 0-5 seconds, plus buffer
      expect(screen.getByText('Caption 0')).toBeInTheDocument();

      // Caption at 500 seconds should not be rendered
      expect(screen.queryByText('Caption 50')).not.toBeInTheDocument();
    });

    it('handles zero zoom gracefully by showing all captions', () => {
      const captions = [
        createTestCaption({ id: 'c1', text: 'First' }),
        createTestCaption({ id: 'c2', text: 'Second', startSec: 100, endSec: 105 }),
      ];
      const track = createTestTrack({ captions });

      // Zero zoom should show all captions (fallback behavior)
      render(<CaptionTrack track={track} zoom={0} scrollX={0} viewportWidth={500} />);

      expect(screen.getByText('First')).toBeInTheDocument();
      expect(screen.getByText('Second')).toBeInTheDocument();
    });
  });

  describe('Content Width', () => {
    it('sets content width based on duration and zoom', () => {
      const track = createTestTrack();
      render(<CaptionTrack track={track} zoom={100} duration={120} />);

      const content = screen.getByTestId('caption-track-content');
      // The scrollable container is the second child (first is background pattern)
      const scrollableContainer = content.children[1] as HTMLElement;

      // 120 seconds * 100 px/s = 12000px
      expect(scrollableContainer.style.width).toBe('12000px');
    });
  });

  describe('Export Button', () => {
    it('renders export button in track header', () => {
      const track = createTestTrack();
      render(<CaptionTrack track={track} zoom={100} />);

      const exportButton = screen.getByTestId('caption-export-button');
      expect(exportButton).toBeInTheDocument();
    });

    it('calls onExportClick when export button is clicked', () => {
      const onExportClick = vi.fn();
      const captions = [
        createTestCaption({ id: 'c1', text: 'First' }),
        createTestCaption({ id: 'c2', text: 'Second', startSec: 5, endSec: 10 }),
      ];
      const track = createTestTrack({ id: 'export_track', captions });

      render(<CaptionTrack track={track} zoom={100} onExportClick={onExportClick} />);

      const exportButton = screen.getByTestId('caption-export-button');
      fireEvent.click(exportButton);

      expect(onExportClick).toHaveBeenCalledWith('export_track', captions);
    });

    it('does not propagate click from export button to header', () => {
      const onTrackClick = vi.fn();
      const onExportClick = vi.fn();
      const track = createTestTrack({ captions: [createTestCaption()] });

      render(
        <CaptionTrack
          track={track}
          zoom={100}
          onTrackClick={onTrackClick}
          onExportClick={onExportClick}
        />
      );

      const exportButton = screen.getByTestId('caption-export-button');
      fireEvent.click(exportButton);

      expect(onExportClick).toHaveBeenCalled();
      expect(onTrackClick).not.toHaveBeenCalled();
    });

    it('disables export button when no captions exist', () => {
      const onExportClick = vi.fn();
      const track = createTestTrack({ captions: [] });

      render(<CaptionTrack track={track} zoom={100} onExportClick={onExportClick} />);

      const exportButton = screen.getByTestId('caption-export-button');
      expect(exportButton).toBeDisabled();

      fireEvent.click(exportButton);
      expect(onExportClick).not.toHaveBeenCalled();
    });

    it('shows export button tooltip', () => {
      const track = createTestTrack({ captions: [createTestCaption()] });
      render(<CaptionTrack track={track} zoom={100} />);

      const exportButton = screen.getByTestId('caption-export-button');
      expect(exportButton).toHaveAttribute('title', 'Export captions');
    });
  });
});
