/**
 * ColorCurvesPanel Component Tests
 *
 * BDD-style integration tests for the Color Curves editor panel.
 * Tests user interactions (channel switching, point management, reset)
 * and rendering behavior with real hook state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ColorCurvesPanel } from './ColorCurvesPanel';
import {
  serializeCurvePoints,
  IDENTITY_CURVE,
  FLAT_IDENTITY_CURVE,
} from '@/hooks/useColorCurves';

// =============================================================================
// Test Data
// =============================================================================

const identityJson = serializeCurvePoints(IDENTITY_CURVE);
const flatJson = serializeCurvePoints(FLAT_IDENTITY_CURVE);

function createDefaultParams(): Record<string, string> {
  return {
    master_curve: identityJson,
    red_curve: identityJson,
    green_curve: identityJson,
    blue_curve: identityJson,
    hue_vs_hue_curve: flatJson,
    hue_vs_sat_curve: flatJson,
    luma_vs_sat_curve: flatJson,
  };
}

function createSCurveParams(): Record<string, string> {
  const sCurve = serializeCurvePoints([
    { x: 0, y: 0 },
    { x: 0.25, y: 0.1 },
    { x: 0.75, y: 0.9 },
    { x: 1, y: 1 },
  ]);
  return {
    master_curve: sCurve,
    red_curve: identityJson,
    green_curve: identityJson,
    blue_curve: identityJson,
  };
}

// =============================================================================
// Rendering
// =============================================================================

describe('ColorCurvesPanel', () => {
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
  });

  describe('rendering', () => {
    it('should render the panel with canvas and channel tabs', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      expect(screen.getByTestId('color-curves-panel')).toBeInTheDocument();
      expect(screen.getByTestId('color-curves-canvas')).toBeInTheDocument();
      expect(screen.getByTestId('channel-tab-master')).toBeInTheDocument();
      expect(screen.getByTestId('channel-tab-red')).toBeInTheDocument();
      expect(screen.getByTestId('channel-tab-green')).toBeInTheDocument();
      expect(screen.getByTestId('channel-tab-blue')).toBeInTheDocument();
    });

    it('should show correct point count for identity curve', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      expect(screen.getByTestId('point-count')).toHaveTextContent('Points: 2');
    });

    it('should show correct point count for S-curve', () => {
      render(
        <ColorCurvesPanel params={createSCurveParams()} onChange={onChange} />
      );
      expect(screen.getByTestId('point-count')).toHaveTextContent('Points: 4');
    });

    it('should render canvas with correct dimensions', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      const canvas = screen.getByTestId('color-curves-canvas') as HTMLCanvasElement;
      expect(canvas.width).toBe(256);
      expect(canvas.height).toBe(256);
    });

    it('should render reset button', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      expect(screen.getByTestId('reset-channel-btn')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Channel Switching
  // ===========================================================================

  describe('channel switching', () => {
    it('should switch to red channel when R tab is clicked', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      fireEvent.click(screen.getByTestId('channel-tab-red'));
      const canvas = screen.getByTestId('color-curves-canvas');
      expect(canvas).toHaveAttribute('aria-label', 'red curve editor');
    });

    it('should switch to green channel when G tab is clicked', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      fireEvent.click(screen.getByTestId('channel-tab-green'));
      const canvas = screen.getByTestId('color-curves-canvas');
      expect(canvas).toHaveAttribute('aria-label', 'green curve editor');
    });

    it('should switch to blue channel when B tab is clicked', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      fireEvent.click(screen.getByTestId('channel-tab-blue'));
      const canvas = screen.getByTestId('color-curves-canvas');
      expect(canvas).toHaveAttribute('aria-label', 'blue curve editor');
    });

    it('should default to master channel', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      const canvas = screen.getByTestId('color-curves-canvas');
      expect(canvas).toHaveAttribute('aria-label', 'master curve editor');
    });
  });

  // ===========================================================================
  // Adding Points
  // ===========================================================================

  describe('adding control points', () => {
    it('should call onChange with new point when clicking empty area on canvas', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      const canvas = screen.getByTestId('color-curves-canvas') as HTMLCanvasElement;

      // Simulate a click at the center of the canvas (should not hit existing endpoints)
      // Canvas is 256x256, getBoundingClientRect mocked to 256x256
      Object.defineProperty(canvas, 'getBoundingClientRect', {
        value: () => ({ left: 0, top: 0, width: 256, height: 256, right: 256, bottom: 256 }),
      });

      fireEvent.mouseDown(canvas, { clientX: 128, clientY: 128, button: 0 });

      expect(onChange).toHaveBeenCalledWith(
        'master_curve',
        expect.any(String)
      );

      // The new curve should have 3 points (identity 2 + new 1)
      const serialized = onChange.mock.calls[0][1] as string;
      const points = JSON.parse(serialized);
      expect(points).toHaveLength(3);
    });
  });

  // ===========================================================================
  // Deleting Points
  // ===========================================================================

  describe('deleting control points', () => {
    it('should call onChange when right-clicking a non-endpoint control point', () => {
      const params = createSCurveParams();
      render(<ColorCurvesPanel params={params} onChange={onChange} />);

      const canvas = screen.getByTestId('color-curves-canvas') as HTMLCanvasElement;
      Object.defineProperty(canvas, 'getBoundingClientRect', {
        value: () => ({ left: 0, top: 0, width: 256, height: 256, right: 256, bottom: 256 }),
      });

      // Right-click near the second control point (x=0.25 → pixel 64, y=0.1 → pixel 230)
      fireEvent.contextMenu(canvas, { clientX: 64, clientY: 230 });

      // Should have called onChange to update the curve with one fewer point
      expect(onChange).toHaveBeenCalled();
      const serialized = onChange.mock.calls[0][1] as string;
      const points = JSON.parse(serialized);
      expect(points).toHaveLength(3);
    });

    it('should not delete endpoint when right-clicking first or last point', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      const canvas = screen.getByTestId('color-curves-canvas') as HTMLCanvasElement;
      Object.defineProperty(canvas, 'getBoundingClientRect', {
        value: () => ({ left: 0, top: 0, width: 256, height: 256, right: 256, bottom: 256 }),
      });

      // Right-click on first endpoint (0,0) → canvas pixel (0, 256)
      fireEvent.contextMenu(canvas, { clientX: 0, clientY: 256 });

      // onChange should NOT be called since endpoints can't be deleted
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Reset
  // ===========================================================================

  describe('reset channel', () => {
    it('should reset active channel to identity when reset button is clicked', () => {
      render(
        <ColorCurvesPanel params={createSCurveParams()} onChange={onChange} />
      );
      fireEvent.click(screen.getByTestId('reset-channel-btn'));

      expect(onChange).toHaveBeenCalledWith('master_curve', identityJson);
    });

    it('should reset only the active channel', () => {
      render(
        <ColorCurvesPanel params={createSCurveParams()} onChange={onChange} />
      );
      // Switch to red channel first
      fireEvent.click(screen.getByTestId('channel-tab-red'));
      fireEvent.click(screen.getByTestId('reset-channel-btn'));

      expect(onChange).toHaveBeenCalledWith('red_curve', identityJson);
      // master_curve should NOT have been reset
      const masterCalls = onChange.mock.calls.filter(
        (c: unknown[]) => c[0] === 'master_curve'
      );
      expect(masterCalls).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Read-Only Mode
  // ===========================================================================

  describe('read-only mode', () => {
    it('should disable reset button when readOnly', () => {
      render(
        <ColorCurvesPanel
          params={createDefaultParams()}
          onChange={onChange}
          readOnly
        />
      );
      expect(screen.getByTestId('reset-channel-btn')).toBeDisabled();
    });

    it('should not add points when clicking canvas in readOnly mode', () => {
      render(
        <ColorCurvesPanel
          params={createDefaultParams()}
          onChange={onChange}
          readOnly
        />
      );
      const canvas = screen.getByTestId('color-curves-canvas') as HTMLCanvasElement;
      Object.defineProperty(canvas, 'getBoundingClientRect', {
        value: () => ({ left: 0, top: 0, width: 256, height: 256, right: 256, bottom: 256 }),
      });

      fireEvent.mouseDown(canvas, { clientX: 128, clientY: 128, button: 0 });
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Dragging Points
  // ===========================================================================

  describe('dragging control points', () => {
    it('should call onChange during mouse move when dragging a point', () => {
      const params = createSCurveParams();
      render(<ColorCurvesPanel params={params} onChange={onChange} />);

      const canvas = screen.getByTestId('color-curves-canvas') as HTMLCanvasElement;
      Object.defineProperty(canvas, 'getBoundingClientRect', {
        value: () => ({ left: 0, top: 0, width: 256, height: 256, right: 256, bottom: 256 }),
      });

      // MouseDown on the second point (x=0.25 → 64px, y=0.1 → 230px)
      fireEvent.mouseDown(canvas, { clientX: 64, clientY: 230, button: 0 });

      // MouseMove to new position
      fireEvent.mouseMove(canvas, { clientX: 80, clientY: 200 });

      // Should have triggered onChange for the drag move
      const calls = onChange.mock.calls.filter(
        (c: unknown[]) => c[0] === 'master_curve'
      );
      expect(calls.length).toBeGreaterThan(0);
    });

    it('should stop dragging on mouseUp', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      const canvas = screen.getByTestId('color-curves-canvas') as HTMLCanvasElement;
      Object.defineProperty(canvas, 'getBoundingClientRect', {
        value: () => ({ left: 0, top: 0, width: 256, height: 256, right: 256, bottom: 256 }),
      });

      fireEvent.mouseUp(canvas);
      fireEvent.mouseMove(canvas, { clientX: 128, clientY: 128 });

      // No onChange should fire since we're not dragging
      expect(onChange).not.toHaveBeenCalled();
    });

    it('should stop dragging on mouseLeave', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      const canvas = screen.getByTestId('color-curves-canvas') as HTMLCanvasElement;

      fireEvent.mouseLeave(canvas);
      fireEvent.mouseMove(canvas, { clientX: 128, clientY: 128 });

      expect(onChange).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Advanced Curve Tabs (H/H, H/S, L/S)
  // ===========================================================================

  describe('advanced curve tabs', () => {
    it('should render H/H, H/S, L/S tabs', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      expect(screen.getByTestId('channel-tab-hue_vs_hue')).toBeInTheDocument();
      expect(screen.getByTestId('channel-tab-hue_vs_sat')).toBeInTheDocument();
      expect(screen.getByTestId('channel-tab-luma_vs_sat')).toBeInTheDocument();
    });

    it('should render separator between RGB and advanced tabs', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      expect(screen.getByTestId('channel-separator')).toBeInTheDocument();
    });

    it('should switch to hue_vs_hue channel when H/H tab is clicked', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      fireEvent.click(screen.getByTestId('channel-tab-hue_vs_hue'));
      const canvas = screen.getByTestId('color-curves-canvas');
      expect(canvas).toHaveAttribute('aria-label', 'hue_vs_hue curve editor');
    });

    it('should switch to hue_vs_sat channel when H/S tab is clicked', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      fireEvent.click(screen.getByTestId('channel-tab-hue_vs_sat'));
      const canvas = screen.getByTestId('color-curves-canvas');
      expect(canvas).toHaveAttribute('aria-label', 'hue_vs_sat curve editor');
    });

    it('should switch to luma_vs_sat channel when L/S tab is clicked', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      fireEvent.click(screen.getByTestId('channel-tab-luma_vs_sat'));
      const canvas = screen.getByTestId('color-curves-canvas');
      expect(canvas).toHaveAttribute('aria-label', 'luma_vs_sat curve editor');
    });

    it('should show 2 points for flat identity curve on advanced tab', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      fireEvent.click(screen.getByTestId('channel-tab-hue_vs_hue'));
      expect(screen.getByTestId('point-count')).toHaveTextContent('Points: 2');
    });

    it('should reset advanced channel to flat identity when reset clicked', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      fireEvent.click(screen.getByTestId('channel-tab-hue_vs_sat'));
      fireEvent.click(screen.getByTestId('reset-channel-btn'));

      expect(onChange).toHaveBeenCalledWith('hue_vs_sat_curve', flatJson);
    });

    it('should add point to advanced curve on canvas click', () => {
      render(
        <ColorCurvesPanel params={createDefaultParams()} onChange={onChange} />
      );
      fireEvent.click(screen.getByTestId('channel-tab-luma_vs_sat'));

      const canvas = screen.getByTestId('color-curves-canvas') as HTMLCanvasElement;
      Object.defineProperty(canvas, 'getBoundingClientRect', {
        value: () => ({ left: 0, top: 0, width: 256, height: 256, right: 256, bottom: 256 }),
      });

      fireEvent.mouseDown(canvas, { clientX: 128, clientY: 64, button: 0 });

      expect(onChange).toHaveBeenCalledWith(
        'luma_vs_sat_curve',
        expect.any(String)
      );
      const serialized = onChange.mock.calls[0][1] as string;
      const points = JSON.parse(serialized);
      expect(points).toHaveLength(3);
    });
  });
});
