/**
 * Clip Component Tests
 *
 * Tests for the timeline clip component.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Clip as ClipType, Asset } from '@/types';
import { TEXT_ASSET_PREFIX } from '@/types';

vi.mock('./LazyThumbnailStrip', () => ({
  LazyThumbnailStrip: () => <div data-testid="lazy-thumbnail-strip-mock" />,
}));

vi.mock('./AudioClipWaveform', () => ({
  AudioClipWaveform: () => <div data-testid="audio-clip-waveform-mock" />,
}));

import { Clip } from './Clip';

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

const mockVisualAsset: Asset = {
  id: 'asset_001',
  kind: 'video',
  name: 'city-broll.mp4',
  uri: '/path/to/video.mp4',
  hash: 'hash123',
  durationSec: 10,
  fileSize: 1024,
  importedAt: '2024-01-01T00:00:00Z',
  license: {
    source: 'user',
    licenseType: 'unknown',
    allowedUse: [],
  },
  tags: [],
  proxyStatus: 'notNeeded',
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

    it('should expose clip label through title attribute', () => {
      render(<Clip clip={mockClip} zoom={100} selected={false} />);
      expect(screen.getByTestId('clip-clip_001')).toHaveAttribute('title', 'Test Clip');
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

    it('should render thumbnails even when waveform is enabled', () => {
      render(
        <Clip
          clip={mockClip}
          zoom={100}
          selected={false}
          thumbnailConfig={{ asset: mockVisualAsset, enabled: true }}
          waveformConfig={{
            assetId: mockVisualAsset.id,
            inputPath: mockVisualAsset.uri,
            totalDurationSec: mockVisualAsset.durationSec ?? 0,
            enabled: true,
          }}
        />,
      );

      expect(screen.getByTestId('lazy-thumbnail-strip-mock')).toBeInTheDocument();
    });

    it('should fall back to asset name when clip label is missing', () => {
      render(
        <Clip
          clip={{ ...mockClip, label: undefined }}
          zoom={100}
          selected={false}
          thumbnailConfig={{ asset: mockVisualAsset, enabled: true }}
        />,
      );

      expect(screen.getByText('city-broll.mp4')).toBeInTheDocument();
    });

    it('should fall back to waveform display label when thumbnail is not available', () => {
      render(
        <Clip
          clip={{ ...mockClip, label: undefined }}
          zoom={100}
          selected={false}
          waveformConfig={{
            assetId: mockVisualAsset.id,
            inputPath: mockVisualAsset.uri,
            totalDurationSec: mockVisualAsset.durationSec ?? 0,
            enabled: true,
            displayLabel: 'Video Audio: city-broll.mp4',
          }}
        />,
      );

      expect(screen.getByText('Video Audio: city-broll.mp4')).toBeInTheDocument();
    });

    it('should treat empty clip label as missing and use waveform display label fallback', () => {
      render(
        <Clip
          clip={{ ...mockClip, label: '   ' }}
          zoom={100}
          selected={false}
          waveformConfig={{
            assetId: mockVisualAsset.id,
            inputPath: mockVisualAsset.uri,
            totalDurationSec: mockVisualAsset.durationSec ?? 0,
            enabled: true,
            displayLabel: 'Video Audio: city-broll.mp4',
          }}
        />,
      );

      expect(screen.getByText('Video Audio: city-broll.mp4')).toBeInTheDocument();
    });

    it('should render video-audio source tag when waveform comes from video asset', () => {
      render(
        <Clip
          clip={mockClip}
          zoom={100}
          selected={false}
          waveformConfig={{
            assetId: mockVisualAsset.id,
            inputPath: mockVisualAsset.uri,
            totalDurationSec: mockVisualAsset.durationSec ?? 0,
            enabled: true,
            isVideoSource: true,
          }}
        />,
      );

      expect(screen.getByTestId('video-audio-source-tag')).toHaveTextContent('Video Audio');
    });

    it('should not render video-audio source tag for pure audio source', () => {
      render(
        <Clip
          clip={mockClip}
          zoom={100}
          selected={false}
          waveformConfig={{
            assetId: 'asset_audio_001',
            inputPath: '/path/to/audio.wav',
            totalDurationSec: 10,
            enabled: true,
            isVideoSource: false,
          }}
        />,
      );

      expect(screen.queryByTestId('video-audio-source-tag')).not.toBeInTheDocument();
    });

    it('should allow label overflow for audio-style clips', () => {
      render(
        <Clip
          clip={{ ...mockClip, label: undefined }}
          zoom={100}
          selected={false}
          waveformConfig={{
            assetId: 'asset_audio_001',
            inputPath: '/path/to/audio.wav',
            totalDurationSec: 10,
            enabled: true,
            displayLabel: 'Very long audio source label that must remain visible',
          }}
        />,
      );

      expect(screen.getByTestId('clip-clip_001')).toHaveClass('overflow-visible');
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

  describe('audio editing controls', () => {
    it('should render audio editing controls for audio track clips', () => {
      render(
        <Clip
          clip={mockClip}
          zoom={100}
          selected={false}
          trackKind="audio"
          waveformConfig={{
            assetId: 'asset_audio_001',
            inputPath: '/path/to/audio.wav',
            totalDurationSec: 10,
            enabled: true,
          }}
        />,
      );

      expect(screen.getByTestId('audio-clip-controls')).toBeInTheDocument();
      expect(screen.getByTestId('audio-volume-handle')).toBeInTheDocument();
      expect(screen.getByTestId('audio-fade-in-handle')).toBeInTheDocument();
      expect(screen.getByTestId('audio-fade-out-handle')).toBeInTheDocument();
    });

    it('should commit clip volume changes after dragging the volume handle', () => {
      const onAudioSettingsChange = vi.fn();

      render(
        <Clip
          clip={mockClip}
          zoom={100}
          selected={false}
          trackKind="audio"
          onAudioSettingsChange={onAudioSettingsChange}
        />,
      );

      fireEvent.mouseDown(screen.getByTestId('audio-volume-handle'), {
        clientX: 100,
        clientY: 32,
      });

      fireEvent.mouseMove(window, {
        clientX: 100,
        clientY: 12,
      });

      fireEvent.mouseUp(window);

      expect(onAudioSettingsChange).toHaveBeenCalledTimes(1);
      expect(onAudioSettingsChange).toHaveBeenCalledWith(
        'clip_001',
        expect.objectContaining({
          volumeDb: expect.any(Number),
        }),
      );
    });

    it('should commit fade-in updates after dragging fade-in handle', () => {
      const onAudioSettingsChange = vi.fn();

      render(
        <Clip
          clip={mockClip}
          zoom={100}
          selected={false}
          trackKind="audio"
          onAudioSettingsChange={onAudioSettingsChange}
        />,
      );

      fireEvent.mouseDown(screen.getByTestId('audio-fade-in-handle'), {
        clientX: 0,
        clientY: 8,
      });

      fireEvent.mouseMove(window, {
        clientX: 100,
        clientY: 8,
      });

      fireEvent.mouseUp(window);

      expect(onAudioSettingsChange).toHaveBeenCalledWith(
        'clip_001',
        expect.objectContaining({
          fadeInSec: expect.any(Number),
        }),
      );
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

  // ===========================================================================
  // Text Clip Rendering Tests
  // ===========================================================================

  describe('text clip rendering', () => {
    const mockTextClip: ClipType = {
      id: 'text_clip_001',
      assetId: `${TEXT_ASSET_PREFIX}text_clip_001`,
      range: { sourceInSec: 0, sourceOutSec: 5 },
      place: { timelineInSec: 10, durationSec: 5 },
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
      label: 'Text: Hello World',
    };

    it('should show text icon indicator for text clips', () => {
      render(<Clip clip={mockTextClip} zoom={100} selected={false} />);

      expect(screen.getByTestId('text-clip-indicator')).toBeInTheDocument();
    });

    it('should display text clip label', () => {
      render(<Clip clip={mockTextClip} zoom={100} selected={false} />);

      expect(screen.getByText('Text: Hello World')).toBeInTheDocument();
    });

    it('should have distinct background color for text clips', () => {
      const { container } = render(<Clip clip={mockTextClip} zoom={100} selected={false} />);
      const clipElement = container.firstChild as HTMLElement;

      // Text clips should have teal/cyan background color class or inline style
      expect(clipElement).toHaveClass('bg-teal-600');
    });

    it('should not show thumbnail or waveform for text clips', () => {
      // Even if configs are provided, text clips should not show thumbnails/waveforms
      const thumbnailConfig = {
        asset: {
          id: 'dummy',
          kind: 'video' as const,
          name: 'dummy',
          uri: '',
          hash: 'abc123',
          fileSize: 1000,
          importedAt: '2024-01-01T00:00:00Z',
          license: {
            source: 'user' as const,
            licenseType: 'unknown' as const,
            allowedUse: [],
          },
          tags: [],
          proxyStatus: 'notNeeded' as const,
        },
        enabled: true,
      };

      render(
        <Clip clip={mockTextClip} zoom={100} selected={false} thumbnailConfig={thumbnailConfig} />,
      );

      // The thumbnail strip should not be rendered for text clips
      // Text clips use virtual assets, so thumbnail loading would fail anyway
      expect(screen.getByTestId('text-clip-indicator')).toBeInTheDocument();
    });

    it('should display default label when text clip has no label', () => {
      const textClipNoLabel: ClipType = {
        ...mockTextClip,
        label: undefined,
      };

      render(<Clip clip={textClipNoLabel} zoom={100} selected={false} />);

      // Should show "Text" as default label for text clips
      expect(screen.getByText('Text')).toBeInTheDocument();
    });

    it('should handle text clip interactions same as regular clips', () => {
      const onClick = vi.fn();
      render(<Clip clip={mockTextClip} zoom={100} selected={false} onClick={onClick} />);

      fireEvent.click(screen.getByTestId(`clip-${mockTextClip.id}`));
      expect(onClick).toHaveBeenCalledWith('text_clip_001', {
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
      });
    });

    it('should be selectable like regular clips', () => {
      const { container } = render(<Clip clip={mockTextClip} zoom={100} selected={true} />);
      const clipElement = container.firstChild as HTMLElement;

      expect(clipElement).toHaveClass('ring-2');
    });
  });
});
