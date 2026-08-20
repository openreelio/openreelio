/**
 * MoveableTransformOverlay Gesture Tests
 *
 * react-moveable is an external boundary, so it is mocked at the facade and the
 * gesture callbacks are driven directly. jsdom has no layout, so the real
 * library cannot produce a meaningful matrix here; the payloads it emits are
 * replayed instead and the assertions cover what this component owns:
 *
 * - exactly one `SetClipTransform` per gesture, on the *End callback only
 * - the committed transform is the one `previewCoords` derives from the rect
 * - position clamping, scale clamping, non-uniform vs uniform resize config
 * - rotation snapping only while Shift is held
 * - no command when the viewport is unmeasured or nothing moved
 * - the box is restored when the command is rejected
 *
 * Everything else runs for real: the project / timeline / playback stores are
 * driven through `setState`, and the text clip payloads arrive through the real
 * `useSequenceTextClipData` hook over the globally mocked Tauri IPC boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import type { Sequence, Clip, Track, Asset, TextClipData, Transform } from '@/types';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import {
  clipBoundsFromTransform,
  MAX_TRANSFORM_SCALE,
  MIN_TRANSFORM_SCALE,
  type PreviewSource,
  type PreviewViewport,
} from '@/utils/previewCoords';
import { RENDER_DIRECTIONS } from './transformOverlayHandles';

interface MoveableCallbacks {
  draggable: boolean;
  resizable: boolean;
  rotatable: boolean;
  keepRatio: boolean;
  origin: boolean;
  throttleRotate: number;
  renderDirections: string[];
  transformOrigin: string;
  onDragStart: () => boolean;
  onDrag: (event: { beforeTranslate: number[] }) => void;
  onDragEnd: () => void;
  onResizeStart: () => boolean;
  onResize: (event: {
    direction: number[];
    width: number;
    height: number;
    drag: { beforeTranslate: number[] };
  }) => void;
  onResizeEnd: () => void;
  onRotateStart: () => boolean;
  onRotate: (event: { beforeRotate: number }) => void;
  onRotateEnd: () => void;
}

let lastMoveableProps: MoveableCallbacks | null = null;

vi.mock('react-moveable', async () => {
  const react = await import('react');

  return {
    default: react.forwardRef(function MoveableMock(
      props: Record<string, unknown>,
      ref: React.Ref<unknown>,
    ) {
      lastMoveableProps = props as unknown as MoveableCallbacks;
      react.useImperativeHandle(ref, () => ({
        updateRect: () => undefined,
        getControlBoxElement: () => null,
      }));
      return react.createElement('div', { 'data-testid': 'moveable-mock' });
    }),
  };
});

// Imported after the moveable mock so the component picks up the stub.
const { MoveableTransformOverlay } = await import('./MoveableTransformOverlay');

// =============================================================================
// Fixtures
// =============================================================================

const CANVAS = { width: 1920, height: 1080 };

const defaultProps = {
  canvasWidth: CANVAS.width,
  canvasHeight: CANVAS.height,
  containerWidth: 960,
  containerHeight: 540,
  displayScale: 0.5,
  panX: 0,
  panY: 0,
};

const viewport: PreviewViewport = { ...defaultProps };
const videoSource: PreviewSource = { width: 1920, height: 1080 };

const realExecuteCommand = useProjectStore.getState().executeCommand;
const mockExecuteCommand = vi.fn();

function identityTransform(): Transform {
  return {
    position: { x: 0.5, y: 0.5 },
    scale: { x: 1, y: 1 },
    rotationDeg: 0,
    anchor: { x: 0.5, y: 0.5 },
  };
}

function makeSequence(): Sequence {
  const clip: Clip = {
    id: 'clip-1',
    assetId: 'asset-1',
    range: { sourceInSec: 0, sourceOutSec: 10 },
    place: { timelineInSec: 0, durationSec: 10 },
    transform: identityTransform(),
    opacity: 1,
    speed: 1,
    effects: [],
    audio: { volumeDb: 0, pan: 0, muted: false },
    label: 'Test Clip',
  };

  const track: Track = {
    id: 'track-1',
    name: 'V1',
    kind: 'video',
    blendMode: 'normal',
    muted: false,
    locked: false,
    visible: true,
    volume: 1,
    clips: [clip],
  };

  return {
    id: 'seq-1',
    name: 'Sequence 1',
    format: {
      canvas: { width: CANVAS.width, height: CANVAS.height },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks: [track],
    markers: [],
  };
}

function makeTextClipData(alignment: 'left' | 'center' | 'right'): TextClipData {
  return {
    content: 'Anchored title',
    style: {
      fontFamily: 'Arial',
      fontSize: 48,
      fontWeight: 400,
      color: '#FFFFFF',
      backgroundPadding: 0,
      alignment,
      bold: false,
      italic: false,
      underline: false,
      lineHeight: 1.2,
      letterSpacing: 0,
    },
    position: { x: 0.25, y: 0.5 },
    rotation: 0,
    opacity: 1,
  };
}

/**
 * Builds a text-clip sequence and arms the Tauri IPC boundary with the payload
 * the real `useSequenceTextClipData` hook fetches for it.
 */
