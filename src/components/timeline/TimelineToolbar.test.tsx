/**
 * TimelineToolbar Component Tests
 *
 * Tests for timeline toolbar with zoom and scroll controls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TimelineToolbar } from './TimelineToolbar';
import { useTimelineStore } from '@/stores/timelineStore';

// =============================================================================
// Tests
// =============================================================================

describe('TimelineToolbar', () => {
  beforeEach(() => {
    // Reset timeline store before each test
    useTimelineStore.setState({
      zoom: 100,
      scrollX: 0,
      scrollY: 0,
    });
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render toolbar container', () => {
      render(<TimelineToolbar />);
      expect(screen.getByTestId('timeline-toolbar')).toBeInTheDocument();
    });

    it('should render zoom in button', () => {
      render(<TimelineToolbar />);
      expect(screen.getByTestId('zoom-in-button')).toBeInTheDocument();
    });

    it('should render zoom out button', () => {
      render(<TimelineToolbar />);
      expect(screen.getByTestId('zoom-out-button')).toBeInTheDocument();
    });

    it('should render zoom slider', () => {
      render(<TimelineToolbar />);
      expect(screen.getByTestId('zoom-slider')).toBeInTheDocument();
    });

    it('should render fit to window button', () => {
      render(<TimelineToolbar />);
      expect(screen.getByTestId('fit-to-window-button')).toBeInTheDocument();
    });

    it('should render zoom percentage display', () => {
      render(<TimelineToolbar />);
      expect(screen.getByTestId('zoom-display')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Zoom Controls Tests
  // ===========================================================================

  describe('zoom controls', () => {
    it('should call zoomIn when zoom in button is clicked', () => {
      render(<TimelineToolbar />);

      const zoomInButton = screen.getByTestId('zoom-in-button');
      fireEvent.click(zoomInButton);

      // Default zoom is 100, after zoom in should be higher
      expect(useTimelineStore.getState().zoom).toBeGreaterThan(100);
    });

    it('should call zoomOut when zoom out button is clicked', () => {
      render(<TimelineToolbar />);

      const zoomOutButton = screen.getByTestId('zoom-out-button');
      fireEvent.click(zoomOutButton);

      // Default zoom is 100, after zoom out should be lower
      expect(useTimelineStore.getState().zoom).toBeLessThan(100);
    });

    it('should update zoom when slider is changed', () => {
      render(<TimelineToolbar />);

      const slider = screen.getByTestId('zoom-slider');
      fireEvent.change(slider, { target: { value: '200' } });

      expect(useTimelineStore.getState().zoom).toBe(200);
    });

    it('should display current zoom percentage', () => {
      useTimelineStore.setState({ zoom: 150 });
      render(<TimelineToolbar />);

      expect(screen.getByTestId('zoom-display')).toHaveTextContent('150%');
    });

    it('should disable zoom in button at max zoom', () => {
      useTimelineStore.setState({ zoom: 500 }); // MAX_ZOOM
      render(<TimelineToolbar />);

      const zoomInButton = screen.getByTestId('zoom-in-button');
      expect(zoomInButton).toBeDisabled();
    });

    it('should disable zoom out button at min zoom', () => {
      useTimelineStore.setState({ zoom: 10 }); // MIN_ZOOM
      render(<TimelineToolbar />);

      const zoomOutButton = screen.getByTestId('zoom-out-button');
      expect(zoomOutButton).toBeDisabled();
    });
  });

  // ===========================================================================
  // Fit to Window Tests
  // ===========================================================================

  describe('fit to window', () => {
    it('should call onFitToWindow when fit button is clicked', () => {
      const onFitToWindow = vi.fn();
      render(<TimelineToolbar onFitToWindow={onFitToWindow} />);

      const fitButton = screen.getByTestId('fit-to-window-button');
      fireEvent.click(fitButton);

      expect(onFitToWindow).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Snap Toggle Tests
  // ===========================================================================

  describe('snap toggle', () => {
    it('should render snap toggle button', () => {
      render(<TimelineToolbar />);
      expect(screen.getByTestId('snap-toggle-button')).toBeInTheDocument();
    });

    it('should toggle snap when clicked', () => {
      useTimelineStore.setState({ snapEnabled: true });
      render(<TimelineToolbar />);

      const snapButton = screen.getByTestId('snap-toggle-button');
      fireEvent.click(snapButton);

      expect(useTimelineStore.getState().snapEnabled).toBe(false);
    });

    it('should show active state when snap is enabled', () => {
      useTimelineStore.setState({ snapEnabled: true });
      render(<TimelineToolbar />);

      const snapButton = screen.getByTestId('snap-toggle-button');
      expect(snapButton).toHaveAttribute('aria-pressed', 'true');
    });
  });

  // ===========================================================================
  // Keyboard Shortcuts Tests
  // ===========================================================================

  describe('keyboard shortcuts', () => {
    it('should zoom in on Ctrl+Plus', () => {
      render(<TimelineToolbar />);

      const toolbar = screen.getByTestId('timeline-toolbar');
      fireEvent.keyDown(toolbar, { key: '+', ctrlKey: true });

      expect(useTimelineStore.getState().zoom).toBeGreaterThan(100);
    });

    it('should zoom out on Ctrl+Minus', () => {
      render(<TimelineToolbar />);

      const toolbar = screen.getByTestId('timeline-toolbar');
      fireEvent.keyDown(toolbar, { key: '-', ctrlKey: true });

      expect(useTimelineStore.getState().zoom).toBeLessThan(100);
    });

    it('should fit to window on Ctrl+0', () => {
      const onFitToWindow = vi.fn();
      render(<TimelineToolbar onFitToWindow={onFitToWindow} />);

      const toolbar = screen.getByTestId('timeline-toolbar');
      fireEvent.keyDown(toolbar, { key: '0', ctrlKey: true });

      expect(onFitToWindow).toHaveBeenCalled();
    });
  });
});
