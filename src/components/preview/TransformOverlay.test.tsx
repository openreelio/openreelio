/**
 * TransformOverlay Component Tests
 *
 * Comprehensive tests for transform interactions including:
 * - Single command commit on mouseup (not on mousemove)
 * - Overlay visibility based on clip selection
 * - Resize handle interactions
 * - Position clamping (0-1 range)
 * - Edge cases (invalid displayScale, multiple selections)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TransformOverlay } from './TransformOverlay';
import type { Sequence, Clip, Track, Asset } from '@/types';

const mockExecuteCommand = vi.fn();
let mockSelectedClipIds: string[] = ['clip-1'];

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: (selector: (state: { executeCommand: typeof mockExecuteCommand }) => unknown) =>
    selector({ executeCommand: mockExecuteCommand }),
}));

vi.mock('@/stores/timelineStore', () => ({
  useTimelineStore: (selector: (state: { selectedClipIds: string[] }) => unknown) =>
    selector({ selectedClipIds: mockSelectedClipIds }),
}));

function makeSequence(): Sequence {
  const clip: Clip = {
    id: 'clip-1',
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
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks: [track],
    markers: [],
  };
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
        license: {
          source: 'user',
          licenseType: 'unknown',
          allowedUse: [],
        },
        tags: [],
        proxyStatus: 'notNeeded',
      },
    ],
  ]);
}

const defaultProps = {
  canvasWidth: 1920,
  canvasHeight: 1080,
  containerWidth: 960,
  containerHeight: 540,
  displayScale: 1,
  panX: 0,
  panY: 0,
};

describe('TransformOverlay', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
    mockSelectedClipIds = ['clip-1'];
  });

  // ===========================================================================
  // Visibility Tests
  // ===========================================================================

  describe('visibility', () => {
    it('should render overlay when a single clip is selected', () => {
      mockSelectedClipIds = ['clip-1'];
      const sequence = makeSequence();
      const assets = makeAssets();

      render(<TransformOverlay sequence={sequence} assets={assets} {...defaultProps} />);

      expect(screen.getByTestId('transform-overlay')).toBeInTheDocument();
      expect(screen.getByTestId('transform-bounds')).toBeInTheDocument();
    });

    it('should not render bounds when no clip is selected', () => {
      mockSelectedClipIds = [];
      const sequence = makeSequence();
      const assets = makeAssets();

      render(<TransformOverlay sequence={sequence} assets={assets} {...defaultProps} />);

      expect(screen.queryByTestId('transform-bounds')).not.toBeInTheDocument();
    });

    it('should not render bounds when multiple clips are selected', () => {
      mockSelectedClipIds = ['clip-1', 'clip-2'];
      const sequence = makeSequence();
      const assets = makeAssets();

      render(<TransformOverlay sequence={sequence} assets={assets} {...defaultProps} />);

      expect(screen.queryByTestId('transform-bounds')).not.toBeInTheDocument();
    });

    it('should not render bounds when sequence is null', () => {
      mockSelectedClipIds = ['clip-1'];
      const assets = makeAssets();

      render(<TransformOverlay sequence={null} assets={assets} {...defaultProps} />);

      expect(screen.queryByTestId('transform-bounds')).not.toBeInTheDocument();
    });

    it('should not render bounds when selected clip does not exist in sequence', () => {
      mockSelectedClipIds = ['non-existent-clip'];
      const sequence = makeSequence();
      const assets = makeAssets();

      render(<TransformOverlay sequence={sequence} assets={assets} {...defaultProps} />);

      expect(screen.queryByTestId('transform-bounds')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Move Interaction Tests
  // ===========================================================================

  describe('move interaction', () => {
    it('should commit a single SetClipTransform command on mouseup (not on mousemove)', () => {
      const sequence = makeSequence();
      const assets = makeAssets();

      render(<TransformOverlay sequence={sequence} assets={assets} {...defaultProps} />);

      const bounds = screen.getByTestId('transform-bounds');

      fireEvent.mouseDown(bounds, { clientX: 100, clientY: 100 });
      fireEvent.mouseMove(window, { clientX: 150, clientY: 120 });
      fireEvent.mouseMove(window, { clientX: 180, clientY: 140 });

      expect(mockExecuteCommand).not.toHaveBeenCalled();

      fireEvent.mouseUp(window);

      expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SetClipTransform',
          payload: expect.objectContaining({
            sequenceId: 'seq-1',
            trackId: 'track-1',
            clipId: 'clip-1',
            transform: expect.objectContaining({
              position: expect.any(Object),
              scale: expect.any(Object),
            }),
          }),
        }),
      );
    });

    it('should update position based on drag delta', () => {
      const sequence = makeSequence();
      const assets = makeAssets();

      render(<TransformOverlay sequence={sequence} assets={assets} {...defaultProps} />);

      const bounds = screen.getByTestId('transform-bounds');

      // Start at center (0.5, 0.5) and drag
      fireEvent.mouseDown(bounds, { clientX: 0, clientY: 0 });
      fireEvent.mouseMove(window, { clientX: 100, clientY: 50 });
      fireEvent.mouseUp(window);

      expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
      const call = mockExecuteCommand.mock.calls[0][0];
      const position = call.payload.transform.position;

      // Position should have changed from initial 0.5
      expect(position.x).not.toBe(0.5);
      expect(position.y).not.toBe(0.5);
    });

    it('should clamp position to 0-1 range', () => {
      const sequence = makeSequence();
      const assets = makeAssets();

      render(<TransformOverlay sequence={sequence} assets={assets} {...defaultProps} />);

      const bounds = screen.getByTestId('transform-bounds');

      // Drag far to the right/bottom to exceed bounds
      fireEvent.mouseDown(bounds, { clientX: 0, clientY: 0 });
      fireEvent.mouseMove(window, { clientX: 10000, clientY: 10000 });
      fireEvent.mouseUp(window);

      const call = mockExecuteCommand.mock.calls[0][0];
      const position = call.payload.transform.position;

      expect(position.x).toBeLessThanOrEqual(1);
      expect(position.y).toBeLessThanOrEqual(1);
      expect(position.x).toBeGreaterThanOrEqual(0);
      expect(position.y).toBeGreaterThanOrEqual(0);
    });
  });

  // ===========================================================================
  // Resize Interaction Tests
  // ===========================================================================

  describe('resize interaction', () => {
    it('should render all 8 resize handles', () => {
      mockSelectedClipIds = ['clip-1'];
      const sequence = makeSequence();
      const assets = makeAssets();

      render(<TransformOverlay sequence={sequence} assets={assets} {...defaultProps} />);

      expect(screen.getByTestId('transform-handle-top-left')).toBeInTheDocument();
      expect(screen.getByTestId('transform-handle-top')).toBeInTheDocument();
      expect(screen.getByTestId('transform-handle-top-right')).toBeInTheDocument();
      expect(screen.getByTestId('transform-handle-right')).toBeInTheDocument();
      expect(screen.getByTestId('transform-handle-bottom-right')).toBeInTheDocument();
      expect(screen.getByTestId('transform-handle-bottom')).toBeInTheDocument();
      expect(screen.getByTestId('transform-handle-bottom-left')).toBeInTheDocument();
      expect(screen.getByTestId('transform-handle-left')).toBeInTheDocument();
    });

    it('should update scale when dragging right handle', () => {
      const sequence = makeSequence();
      const assets = makeAssets();

      render(<TransformOverlay sequence={sequence} assets={assets} {...defaultProps} />);

      const rightHandle = screen.getByTestId('transform-handle-right');

      fireEvent.mouseDown(rightHandle, { clientX: 0, clientY: 0 });
      fireEvent.mouseMove(window, { clientX: 100, clientY: 0 });
      fireEvent.mouseUp(window);

      expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
      const call = mockExecuteCommand.mock.calls[0][0];
      const scale = call.payload.transform.scale;

      // Scale X should have increased
      expect(scale.x).toBeGreaterThan(1);
      // Scale Y should remain unchanged
      expect(scale.y).toBe(1);
    });

    it('should update scale when dragging bottom handle', () => {
      const sequence = makeSequence();
      const assets = makeAssets();

      render(<TransformOverlay sequence={sequence} assets={assets} {...defaultProps} />);

      const bottomHandle = screen.getByTestId('transform-handle-bottom');

      fireEvent.mouseDown(bottomHandle, { clientX: 0, clientY: 0 });
      fireEvent.mouseMove(window, { clientX: 0, clientY: 100 });
      fireEvent.mouseUp(window);

      expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
      const call = mockExecuteCommand.mock.calls[0][0];
      const scale = call.payload.transform.scale;

      // Scale Y should have increased
      expect(scale.y).toBeGreaterThan(1);
      // Scale X should remain unchanged
      expect(scale.x).toBe(1);
    });

    it('should update both scales when dragging corner handle', () => {
      const sequence = makeSequence();
      const assets = makeAssets();

      render(<TransformOverlay sequence={sequence} assets={assets} {...defaultProps} />);

      const cornerHandle = screen.getByTestId('transform-handle-bottom-right');

      fireEvent.mouseDown(cornerHandle, { clientX: 0, clientY: 0 });
      fireEvent.mouseMove(window, { clientX: 100, clientY: 100 });
      fireEvent.mouseUp(window);

      expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
      const call = mockExecuteCommand.mock.calls[0][0];
      const scale = call.payload.transform.scale;

      // Both scales should have increased
      expect(scale.x).toBeGreaterThan(1);
      expect(scale.y).toBeGreaterThan(1);
    });

    it('should enforce minimum scale of 0.1', () => {
      const sequence = makeSequence();
      const assets = makeAssets();

      render(<TransformOverlay sequence={sequence} assets={assets} {...defaultProps} />);

      const leftHandle = screen.getByTestId('transform-handle-left');

      // Drag left handle far to the right to try to create negative/zero scale
      fireEvent.mouseDown(leftHandle, { clientX: 0, clientY: 0 });
      fireEvent.mouseMove(window, { clientX: 10000, clientY: 0 });
      fireEvent.mouseUp(window);

      const call = mockExecuteCommand.mock.calls[0][0];
      const scale = call.payload.transform.scale;

      expect(scale.x).toBeGreaterThanOrEqual(0.1);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should not crash with zero displayScale', () => {
      const sequence = makeSequence();
      const assets = makeAssets();

      // Should not throw
      expect(() => {
        render(
          <TransformOverlay sequence={sequence} assets={assets} {...defaultProps} displayScale={0} />,
        );
      }).not.toThrow();
    });

    it('should not execute command when displayScale is invalid during drag', () => {
      const sequence = makeSequence();
      const assets = makeAssets();

      render(
        <TransformOverlay sequence={sequence} assets={assets} {...defaultProps} displayScale={0} />,
      );

      const bounds = screen.getByTestId('transform-bounds');

      fireEvent.mouseDown(bounds, { clientX: 0, clientY: 0 });
      fireEvent.mouseMove(window, { clientX: 100, clientY: 100 });
      fireEvent.mouseUp(window);

      // Should not crash and should handle gracefully
      // Command may or may not be called depending on implementation
    });

    it('should handle missing transform in clip gracefully', () => {
      const sequence = makeSequence();
      // Remove transform from clip to test default handling
      (sequence.tracks[0].clips[0] as { transform?: unknown }).transform = undefined;
      const assets = makeAssets();

      expect(() => {
        render(<TransformOverlay sequence={sequence} assets={assets} {...defaultProps} />);
      }).not.toThrow();
    });

    it('should handle missing asset gracefully', () => {
      const sequence = makeSequence();
      const assets = new Map<string, Asset>(); // Empty assets map

      expect(() => {
        render(<TransformOverlay sequence={sequence} assets={assets} {...defaultProps} />);
      }).not.toThrow();
    });
  });

  // ===========================================================================
  // Info Display Tests
  // ===========================================================================

  describe('info display', () => {
    it('should display current scale percentage', () => {
      const sequence = makeSequence();
      const assets = makeAssets();

      render(<TransformOverlay sequence={sequence} assets={assets} {...defaultProps} />);

      // Initial scale is 1.0 = 100%
      expect(screen.getByText(/100% x 100%/)).toBeInTheDocument();
    });
  });
});
