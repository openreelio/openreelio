/**
 * TrackingOverlay Integration Tests
 *
 * BDD-style tests for the SVG tracking overlay on the video preview.
 * No mocking needed — this is a pure presentational component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrackingOverlay } from './TrackingOverlay';
import type { TrackingOverlayProps } from './TrackingOverlay';
import type { TrackKeyframe } from '@/utils/motionTracking';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONTAINER_WIDTH = 200;
const CONTAINER_HEIGHT = 100;

/** Build a set of tracking keyframes */
function makeKeyframes(count: number): TrackKeyframe[] {
  return Array.from({ length: count }, (_, i) => ({
    time: i * 0.5,
    x: 0.2 + i * 0.1,
    y: 0.3 + i * 0.05,
    confidence: 0.9,
  }));
}

function renderOverlay(overrides: Partial<TrackingOverlayProps> = {}) {
  const onPointSelected = vi.fn();
  const props: TrackingOverlayProps = {
    isSelectingPoint: false,
    onPointSelected,
    trackingPath: null,
    currentTime: 0,
    width: CONTAINER_WIDTH,
    height: CONTAINER_HEIGHT,
    ...overrides,
  };
  const utils = render(<TrackingOverlay {...props} />);
  return { ...utils, onPointSelected };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrackingOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Scenario: Not rendered when no content
  // =========================================================================

  describe('empty state', () => {
    it('should not render the overlay when isSelectingPoint=false and trackingPath=null', () => {
      renderOverlay({
        isSelectingPoint: false,
        trackingPath: null,
      });

      expect(screen.queryByTestId('tracking-overlay')).not.toBeInTheDocument();
    });

    it('should not render the overlay when trackingPath is an empty array', () => {
      renderOverlay({
        isSelectingPoint: false,
        trackingPath: [],
      });

      expect(screen.queryByTestId('tracking-overlay')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Scenario: Shows crosshair text in selection mode
  // =========================================================================

  describe('point selection mode', () => {
    it('should render the overlay when isSelectingPoint=true', () => {
      renderOverlay({ isSelectingPoint: true });

      expect(screen.getByTestId('tracking-overlay')).toBeInTheDocument();
    });

    it('should show "Click to set tracking point" text when in selection mode', () => {
      renderOverlay({ isSelectingPoint: true });

      expect(screen.getByText('Click to set tracking point')).toBeInTheDocument();
    });

    it('should accept click events when in selection mode', () => {
      const { onPointSelected } = renderOverlay({ isSelectingPoint: true });
      const overlay = screen.getByTestId('tracking-overlay');

      vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({
        left: 0, top: 0, width: CONTAINER_WIDTH, height: CONTAINER_HEIGHT,
        right: CONTAINER_WIDTH, bottom: CONTAINER_HEIGHT, x: 0, y: 0, toJSON: () => ({}),
      });

      fireEvent.click(overlay, { clientX: 100, clientY: 50 });
      expect(onPointSelected).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Scenario: Calls onPointSelected on click
  // =========================================================================

  describe('point selection click', () => {
    it('should call onPointSelected with normalized coordinates when clicked', () => {
      const { onPointSelected } = renderOverlay({ isSelectingPoint: true });

      const overlay = screen.getByTestId('tracking-overlay');

      // Mock getBoundingClientRect to return known dimensions
      vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: CONTAINER_WIDTH,
        height: CONTAINER_HEIGHT,
        right: CONTAINER_WIDTH,
        bottom: CONTAINER_HEIGHT,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      // Click at center (100, 50) of a 200x100 container = (0.5, 0.5)
      fireEvent.click(overlay, { clientX: 100, clientY: 50 });

      expect(onPointSelected).toHaveBeenCalledWith(0.5, 0.5);
    });

    it('should clamp normalized coordinates to [0, 1] range', () => {
      const { onPointSelected } = renderOverlay({ isSelectingPoint: true });

      const overlay = screen.getByTestId('tracking-overlay');

      vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: CONTAINER_WIDTH,
        height: CONTAINER_HEIGHT,
        right: CONTAINER_WIDTH,
        bottom: CONTAINER_HEIGHT,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      // Click outside bounds (negative)
      fireEvent.click(overlay, { clientX: -50, clientY: -50 });

      expect(onPointSelected).toHaveBeenCalledWith(0, 0);
    });

    it('should not call onPointSelected when not in selection mode', () => {
      const { onPointSelected } = renderOverlay({
        isSelectingPoint: false,
        trackingPath: makeKeyframes(3),
      });

      const overlay = screen.getByTestId('tracking-overlay');
      fireEvent.click(overlay, { clientX: 100, clientY: 50 });

      expect(onPointSelected).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Scenario: Renders tracking path
  // =========================================================================

  describe('tracking path visualization', () => {
    it('should render the overlay when a trackingPath is provided', () => {
      renderOverlay({ trackingPath: makeKeyframes(3) });

      expect(screen.getByTestId('tracking-overlay')).toBeInTheDocument();
    });

    it('should render circle elements for each keyframe', () => {
      const keyframes = makeKeyframes(3);
      renderOverlay({ trackingPath: keyframes });

      const overlay = screen.getByTestId('tracking-overlay');
      // Count point circles (exclude the current-position marker circles)
      const allCircles = overlay.querySelectorAll('circle');
      // At least 3 point circles should be rendered
      expect(allCircles.length).toBeGreaterThanOrEqual(3);
    });

    it('should render a path line when there are 2+ keyframes', () => {
      renderOverlay({ trackingPath: makeKeyframes(3) });

      const overlay = screen.getByTestId('tracking-overlay');
      const pathEl = overlay.querySelector('path');
      expect(pathEl).not.toBeNull();
      expect(pathEl?.getAttribute('d')).toContain('M');
      expect(pathEl?.getAttribute('d')).toContain('L');
    });

    it('should not render a path line for a single keyframe', () => {
      renderOverlay({ trackingPath: makeKeyframes(1) });

      const overlay = screen.getByTestId('tracking-overlay');
      const pathEl = overlay.querySelector('path');
      expect(pathEl).toBeNull();
    });

    it('should convert normalized coordinates to pixel positions', () => {
      // Single keyframe at x=0.5, y=0.5
      const keyframes: TrackKeyframe[] = [
        { time: 0, x: 0.5, y: 0.5, confidence: 0.9 },
      ];
      renderOverlay({ trackingPath: keyframes });

      const overlay = screen.getByTestId('tracking-overlay');
      const circle = overlay.querySelector('circle[r="4"]');
      // 0.5 * 200 = 100, 0.5 * 100 = 50
      expect(circle?.getAttribute('cx')).toBe('100');
      expect(circle?.getAttribute('cy')).toBe('50');
    });

    it('should not respond to clicks when not in selection mode', () => {
      const { onPointSelected } = renderOverlay({ trackingPath: makeKeyframes(3) });

      const overlay = screen.getByTestId('tracking-overlay');
      fireEvent.click(overlay, { clientX: 100, clientY: 50 });
      expect(onPointSelected).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Scenario: Highlights current position
  // =========================================================================

  describe('current position marker', () => {
    it('should show the current-position marker when trackingPath and currentTime are set', () => {
      const keyframes = makeKeyframes(3); // times: 0, 0.5, 1.0

      renderOverlay({
        trackingPath: keyframes,
        currentTime: 0.5,
      });

      expect(screen.getByTestId('current-position')).toBeInTheDocument();
    });

    it('should render the current-position marker as a circle', () => {
      const keyframes = makeKeyframes(3);

      renderOverlay({
        trackingPath: keyframes,
        currentTime: 0.25,
      });

      const marker = screen.getByTestId('current-position');
      // Verify it is a circle with a positive radius (decouple from constant)
      const r = Number(marker.getAttribute('r'));
      expect(r).toBeGreaterThan(0);
    });

    it('should position the current marker at the interpolated location', () => {
      // Two keyframes: at x=0.2,y=0.3 (t=0) and x=0.4,y=0.4 (t=1)
      const keyframes: TrackKeyframe[] = [
        { time: 0, x: 0.2, y: 0.3, confidence: 0.9 },
        { time: 1, x: 0.4, y: 0.4, confidence: 0.9 },
      ];

      // At t=0.5, interpolated: x=0.3, y=0.35
      // Pixel: x=0.3*200=60, y=0.35*100=35
      renderOverlay({
        trackingPath: keyframes,
        currentTime: 0.5,
      });

      const marker = screen.getByTestId('current-position');
      expect(Number(marker.getAttribute('cx'))).toBeCloseTo(60, 0);
      expect(Number(marker.getAttribute('cy'))).toBeCloseTo(35, 0);
    });

    it('should snap to first keyframe when currentTime is before start', () => {
      const keyframes: TrackKeyframe[] = [
        { time: 1, x: 0.5, y: 0.5, confidence: 0.9 },
        { time: 2, x: 0.6, y: 0.6, confidence: 0.9 },
      ];

      renderOverlay({
        trackingPath: keyframes,
        currentTime: 0, // Before first keyframe
      });

      const marker = screen.getByTestId('current-position');
      // Should snap to first keyframe: x=0.5*200=100, y=0.5*100=50
      expect(Number(marker.getAttribute('cx'))).toBeCloseTo(100, 0);
      expect(Number(marker.getAttribute('cy'))).toBeCloseTo(50, 0);
    });

    it('should snap to last keyframe when currentTime is after end', () => {
      const keyframes: TrackKeyframe[] = [
        { time: 0, x: 0.2, y: 0.3, confidence: 0.9 },
        { time: 1, x: 0.8, y: 0.7, confidence: 0.9 },
      ];

      renderOverlay({
        trackingPath: keyframes,
        currentTime: 5, // After last keyframe
      });

      const marker = screen.getByTestId('current-position');
      // Should snap to last keyframe: x=0.8*200=160, y=0.7*100=70
      expect(Number(marker.getAttribute('cx'))).toBeCloseTo(160, 0);
      expect(Number(marker.getAttribute('cy'))).toBeCloseTo(70, 0);
    });
  });

  // =========================================================================
  // Scenario: Combined selection mode + tracking path
  // =========================================================================

  describe('combined mode', () => {
    it('should show both crosshair text and tracking path when both active', () => {
      renderOverlay({
        isSelectingPoint: true,
        trackingPath: makeKeyframes(3),
      });

      expect(screen.getByText('Click to set tracking point')).toBeInTheDocument();

      const overlay = screen.getByTestId('tracking-overlay');
      const allCircles = overlay.querySelectorAll('circle');
      expect(allCircles.length).toBeGreaterThanOrEqual(3);
    });
  });
});
