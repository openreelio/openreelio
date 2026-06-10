import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TimelineIndexPanel } from './TimelineIndexPanel';
import { usePlaybackStore, useProjectStore, useTimelineStore } from '@/stores';
import type { Asset, Clip, Effect, Sequence } from '@/types';

function createClip(overrides: Partial<Clip>): Clip {
  return {
    id: 'clip',
    assetId: 'asset',
    range: { sourceInSec: 0, sourceOutSec: 1 },
    place: { timelineInSec: 0, durationSec: 1 },
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    },
    opacity: 1,
    blendMode: 'normal',
    speed: 1,
    effects: [],
    audio: { volumeDb: 0, pan: 0, muted: false },
    ...overrides,
  };
}

function createAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    name: 'Interview.mov',
    kind: 'video',
    uri: '/media/interview.mov',
    durationSec: 10,
    hash: 'hash-1',
    fileSize: 1000,
    importedAt: '2026-01-01T00:00:00Z',
    license: {
      source: 'user',
      licenseType: 'unknown',
      allowedUse: [],
    },
    tags: [],
    proxyStatus: 'notNeeded',
    ...overrides,
  };
}

function createSequence(): Sequence {
  return {
    id: 'seq-1',
    name: 'Main',
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    markers: [
      {
        id: 'marker-1',
        timeSec: 3,
        label: 'Act break',
        markerType: 'chapter',
        color: { r: 255, g: 255, b: 0, a: 255 },
      },
    ],
    tracks: [
      {
        id: 'video-1',
        name: 'V1',
        kind: 'video',
        muted: false,
        locked: false,
        visible: true,
        volume: 1,
        blendMode: 'normal',
        clips: [
          createClip({
            id: 'clip-1',
            assetId: 'asset-1',
            range: { sourceInSec: 0, sourceOutSec: 4 },
            place: { timelineInSec: 1, durationSec: 4 },
            effects: ['effect-1'],
          }),
          createClip({
            id: 'clip-missing',
            assetId: 'missing-asset',
            range: { sourceInSec: 0, sourceOutSec: 2 },
            place: { timelineInSec: 8, durationSec: 2 },
            effects: [],
            enabled: false,
          }),
        ],
      },
      {
        id: 'caption-1',
        name: 'C1',
        kind: 'caption',
        muted: false,
        locked: false,
        visible: true,
        volume: 1,
        blendMode: 'normal',
        clips: [
          createClip({
            id: 'caption-clip',
            assetId: 'caption',
            label: 'Hello caption',
            range: { sourceInSec: 0, sourceOutSec: 2 },
            place: { timelineInSec: 5, durationSec: 2 },
            effects: [],
          }),
        ],
      },
    ],
  };
}

describe('TimelineIndexPanel', () => {
  beforeEach(() => {
    useProjectStore.setState({
      assets: new Map([
        [
          'asset-1',
          createAsset(),
        ],
      ]),
      effects: new Map([
        [
          'effect-1',
          {
            id: 'effect-1',
            effectType: 'brightness',
            enabled: true,
            params: {},
            keyframes: {},
            order: 0,
          } satisfies Effect,
        ],
      ]),
    });
  });

  it('lists clips, markers, captions, effects, missing assets, and disabled clips', () => {
    render(<TimelineIndexPanel sequence={createSequence()} />);

    expect(screen.getByText('Interview.mov')).toBeInTheDocument();
    expect(screen.getByText('Act break')).toBeInTheDocument();
    expect(screen.getByText('Hello caption')).toBeInTheDocument();
    expect(screen.getByText('Brightness')).toBeInTheDocument();
    expect(screen.getAllByText('Missing')).toHaveLength(1);
    expect(screen.getAllByText('Disabled')).toHaveLength(1);
  });

  it('filters by query', () => {
    render(<TimelineIndexPanel sequence={createSequence()} />);

    fireEvent.change(screen.getByLabelText('Search timeline index'), {
      target: { value: 'caption' },
    });

    expect(screen.getByText('Hello caption')).toBeInTheDocument();
    expect(screen.queryByText('Interview.mov')).not.toBeInTheDocument();
  });

  it('seeks and selects clips from index rows', () => {
    const seek = vi.fn();
    const selectClip = vi.fn();
    usePlaybackStore.setState({ seek });
    useTimelineStore.setState({ selectClip });

    render(<TimelineIndexPanel sequence={createSequence()} />);

    fireEvent.click(screen.getByText('Brightness'));

    expect(seek).toHaveBeenCalledWith(1, 'timeline-index');
    expect(selectClip).toHaveBeenCalledWith('clip-1');
  });
});