function makeTextSequence(alignment: 'left' | 'center' | 'right'): Sequence {
  const sequence = makeSequence();
  const clip = sequence.tracks[0].clips[0];
  clip.assetId = '__text__clip-1';
  clip.label = 'Text: Anchored title';

  vi.mocked(invoke).mockResolvedValue([
    {
      sequenceId: sequence.id,
      trackId: 'track-1',
      clipId: clip.id,
      textData: makeTextClipData(alignment),
    },
  ]);

  return sequence;
}

function makeAssets(): Map<string, Asset> {
  return new Map<string, Asset>([
    [
      'asset-1',
      {
        id: 'asset-1',
        kind: 'video',
        name: 'clip.mp4',
        uri: 'file:///clip.mp4',
        hash: 'abc123',
        fileSize: 1000000,
        importedAt: '2026-01-01T00:00:00Z',
        video: {
          width: 1920,
          height: 1080,
          fps: { num: 30, den: 1 },
          codec: 'h264',
          hasAlpha: false,
        },
        license: { source: 'user', licenseType: 'unknown', allowedUse: [] },
        tags: [],
        proxyStatus: 'notNeeded',
      },
    ],
  ]);
}

function moveable(): MoveableCallbacks {
  if (!lastMoveableProps) {
    throw new Error('Moveable was not rendered.');
  }
  return lastMoveableProps;
}

function committedTransform(): Transform {
  expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
  return mockExecuteCommand.mock.calls[0][0].payload.transform as Transform;
}

/** Screen rectangle the overlay starts from for an identity full-frame clip. */
function startBounds() {
  return clipBoundsFromTransform(identityTransform(), videoSource, viewport);
}

/** The inline transform the overlay box currently draws. */
function boxTransformStyle(): string {
  return screen.getByTestId('transform-bounds').style.transform;
}

function renderOverlay(sequence: Sequence = makeSequence()) {
  return render(
    <MoveableTransformOverlay sequence={sequence} assets={makeAssets()} {...defaultProps} />,
  );
}

// =============================================================================
// Tests
// =============================================================================

