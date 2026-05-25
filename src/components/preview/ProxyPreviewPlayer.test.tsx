import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { ProxyPreviewPlayer } from './ProxyPreviewPlayer';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import type { RenderGraph } from '@/bindings';
import type { Asset, Clip, Sequence, Track } from '@/types';

const runtimeMocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(() => false),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path: string) => path),
  invoke: vi.fn(),
}));

vi.mock('@/services/framePaths', () => ({
  isTauriRuntime: runtimeMocks.isTauriRuntime,
}));

const mockedInvoke = vi.mocked(invoke);

function createClip(id: string, assetId: string): Clip {
  return {
    id,
    assetId,
    label: id,
    place: { timelineInSec: 0, durationSec: 10 },
    range: { sourceInSec: 0, sourceOutSec: 10 },
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    },
    speed: 1,
    opacity: 1,
    effects: [],
    audio: { volumeDb: 0, pan: 0, muted: false },
  };
}

function createVideoTrack(id: string, clip: Clip): Track {
  return {
    id,
    name: id,
    kind: 'video',
    clips: [clip],
    blendMode: 'normal',
    muted: false,
    visible: true,
    locked: false,
    volume: 1,
  };
}

function createCaptionTrack(id: string, clip: Clip): Track {
  return {
    id,
    name: id,
    kind: 'caption',
    clips: [clip],
    blendMode: 'normal',
    muted: false,
    visible: true,
    locked: false,
    volume: 1,
  };
}

function createVideoAsset(id: string, uri: string): Asset {
  return {
    id,
    kind: 'video',
    name: `${id}.mp4`,
    uri,
    hash: id,
    fileSize: 100,
    importedAt: '2026-01-01T00:00:00.000Z',
    license: {
      source: 'user',
      licenseType: 'unknown',
      allowedUse: [],
    },
    tags: [],
    proxyStatus: 'notNeeded',
  };
}

function createSequence(): Sequence {
  const topClip = createClip('clip-top', 'asset-top');
  const bottomClip = createClip('clip-bottom', 'asset-bottom');

  return {
    id: 'sequence-1',
    name: 'Sequence 1',
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks: [createVideoTrack('track-top', topClip), createVideoTrack('track-bottom', bottomClip)],
    markers: [],
  };
}

