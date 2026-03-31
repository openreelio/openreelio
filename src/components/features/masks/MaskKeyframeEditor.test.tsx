/**
 * BDD Tests for MaskKeyframeEditor component.
 *
 * Tests mask keyframe management UI: adding, removing, navigating,
 * easing selection, and tracker linking.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MaskKeyframeEditor } from './MaskKeyframeEditor';
import type { Mask, MaskKeyframe, MaskShape } from '@/types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  ChevronLeft: () => <span data-testid="icon-chevron-left" />,
  ChevronRight: () => <span data-testid="icon-chevron-right" />,
  Plus: () => <span data-testid="icon-plus" />,
  Trash2: () => <span data-testid="icon-trash" />,
  Link: () => <span data-testid="icon-link" />,
}));

// =============================================================================
// Helpers
// =============================================================================

const baseShape: MaskShape = {
  type: 'rectangle',
  x: 0.5,
  y: 0.5,
  width: 0.4,
  height: 0.4,
  cornerRadius: 0,
  rotation: 0,
};

function createMask(keyframes: MaskKeyframe[] = [], trackingSourceId?: string): Mask {
  return {
    id: 'mask-001',
    name: 'Test Mask',
    shape: baseShape,
    inverted: false,
    feather: 0,
    opacity: 1,
    expansion: 0,
    blendMode: 'add',
    enabled: true,
    locked: false,
    keyframes,
    trackingSourceId,
  };
}

function createKeyframe(timeOffset: number, x = 0.5): MaskKeyframe {
  return {
    timeOffset,
    shape: { ...baseShape, x } as MaskShape,
    easing: 'linear',
  };
}

// =============================================================================
// Feature: Keyframe display
// =============================================================================

describe('MaskKeyframeEditor', () => {
  it('should display keyframe count', () => {
    const mask = createMask([createKeyframe(0), createKeyframe(1), createKeyframe(2)]);
    render(
      <MaskKeyframeEditor mask={mask} currentTime={0} duration={5} onKeyframesChange={vi.fn()} />,
    );

    expect(screen.getByText('3 keyframes')).toBeTruthy();
  });

  it('should display singular form for 1 keyframe', () => {
    const mask = createMask([createKeyframe(0)]);
    render(
      <MaskKeyframeEditor mask={mask} currentTime={0} duration={5} onKeyframesChange={vi.fn()} />,
    );

    expect(screen.getByText('1 keyframe')).toBeTruthy();
  });

  it('should render keyframe markers on timeline', () => {
    const mask = createMask([createKeyframe(0), createKeyframe(2.5), createKeyframe(5)]);
    render(
      <MaskKeyframeEditor mask={mask} currentTime={0} duration={5} onKeyframesChange={vi.fn()} />,
    );

    const markers = screen.getAllByTestId('keyframe-marker');
    expect(markers.length).toBe(3);
  });

  it('should render playhead indicator', () => {
    const mask = createMask([createKeyframe(0)]);
    render(
      <MaskKeyframeEditor mask={mask} currentTime={2.5} duration={5} onKeyframesChange={vi.fn()} />,
    );

    expect(screen.getByTestId('playhead-indicator')).toBeTruthy();
  });

  it('should display keyframe list items', () => {
    const mask = createMask([createKeyframe(0), createKeyframe(1.5)]);
    render(
      <MaskKeyframeEditor mask={mask} currentTime={0} duration={5} onKeyframesChange={vi.fn()} />,
    );

    const items = screen.getAllByTestId('keyframe-list-item');
    expect(items.length).toBe(2);
    expect(screen.getByText('0.00s')).toBeTruthy();
    expect(screen.getByText('1.50s')).toBeTruthy();
  });

  // ===========================================================================
  // Feature: Add and remove keyframes
  // ===========================================================================

  it('should show "Set Keyframe" button when no keyframe at current time', () => {
    const mask = createMask([createKeyframe(0)]);
    render(
      <MaskKeyframeEditor mask={mask} currentTime={1.0} duration={5} onKeyframesChange={vi.fn()} />,
    );

    expect(screen.getByLabelText('Set keyframe')).toBeTruthy();
  });

  it('should show "Remove" button when keyframe exists at current time', () => {
    const mask = createMask([createKeyframe(1.0)]);
    render(
      <MaskKeyframeEditor mask={mask} currentTime={1.0} duration={5} onKeyframesChange={vi.fn()} />,
    );

    expect(screen.getByLabelText('Remove keyframe')).toBeTruthy();
  });

  it('should add keyframe when "Set Keyframe" is clicked', () => {
    const onChange = vi.fn();
    const mask = createMask([createKeyframe(0)]);
    render(
      <MaskKeyframeEditor
        mask={mask}
        currentTime={1.5}
        duration={5}
        onKeyframesChange={onChange}
      />,
    );

    fireEvent.click(screen.getByLabelText('Set keyframe'));

    expect(onChange).toHaveBeenCalledTimes(1);
    const newKeyframes = onChange.mock.calls[0][0] as MaskKeyframe[];
    expect(newKeyframes.length).toBe(2);
    expect(newKeyframes[1].timeOffset).toBeCloseTo(1.5);
  });

  it('should deep-clone nested shape data when adding a keyframe', () => {
    const onChange = vi.fn();
    const polygonMask: Mask = {
      ...createMask(),
      shape: {
        type: 'polygon',
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.8, y: 0.1 },
          { x: 0.5, y: 0.8 },
        ],
      },
    };

    render(
      <MaskKeyframeEditor
        mask={polygonMask}
        currentTime={1}
        duration={5}
        onKeyframesChange={onChange}
      />,
    );

    fireEvent.click(screen.getByLabelText('Set keyframe'));

    const newKeyframes = onChange.mock.calls[0][0] as MaskKeyframe[];
    const newShape = newKeyframes[0].shape as Extract<MaskShape, { type: 'polygon' }>;
    newShape.points[0].x = 0.25;

    expect((polygonMask.shape as Extract<MaskShape, { type: 'polygon' }>).points[0].x).toBe(0.1);
  });

  it('should remove keyframe when "Remove" is clicked', () => {
    const onChange = vi.fn();
    const mask = createMask([createKeyframe(0), createKeyframe(1.0)]);
    render(
      <MaskKeyframeEditor
        mask={mask}
        currentTime={1.0}
        duration={5}
        onKeyframesChange={onChange}
      />,
    );

    fireEvent.click(screen.getByLabelText('Remove keyframe'));

    expect(onChange).toHaveBeenCalledTimes(1);
    const remaining = onChange.mock.calls[0][0] as MaskKeyframe[];
    expect(remaining.length).toBe(1);
    expect(remaining[0].timeOffset).toBeCloseTo(0);
  });

  it('should keep keyframes sorted after adding', () => {
    const onChange = vi.fn();
    const mask = createMask([createKeyframe(0), createKeyframe(3)]);
    render(
      <MaskKeyframeEditor
        mask={mask}
        currentTime={1.5}
        duration={5}
        onKeyframesChange={onChange}
      />,
    );

    fireEvent.click(screen.getByLabelText('Set keyframe'));

    const sorted = onChange.mock.calls[0][0] as MaskKeyframe[];
    expect(sorted[0].timeOffset).toBeCloseTo(0);
    expect(sorted[1].timeOffset).toBeCloseTo(1.5);
    expect(sorted[2].timeOffset).toBeCloseTo(3);
  });

  // ===========================================================================
  // Feature: Easing selection
  // ===========================================================================

  it('should change easing for a keyframe', () => {
    const onChange = vi.fn();
    const mask = createMask([createKeyframe(0), createKeyframe(2)]);
    render(
      <MaskKeyframeEditor mask={mask} currentTime={0} duration={5} onKeyframesChange={onChange} />,
    );

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'ease_in' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const updated = onChange.mock.calls[0][0] as MaskKeyframe[];
    expect(updated[0].easing).toBe('ease_in');
    expect(updated[1].easing).toBe('linear');
  });

  // ===========================================================================
  // Feature: Delete keyframe
  // ===========================================================================

  it('should delete a specific keyframe by index', () => {
    const onChange = vi.fn();
    const mask = createMask([createKeyframe(0), createKeyframe(1), createKeyframe(2)]);
    render(
      <MaskKeyframeEditor
        mask={mask}
        currentTime={0.5}
        duration={5}
        onKeyframesChange={onChange}
      />,
    );

    // Delete the second keyframe (index 1)
    const deleteButtons = screen.getAllByLabelText(/Delete keyframe/);
    fireEvent.click(deleteButtons[1]);

    expect(onChange).toHaveBeenCalledTimes(1);
    const remaining = onChange.mock.calls[0][0] as MaskKeyframe[];
    expect(remaining.length).toBe(2);
    expect(remaining[0].timeOffset).toBeCloseTo(0);
    expect(remaining[1].timeOffset).toBeCloseTo(2);
  });

  // ===========================================================================
  // Feature: Disabled state
  // ===========================================================================

  it('should disable controls when disabled prop is true', () => {
    const mask = createMask([createKeyframe(0)]);
    render(
      <MaskKeyframeEditor
        mask={mask}
        currentTime={1.0}
        duration={5}
        onKeyframesChange={vi.fn()}
        disabled
      />,
    );

    const addButton = screen.getByLabelText('Set keyframe');
    expect(addButton).toHaveProperty('disabled', true);
  });

  // ===========================================================================
  // Feature: Tracker linking
  // ===========================================================================

  it('should show "Link Tracker" button when tracking data is available', () => {
    const mask = createMask();
    render(
      <MaskKeyframeEditor
        mask={mask}
        currentTime={0}
        duration={5}
        onKeyframesChange={vi.fn()}
        hasTrackingData
        onLinkTracking={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Link to tracker')).toBeTruthy();
  });

  it('should show "Linked" badge when tracking source is set', () => {
    const mask = createMask([], 'track-effect-001');
    render(
      <MaskKeyframeEditor
        mask={mask}
        currentTime={0}
        duration={5}
        onKeyframesChange={vi.fn()}
        hasTrackingData
        onLinkTracking={vi.fn()}
      />,
    );

    expect(screen.getByText('Linked')).toBeTruthy();
  });

  it('should call onLinkTracking when "Link Tracker" is clicked', () => {
    const onLink = vi.fn();
    const mask = createMask();
    render(
      <MaskKeyframeEditor
        mask={mask}
        currentTime={0}
        duration={5}
        onKeyframesChange={vi.fn()}
        hasTrackingData
        onLinkTracking={onLink}
      />,
    );

    fireEvent.click(screen.getByLabelText('Link to tracker'));
    expect(onLink).toHaveBeenCalledTimes(1);
  });

  it('should not show tracker button when no tracking data', () => {
    const mask = createMask();
    render(
      <MaskKeyframeEditor
        mask={mask}
        currentTime={0}
        duration={5}
        onKeyframesChange={vi.fn()}
        hasTrackingData={false}
      />,
    );

    expect(screen.queryByLabelText('Link to tracker')).toBeNull();
  });
});