describe('MoveableTransformOverlay', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
    mockExecuteCommand.mockResolvedValue({ ok: true });
    lastMoveableProps = null;

    useProjectStore.setState({ executeCommand: mockExecuteCommand });
    useTimelineStore.setState({ selectedClipIds: ['clip-1'] });
    usePlaybackStore.setState({ currentTime: 0 });

    // The real text-clip hook only fetches inside the Tauri runtime.
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    // Unmount before restoring the stores: a store write while the overlay is
    // still mounted is an un-acted React update.
    cleanup();
    act(() => {
      useProjectStore.setState({ executeCommand: realExecuteCommand });
      useTimelineStore.setState({ selectedClipIds: [] });
    });
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  describe('selection gating', () => {
    it.each([
      ['no clip is selected', [] as string[]],
      ['multiple clips are selected', ['clip-1', 'clip-2']],
      ['the selected clip is missing', ['ghost-clip']],
    ])('should render nothing when %s', (_label, selection) => {
      useTimelineStore.setState({ selectedClipIds: selection });

      renderOverlay();

      expect(screen.queryByTestId('transform-overlay')).not.toBeInTheDocument();
    });

    it('should render nothing when the sequence is null', () => {
      render(
        <MoveableTransformOverlay sequence={null} assets={makeAssets()} {...defaultProps} />,
      );

      expect(screen.queryByTestId('transform-overlay')).not.toBeInTheDocument();
    });
  });

  describe('moveable configuration', () => {
    it('should enable drag, resize and rotate with the 8 resize directions', () => {
      renderOverlay();

      const props = moveable();
      expect(props.draggable).toBe(true);
      expect(props.resizable).toBe(true);
      expect(props.rotatable).toBe(true);
      expect(props.origin).toBe(false);
      expect(props.renderDirections).toEqual([...RENDER_DIRECTIONS]);
    });

    it('should rotate about the anchor rather than the box center', () => {
      const sequence = makeSequence();
      sequence.tracks[0].clips[0].transform = {
        ...identityTransform(),
        anchor: { x: 0, y: 1 },
      };

      renderOverlay(sequence);

      expect(moveable().transformOrigin).toBe('0% 100%');
    });

    it('should allow non-uniform resizing for a video clip', () => {
      renderOverlay();

      expect(moveable().keepRatio).toBe(false);
    });

    it('should force uniform resizing for a text clip', async () => {
      renderOverlay(makeTextSequence('right'));

      expect(moveable().keepRatio).toBe(true);
      // Settle the text payload the real hook fetches so the assertion also
      // holds once the resolved alignment has been applied.
      await waitFor(() => expect(moveable().transformOrigin).toBe('100% 50%'));
      expect(moveable().keepRatio).toBe(true);
    });

    it('should disable editing for a clip driven by motion keyframes', () => {
      const sequence = makeSequence();
      sequence.tracks[0].clips[0].motionKeyframes = [
        { timeOffset: 0, interpolation: 'linear', transform: identityTransform() },
      ];

      renderOverlay(sequence);

      const props = moveable();
      expect(props.draggable).toBe(false);
      expect(props.resizable).toBe(false);
      expect(props.rotatable).toBe(false);

      expect(props.onDragStart()).toBe(false);
      props.onDrag({ beforeTranslate: [200, 100] });
      props.onDragEnd();

      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });

    it('should stay editable when every motion keyframe is invalid', () => {
      const sequence = makeSequence();
      // The motion sampler discards non-finite / negative offsets, so these
      // keyframes drive nothing and must not lock the overlay.
      sequence.tracks[0].clips[0].motionKeyframes = [
        { timeOffset: Number.NaN, interpolation: 'linear', transform: identityTransform() },
        { timeOffset: -2, interpolation: 'linear', transform: identityTransform() },
      ];

      renderOverlay(sequence);

      const props = moveable();
      expect(props.draggable).toBe(true);
      expect(props.onDragStart()).toBe(true);

      const bounds = startBounds();
      props.onDrag({ beforeTranslate: [bounds.left + 96, bounds.top] });
      props.onDragEnd();

      expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
    });
  });

  describe('rotation snapping', () => {
    it('should rotate freely when Shift is not held', () => {
      renderOverlay();

      expect(moveable().throttleRotate).toBe(0);
    });

    it('should snap to 15 degree steps while Shift is held', () => {
      renderOverlay();

      fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
      expect(moveable().throttleRotate).toBe(15);

      fireEvent.keyUp(window, { key: 'Shift', shiftKey: false });
      expect(moveable().throttleRotate).toBe(0);
    });

    it('should force uniform resizing while Shift is held', () => {
      renderOverlay();

      expect(moveable().keepRatio).toBe(false);
      fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
      expect(moveable().keepRatio).toBe(true);
    });
  });

  describe('drag gesture', () => {
    beforeEach(() => {
      renderOverlay();
    });

    it('should commit exactly one SetClipTransform, and only on drag end', () => {
      const bounds = startBounds();
      const props = moveable();

      expect(props.onDragStart()).toBe(true);
      props.onDrag({ beforeTranslate: [bounds.left + 48, bounds.top + 24] });
      props.onDrag({ beforeTranslate: [bounds.left + 96, bounds.top + 48] });

      expect(mockExecuteCommand).not.toHaveBeenCalled();

      props.onDragEnd();

      expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
      expect(mockExecuteCommand).toHaveBeenCalledWith({
        type: 'SetClipTransform',
        payload: {
          sequenceId: 'seq-1',
          trackId: 'track-1',
          clipId: 'clip-1',
          transform: expect.any(Object),
        },
      });
    });

    it('should map the screen delta to normalized canvas position', () => {
      const bounds = startBounds();
      const props = moveable();

      props.onDragStart();
      // 96 screen px at displayScale 0.5 = 192 canvas px = 0.1 of a 1920 canvas;
      // 27 screen px = 54 canvas px = 0.05 of a 1080 canvas.
      props.onDrag({ beforeTranslate: [bounds.left + 96, bounds.top + 27] });
      props.onDragEnd();

      const transform = committedTransform();
      expect(transform.position.x).toBeCloseTo(0.6);
      expect(transform.position.y).toBeCloseTo(0.55);
      expect(transform.scale).toEqual({ x: 1, y: 1 });
    });

    it('should clamp the committed position to the 0-1 range', () => {
      const props = moveable();

      props.onDragStart();
      props.onDrag({ beforeTranslate: [100000, -100000] });
      props.onDragEnd();

      const transform = committedTransform();
      expect(transform.position.x).toBe(1);
      expect(transform.position.y).toBe(0);
    });

    it('should not commit when the gesture never moved', () => {
      const props = moveable();

      props.onDragStart();
      props.onDragEnd();

      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });
  });

  describe('scale is owned by resize alone', () => {
    it('should carry a tiny scale through a drag untouched', () => {
      const sequence = makeSequence();
      sequence.tracks[0].clips[0].transform = {
        ...identityTransform(),
        scale: { x: 0.02, y: 0.02 },
      };

      renderOverlay(sequence);
      const bounds = clipBoundsFromTransform(
        sequence.tracks[0].clips[0].transform,
        videoSource,
        viewport,
      );

      const props = moveable();
      props.onDragStart();
      props.onDrag({ beforeTranslate: [bounds.left + 96, bounds.top + 27] });
      props.onDragEnd();

      const transform = committedTransform();
      expect(transform.scale).toEqual({ x: 0.02, y: 0.02 });
      expect(transform.position.x).toBeCloseTo(0.6);
    });

    it('should carry scale through a rotation untouched', () => {
      const sequence = makeSequence();
      sequence.tracks[0].clips[0].transform = {
        ...identityTransform(),
        scale: { x: 0.02, y: 1.75 },
      };

      renderOverlay(sequence);

      const props = moveable();
      props.onRotateStart();
      props.onRotate({ beforeRotate: 33 });
      props.onRotateEnd();

      const transform = committedTransform();
      expect(transform.scale).toEqual({ x: 0.02, y: 1.75 });
      expect(transform.rotationDeg).toBe(33);
    });
  });

  describe('resize gesture', () => {
    beforeEach(() => {
      renderOverlay();
    });

    it('should scale only the X axis for an east-edge resize', () => {
      const bounds = startBounds();
      const props = moveable();

      props.onResizeStart();
      // moveable pins the west edge for an east drag: the box grows, left stays.
      props.onResize({
        direction: [1, 0],
        width: bounds.width + 96,
        height: bounds.height,
        drag: { beforeTranslate: [bounds.left, bounds.top] },
      });
      props.onResizeEnd();

      const transform = committedTransform();
      // 96 screen px at displayScale 0.5 grows a 1920 px wide source by 10%.
      expect(transform.scale.x).toBeCloseTo(1.1);
      expect(transform.scale.y).toBe(1);
    });

    it('should move the center-anchored position so the opposite edge stays pinned', () => {
      const bounds = startBounds();
      const props = moveable();

      props.onResizeStart();
      props.onResize({
        direction: [1, 0],
        width: bounds.width + 96,
        height: bounds.height,
        drag: { beforeTranslate: [bounds.left, bounds.top] },
      });
      props.onResizeEnd();

      const transform = committedTransform();
      expect(transform.position.x).toBeGreaterThan(0.5);
      expect(transform.position.y).toBeCloseTo(0.5);
    });

    it('should ignore the untouched axis moveable reports for an edge resize', () => {
      const bounds = startBounds();
      const props = moveable();

      props.onResizeStart();
      // moveable rounds both axes to CSS pixels even when only one is dragged.
      props.onResize({
        direction: [1, 0],
        width: bounds.width + 96,
        height: bounds.height + 0.5,
        drag: { beforeTranslate: [bounds.left, bounds.top] },
      });
      props.onResizeEnd();

      expect(committedTransform().scale.y).toBe(1);
    });

    it('should scale both axes for a corner resize', () => {
      const bounds = startBounds();
      const props = moveable();

      props.onResizeStart();
      props.onResize({
        direction: [1, 1],
        width: bounds.width + 96,
        height: bounds.height + 54,
        drag: { beforeTranslate: [bounds.left, bounds.top] },
      });
      props.onResizeEnd();

      const transform = committedTransform();
      expect(transform.scale.x).toBeGreaterThan(1);
      expect(transform.scale.y).toBeGreaterThan(1);
    });

    it('should clamp a collapsed resize to the backend minimum scale', () => {
      const bounds = startBounds();
      const props = moveable();

      props.onResizeStart();
      props.onResize({
        direction: [1, 1],
        width: 0,
        height: 0,
        drag: { beforeTranslate: [bounds.left, bounds.top] },
      });
      props.onResizeEnd();

      const transform = committedTransform();
      expect(transform.scale.x).toBe(MIN_TRANSFORM_SCALE);
      expect(transform.scale.y).toBe(MIN_TRANSFORM_SCALE);
    });

    it('should clamp a runaway resize to the backend maximum scale', () => {
      const bounds = startBounds();
      const props = moveable();

      props.onResizeStart();
      props.onResize({
        direction: [1, 1],
        width: bounds.width * 500,
        height: bounds.height * 500,
        drag: { beforeTranslate: [bounds.left, bounds.top] },
      });
      props.onResizeEnd();

      const transform = committedTransform();
      expect(transform.scale.x).toBe(MAX_TRANSFORM_SCALE);
      expect(transform.scale.y).toBe(MAX_TRANSFORM_SCALE);
    });
  });

  describe('text clip anchoring', () => {
    it('should keep a left-aligned text anchor fixed while the right edge grows', async () => {
      renderOverlay(makeTextSequence('left'));

      // The anchor follows the alignment once the payload resolves.
      await waitFor(() => expect(moveable().transformOrigin).toBe('0% 50%'));

      const boxElement = screen.getByTestId('transform-bounds');
      const startWidth = Number.parseFloat(boxElement.style.width);
      const [startLeft, startTop] = boxElement.style.transform
        .match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/)!
        .slice(1)
        .map(Number);

      const startHeight = Number.parseFloat(boxElement.style.height);
      const ratio = (startWidth + 60) / startWidth;

      const props = moveable();
      expect(props.keepRatio).toBe(true);
      props.onResizeStart();
      // keepRatio is on for text, so moveable scales both axes together and
      // keeps the west edge midpoint fixed for an east handle.
      props.onResize({
        direction: [1, 0],
        width: startWidth + 60,
        height: startHeight * ratio,
        drag: {
          beforeTranslate: [startLeft, startTop - (startHeight * ratio - startHeight) / 2],
        },
      });
      props.onResizeEnd();

      const transform = committedTransform();
      expect(transform.anchor).toEqual({ x: 0, y: 0.5 });
      expect(transform.position.x).toBeCloseTo(0.25);
      expect(transform.position.y).toBeCloseTo(0.5);
      expect(transform.scale.x).toBeGreaterThan(1);
      expect(transform.scale.y).toBeCloseTo(transform.scale.x, 6);
    });

    it('should stay exactly proportional when moveable rounds a uniform resize', async () => {
      renderOverlay(makeTextSequence('center'));
      await waitFor(() => expect(moveable().keepRatio).toBe(true));

      const boxElement = screen.getByTestId('transform-bounds');
      const startWidth = Number.parseFloat(boxElement.style.width);
      const startHeight = Number.parseFloat(boxElement.style.height);
      const startRatio = startWidth / startHeight;

      const props = moveable();
      props.onResizeStart();

      // Replay a sequence of moveable payloads whose height is rounded to whole
      // CSS pixels: the drifting axis must be re-derived, not adopted.
      for (const grow of [17, 41, 96]) {
        const width = startWidth + grow;
        props.onResize({
          direction: [1, 1],
          width,
          height: Math.round(width / startRatio),
          drag: { beforeTranslate: [0, 0] },
        });

        const ratio =
          Number.parseFloat(boxElement.style.width) /
          Number.parseFloat(boxElement.style.height);
        expect(ratio).toBeCloseTo(startRatio, 12);
      }

      props.onResizeEnd();

      const transform = committedTransform();
      expect(transform.scale.x / transform.scale.y).toBeCloseTo(1, 12);
    });
  });

  describe('rotate gesture', () => {
    it('should commit the rotation reported by moveable', () => {
      renderOverlay();

      const props = moveable();
      props.onRotateStart();
      props.onRotate({ beforeRotate: 45 });
      props.onRotateEnd();

      const transform = committedTransform();
      expect(transform.rotationDeg).toBe(45);
      expect(transform.position.x).toBeCloseTo(0.5);
      expect(transform.scale).toEqual({ x: 1, y: 1 });
    });
  });

  describe('rejected command', () => {
    it('should restore the pre-gesture box when the command fails', async () => {
      mockExecuteCommand.mockRejectedValue(new Error('Clip not found'));

      renderOverlay();
      const committedBox = boxTransformStyle();

      const bounds = startBounds();
      const props = moveable();
      props.onDragStart();
      props.onDrag({ beforeTranslate: [bounds.left + 240, bounds.top + 120] });
      props.onDragEnd();

      // The gesture leaves the box at the position it dragged to...
      expect(boxTransformStyle()).not.toBe(committedBox);

      // ...until the rejection lands, which snaps it back to the stored state.
      await waitFor(() => expect(boxTransformStyle()).toBe(committedBox));
    });

    it('should keep the box where the gesture left it when the command succeeds', async () => {
      renderOverlay();
      const committedBox = boxTransformStyle();

      const bounds = startBounds();
      const props = moveable();
      props.onDragStart();
      props.onDrag({ beforeTranslate: [bounds.left + 240, bounds.top + 120] });
      props.onDragEnd();

      const draggedBox = boxTransformStyle();
      expect(draggedBox).not.toBe(committedBox);

      await Promise.resolve();
      expect(boxTransformStyle()).toBe(draggedBox);
    });
  });

  describe('unmeasured viewport', () => {
    it('should refuse to start a gesture and never commit when displayScale is zero', () => {
      render(
        <MoveableTransformOverlay
          sequence={makeSequence()}
          assets={makeAssets()}
          {...defaultProps}
          displayScale={0}
        />,
      );

      const props = moveable();
      expect(props.onDragStart()).toBe(false);
      props.onDrag({ beforeTranslate: [100, 100] });
      props.onDragEnd();

      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });
  });
});
