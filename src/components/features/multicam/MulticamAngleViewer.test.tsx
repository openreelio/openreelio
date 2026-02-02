/**
 * MulticamAngleViewer Tests
 *
 * Tests for the multicam angle viewer component that displays
 * multiple camera angles in a grid layout.
 *
 * Following TDD methodology.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MulticamAngleViewer } from './MulticamAngleViewer';
import type { MulticamGroup } from '@/utils/multicam';

describe('MulticamAngleViewer', () => {
  const mockGroup: MulticamGroup = {
    id: 'group-1',
    sequenceId: 'seq-1',
    name: 'Test Multicam',
    angles: [
      { id: 'angle-1', clipId: 'clip-1', trackId: 'track-1', label: 'Camera 1' },
      { id: 'angle-2', clipId: 'clip-2', trackId: 'track-2', label: 'Camera 2' },
      { id: 'angle-3', clipId: 'clip-3', trackId: 'track-3', label: 'Camera 3' },
      { id: 'angle-4', clipId: 'clip-4', trackId: 'track-4', label: 'Camera 4' },
    ],
    activeAngleIndex: 0,
    timelineInSec: 0,
    durationSec: 60,
    audioMixMode: 'active',
    angleSwitches: [],
  };

  const defaultProps = {
    group: mockGroup,
    currentTimeSec: 0,
    onAngleSwitch: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render all angles in a grid', () => {
      render(<MulticamAngleViewer {...defaultProps} />);

      expect(screen.getByText('Camera 1')).toBeInTheDocument();
      expect(screen.getByText('Camera 2')).toBeInTheDocument();
      expect(screen.getByText('Camera 3')).toBeInTheDocument();
      expect(screen.getByText('Camera 4')).toBeInTheDocument();
    });

    it('should highlight the active angle', () => {
      render(<MulticamAngleViewer {...defaultProps} />);

      const activePanel = screen.getByTestId('angle-panel-0');
      expect(activePanel).toHaveClass('ring-2');
    });

    it('should show angle numbers as keyboard hints', () => {
      render(<MulticamAngleViewer {...defaultProps} />);

      // Numbers appear both as keyboard hints and default thumbnails
      expect(screen.getAllByText('1').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('3').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('4').length).toBeGreaterThanOrEqual(1);
    });

    it('should render in 2x2 grid by default', () => {
      render(<MulticamAngleViewer {...defaultProps} />);

      const grid = screen.getByTestId('multicam-grid');
      expect(grid).toHaveClass('grid-cols-2');
      expect(grid).toHaveClass('grid-rows-2');
    });

    it('should render with custom grid layout', () => {
      render(
        <MulticamAngleViewer
          {...defaultProps}
          gridLayout={{ rows: 1, cols: 4 }}
        />
      );

      const grid = screen.getByTestId('multicam-grid');
      expect(grid).toHaveClass('grid-cols-4');
      expect(grid).toHaveClass('grid-rows-1');
    });
  });

  describe('interaction', () => {
    it('should call onAngleSwitch when clicking an angle', async () => {
      const onAngleSwitch = vi.fn();
      render(
        <MulticamAngleViewer {...defaultProps} onAngleSwitch={onAngleSwitch} />
      );

      const angle2 = screen.getByTestId('angle-panel-1');
      await userEvent.click(angle2);

      expect(onAngleSwitch).toHaveBeenCalledWith(1);
    });

    it('should not call onAngleSwitch when clicking active angle', async () => {
      const onAngleSwitch = vi.fn();
      render(
        <MulticamAngleViewer {...defaultProps} onAngleSwitch={onAngleSwitch} />
      );

      const activeAngle = screen.getByTestId('angle-panel-0');
      await userEvent.click(activeAngle);

      expect(onAngleSwitch).not.toHaveBeenCalled();
    });

    it('should handle keyboard number shortcuts', async () => {
      const onAngleSwitch = vi.fn();
      render(
        <MulticamAngleViewer {...defaultProps} onAngleSwitch={onAngleSwitch} />
      );

      const container = screen.getByTestId('multicam-viewer');
      fireEvent.keyDown(container, { key: '2' });

      expect(onAngleSwitch).toHaveBeenCalledWith(1);
    });

    it('should show hover state on angle panels', async () => {
      render(<MulticamAngleViewer {...defaultProps} />);

      const angle2 = screen.getByTestId('angle-panel-1');
      await userEvent.hover(angle2);

      expect(angle2).toHaveClass('ring-blue-400');
    });
  });

  describe('disabled state', () => {
    it('should not respond to clicks when disabled', async () => {
      const onAngleSwitch = vi.fn();
      render(
        <MulticamAngleViewer
          {...defaultProps}
          onAngleSwitch={onAngleSwitch}
          disabled
        />
      );

      const angle2 = screen.getByTestId('angle-panel-1');
      await userEvent.click(angle2);

      expect(onAngleSwitch).not.toHaveBeenCalled();
    });

    it('should show disabled styling', () => {
      render(<MulticamAngleViewer {...defaultProps} disabled />);

      const container = screen.getByTestId('multicam-viewer');
      expect(container).toHaveClass('opacity-50');
    });
  });

  describe('recording mode', () => {
    it('should show recording indicator when recording', () => {
      render(<MulticamAngleViewer {...defaultProps} isRecording />);

      expect(screen.getByTestId('recording-indicator')).toBeInTheDocument();
    });

    it('should not show recording indicator when not recording', () => {
      render(<MulticamAngleViewer {...defaultProps} isRecording={false} />);

      expect(screen.queryByTestId('recording-indicator')).not.toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('should show message when group has no angles', () => {
      const emptyGroup: MulticamGroup = {
        ...mockGroup,
        angles: [],
      };

      render(<MulticamAngleViewer {...defaultProps} group={emptyGroup} />);

      expect(screen.getByText(/no angles/i)).toBeInTheDocument();
    });

    it('should show message when group is null', () => {
      render(<MulticamAngleViewer {...defaultProps} group={null} />);

      expect(screen.getByText(/no multicam group/i)).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('should have proper ARIA labels', () => {
      render(<MulticamAngleViewer {...defaultProps} />);

      const viewer = screen.getByTestId('multicam-viewer');
      expect(viewer).toHaveAttribute('role', 'grid');
      expect(viewer).toHaveAttribute('aria-label', 'Multicam angle viewer');
    });

    it('should mark active angle for screen readers', () => {
      render(<MulticamAngleViewer {...defaultProps} />);

      const activePanel = screen.getByTestId('angle-panel-0');
      expect(activePanel).toHaveAttribute('aria-selected', 'true');
    });

    it('should have keyboard instructions', () => {
      render(<MulticamAngleViewer {...defaultProps} />);

      const instructions = screen.getByText(/press 1-4/i);
      expect(instructions).toBeInTheDocument();
    });
  });

  describe('preview thumbnail', () => {
    it('should render thumbnail placeholder for each angle', () => {
      render(<MulticamAngleViewer {...defaultProps} />);

      const thumbnails = screen.getAllByTestId(/angle-thumbnail/);
      expect(thumbnails).toHaveLength(4);
    });

    it('should accept custom thumbnail renderer', () => {
      const renderThumbnail = vi.fn((angle) => (
        <div data-testid={`custom-thumb-${angle.id}`}>Custom</div>
      ));

      render(
        <MulticamAngleViewer
          {...defaultProps}
          renderThumbnail={renderThumbnail}
        />
      );

      expect(screen.getByTestId('custom-thumb-angle-1')).toBeInTheDocument();
      expect(renderThumbnail).toHaveBeenCalledTimes(4);
    });
  });
});
