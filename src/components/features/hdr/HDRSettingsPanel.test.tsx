/**
 * HDRSettingsPanel Component Tests
 *
 * TDD: RED phase - Writing tests first
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HDRSettingsPanel } from './HDRSettingsPanel';

// =============================================================================
// Mocks
// =============================================================================

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// =============================================================================
// Test Suite
// =============================================================================

describe('HDRSettingsPanel', () => {
  const defaultProps = {
    sequenceId: 'seq-123',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue({ success: true });
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render the HDR settings panel', () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      expect(screen.getByTestId('hdr-settings-panel')).toBeInTheDocument();
    });

    it('should render panel header', () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      expect(screen.getByText(/hdr settings/i)).toBeInTheDocument();
    });

    it('should render HDR mode selector', () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      expect(screen.getByLabelText(/hdr mode/i)).toBeInTheDocument();
    });

    it('should render SDR mode by default', () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      const modeSelect = screen.getByLabelText(/hdr mode/i);
      expect(modeSelect).toHaveValue('sdr');
    });

    it('should render bit depth selector', () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      expect(screen.getByLabelText(/bit depth/i)).toBeInTheDocument();
    });

    it('should not render luminance settings in SDR mode', () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      expect(screen.queryByLabelText(/max cll/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/max fall/i)).not.toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(<HDRSettingsPanel {...defaultProps} className="custom-class" />);

      expect(screen.getByTestId('hdr-settings-panel')).toHaveClass('custom-class');
    });
  });

  // ===========================================================================
  // HDR Mode Tests
  // ===========================================================================

  describe('HDR mode selection', () => {
    it('should switch to HDR10 mode', () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      const modeSelect = screen.getByLabelText(/hdr mode/i);
      fireEvent.change(modeSelect, { target: { value: 'hdr10' } });

      expect(modeSelect).toHaveValue('hdr10');
    });

    it('should switch to HLG mode', () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      const modeSelect = screen.getByLabelText(/hdr mode/i);
      fireEvent.change(modeSelect, { target: { value: 'hlg' } });

      expect(modeSelect).toHaveValue('hlg');
    });

    it('should show luminance settings when HDR mode is selected', () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      const modeSelect = screen.getByLabelText(/hdr mode/i);
      fireEvent.change(modeSelect, { target: { value: 'hdr10' } });

      expect(screen.getByLabelText(/max cll/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/max fall/i)).toBeInTheDocument();
    });

    it('should auto-upgrade bit depth when switching to HDR', () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      // Default is 8-bit
      const bitDepthSelect = screen.getByLabelText(/bit depth/i);
      expect(bitDepthSelect).toHaveValue('8');

      // Switch to HDR10
      const modeSelect = screen.getByLabelText(/hdr mode/i);
      fireEvent.change(modeSelect, { target: { value: 'hdr10' } });

      // Should auto-upgrade to 10-bit
      expect(bitDepthSelect).toHaveValue('10');
    });
  });

  // ===========================================================================
  // Luminance Settings Tests
  // ===========================================================================

  describe('luminance settings', () => {
    it('should update Max CLL', () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      // Enable HDR first
      const modeSelect = screen.getByLabelText(/hdr mode/i);
      fireEvent.change(modeSelect, { target: { value: 'hdr10' } });

      // Change Max CLL
      const cllInput = screen.getByLabelText(/max cll/i);
      fireEvent.change(cllInput, { target: { value: '1500' } });

      expect(cllInput).toHaveValue('1500');
    });

    it('should update Max FALL', () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      // Enable HDR first
      const modeSelect = screen.getByLabelText(/hdr mode/i);
      fireEvent.change(modeSelect, { target: { value: 'hdr10' } });

      // Change Max FALL
      const fallInput = screen.getByLabelText(/max fall/i);
      fireEvent.change(fallInput, { target: { value: '600' } });

      expect(fallInput).toHaveValue('600');
    });
  });

  // ===========================================================================
  // Preset Tests
  // ===========================================================================

  describe('presets', () => {
    it('should render preset buttons', () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      expect(screen.getByRole('button', { name: /sdr preset/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /hdr10 preset/i })).toBeInTheDocument();
    });

    it('should apply HDR10 preset', () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /hdr10 preset/i }));

      expect(screen.getByLabelText(/hdr mode/i)).toHaveValue('hdr10');
      expect(screen.getByLabelText(/bit depth/i)).toHaveValue('10');
    });

    it('should apply SDR preset', () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      // First set to HDR10
      fireEvent.click(screen.getByRole('button', { name: /hdr10 preset/i }));
      expect(screen.getByLabelText(/hdr mode/i)).toHaveValue('hdr10');

      // Then apply SDR preset
      fireEvent.click(screen.getByRole('button', { name: /sdr preset/i }));
      expect(screen.getByLabelText(/hdr mode/i)).toHaveValue('sdr');
    });
  });

  // ===========================================================================
  // Validation Tests
  // ===========================================================================

  describe('validation', () => {
    it('should show warning when HDR with 8-bit depth', () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      // Enable HDR
      const modeSelect = screen.getByLabelText(/hdr mode/i);
      fireEvent.change(modeSelect, { target: { value: 'hdr10' } });

      // Force 8-bit (this would typically be prevented by auto-upgrade)
      const bitDepthSelect = screen.getByLabelText(/bit depth/i);
      fireEvent.change(bitDepthSelect, { target: { value: '8' } });

      expect(screen.getByText(/requires 10-bit or higher/i)).toBeInTheDocument();
    });

    it('should show codec compatibility info', () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      // Enable HDR
      const modeSelect = screen.getByLabelText(/hdr mode/i);
      fireEvent.change(modeSelect, { target: { value: 'hdr10' } });

      expect(screen.getByText(/h\.265|hevc/i)).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Save Tests
  // ===========================================================================

  describe('save', () => {
    it('should save settings on apply button click', async () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      // Make changes
      const modeSelect = screen.getByLabelText(/hdr mode/i);
      fireEvent.change(modeSelect, { target: { value: 'hdr10' } });

      // Click apply
      fireEvent.click(screen.getByRole('button', { name: /apply/i }));

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
          commandType: 'UpdateSequenceHdrSettings',
          payload: expect.objectContaining({
            sequenceId: 'seq-123',
            settings: expect.objectContaining({
              hdrMode: 'hdr10',
            }),
          }),
        });
      });
    });

    it('should show success message after save', async () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      // Click apply
      fireEvent.click(screen.getByRole('button', { name: /apply/i }));

      await waitFor(() => {
        expect(screen.getByText(/saved/i)).toBeInTheDocument();
      });
    });
  });

  // ===========================================================================
  // Reset Tests
  // ===========================================================================

  describe('reset', () => {
    it('should reset to defaults', () => {
      render(<HDRSettingsPanel {...defaultProps} />);

      // Make changes
      const modeSelect = screen.getByLabelText(/hdr mode/i);
      fireEvent.change(modeSelect, { target: { value: 'hdr10' } });

      expect(modeSelect).toHaveValue('hdr10');

      // Reset
      fireEvent.click(screen.getByRole('button', { name: /^reset$/i }));

      expect(modeSelect).toHaveValue('sdr');
    });
  });

  // ===========================================================================
  // Collapsed State Tests
  // ===========================================================================

  describe('collapsed state', () => {
    it('should support collapsed mode', () => {
      render(<HDRSettingsPanel {...defaultProps} collapsed />);

      // Content should be hidden
      expect(screen.queryByLabelText(/hdr mode/i)).not.toBeInTheDocument();
    });

    it('should toggle collapsed state', () => {
      render(<HDRSettingsPanel {...defaultProps} collapsible />);

      // Should be expanded initially
      expect(screen.getByLabelText(/hdr mode/i)).toBeInTheDocument();

      // Click header to collapse
      fireEvent.click(screen.getByText(/hdr settings/i));

      // Should be collapsed
      expect(screen.queryByLabelText(/hdr mode/i)).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Disabled State Tests
  // ===========================================================================

  describe('disabled state', () => {
    it('should disable all controls when disabled', () => {
      render(<HDRSettingsPanel {...defaultProps} disabled />);

      expect(screen.getByLabelText(/hdr mode/i)).toBeDisabled();
      expect(screen.getByLabelText(/bit depth/i)).toBeDisabled();
    });
  });
});
