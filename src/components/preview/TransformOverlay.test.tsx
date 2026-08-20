/**
 * TransformOverlay DOM Contract Tests
 *
 * Renders the overlay with the real react-moveable so the DOM contract the
 * Playwright E2E depends on is verified end to end in jsdom:
 * - the overlay only appears for a single selection
 * - `transform-overlay`, `transform-bounds`, the 8 resize handles and the
 *   rotation handle all resolve
 * - keyframed clips are shown but not editable
 *
 * Gesture behaviour is covered in `MoveableTransformOverlay.test.tsx`, which
 * mocks the moveable facade; jsdom has no layout so real drags cannot run here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TransformOverlay } from './TransformOverlay';
import type { Sequence, Clip, Track, Asset, TextClipData } from '@/types';

const mockExecuteCommand = vi.fn();
let mockSelectedClipIds: string[] = ['clip-1'];
let mockTextClipDataById = new Map<string, TextClipData>();

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: (selector: (state: { executeCommand: typeof mockExecuteCommand }) => unknown) =>
    selector({ executeCommand: mockExecuteCommand }),
}));

vi.mock('@/stores/timelineStore', () => ({
  useTimelineStore: (selector: (state: { selectedClipIds: string[] }) => unknown) =>
    selector({ selectedClipIds: mockSelectedClipIds }),
}));

vi.mock('@/hooks/useSequenceTextClipData', () => ({
  useSequenceTextClipData: () => mockTextClipDataById,
}));

const HANDLE_TEST_IDS = [
  'transform-handle-top-left',
  'transform-handle-top',
  'transform-handle-top-right',
  'transform-handle-right',
  'transform-handle-bottom-right',
  'transform-handle-bottom',
  'transform-handle-bottom-left',
  'transform-handle-left',
];

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
  displayScale: 0.5,
  panX: 0,
  panY: 0,
};

describe('TransformOverlay', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
    mockSelectedClipIds = ['clip-1'];
    mockTextClipDataById = new Map<string, TextClipData>();
  });

  describe('visibility', () => {
    it('should render overlay when a single clip is selected', () => {
      const sequence = makeSequence();

      render(<TransformOverlay sequence={sequence} assets={makeAssets()} {...defaultProps} />);

      expect(screen.getByTestId('transform-overlay')).toBeInTheDocument();
      expect(screen.getByTestId('transform-bounds')).toBeInTheDocument();
    });

    it('should not render bounds when no clip is selected', () => {
      mockSelectedClipIds = [];

      render(
        <TransformOverlay sequence={makeSequence()} assets={makeAssets()} {...defaultProps} />,
      );

      expect(screen.queryByTestId('transform-bounds')).not.toBeInTheDocument();
    });

    it('should not render bounds when multiple clips are selected', () => {
      mockSelectedClipIds = ['clip-1', 'clip-2'];

      render(
        <TransformOverlay sequence={makeSequence()} assets={makeAssets()} {...defaultProps} />,
      );

      expect(screen.queryByTestId('transform-bounds')).not.toBeInTheDocument();
    });

    it('should not render bounds when sequence is null', () => {
      render(<TransformOverlay sequence={null} assets={makeAssets()} {...defaultProps} />);

      expect(screen.queryByTestId('transform-bounds')).not.toBeInTheDocument();
    });

    it('should not render bounds when selected clip does not exist in sequence', () => {
      mockSelectedClipIds = ['non-existent-clip'];

      render(
        <TransformOverlay sequence={makeSequence()} assets={makeAssets()} {...defaultProps} />,
      );

      expect(screen.queryByTestId('transform-bounds')).not.toBeInTheDocument();
    });
  });

  describe('handle contract', () => {
    it('should expose all 8 resize handles', () => {
      render(
        <TransformOverlay sequence={makeSequence()} assets={makeAssets()} {...defaultProps} />,
      );

      for (const testId of HANDLE_TEST_IDS) {
        expect(screen.getByTestId(testId)).toBeInTheDocument();
      }
    });

    it('should expose the rotation handle', () => {
      render(
        <TransformOverlay sequence={makeSequence()} assets={makeAssets()} {...defaultProps} />,
      );

      expect(screen.getByTestId('transform-handle-rotate')).toBeInTheDocument();
    });

    it('should position the bounds box from the clip transform', () => {
      render(
        <TransformOverlay sequence={makeSequence()} assets={makeAssets()} {...defaultProps} />,
      );

      const bounds = screen.getByTestId('transform-bounds');

      // A full-frame clip at identity fills the 960x540 container.
      expect(bounds.style.width).toBe('960px');
      expect(bounds.style.height).toBe('540px');
      expect(bounds.style.transform).toBe('translate(0px, 0px) rotate(0deg)');
      expect(bounds.style.transformOrigin).toBe('50% 50%');
    });

    it('should rotate the bounds box about the anchor point', () => {
      const sequence = makeSequence();
      sequence.tracks[0].clips[0].transform = {
        position: { x: 0.5, y: 0.5 },
        scale: { x: 1, y: 1 },
        rotationDeg: 30,
        anchor: { x: 0, y: 1 },
      };

      render(<TransformOverlay sequence={sequence} assets={makeAssets()} {...defaultProps} />);

      const bounds = screen.getByTestId('transform-bounds');

      expect(bounds.style.transformOrigin).toBe('0% 100%');
      expect(bounds.style.transform).toContain('rotate(30deg)');
    });
  });

  describe('info display', () => {
    it('should display current scale percentage', () => {
      render(
        <TransformOverlay sequence={makeSequence()} assets={makeAssets()} {...defaultProps} />,
      );

      expect(screen.getByText(/100% x 100%/)).toBeInTheDocument();
    });
  });

  describe('keyframed clips', () => {
    it('should show the bounds but disable editing when the clip has motion keyframes', () => {
      const sequence = makeSequence();
      sequence.tracks[0].clips[0].motionKeyframes = [
        {
          timeOffset: 0,
          interpolation: 'linear',
          transform: {
            position: { x: 0.5, y: 0.5 },
            scale: { x: 1, y: 1 },
            rotationDeg: 0,
            anchor: { x: 0.5, y: 0.5 },
          },
        },
      ];

      render(<TransformOverlay sequence={sequence} assets={makeAssets()} {...defaultProps} />);

      const bounds = screen.getByTestId('transform-bounds');
      expect(bounds).toHaveAttribute('data-keyframed', 'true');
      expect(screen.getByTestId('transform-info')).toHaveTextContent(/Keyframed/);
      expect(screen.queryByTestId('transform-handle-bottom-right')).not.toBeInTheDocument();
    });
  });

  describe('edge cases', () => {
    it('should not crash with zero displayScale', () => {
      expect(() => {
        render(
          <TransformOverlay
            sequence={makeSequence()}
            assets={makeAssets()}
            {...defaultProps}
            displayScale={0}
          />,
        );
      }).not.toThrow();
    });

    it('should handle missing transform in clip gracefully', () => {
      const sequence = makeSequence();
      (sequence.tracks[0].clips[0] as { transform?: unknown }).transform = undefined;

      expect(() => {
        render(<TransformOverlay sequence={sequence} assets={makeAssets()} {...defaultProps} />);
      }).not.toThrow();
    });

    it('should handle missing asset gracefully', () => {
      expect(() => {
        render(
          <TransformOverlay
            sequence={makeSequence()}
            assets={new Map<string, Asset>()}
            {...defaultProps}
          />,
        );
      }).not.toThrow();
    });
  });
});
