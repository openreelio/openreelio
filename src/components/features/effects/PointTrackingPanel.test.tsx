/**
 * PointTrackingPanel Integration Tests
 *
 * BDD-style tests for the point tracking effect inspector panel.
 * Only mocks external boundaries (Tauri IPC).
 * Uses real MotionTrackingControl, real motionTracking utils, real usePointTracking hook.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PointTrackingPanel } from './PointTrackingPanel';
import type { PointTrackingPanelProps } from './PointTrackingPanel';
import type { ClipContext } from '@/hooks/usePointTracking';

// ---------------------------------------------------------------------------
// Tauri IPC mocks (external boundary only)
// ---------------------------------------------------------------------------

const mockInvoke = vi.hoisted(() => vi.fn());
const mockListen = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLIP_CONTEXT: ClipContext = {
  sequenceId: 'seq-001',
  trackId: 'track-001',
  clipId: 'clip-001',
};

const DEFAULT_PARAMS: Record<string, number | string | boolean> = {
  origin_x: -1,
  origin_y: -1,
  template_size: 25,
  search_area_size: 100,
  confidence_threshold: 0.75,
  tracking_data: '',
  start_frame: 0,
};

/** Params representing a point already placed at center */
const PARAMS_WITH_POINT: Record<string, number | string | boolean> = {
  ...DEFAULT_PARAMS,
  origin_x: 0.5,
  origin_y: 0.5,
};

/** Simulated backend response for a successful track */
function makeTrackPointResult(pointCount: number) {
  const points = Array.from({ length: pointCount }, (_, i) => ({
    frame: i,
    x: 0.5 + i * 0.01,
    y: 0.5 + i * 0.005,
    confidence: 0.95 - i * 0.01,
  }));
  return {
    trackingData: JSON.stringify(points),
    pointsCount: pointCount,
    averageConfidence: 0.9,
  };
}

/** Params with existing tracking data (5 keyframes) */
function makeParamsWithTrackingData(count: number): Record<string, number | string | boolean> {
  const keyframes = Array.from({ length: count }, (_, i) => ({
    time: i / 30,
    x: 0.5 + i * 0.01,
    y: 0.5 + i * 0.005,
    confidence: 0.9,
  }));
  return {
    ...PARAMS_WITH_POINT,
    tracking_data: JSON.stringify(keyframes),
  };
}

