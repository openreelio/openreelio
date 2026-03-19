/**
 * AudioRubberBand Component Tests
 *
 * Integration tests for the SVG rubber band overlay that visualizes
 * audio volume automation keyframes on timeline clips.
 *
 * Mock policy: Only the actions object is mocked (external boundary = IPC).
 * No internal modules are mocked.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AudioRubberBand } from './AudioRubberBand';
import type { Clip } from '@/types';
import type { AudioKeyframeActions } from '@/hooks/useAudioKeyframes';

// =============================================================================
// Test Fixtures
// =============================================================================

const mockClip: Clip = {
  id: 'clip-1',
  assetId: 'asset-1',
  range: { sourceInSec: 0, sourceOutSec: 10 },
  place: { timelineInSec: 0, durationSec: 10 },
  transform: {
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotationDeg: 0,
    anchor: { x: 0.5, y: 0.5 },
  },
  opacity: 1,
  speed: 1,
  effects: [],
  audio: {
    volumeDb: 0,
    pan: 0,
    muted: false,
    volumeKeyframes: [
      { timeOffset: 0, valueDb: 0, interpolation: 'linear' as const },
      { timeOffset: 5, valueDb: -12, interpolation: 'linear' as const },
      { timeOffset: 10, valueDb: 0, interpolation: 'linear' as const },
    ],
  },
};

function createMockActions(): AudioKeyframeActions {
  return {
    addKeyframe: vi
      .fn()
      .mockResolvedValue({ opId: 'op-1', changes: [], createdIds: [], deletedIds: [] }),
    removeKeyframe: vi
      .fn()
      .mockResolvedValue({ opId: 'op-2', changes: [], createdIds: [], deletedIds: [] }),
    moveKeyframe: vi
      .fn()
      .mockResolvedValue({ opId: 'op-3', changes: [], createdIds: [], deletedIds: [] }),
    setKeyframeValue: vi
      .fn()
      .mockResolvedValue({ opId: 'op-4', changes: [], createdIds: [], deletedIds: [] }),
  };
}

// =============================================================================
// Rendering Tests
// =============================================================================

describe('AudioRubberBand', () => {
  describe('rendering', () => {
    it('should render rubber band curve when clip has >= 2 keyframes', () => {
      const actions = createMockActions();
      render(<AudioRubberBand clip={mockClip} width={500} actions={actions} />);

      expect(screen.getByTestId('audio-rubber-band')).toBeInTheDocument();
      expect(screen.getByTestId('rubber-band-curve')).toBeInTheDocument();
    });

    it('should render keyframe dots for each keyframe', () => {
      const actions = createMockActions();
      render(<AudioRubberBand clip={mockClip} width={500} actions={actions} />);

      expect(screen.getByTestId('keyframe-dot-0')).toBeInTheDocument();
      expect(screen.getByTestId('keyframe-dot-1')).toBeInTheDocument();
      expect(screen.getByTestId('keyframe-dot-2')).toBeInTheDocument();
    });

    it('should not render when width < 40', () => {
      const actions = createMockActions();
      const { container } = render(
        <AudioRubberBand clip={mockClip} width={30} actions={actions} />,
      );

      expect(container.querySelector('[data-testid="audio-rubber-band"]')).not.toBeInTheDocument();
    });

    it('should render when clip has a single keyframe so the next point can be added', () => {
      const actions = createMockActions();
      const singleKeyframeClip: Clip = {
        ...mockClip,
        audio: {
          volumeDb: 0,
          pan: 0,
          muted: false,
          volumeKeyframes: [{ timeOffset: 0, valueDb: 0, interpolation: 'linear' as const }],
        },
      };

      render(<AudioRubberBand clip={singleKeyframeClip} width={500} actions={actions} />);

      expect(screen.getByTestId('audio-rubber-band')).toBeInTheDocument();
      expect(screen.getByTestId('keyframe-dot-0')).toBeInTheDocument();
    });

    it('should not render when clip has no audio keyframes', () => {
      const actions = createMockActions();
      const noKeyframeClip: Clip = {
        ...mockClip,
        audio: {
          volumeDb: 0,
          pan: 0,
          muted: false,
        },
      };

      const { container } = render(
        <AudioRubberBand clip={noKeyframeClip} width={500} actions={actions} />,
      );

      expect(container.querySelector('[data-testid="audio-rubber-band"]')).not.toBeInTheDocument();
    });

    it('should render correct number of keyframe dots with 2 keyframes', () => {
      const actions = createMockActions();
      const twoKeyframeClip: Clip = {
        ...mockClip,
        audio: {
          volumeDb: 0,
          pan: 0,
          muted: false,
          volumeKeyframes: [
            { timeOffset: 0, valueDb: 0, interpolation: 'linear' as const },
            { timeOffset: 10, valueDb: -6, interpolation: 'linear' as const },
          ],
        },
      };

      render(<AudioRubberBand clip={twoKeyframeClip} width={500} actions={actions} />);

      expect(screen.getByTestId('keyframe-dot-0')).toBeInTheDocument();
      expect(screen.getByTestId('keyframe-dot-1')).toBeInTheDocument();
      expect(screen.queryByTestId('keyframe-dot-2')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  describe('interactions', () => {
    it('should call addKeyframe when clicking on the curve', () => {
      const actions = createMockActions();
      render(<AudioRubberBand clip={mockClip} width={500} actions={actions} />);

      const curve = screen.getByTestId('rubber-band-curve');

      // Simulate a click on the polyline; getBoundingClientRect is needed by the handler
      // In jsdom SVG elements return 0,0,0,0 for getBoundingClientRect, so the click
      // at clientX=250, clientY=20 will produce x=250, y=20 relative to rect.
      fireEvent.click(curve, { clientX: 250, clientY: 20 });

      expect(actions.addKeyframe).toHaveBeenCalledTimes(1);
      // Verify called with a time offset (number) and dB value (number)
      const [timeArg, dbArg] = (actions.addKeyframe as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(typeof timeArg).toBe('number');
      expect(typeof dbArg).toBe('number');
    });

    it('should not call addKeyframe when disabled and curve is clicked', () => {
      const actions = createMockActions();
      render(<AudioRubberBand clip={mockClip} width={500} disabled actions={actions} />);

      const curve = screen.getByTestId('rubber-band-curve');
      fireEvent.click(curve, { clientX: 250, clientY: 20 });

      expect(actions.addKeyframe).not.toHaveBeenCalled();
    });

    it('should show context menu on keyframe right-click', () => {
      const actions = createMockActions();
      render(<AudioRubberBand clip={mockClip} width={500} actions={actions} />);

      // The hit area circles are siblings of the visible dots.
      // Right-click on the first keyframe dot area. The hit area circle is
      // the element with onContextMenu; we target the <g> group wrapping it.
      // Since the hit area circles don't have data-testid, we find them via
      // the SVG structure. The keyframe dots are pointer-events-none, but
      // the invisible hit area circles above them are pointer-events-auto.
      const dot0 = screen.getByTestId('keyframe-dot-0');
      // The hit area circle is a sibling in the same <g> parent
      const hitArea = dot0.parentElement?.querySelector('circle[class*="cursor-grab"]');
      expect(hitArea).toBeTruthy();

      fireEvent.contextMenu(hitArea!, { clientX: 100, clientY: 20 });

      expect(screen.getByTestId('keyframe-context-menu')).toBeInTheDocument();
      expect(screen.getByText('Delete Keyframe')).toBeInTheDocument();
    });

    it('should call removeKeyframe when clicking Delete in context menu', () => {
      const actions = createMockActions();
      render(<AudioRubberBand clip={mockClip} width={500} actions={actions} />);

      // Open context menu on second keyframe (index 1)
      const dot1 = screen.getByTestId('keyframe-dot-1');
      const hitArea = dot1.parentElement?.querySelector('circle[class*="cursor-grab"]');
      expect(hitArea).toBeTruthy();

      fireEvent.contextMenu(hitArea!, { clientX: 200, clientY: 30 });

      // Click the delete button
      const deleteBtn = screen.getByTestId('keyframe-delete-btn');
      fireEvent.click(deleteBtn);

      expect(actions.removeKeyframe).toHaveBeenCalledTimes(1);
      expect(actions.removeKeyframe).toHaveBeenCalledWith(1);
    });

    it('should close context menu after deleting a keyframe', () => {
      const actions = createMockActions();
      render(<AudioRubberBand clip={mockClip} width={500} actions={actions} />);

      const dot0 = screen.getByTestId('keyframe-dot-0');
      const hitArea = dot0.parentElement?.querySelector('circle[class*="cursor-grab"]');
      fireEvent.contextMenu(hitArea!, { clientX: 50, clientY: 20 });

      expect(screen.getByTestId('keyframe-context-menu')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('keyframe-delete-btn'));

      expect(screen.queryByTestId('keyframe-context-menu')).not.toBeInTheDocument();
    });

    it('should display interpolation options in context menu', () => {
      const actions = createMockActions();
      render(<AudioRubberBand clip={mockClip} width={500} actions={actions} />);

      const dot0 = screen.getByTestId('keyframe-dot-0');
      const hitArea = dot0.parentElement?.querySelector('circle[class*="cursor-grab"]');
      fireEvent.contextMenu(hitArea!, { clientX: 50, clientY: 20 });

      expect(screen.getByText('Linear')).toBeInTheDocument();
      expect(screen.getByText('Hold')).toBeInTheDocument();
    });

    it('should call setKeyframeValue when changing interpolation mode', () => {
      const actions = createMockActions();
      render(<AudioRubberBand clip={mockClip} width={500} actions={actions} />);

      // Open context menu on first keyframe (index 0, interpolation = 'linear')
      const dot0 = screen.getByTestId('keyframe-dot-0');
      const hitArea = dot0.parentElement?.querySelector('circle[class*="cursor-grab"]');
      fireEvent.contextMenu(hitArea!, { clientX: 50, clientY: 20 });

      // Click "Hold" to change interpolation
      fireEvent.click(screen.getByText('Hold'));

      expect(actions.setKeyframeValue).toHaveBeenCalledTimes(1);
      // Called with (keyframeIndex, valueDb, interpolation)
      expect(actions.setKeyframeValue).toHaveBeenCalledWith(0, 0, 'hold');
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should render at exactly width=40 (minimum threshold)', () => {
      const actions = createMockActions();
      render(<AudioRubberBand clip={mockClip} width={40} actions={actions} />);

      expect(screen.getByTestId('audio-rubber-band')).toBeInTheDocument();
    });

    it('should not render at width=39 (below minimum threshold)', () => {
      const actions = createMockActions();
      const { container } = render(
        <AudioRubberBand clip={mockClip} width={39} actions={actions} />,
      );

      expect(container.querySelector('[data-testid="audio-rubber-band"]')).not.toBeInTheDocument();
    });

    it('should not render when clip has zero source duration', () => {
      const actions = createMockActions();
      const zeroDurationClip: Clip = {
        ...mockClip,
        range: { sourceInSec: 5, sourceOutSec: 5 },
      };

      const { container } = render(
        <AudioRubberBand clip={zeroDurationClip} width={500} actions={actions} />,
      );

      expect(container.querySelector('[data-testid="audio-rubber-band"]')).not.toBeInTheDocument();
    });

    it('should handle clip with speed > 1 correctly', () => {
      const actions = createMockActions();
      const fastClip: Clip = {
        ...mockClip,
        speed: 2,
        audio: {
          volumeDb: 0,
          pan: 0,
          muted: false,
          volumeKeyframes: [
            { timeOffset: 0, valueDb: 0, interpolation: 'linear' as const },
            { timeOffset: 5, valueDb: -6, interpolation: 'linear' as const },
          ],
        },
      };

      render(<AudioRubberBand clip={fastClip} width={500} actions={actions} />);

      // Clip duration = (10-0)/2 = 5s; has 2 keyframes and width >= 40 => should render
      expect(screen.getByTestId('audio-rubber-band')).toBeInTheDocument();
    });
  });
});