describe('ProxyPreviewPlayer', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    runtimeMocks.isTauriRuntime.mockReturnValue(false);
    usePlaybackStore.getState().reset();
    usePlaybackStore.setState({
      currentTime: 2,
      duration: 20,
      isPlaying: false,
      syncWithTimeline: true,
      volume: 1,
      isMuted: false,
      playbackRate: 1,
    });
    useTimelineStore.setState({ selectedClipIds: [] });
    useProjectStore.setState({
      executeCommand: vi.fn().mockResolvedValue({
        opId: 'op-preview-test',
        changes: [],
        createdIds: [],
        deletedIds: [],
      }),
    });

    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = vi.fn();
    }
    if (!HTMLElement.prototype.releasePointerCapture) {
      HTMLElement.prototype.releasePointerCapture = vi.fn();
    }
    if (!HTMLElement.prototype.hasPointerCapture) {
      HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
    }
  });

  it('keeps media layers non-interactive so controls are not blocked', () => {
    const sequence = createSequence();
    const assets = new Map<string, Asset>([
      ['asset-top', createVideoAsset('asset-top', 'https://example.com/top.mp4')],
      ['asset-bottom', createVideoAsset('asset-bottom', 'https://example.com/bottom.mp4')],
    ]);

    render(<ProxyPreviewPlayer sequence={sequence} assets={assets} showControls />);

    expect(screen.getByTestId('proxy-video-layer')).toHaveClass('pointer-events-none');
    expect(screen.getByTestId('proxy-video-clip-top')).toHaveClass('pointer-events-none');
    expect(screen.getByTestId('proxy-video-clip-bottom')).toHaveClass('pointer-events-none');
  });

  it('renders controls above the highest video track layer', () => {
    const sequence = createSequence();
    const assets = new Map<string, Asset>([
      ['asset-top', createVideoAsset('asset-top', 'https://example.com/top.mp4')],
      ['asset-bottom', createVideoAsset('asset-bottom', 'https://example.com/bottom.mp4')],
    ]);

    render(<ProxyPreviewPlayer sequence={sequence} assets={assets} showControls />);

    const controlsLayer = screen.getByTestId('proxy-controls-layer');
    const topVideo = screen.getByTestId('proxy-video-clip-top');

    const controlsZ = Number((controlsLayer as HTMLElement).style.zIndex);
    const videoZ = Number((topVideo as HTMLElement).style.zIndex);

    expect(Number.isFinite(controlsZ)).toBe(true);
    expect(Number.isFinite(videoZ)).toBe(true);
    expect(controlsZ).toBeGreaterThan(videoZ);
  });

  it('does not render disabled clips in the preview stack', () => {
    const sequence = createSequence();
    sequence.tracks[0].clips[0].enabled = false;

    const assets = new Map<string, Asset>([
      ['asset-top', createVideoAsset('asset-top', 'https://example.com/top.mp4')],
      ['asset-bottom', createVideoAsset('asset-bottom', 'https://example.com/bottom.mp4')],
    ]);

    render(<ProxyPreviewPlayer sequence={sequence} assets={assets} showControls />);

    expect(screen.queryByTestId('proxy-video-clip-top')).not.toBeInTheDocument();
    expect(screen.getByTestId('proxy-video-clip-bottom')).toBeInTheDocument();
  });

  it('ignores a stale render graph from a different sequence and keeps raw-track fallback', async () => {
    runtimeMocks.isTauriRuntime.mockReturnValue(true);
    const sequence = createSequence();
    const staleGraph: RenderGraph = {
      graphVersion: 1,
      sequenceId: 'previous-sequence',
      format: sequence.format,
      durationSec: 10,
      durationFrames: 300,
      visualLayers: [
        {
          layerIndex: 0,
          trackId: 'previous-track',
          trackKind: 'video',
          trackIndex: 0,
          clipId: 'previous-clip',
          timelineInSec: 0,
          timelineOutSec: 10,
          timelineInFrame: 0,
          timelineOutFrame: 300,
          durationFrames: 300,
          sourceInSec: 0,
          sourceOutSec: 10,
          sourceInFrame: 0,
          sourceOutFrame: 300,
          transform: sequence.tracks[0].clips[0].transform,
          opacity: 1,
          blendMode: 'normal',
          effects: [],
          source: {
            type: 'media',
            assetId: 'asset-top',
          },
        },
      ],
      audioLayers: [],
    };
    mockedInvoke.mockImplementation(async (command) => {
      if (command === 'get_sequence_render_graph') {
        return staleGraph;
      }

      return [];
    });

    const assets = new Map<string, Asset>([
      ['asset-top', createVideoAsset('asset-top', 'https://example.com/top.mp4')],
      ['asset-bottom', createVideoAsset('asset-bottom', 'https://example.com/bottom.mp4')],
    ]);

    render(<ProxyPreviewPlayer sequence={sequence} assets={assets} showControls />);

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_sequence_render_graph', {
        sequenceId: sequence.id,
      });
    });

    expect(screen.getByTestId('proxy-video-clip-top')).toBeInTheDocument();
    expect(screen.getByTestId('proxy-video-clip-bottom')).toBeInTheDocument();
  });

  it('renders active text overlays from the sequence render graph', async () => {
    runtimeMocks.isTauriRuntime.mockReturnValue(true);
    const sequence = createSequence();
    const textClip = createClip('text-clip', '__text__title');
    sequence.tracks[0].clips.push(textClip);

    const renderGraph: RenderGraph = {
      graphVersion: 1,
      sequenceId: sequence.id,
      format: sequence.format,
      durationSec: 10,
      durationFrames: 300,
      visualLayers: [
        {
          layerIndex: 0,
          trackId: sequence.tracks[0].id,
          trackKind: 'video',
          trackIndex: 0,
          clipId: textClip.id,
          timelineInSec: 0,
          timelineOutSec: 10,
          timelineInFrame: 0,
          timelineOutFrame: 300,
          durationFrames: 300,
          sourceInSec: 0,
          sourceOutSec: 10,
          sourceInFrame: 0,
          sourceOutFrame: 300,
          transform: textClip.transform,
          opacity: 1,
          blendMode: 'normal',
          effects: [],
          source: {
            type: 'text',
            assetId: textClip.assetId,
            textData: null,
            renderSpec: {
              text: 'Graph title',
              style: {
                fontFamily: 'Inter',
                fontSizePx: 64,
                fontWeight: 650,
                bold: true,
                italic: false,
                underline: false,
                alignment: 'center',
                lineHeight: 1.2,
                letterSpacingPx: 2,
                fillColor: { r: 255, g: 10, b: 20, a: 255 },
                opacity: 0.8,
              },
              position: {
                xPercent: 25,
                yPercent: 75,
                anchorXPercent: 50,
                anchorYPercent: 50,
              },
              background: null,
              outline: null,
              shadow: null,
              rotationDeg: 0,
            },
          },
        },
      ],
      audioLayers: [],
    };

    mockedInvoke.mockImplementation(async (command) => {
      if (command === 'get_sequence_render_graph') {
        return renderGraph;
      }

      return [];
    });

    const assets = new Map<string, Asset>([
      ['asset-top', createVideoAsset('asset-top', 'https://example.com/top.mp4')],
      ['asset-bottom', createVideoAsset('asset-bottom', 'https://example.com/bottom.mp4')],
    ]);

    render(<ProxyPreviewPlayer sequence={sequence} assets={assets} showControls />);

    await waitFor(() => {
      expect(screen.getByTestId('proxy-text-overlay-text-clip')).toHaveTextContent('Graph title');
    });

    const overlay = screen.getByTestId('proxy-text-overlay-text-clip') as HTMLElement;
    expect(overlay.style.left).toBe('25%');
    expect(overlay.style.top).toBe('75%');
    expect(overlay.style.fontFamily).toBe('Inter');
    expect(overlay.style.fontSize).toBe('64px');
    expect(overlay.style.fontWeight).toBe('650');
    expect(overlay.style.letterSpacing).toBe('2px');
    expect(overlay.style.transform).toBe('translate(-50%, -50%) rotate(0deg)');
    expect(overlay.style.transformOrigin).toBe('center center');
    expect(overlay.style.opacity).toBe('0.8');
  });

  it('commits text placement from an inline preview input', async () => {
    const sequence = createSequence();
    const onTextPlacementCommit = vi.fn();
    const assets = new Map<string, Asset>([
      ['asset-top', createVideoAsset('asset-top', 'https://example.com/top.mp4')],
      ['asset-bottom', createVideoAsset('asset-bottom', 'https://example.com/bottom.mp4')],
    ]);

    render(
      <ProxyPreviewPlayer
        sequence={sequence}
        assets={assets}
        showControls
        textPlacementModeActive
        onTextPlacementCommit={onTextPlacementCommit}
      />,
    );

    const overlay = screen.getByTestId('text-placement-overlay');
    Object.defineProperty(overlay, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: 400,
        height: 300,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(overlay, { clientX: 200, clientY: 150, button: 0 });
    const input = screen.getByTestId('text-placement-input');
    fireEvent.change(input, { target: { value: 'Placed title' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(onTextPlacementCommit).toHaveBeenCalledWith({
        content: 'Placed title',
        position: { x: 0.5, y: 0.5 },
      });
    });
  });

  it('keeps the current text placement draft when the overlay is clicked again', () => {
    const sequence = createSequence();
    const assets = new Map<string, Asset>([
      ['asset-top', createVideoAsset('asset-top', 'https://example.com/top.mp4')],
      ['asset-bottom', createVideoAsset('asset-bottom', 'https://example.com/bottom.mp4')],
    ]);

    render(
      <ProxyPreviewPlayer
        sequence={sequence}
        assets={assets}
        showControls
        textPlacementModeActive
        onTextPlacementCommit={vi.fn()}
      />,
    );

    const overlay = screen.getByTestId('text-placement-overlay');
    Object.defineProperty(overlay, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: 400,
        height: 300,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(overlay, { clientX: 200, clientY: 150, button: 0 });
    const input = screen.getByTestId('text-placement-input');
    fireEvent.change(input, { target: { value: 'Draft title' } });

    fireEvent.pointerDown(overlay, { clientX: 20, clientY: 20, button: 0 });

    expect(screen.getByTestId('text-placement-input')).toHaveValue('Draft title');
  });

  it('does not commit text placement while IME composition is active', async () => {
    const sequence = createSequence();
    const onTextPlacementCommit = vi.fn();
    const assets = new Map<string, Asset>([
      ['asset-top', createVideoAsset('asset-top', 'https://example.com/top.mp4')],
      ['asset-bottom', createVideoAsset('asset-bottom', 'https://example.com/bottom.mp4')],
    ]);

    render(
      <ProxyPreviewPlayer
        sequence={sequence}
        assets={assets}
        showControls
        textPlacementModeActive
        onTextPlacementCommit={onTextPlacementCommit}
      />,
    );

    const overlay = screen.getByTestId('text-placement-overlay');
    Object.defineProperty(overlay, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: 400,
        height: 300,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(overlay, { clientX: 200, clientY: 150, button: 0 });
    const input = screen.getByTestId('text-placement-input');
    fireEvent.change(input, { target: { value: 'Composing title' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(onTextPlacementCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId('text-placement-input')).toHaveValue('Composing title');

    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(onTextPlacementCommit).toHaveBeenCalledWith({
        content: 'Composing title',
        position: { x: 0.5, y: 0.5 },
      });
    });
  });

  it('commits caption preview drag as a single UpdateCaption on pointer up', async () => {
    const captionClip = createClip('caption-clip', 'caption-asset');
    captionClip.label = 'Caption line';
    captionClip.captionPosition = {
      type: 'preset',
      vertical: 'bottom',
      marginPercent: 5,
    };
    const sequence = {
      ...createSequence(),
      tracks: [createCaptionTrack('caption-track', captionClip)],
    };
    const executeCommand = vi.fn().mockResolvedValue({
      opId: 'op-caption-position',
      changes: [],
      createdIds: [],
      deletedIds: [],
    });
    useProjectStore.setState({ executeCommand });
    useTimelineStore.setState({ selectedClipIds: [captionClip.id] });

    render(<ProxyPreviewPlayer sequence={sequence} assets={new Map()} showControls />);

    const player = screen.getByTestId('proxy-preview-player');
    Object.defineProperty(player, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: 400,
        height: 300,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    const caption = screen.getByTestId(`proxy-caption-${captionClip.id}`);
    fireEvent.pointerDown(caption, { clientX: 200, clientY: 285, pointerId: 1 });
    fireEvent.pointerMove(caption, { clientX: 280, clientY: 150, pointerId: 1 });

    expect(executeCommand).not.toHaveBeenCalled();

    fireEvent.pointerUp(caption, { clientX: 280, clientY: 150, pointerId: 1 });

    await waitFor(() => {
      expect(executeCommand).toHaveBeenCalledTimes(1);
    });
    expect(executeCommand).toHaveBeenCalledWith({
      type: 'UpdateCaption',
      payload: {
        sequenceId: sequence.id,
        trackId: 'caption-track',
        captionId: captionClip.id,
        position: {
          type: 'custom',
          xPercent: 70,
          yPercent: 50,
        },
      },
    });
  });
});
