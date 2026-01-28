/**
 * PreviewToolbar Component Tests
 *
 * Tests for the preview zoom toolbar:
 * - Zoom controls (in/out buttons)
 * - Zoom mode selection (fit/fill/custom)
 * - Zoom presets dropdown
 * - Reset view functionality
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PreviewToolbar } from './PreviewToolbar';
import { usePreviewStore } from '@/stores/previewStore';

describe('PreviewToolbar', () => {
  beforeEach(() => {
    // Reset store to initial state
    usePreviewStore.setState({
      zoomLevel: 1.0,
      zoomMode: 'fit',
      panX: 0,
      panY: 0,
      isPanning: false,
    });
  });

  // ===========================================================================
  // Rendering
  // ===========================================================================

  describe('rendering', () => {
    it('should render toolbar', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      expect(screen.getByTestId('preview-toolbar')).toBeInTheDocument();
    });

    it('should render zoom in button', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      expect(screen.getByLabelText('Zoom in')).toBeInTheDocument();
    });

    it('should render zoom out button', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      expect(screen.getByLabelText('Zoom out')).toBeInTheDocument();
    });

    it('should render fit button', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      expect(screen.getByLabelText('Fit to window')).toBeInTheDocument();
    });

    it('should render reset button', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      expect(screen.getByLabelText('Reset view')).toBeInTheDocument();
    });

    it('should display current zoom mode label', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      expect(screen.getByText('Fit')).toBeInTheDocument();
    });

    it('should display custom zoom percentage when in custom mode', () => {
      render(<PreviewToolbar zoomPercentage="150%" zoomMode="custom" />);

      expect(screen.getByText('150%')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Zoom In/Out
  // ===========================================================================

  describe('zoom in/out', () => {
    it('should call zoomIn when zoom in button is clicked', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      const initialZoom = usePreviewStore.getState().zoomLevel;

      fireEvent.click(screen.getByLabelText('Zoom in'));

      expect(usePreviewStore.getState().zoomLevel).toBeGreaterThan(initialZoom);
    });

    it('should call zoomOut when zoom out button is clicked', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      const initialZoom = usePreviewStore.getState().zoomLevel;

      fireEvent.click(screen.getByLabelText('Zoom out'));

      expect(usePreviewStore.getState().zoomLevel).toBeLessThan(initialZoom);
    });
  });

  // ===========================================================================
  // Fit Button
  // ===========================================================================

  describe('fit button', () => {
    it('should set zoom mode to fit when clicked', () => {
      usePreviewStore.setState({ zoomMode: 'custom' });

      render(<PreviewToolbar zoomPercentage="150%" zoomMode="custom" />);

      fireEvent.click(screen.getByLabelText('Fit to window'));

      expect(usePreviewStore.getState().zoomMode).toBe('fit');
    });

    it('should highlight fit button when in fit mode', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      const fitButton = screen.getByLabelText('Fit to window');
      expect(fitButton).toHaveClass('text-accent-primary');
    });
  });

  // ===========================================================================
  // Reset Button
  // ===========================================================================

  describe('reset button', () => {
    it('should reset view when clicked', () => {
      usePreviewStore.setState({
        zoomMode: 'custom',
        zoomLevel: 2.0,
        panX: 100,
        panY: 50,
      });

      render(<PreviewToolbar zoomPercentage="200%" zoomMode="custom" />);

      fireEvent.click(screen.getByLabelText('Reset view'));

      const state = usePreviewStore.getState();
      expect(state.zoomMode).toBe('fit');
      expect(state.zoomLevel).toBe(1.0);
      expect(state.panX).toBe(0);
      expect(state.panY).toBe(0);
    });
  });

  // ===========================================================================
  // Dropdown
  // ===========================================================================

  describe('dropdown', () => {
    it('should open dropdown when clicking zoom button', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      // Click the dropdown button (shows current mode)
      fireEvent.click(screen.getByText('Fit'));

      // Should show dropdown options
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    it('should show Fit and Fill options in dropdown', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      fireEvent.click(screen.getByText('Fit'));

      expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
      // Fit option (in dropdown, not the main button)
      const fitOptions = screen.getAllByText('Fit');
      expect(fitOptions.length).toBeGreaterThan(0);
      expect(screen.getByText('Fill')).toBeInTheDocument();
    });

    it('should show zoom presets in dropdown', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      fireEvent.click(screen.getByText('Fit'));

      // Should show at least some presets
      expect(screen.getByText('100%')).toBeInTheDocument();
      expect(screen.getByText('50%')).toBeInTheDocument();
    });

    it('should close dropdown when clicking outside', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      // Open dropdown
      fireEvent.click(screen.getByText('Fit'));
      expect(screen.getByRole('listbox')).toBeInTheDocument();

      // Click outside
      fireEvent.mouseDown(document.body);

      // Dropdown should close
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('should set zoom mode when selecting Fit', () => {
      usePreviewStore.setState({ zoomMode: 'custom' });

      render(<PreviewToolbar zoomPercentage="150%" zoomMode="custom" />);

      fireEvent.click(screen.getByText('150%'));

      // Click Fit in dropdown
      const fitButtons = screen.getAllByText('Fit');
      // Find the one in the dropdown (not the button label)
      const fitOption = fitButtons.find((btn) => btn.getAttribute('role') === 'option');
      if (fitOption) {
        fireEvent.click(fitOption);
      }

      expect(usePreviewStore.getState().zoomMode).toBe('fit');
    });

    it('should set zoom mode when selecting Fill', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      fireEvent.click(screen.getByText('Fit'));
      fireEvent.click(screen.getByText('Fill'));

      expect(usePreviewStore.getState().zoomMode).toBe('fill');
    });

    it('should set zoom level when selecting a preset', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      fireEvent.click(screen.getByText('Fit'));
      fireEvent.click(screen.getByText('200%'));

      expect(usePreviewStore.getState().zoomLevel).toBe(2.0);
      expect(usePreviewStore.getState().zoomMode).toBe('custom');
    });

    it('should close dropdown after selecting an option', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      fireEvent.click(screen.getByText('Fit'));
      expect(screen.getByRole('listbox')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Fill'));
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Mode Labels
  // ===========================================================================

  describe('mode labels', () => {
    it('should show "Fit" when mode is fit', () => {
      render(<PreviewToolbar zoomPercentage="50%" zoomMode="fit" />);

      expect(screen.getByText('Fit')).toBeInTheDocument();
    });

    it('should show "Fill" when mode is fill', () => {
      render(<PreviewToolbar zoomPercentage="75%" zoomMode="fill" />);

      expect(screen.getByText('Fill')).toBeInTheDocument();
    });

    it('should show "100%" when mode is 100%', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="100%" />);

      expect(screen.getByText('100%')).toBeInTheDocument();
    });

    it('should show zoom percentage when mode is custom', () => {
      render(<PreviewToolbar zoomPercentage="175%" zoomMode="custom" />);

      expect(screen.getByText('175%')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Accessibility
  // ===========================================================================

  describe('accessibility', () => {
    it('should have aria-label on all buttons', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      expect(screen.getByLabelText('Zoom in')).toBeInTheDocument();
      expect(screen.getByLabelText('Zoom out')).toBeInTheDocument();
      expect(screen.getByLabelText('Fit to window')).toBeInTheDocument();
      expect(screen.getByLabelText('Reset view')).toBeInTheDocument();
    });

    it('should have aria-haspopup on dropdown button', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      const dropdownButton = screen.getByText('Fit').closest('button');
      expect(dropdownButton).toHaveAttribute('aria-haspopup', 'listbox');
    });

    it('should have aria-expanded on dropdown button', () => {
      render(<PreviewToolbar zoomPercentage="100%" zoomMode="fit" />);

      const dropdownButton = screen.getByText('Fit').closest('button');
      expect(dropdownButton).toHaveAttribute('aria-expanded', 'false');

      fireEvent.click(dropdownButton!);
      expect(dropdownButton).toHaveAttribute('aria-expanded', 'true');
    });
  });
});
