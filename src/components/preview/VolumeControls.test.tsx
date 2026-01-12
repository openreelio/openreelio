/**
 * VolumeControls Component Tests
 *
 * Tests for the volume control UI.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VolumeControls } from './VolumeControls';

// =============================================================================
// Tests
// =============================================================================

describe('VolumeControls', () => {
  const defaultProps = {
    volume: 0.7,
    isMuted: false,
  };

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render volume controls container', () => {
      render(<VolumeControls {...defaultProps} />);
      expect(screen.getByTestId('volume-controls')).toBeInTheDocument();
    });

    it('should render volume button', () => {
      render(<VolumeControls {...defaultProps} />);
      expect(screen.getByTestId('volume-button')).toBeInTheDocument();
    });

    it('should render volume slider', () => {
      render(<VolumeControls {...defaultProps} />);
      expect(screen.getByTestId('volume-slider')).toBeInTheDocument();
    });

    it('should show muted icon when muted', () => {
      render(<VolumeControls {...defaultProps} isMuted={true} />);
      expect(screen.getByTestId('mute-icon')).toBeInTheDocument();
    });

    it('should show high volume icon when volume >= 0.5', () => {
      render(<VolumeControls {...defaultProps} volume={0.7} />);
      expect(screen.getByTestId('volume-high-icon')).toBeInTheDocument();
    });

    it('should show low volume icon when volume < 0.5', () => {
      render(<VolumeControls {...defaultProps} volume={0.3} />);
      expect(screen.getByTestId('volume-low-icon')).toBeInTheDocument();
    });

    it('should show muted icon when volume is 0', () => {
      render(<VolumeControls {...defaultProps} volume={0} />);
      expect(screen.getByTestId('mute-icon')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  describe('interactions', () => {
    it('should call onMuteToggle when volume button clicked', () => {
      const onMuteToggle = vi.fn();
      render(<VolumeControls {...defaultProps} onMuteToggle={onMuteToggle} />);

      fireEvent.click(screen.getByTestId('volume-button'));

      expect(onMuteToggle).toHaveBeenCalled();
    });

    it('should call onVolumeChange when slider changes', () => {
      const onVolumeChange = vi.fn();
      render(<VolumeControls {...defaultProps} onVolumeChange={onVolumeChange} />);

      fireEvent.change(screen.getByTestId('volume-slider'), { target: { value: '0.5' } });

      expect(onVolumeChange).toHaveBeenCalledWith(0.5);
    });

    it('should not call handlers when disabled', () => {
      const onMuteToggle = vi.fn();
      const onVolumeChange = vi.fn();
      render(
        <VolumeControls
          {...defaultProps}
          onMuteToggle={onMuteToggle}
          onVolumeChange={onVolumeChange}
          disabled
        />
      );

      fireEvent.click(screen.getByTestId('volume-button'));
      fireEvent.change(screen.getByTestId('volume-slider'), { target: { value: '0.5' } });

      expect(onMuteToggle).not.toHaveBeenCalled();
      expect(onVolumeChange).not.toHaveBeenCalled();
    });

    it('should show 0 on slider when muted', () => {
      render(<VolumeControls {...defaultProps} volume={0.7} isMuted={true} />);
      const slider = screen.getByTestId('volume-slider') as HTMLInputElement;
      expect(slider.value).toBe('0');
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('accessibility', () => {
    it('should have aria-label on volume button', () => {
      render(<VolumeControls {...defaultProps} />);
      expect(screen.getByTestId('volume-button')).toHaveAttribute('aria-label', 'Toggle mute');
    });

    it('should have aria-label on volume slider', () => {
      render(<VolumeControls {...defaultProps} />);
      expect(screen.getByTestId('volume-slider')).toHaveAttribute('aria-label', 'Volume');
    });
  });
});