function renderPanel(overrides: Partial<PointTrackingPanelProps> = {}) {
  const onChange = vi.fn();
  const props: PointTrackingPanelProps = {
    params: DEFAULT_PARAMS,
    onChange,
    clipContext: CLIP_CONTEXT,
    ...overrides,
  };
  const utils = render(<PointTrackingPanel {...props} />);
  return { ...utils, onChange };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PointTrackingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListen.mockResolvedValue(vi.fn());
    mockInvoke.mockResolvedValue(makeTrackPointResult(5));
  });

  // =========================================================================
  // Scenario: Renders with default params
  // =========================================================================

  describe('rendering with default params', () => {
    it('should render the panel container', () => {
      renderPanel();
      expect(screen.getByTestId('point-tracking-panel')).toBeInTheDocument();
    });

    it('should show the MotionTrackingControl when rendered', () => {
      renderPanel();
      expect(screen.getByTestId('motion-tracking-control')).toBeInTheDocument();
    });

    it('should not show error message when no error exists', () => {
      renderPanel();
      expect(screen.queryByTestId('tracking-error')).not.toBeInTheDocument();
    });

    it('should not show result message when no tracking has been done', () => {
      renderPanel();
      expect(screen.queryByTestId('tracking-result')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Scenario: Displays tracking result
  // =========================================================================

  describe('tracking result display', () => {
    it('should show tracked frames count after successful tracking', async () => {
      renderPanel({ params: PARAMS_WITH_POINT });

      // Click the track button to start tracking
      const trackButton = screen.getByRole('button', { name: /^track$/i });
      await userEvent.click(trackButton);

      await waitFor(() => {
        expect(screen.getByTestId('tracking-result')).toBeInTheDocument();
      });

      expect(screen.getByText(/tracked 5 frames/i)).toBeInTheDocument();
    });

    it('should show average confidence percentage after tracking', async () => {
      renderPanel({ params: PARAMS_WITH_POINT });

      const trackButton = screen.getByRole('button', { name: /^track$/i });
      await userEvent.click(trackButton);

      await waitFor(() => {
        expect(screen.getByTestId('tracking-result')).toBeInTheDocument();
      });

      // The result text should contain "avg confidence: XX%"
      const resultEl = screen.getByTestId('tracking-result');
      expect(resultEl.textContent).toMatch(/avg confidence:\s*\d+%/i);
    });
  });

  // =========================================================================
  // Scenario: Displays error message
  // =========================================================================

  describe('error display', () => {
    it('should show error message when tracking fails', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Tracking analysis failed'));

      renderPanel({ params: PARAMS_WITH_POINT });

      const trackButton = screen.getByRole('button', { name: /^track$/i });
      await userEvent.click(trackButton);

      await waitFor(() => {
        expect(screen.getByTestId('tracking-error')).toBeInTheDocument();
      });

      expect(screen.getByText('Tracking analysis failed')).toBeInTheDocument();
    });

    it('should clear the previous tracking result when a retry fails', async () => {
      renderPanel({ params: PARAMS_WITH_POINT });

      const trackButton = screen.getByRole('button', { name: /^track$/i });
      await userEvent.click(trackButton);

      await waitFor(() => {
        expect(screen.getByTestId('tracking-result')).toBeInTheDocument();
      });

      mockInvoke.mockRejectedValueOnce(new Error('Retry failed'));
      await userEvent.click(screen.getByRole('button', { name: /^track$/i }));

      await waitFor(() => {
        expect(screen.getByTestId('tracking-error')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('tracking-result')).not.toBeInTheDocument();
      expect(screen.getByText('Retry failed')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Scenario: Disabled in read-only mode
  // =========================================================================

  describe('read-only mode', () => {
    it('should disable the add point button when readOnly=true', () => {
      renderPanel({ readOnly: true });

      const addButton = screen.getByRole('button', { name: /add point/i });
      expect(addButton).toBeDisabled();
    });

    it('should disable the track button when readOnly=true', () => {
      renderPanel({ readOnly: true });

      const trackButton = screen.getByRole('button', { name: /^track$/i });
      expect(trackButton).toBeDisabled();
    });
  });

  // =========================================================================
  // Scenario: Add point sets origin
  // =========================================================================

  describe('add point', () => {
    it('should call onChange with origin_x=0.5 and origin_y=0.5 when Add Point is clicked', async () => {
      const { onChange } = renderPanel();

      const addButton = screen.getByRole('button', { name: /add point/i });
      await userEvent.click(addButton);

      expect(onChange).toHaveBeenCalledWith('origin_x', 0.5);
      expect(onChange).toHaveBeenCalledWith('origin_y', 0.5);
    });
  });

  describe('point coordinates', () => {
    it('should persist updated normalized coordinates when the point inputs change', async () => {
      const { onChange } = renderPanel({ params: PARAMS_WITH_POINT });

      fireEvent.change(screen.getByLabelText('Point X'), {
        target: { value: '0.625' },
      });

      expect(onChange).toHaveBeenCalledWith('origin_x', 0.625);
    });
  });

  // =========================================================================
  // Scenario: Remove point clears data
  // =========================================================================

  describe('remove point', () => {
    it('should call onChange to clear origin and tracking_data when delete is clicked', async () => {
      // Render with an existing point
      const { onChange } = renderPanel({ params: PARAMS_WITH_POINT });

      // Find and click the delete button for the track point
      const deleteButtons = screen
        .getAllByRole('button')
        .filter((btn) => btn.getAttribute('data-testid')?.startsWith('delete-point-'));

      expect(deleteButtons.length).toBeGreaterThan(0);
      await userEvent.click(deleteButtons[0]);

      expect(onChange).toHaveBeenCalledWith('origin_x', -1);
      expect(onChange).toHaveBeenCalledWith('origin_y', -1);
      expect(onChange).toHaveBeenCalledWith('tracking_data', '');
    });
  });

  // =========================================================================
  // Scenario: Tracking stores result in params
  // =========================================================================

  describe('tracking result persisted to params', () => {
    it('should call onChange with tracking_data when tracking completes', async () => {
      const { onChange } = renderPanel({ params: PARAMS_WITH_POINT });

      const trackButton = screen.getByRole('button', { name: /^track$/i });
      await userEvent.click(trackButton);

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith('tracking_data', expect.any(String));
      });

      // Verify the stored data is valid JSON containing keyframes
      const call = onChange.mock.calls.find(
        (c) => c[0] === 'tracking_data' && typeof c[1] === 'string' && c[1] !== '',
      );
      expect(call).toBeDefined();
      const parsed = JSON.parse(call![1] as string);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(5);
    });
  });

  // =========================================================================
  // Scenario: Existing tracking data renders count in MotionTrackingControl
  // =========================================================================

  describe('existing tracking data', () => {
    it('should build track with keyframes from existing tracking_data param', () => {
      const paramsWithData = makeParamsWithTrackingData(5);
      renderPanel({ params: paramsWithData });

      // The MotionTrackingControl should show the keyframe count
      expect(screen.getByText(/5 keyframes/i)).toBeInTheDocument();
    });
  });
});
