import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { UnifiedPreviewPlayer } from './UnifiedPreviewPlayer';
import { usePreviewStore } from '@/stores/previewStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import type { Asset, Clip, Sequence, Track } from '@/types';

const playbackControllerMock = vi.hoisted(() => ({
  syncState: {
    videoTime: 0,
    audioTime: 0,
    driftMs: 0,
    isSynced: true,
    lastCorrectionTime: 0,
  },
}));

vi.mock('@/hooks/usePreviewMode', () => ({
  usePreviewMode: () => ({
    mode: 'canvas',
    reason: 'test',
    hasGeneratingProxy: false,
  }),
}));

vi.mock('@/services/PlaybackController', () => ({
  usePlaybackController: () => ({
    syncState: playbackControllerMock.syncState,
  }),
}));

vi.mock('./TimelinePreviewPlayer', () => ({
  TimelinePreviewPlayer: ({ width, height }: { width?: number; height?: number }) => (
    <div data-testid="timeline-preview-player" data-width={width} data-height={height} />
  ),
}));

vi.mock('./ProxyPreviewPlayer', () => ({
  ProxyPreviewPlayer: () => <div data-testid="proxy-preview-player" />,
}));

describe('UnifiedPreviewPlayer', () => {
  const emptySequence: Sequence = {
    id: 'seq-quality',
    name: 'Quality Sequence',
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks: [],
    markers: [],
  };

  beforeEach(() => {
    usePreviewStore.setState({
      zoomLevel: 1,
      zoomMode: 'fit',
      panX: 0,
      panY: 0,
      isPanning: false,
      showSafeMargins: false,
      showGuides: false,
      playbackQuality: 'full',
      mediaPreference: 'auto',
      programPreviewCanvas: null,
    });
    usePlaybackStore.setState({ currentTime: 0 });
    useTimelineStore.setState({ selectedClipIds: [] });
    useProjectStore.setState({
      activeSequenceId: null,
      sequences: new Map(),
      assets: new Map(),
      effects: new Map(),
    });
    playbackControllerMock.syncState = {
      videoTime: 0,
      audioTime: 0,
      driftMs: 0,
      isSynced: true,
      lastCorrectionTime: 0,
    };
  });

  it('renders program overlay controls without showing guides by default', () => {
    render(<UnifiedPreviewPlayer />);

    expect(screen.getByTestId('program-overlay-controls')).toBeInTheDocument();
    expect(screen.queryByTestId('program-preview-guides')).not.toBeInTheDocument();
    expect(screen.getByTestId('toggle-safe-margins')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('toggle-composition-guides')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('toggles safe margins and composition guides on the program monitor', () => {
    render(<UnifiedPreviewPlayer />);

    fireEvent.click(screen.getByTestId('toggle-safe-margins'));
    fireEvent.click(screen.getByTestId('toggle-composition-guides'));

    expect(screen.getByTestId('program-preview-guides')).toBeInTheDocument();
    expect(screen.getByTestId('program-action-safe')).toBeInTheDocument();
    expect(screen.getByTestId('program-title-safe')).toBeInTheDocument();
    expect(screen.getByTestId('program-guide-v-1')).toBeInTheDocument();
    expect(screen.getByTestId('program-guide-v-2')).toBeInTheDocument();
    expect(screen.getByTestId('program-guide-h-1')).toBeInTheDocument();
    expect(screen.getByTestId('program-guide-h-2')).toBeInTheDocument();
    expect(screen.getByTestId('toggle-safe-margins')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('toggle-composition-guides')).toHaveAttribute('aria-pressed', 'true');
  });

  it('changes playback render resolution from the preview quality menu', () => {
    useProjectStore.setState({
      activeSequenceId: 'seq-quality',
      sequences: new Map([['seq-quality', emptySequence]]),
      assets: new Map(),
      effects: new Map(),
    });

    render(<UnifiedPreviewPlayer />);

    expect(screen.getByTestId('timeline-preview-player')).toHaveAttribute('data-width', '1920');
    expect(screen.getByTestId('timeline-preview-player')).toHaveAttribute('data-height', '1080');

    fireEvent.click(screen.getByTestId('preview-quality-menu-button'));
    fireEvent.click(screen.getByTestId('preview-quality-half'));

    expect(usePreviewStore.getState().playbackQuality).toBe('half');
    expect(screen.getByTestId('unified-preview-player')).toHaveAttribute(
      'data-playback-quality',
      'half',
    );
    expect(screen.getByTestId('timeline-preview-player')).toHaveAttribute('data-width', '960');
    expect(screen.getByTestId('timeline-preview-player')).toHaveAttribute('data-height', '540');
  });

  it('changes media preference from the preview quality menu', () => {
    render(<UnifiedPreviewPlayer />);

    fireEvent.click(screen.getByTestId('preview-quality-menu-button'));
    fireEvent.click(screen.getByTestId('preview-media-renderCache'));

    expect(usePreviewStore.getState().mediaPreference).toBe('renderCache');
    expect(screen.getByTestId('unified-preview-player')).toHaveAttribute(
      'data-media-preference',
      'renderCache',
    );
  });

  it('renders transform overlay for a selected normal clip in canvas mode', () => {
    const clip: Clip = {
      id: 'clip-transform',
      assetId: 'asset-1',
      range: { sourceInSec: 0, sourceOutSec: 10 },
      place: { timelineInSec: 0, durationSec: 10 },
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
    };
    const sequence: Sequence = {
      ...emptySequence,
      id: 'seq-transform',
      tracks: [
        {
          id: 'track-1',
          name: 'V1',
          kind: 'video',
          clips: [clip],
          blendMode: 'normal',
          muted: false,
          locked: false,
          visible: true,
          volume: 1,
        },
      ],
    };
    const asset: Asset = {
      id: 'asset-1',
      kind: 'video',
      name: 'clip.mp4',
      uri: '/clip.mp4',
      hash: 'asset-1',
      fileSize: 10,
      importedAt: '2026-01-01T00:00:00.000Z',
      video: {
        width: 1920,
        height: 1080,
        fps: { num: 30, den: 1 },
        codec: 'h264',
        hasAlpha: false,
      },
      license: {
        source: 'user',
        licenseType: 'unknown',
        allowedUse: [],
      },
      tags: [],
      proxyStatus: 'notNeeded',
    };

    useProjectStore.setState({
      activeSequenceId: 'seq-transform',
      sequences: new Map([['seq-transform', sequence]]),
      assets: new Map([['asset-1', asset]]),
      effects: new Map(),
    });
    useTimelineStore.setState({ selectedClipIds: ['clip-transform'] });

    render(<UnifiedPreviewPlayer />);

    expect(screen.getByTestId('transform-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('transform-bounds')).toBeInTheDocument();
  });

  it('shows a degraded preview warning when audio sync drift is detected', () => {
    playbackControllerMock.syncState = {
      videoTime: 10,
      audioTime: 10.14,
      driftMs: 140,
      isSynced: false,
      lastCorrectionTime: 0,
    };

    render(<UnifiedPreviewPlayer />);

    expect(screen.getByTestId('preview-degraded-warning')).toHaveTextContent(
      'Audio sync drift 140 ms',
    );
  });

  it('renders object tracking data from the selected clip as a program overlay', () => {
    const clip: Clip = {
      id: 'clip-track',
      assetId: 'asset-1',
      range: { sourceInSec: 0, sourceOutSec: 10 },
      place: { timelineInSec: 0, durationSec: 10 },
      transform: {
        position: { x: 0.5, y: 0.5 },
        scale: { x: 1, y: 1 },
        rotationDeg: 0,
        anchor: { x: 0.5, y: 0.5 },
      },
      opacity: 1,
      speed: 1,
      effects: ['effect-track'],
      audio: { volumeDb: 0, pan: 0, muted: false },
    };
    const track: Track = {
      id: 'track-1',
      name: 'V1',
      kind: 'video',
      clips: [clip],
      blendMode: 'normal',
      muted: false,
      locked: false,
      visible: true,
      volume: 1,
    };
    const sequence: Sequence = {
      id: 'seq-1',
      name: 'Sequence 1',
      format: {
        canvas: { width: 1920, height: 1080 },
        fps: { num: 30, den: 1 },
        audioSampleRate: 48000,
        audioChannels: 2,
      },
      tracks: [track],
      markers: [],
    };
    const asset: Asset = {
      id: 'asset-1',
      kind: 'video',
      name: 'clip.mp4',
      uri: '/clip.mp4',
      hash: 'asset-1',
      fileSize: 10,
      importedAt: '2026-01-01T00:00:00.000Z',
      license: {
        source: 'user',
        licenseType: 'unknown',
        allowedUse: [],
      },
      tags: [],
      proxyStatus: 'notNeeded',
    };

    useProjectStore.setState({
      activeSequenceId: 'seq-1',
      sequences: new Map([['seq-1', sequence]]),
      assets: new Map([['asset-1', asset]]),
      effects: new Map([
        [
          'effect-track',
          {
            id: 'effect-track',
            effectType: 'object_tracking',
            enabled: true,
            order: 0,
            params: {
              tracking_data: JSON.stringify([
                { frame: 0, x: 0.2, y: 0.3, confidence: 0.9 },
                { frame: 30, x: 0.4, y: 0.5, confidence: 0.85 },
              ]),
            },
            keyframes: {},
          },
        ],
      ]),
    });
    useTimelineStore.setState({ selectedClipIds: ['clip-track'] });
    usePlaybackStore.setState({ currentTime: 0.5 });

    render(<UnifiedPreviewPlayer />);

    expect(screen.getByTestId('tracking-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('current-position')).toBeInTheDocument();
  });

  it('renders enabled masks from selected clip effects as a program overlay', () => {
    const clip: Clip = {
      id: 'clip-mask',
      assetId: 'asset-1',
      range: { sourceInSec: 0, sourceOutSec: 10 },
      place: { timelineInSec: 0, durationSec: 10 },
      transform: {
        position: { x: 0.5, y: 0.5 },
        scale: { x: 1, y: 1 },
        rotationDeg: 0,
        anchor: { x: 0.5, y: 0.5 },
      },
      opacity: 1,
      speed: 1,
      effects: ['effect-mask'],
      audio: { volumeDb: 0, pan: 0, muted: false },
    };
    const track: Track = {
      id: 'track-1',
      name: 'V1',
      kind: 'video',
      clips: [clip],
      blendMode: 'normal',
      muted: false,
      locked: false,
      visible: true,
      volume: 1,
    };
    const sequence: Sequence = {
      id: 'seq-1',
      name: 'Sequence 1',
      format: {
        canvas: { width: 1920, height: 1080 },
        fps: { num: 30, den: 1 },
        audioSampleRate: 48000,
        audioChannels: 2,
      },
      tracks: [track],
      markers: [],
    };
    const asset: Asset = {
      id: 'asset-1',
      kind: 'video',
      name: 'clip.mp4',
      uri: '/clip.mp4',
      hash: 'asset-1',
      fileSize: 10,
      importedAt: '2026-01-01T00:00:00.000Z',
      license: {
        source: 'user',
        licenseType: 'unknown',
        allowedUse: [],
      },
      tags: [],
      proxyStatus: 'notNeeded',
    };

    useProjectStore.setState({
      activeSequenceId: 'seq-1',
      sequences: new Map([['seq-1', sequence]]),
      assets: new Map([['asset-1', asset]]),
      effects: new Map([
        [
          'effect-mask',
          {
            id: 'effect-mask',
            effectType: 'gaussian_blur',
            enabled: true,
            order: 0,
            params: { radius: 12 },
            keyframes: {},
            masks: {
              masks: [
                {
                  id: 'mask-1',
                  name: 'Face mask',
                  shape: {
                    type: 'rectangle',
                    x: 0.5,
                    y: 0.5,
                    width: 0.25,
                    height: 0.3,
                    cornerRadius: 0,
                    rotation: 0,
                  },
                  inverted: false,
                  feather: 0.1,
                  opacity: 1,
                  expansion: 0,
                  blendMode: 'add',
                  enabled: true,
                  locked: false,
                },
              ],
            },
          },
        ],
      ]),
    });
    useTimelineStore.setState({ selectedClipIds: ['clip-mask'] });

    render(<UnifiedPreviewPlayer />);

    expect(screen.getByTestId('program-mask-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('program-mask-mask-1')).toBeInTheDocument();
  });
});
