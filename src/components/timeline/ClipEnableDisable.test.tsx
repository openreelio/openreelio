/**
 * Clip Enable/Disable Tests
 *
 * Integration tests for the clip enable/disable feature.
 * Tests visual treatment of disabled clips and context menu label toggling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Clip as ClipType, Track as TrackType } from '@/types';
import { useEditorToolStore } from '@/stores/editorToolStore';

vi.mock('./LazyThumbnailStrip', () => ({
  LazyThumbnailStrip: () => <div data-testid="lazy-thumbnail-strip-mock" />,
}));

vi.mock('./AudioClipWaveform', () => ({
  AudioClipWaveform: () => <div data-testid="audio-clip-waveform-mock" />,
}));

import { Clip } from './Clip';
import { Track } from './Track';

// =============================================================================
// Test Data
// =============================================================================

const baseClip: ClipType = {
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

const mockTrack: TrackType = {
  id: 'track_001',
  kind: 'video',
  name: 'Video 1',
  clips: [],
  blendMode: 'normal',
  muted: false,
  locked: false,
  visible: true,
  volume: 1.0,
};

// =============================================================================
// Tests
// =============================================================================

describe('Clip Enable/Disable', () => {
  beforeEach(() => {
    useEditorToolStore.setState({ activeTool: 'select', previousTool: null });
  });

  // ===========================================================================
  // Disabled clip visual treatment
  // ===========================================================================

  describe('disabled clip visual treatment', () => {
    it('should show disabled overlay and OFF badge when enabled is false', () => {
      const disabledClip: ClipType = { ...baseClip, enabled: false };

      render(<Clip clip={disabledClip} zoom={100} selected={false} />);

      expect(screen.getByTestId('disabled-clip-overlay')).toBeInTheDocument();
      expect(screen.getByTestId('disabled-clip-indicator')).toHaveTextContent('OFF');
    });

    it('should show the disabled overlay when enabled is false', () => {
      const disabledClip: ClipType = { ...baseClip, enabled: false };

      render(<Clip clip={disabledClip} zoom={100} selected={false} />);

      expect(screen.getByTestId('disabled-clip-overlay')).toBeInTheDocument();
    });

    it('should show the OFF indicator badge when enabled is false', () => {
      const disabledClip: ClipType = { ...baseClip, enabled: false };

      render(<Clip clip={disabledClip} zoom={100} selected={false} />);

      const indicator = screen.getByTestId('disabled-clip-indicator');
      expect(indicator).toBeInTheDocument();
      expect(indicator).toHaveTextContent('OFF');
    });
  });

  // ===========================================================================
  // Enabled clip normal appearance
  // ===========================================================================

  describe('enabled clip normal appearance', () => {
    it('should not show disabled overlay when enabled is true', () => {
      const enabledClip: ClipType = { ...baseClip, enabled: true };

      render(<Clip clip={enabledClip} zoom={100} selected={false} />);

      expect(screen.queryByTestId('disabled-clip-overlay')).not.toBeInTheDocument();
      expect(screen.queryByTestId('disabled-clip-indicator')).not.toBeInTheDocument();
    });

    it('should not show disabled overlay when enabled is undefined (default)', () => {
      // enabled is omitted, defaults to true behavior
      render(<Clip clip={baseClip} zoom={100} selected={false} />);

      expect(screen.queryByTestId('disabled-clip-overlay')).not.toBeInTheDocument();
      expect(screen.queryByTestId('disabled-clip-indicator')).not.toBeInTheDocument();
    });

    it('should not show the disabled overlay when enabled is true', () => {
      const enabledClip: ClipType = { ...baseClip, enabled: true };

      render(<Clip clip={enabledClip} zoom={100} selected={false} />);

      expect(screen.queryByTestId('disabled-clip-overlay')).not.toBeInTheDocument();
    });

    it('should not show the disabled overlay when enabled is undefined', () => {
      render(<Clip clip={baseClip} zoom={100} selected={false} />);

      expect(screen.queryByTestId('disabled-clip-overlay')).not.toBeInTheDocument();
    });

    it('should not show the OFF indicator when enabled is true', () => {
      const enabledClip: ClipType = { ...baseClip, enabled: true };

      render(<Clip clip={enabledClip} zoom={100} selected={false} />);

      expect(screen.queryByTestId('disabled-clip-indicator')).not.toBeInTheDocument();
    });

    it('should not show the OFF indicator when enabled is undefined', () => {
      render(<Clip clip={baseClip} zoom={100} selected={false} />);

      expect(screen.queryByTestId('disabled-clip-indicator')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Context menu label
  // ===========================================================================

  describe('context menu label', () => {
    it('should show "Disable Clip" when the clip is enabled', () => {
      const enabledClip: ClipType = { ...baseClip, enabled: true };
      const onClipToggleEnabled = vi.fn();

      render(
        <Track
          track={{ ...mockTrack, clips: [enabledClip] }}
          clips={[enabledClip]}
          zoom={100}
          onClipToggleEnabled={onClipToggleEnabled}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));
      expect(screen.getByRole('button', { name: /Disable Clip/ })).toBeInTheDocument();
    });

    it('should show "Disable Clip" when enabled is undefined (default enabled)', () => {
      const defaultClip: ClipType = { ...baseClip };
      const onClipToggleEnabled = vi.fn();

      render(
        <Track
          track={{ ...mockTrack, clips: [defaultClip] }}
          clips={[defaultClip]}
          zoom={100}
          onClipToggleEnabled={onClipToggleEnabled}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));
      expect(screen.getByRole('button', { name: /Disable Clip/ })).toBeInTheDocument();
    });

    it('should show "Enable Clip" when the clip is disabled', () => {
      const disabledClip: ClipType = { ...baseClip, enabled: false };
      const onClipToggleEnabled = vi.fn();

      render(
        <Track
          track={{ ...mockTrack, clips: [disabledClip] }}
          clips={[disabledClip]}
          zoom={100}
          onClipToggleEnabled={onClipToggleEnabled}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));
      expect(screen.getByRole('button', { name: /Enable Clip/ })).toBeInTheDocument();
    });

    it('should call onClipToggleEnabled when the toggle menu item is clicked', () => {
      const disabledClip: ClipType = { ...baseClip, enabled: false };
      const onClipToggleEnabled = vi.fn();

      render(
        <Track
          track={{ ...mockTrack, clips: [disabledClip] }}
          clips={[disabledClip]}
          zoom={100}
          onClipToggleEnabled={onClipToggleEnabled}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));
      fireEvent.click(screen.getByRole('button', { name: /Enable Clip/ }));

      expect(onClipToggleEnabled).toHaveBeenCalledWith('clip_001', 'track_001');
    });
  });
});
