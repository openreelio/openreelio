import { describe, it, expect, vi } from 'vitest';
import type { Sequence, Track } from '@/types';
import { resolveTrackDropTarget } from './trackDropTarget';

function createTrack(id: string): Track {
  return {
    id,
    kind: 'video',
    name: id,
    clips: [],
    blendMode: 'normal',
    muted: false,
    locked: false,
    visible: true,
    volume: 1,
  };
}

function createSequence(trackCount = 3): Sequence {
  return {
    id: 'seq-1',
    name: 'Test',
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks: Array.from({ length: trackCount }, (_, index) => createTrack(`track-${index}`)),
    markers: [],
  };
}

function mockRect(top: number, height: number, left = 0, width = 800): DOMRect {
  return {
    x: left,
    y: top,
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function createContainer(top = 100, height = 300): HTMLElement {
  const container = document.createElement('div');
  container.getBoundingClientRect = vi.fn().mockReturnValue(mockRect(top, height));
  return container;
}

function appendTrackRow(
  container: HTMLElement,
  trackId: string,
  top: number,
  height: number,
): HTMLElement {
  const row = document.createElement('div');
  row.dataset.trackRow = 'true';
  row.dataset.trackId = trackId;
  row.getBoundingClientRect = vi.fn().mockReturnValue(mockRect(top, height));
  container.appendChild(row);
  return row;
}

describe('resolveTrackDropTarget', () => {
  it('uses DOM row hit-testing when track rows are available', () => {
    const sequence = createSequence(2);
    const container = createContainer(0, 200);
    appendTrackRow(container, 'track-0', 0, 48);
    appendTrackRow(container, 'track-1', 48, 64);

    const result = resolveTrackDropTarget({
      sequence,
      container,
      clientY: 52,
      fallbackTrackHeight: 64,
      scrollY: 0,
    });

    expect(result?.track.id).toBe('track-1');
    expect(result?.trackIndex).toBe(1);
  });

  it('clamps to first/last DOM row when pointer is outside track bounds', () => {
    const sequence = createSequence(3);
    const container = createContainer(0, 300);
    appendTrackRow(container, 'track-0', 10, 64);
    appendTrackRow(container, 'track-1', 74, 64);
    appendTrackRow(container, 'track-2', 138, 64);

    const above = resolveTrackDropTarget({
      sequence,
      container,
      clientY: -20,
      fallbackTrackHeight: 64,
      scrollY: 0,
    });

    const below = resolveTrackDropTarget({
      sequence,
      container,
      clientY: 500,
      fallbackTrackHeight: 64,
      scrollY: 0,
    });

    expect(above?.track.id).toBe('track-0');
    expect(below?.track.id).toBe('track-2');
  });

  it('falls back to index math when DOM rows are unavailable', () => {
    const sequence = createSequence(3);
    const container = createContainer(100, 300);

    const result = resolveTrackDropTarget({
      sequence,
      container,
      clientY: 180,
      fallbackTrackHeight: 64,
      scrollY: 64,
    });

    // relativeY = 180 - 100 + 64 = 144 -> floor(144 / 64) = 2
    expect(result?.track.id).toBe('track-2');
    expect(result?.trackIndex).toBe(2);
  });

  it('returns null when no fallback is provided and no valid rows exist', () => {
    const sequence = createSequence(2);
    const container = createContainer(0, 200);

    const invalidRow = document.createElement('div');
    invalidRow.dataset.trackRow = 'true';
    invalidRow.dataset.trackId = 'unknown-track';
    invalidRow.getBoundingClientRect = vi.fn().mockReturnValue(mockRect(0, 64));
    container.appendChild(invalidRow);

    const result = resolveTrackDropTarget({
      sequence,
      container,
      clientY: 20,
    });

    expect(result).toBeNull();
  });
});
