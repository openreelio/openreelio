/**
 * MotionTrackingControl Tests
 *
 * Tests for the motion tracking control component.
 * Following TDD methodology.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionTrackingControl } from './MotionTrackingControl';
import type { MotionTrack } from '@/utils/motionTracking';
import { createMotionTrack, createTrackPoint } from '@/utils/motionTracking';

describe('MotionTrackingControl', () => {
  const mockTrack: MotionTrack = {
    ...createMotionTrack('clip-1'),
    points: [
      {
        ...createTrackPoint(100, 100),
        id: 'point-1',
        name: 'Point 1',
        keyframes: [
          { time: 0, x: 100, y: 100, confidence: 1 },
          { time: 1, x: 150, y: 120, confidence: 0.95 },
        ],
      },
    ],
    regions: [],
  };

  const defaultProps = {
    track: mockTrack,
    currentTime: 0,
    onTrackChange: vi.fn(),
    onAddPoint: vi.fn(),
    onRemovePoint: vi.fn(),
    onStartTracking: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render motion tracking header', () => {
      render(<MotionTrackingControl {...defaultProps} />);

      expect(screen.getByText(/motion tracking/i)).toBeInTheDocument();
    });

    it('should render tracking method selector', () => {
      render(<MotionTrackingControl {...defaultProps} />);

      expect(screen.getByTestId('method-selector')).toBeInTheDocument();
    });

    it('should render track points list', () => {
      render(<MotionTrackingControl {...defaultProps} />);

      expect(screen.getByText('Point 1')).toBeInTheDocument();
    });

    it('should render add point button', () => {
      render(<MotionTrackingControl {...defaultProps} />);

      expect(screen.getByRole('button', { name: /add point/i })).toBeInTheDocument();
    });

    it('should render track button', () => {
      render(<MotionTrackingControl {...defaultProps} />);

      expect(screen.getByRole('button', { name: /^track$/i })).toBeInTheDocument();
    });

    it('should show empty state when no track points', () => {
      const emptyTrack = { ...mockTrack, points: [], regions: [] };
      render(<MotionTrackingControl {...defaultProps} track={emptyTrack} />);

      expect(screen.getByText(/no track points/i)).toBeInTheDocument();
    });
  });

  describe('method selection', () => {
    it('should show current tracking method', () => {
      render(<MotionTrackingControl {...defaultProps} />);

      const selector = screen.getByTestId('method-selector');
      expect(selector).toHaveTextContent(/point tracking/i);
    });

    it('should open method dropdown when clicked', async () => {
      render(<MotionTrackingControl {...defaultProps} />);

      const selector = screen.getByTestId('method-selector');
      await userEvent.click(selector);

      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    it('should call onTrackChange when method is changed', async () => {
      const onTrackChange = vi.fn();
      render(
        <MotionTrackingControl {...defaultProps} onTrackChange={onTrackChange} />
      );

      const selector = screen.getByTestId('method-selector');
      await userEvent.click(selector);

      const regionOption = screen.getByRole('option', { name: /region/i });
      await userEvent.click(regionOption);

      expect(onTrackChange).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ method: 'region' }),
        })
      );
    });
  });

  describe('track points', () => {
    it('should display all track points', () => {
      const trackWithMultiplePoints: MotionTrack = {
        ...mockTrack,
        points: [
          { ...createTrackPoint(0, 0), id: 'p1', name: 'Point A' },
          { ...createTrackPoint(50, 50), id: 'p2', name: 'Point B' },
        ],
      };

      render(
        <MotionTrackingControl {...defaultProps} track={trackWithMultiplePoints} />
      );

      expect(screen.getByText('Point A')).toBeInTheDocument();
      expect(screen.getByText('Point B')).toBeInTheDocument();
    });

    it('should highlight selected point', async () => {
      render(<MotionTrackingControl {...defaultProps} />);

      const pointItem = screen.getByTestId('track-point-point-1');
      await userEvent.click(pointItem);

      expect(pointItem).toHaveClass('ring-2');
    });

    it('should show keyframe count for each point', () => {
      render(<MotionTrackingControl {...defaultProps} />);

      expect(screen.getByText(/2 keyframes/i)).toBeInTheDocument();
    });

    it('should show confidence indicator', () => {
      render(<MotionTrackingControl {...defaultProps} />);

      expect(screen.getByTestId('confidence-indicator')).toBeInTheDocument();
    });
  });

  describe('add point', () => {
    it('should call onAddPoint when add button is clicked', async () => {
      const onAddPoint = vi.fn();
      render(<MotionTrackingControl {...defaultProps} onAddPoint={onAddPoint} />);

      const addButton = screen.getByRole('button', { name: /add point/i });
      await userEvent.click(addButton);

      expect(onAddPoint).toHaveBeenCalled();
    });
  });

  describe('remove point', () => {
    it('should call onRemovePoint when delete button is clicked', async () => {
      const onRemovePoint = vi.fn();
      render(
        <MotionTrackingControl {...defaultProps} onRemovePoint={onRemovePoint} />
      );

      const deleteButton = screen.getByTestId('delete-point-point-1');
      await userEvent.click(deleteButton);

      expect(onRemovePoint).toHaveBeenCalledWith('point-1');
    });
  });

  describe('tracking controls', () => {
    it('should call onStartTracking when track button is clicked', async () => {
      const onStartTracking = vi.fn();
      render(
        <MotionTrackingControl {...defaultProps} onStartTracking={onStartTracking} />
      );

      const trackButton = screen.getByRole('button', { name: /^track$/i });
      await userEvent.click(trackButton);

      expect(onStartTracking).toHaveBeenCalled();
    });

    it('should show tracking progress when tracking', () => {
      render(<MotionTrackingControl {...defaultProps} isTracking />);

      expect(screen.getByTestId('tracking-progress')).toBeInTheDocument();
    });

    it('should disable controls when tracking', () => {
      render(<MotionTrackingControl {...defaultProps} isTracking />);

      const addButton = screen.getByRole('button', { name: /add point/i });
      expect(addButton).toBeDisabled();
    });

    it('should show stop button when tracking', () => {
      render(<MotionTrackingControl {...defaultProps} isTracking />);

      expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
    });

    it('should disable stop button when onStopTracking is not provided', () => {
      render(<MotionTrackingControl {...defaultProps} isTracking />);

      const stopButton = screen.getByRole('button', { name: /stop/i });
      expect(stopButton).toBeDisabled();
    });

    it('should call onStopTracking when stop button is clicked', async () => {
      const onStopTracking = vi.fn();
      render(
        <MotionTrackingControl
          {...defaultProps}
          isTracking
          onStopTracking={onStopTracking}
        />
      );

      const stopButton = screen.getByRole('button', { name: /stop/i });
      expect(stopButton).not.toBeDisabled();

      await userEvent.click(stopButton);
      expect(onStopTracking).toHaveBeenCalled();
    });
  });

  describe('settings panel', () => {
    it('should show settings when expanded', async () => {
      render(<MotionTrackingControl {...defaultProps} />);

      const settingsToggle = screen.getByRole('button', { name: /settings/i });
      await userEvent.click(settingsToggle);

      expect(screen.getByText(/search area/i)).toBeInTheDocument();
      expect(screen.getByText(/pattern size/i)).toBeInTheDocument();
    });

    it('should update search area size', async () => {
      const onTrackChange = vi.fn();
      render(
        <MotionTrackingControl {...defaultProps} onTrackChange={onTrackChange} />
      );

      const settingsToggle = screen.getByRole('button', { name: /settings/i });
      await userEvent.click(settingsToggle);

      const searchAreaSlider = screen.getByRole('slider', { name: /search area/i });
      fireEvent.change(searchAreaSlider, { target: { value: '150' } });

      expect(onTrackChange).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ searchAreaSize: 150 }),
        })
      );
    });
  });

  describe('disabled state', () => {
    it('should disable all controls when disabled', () => {
      render(<MotionTrackingControl {...defaultProps} disabled />);

      const addButton = screen.getByRole('button', { name: /add point/i });
      const trackButton = screen.getByRole('button', { name: /^track$/i });

      expect(addButton).toBeDisabled();
      expect(trackButton).toBeDisabled();
    });

    it('should show disabled styling', () => {
      render(<MotionTrackingControl {...defaultProps} disabled />);

      const container = screen.getByTestId('motion-tracking-control');
      expect(container).toHaveClass('opacity-50');
    });
  });

  describe('locked state', () => {
    it('should show locked indicator when track is locked', () => {
      const lockedTrack = { ...mockTrack, locked: true };
      render(<MotionTrackingControl {...defaultProps} track={lockedTrack} />);

      expect(screen.getByTestId('locked-indicator')).toBeInTheDocument();
    });

    it('should disable editing when locked', () => {
      const lockedTrack = { ...mockTrack, locked: true };
      render(<MotionTrackingControl {...defaultProps} track={lockedTrack} />);

      const addButton = screen.getByRole('button', { name: /add point/i });
      expect(addButton).toBeDisabled();
    });
  });

  describe('accessibility', () => {
    it('should have proper ARIA labels', () => {
      render(<MotionTrackingControl {...defaultProps} />);

      expect(screen.getByRole('button', { name: /add point/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^track$/i })).toBeInTheDocument();
    });

    it('should have accessible track point items', () => {
      render(<MotionTrackingControl {...defaultProps} />);

      const pointItem = screen.getByTestId('track-point-point-1');
      expect(pointItem).toHaveAttribute('role', 'listitem');
    });
  });
});
