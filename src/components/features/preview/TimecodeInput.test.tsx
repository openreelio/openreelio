/**
 * TimecodeInput Component Tests (BDD)
 *
 * Feature: Timecode Entry & Jump
 *   Click on timecode display to enter SMPTE timecode, press Enter to jump playhead.
 *
 *   Scenario: Click activates edit mode
 *     Given the timecode display shows current time in SMPTE format
 *     When the user clicks on the timecode display
 *     Then it becomes an editable input pre-filled with current timecode
 *
 *   Scenario: Valid timecode entry jumps playhead
 *     Given the input is in edit mode
 *     When the user types a valid SMPTE timecode and presses Enter
 *     Then onSeek is called with the corresponding time in seconds
 *     And the display exits edit mode
 *
 *   Scenario: Invalid timecode shows error
 *     Given the input is in edit mode
 *     When the user types an invalid timecode and presses Enter
 *     Then onSeek is NOT called
 *     And the input shows a visual error (red border)
 *
 *   Scenario: Timecode beyond duration shows error
 *     Given the input is in edit mode and duration is 60s
 *     When the user types "00:02:00:00" (120s) and presses Enter
 *     Then onSeek is NOT called
 *     And the input shows a visual error
 *
 *   Scenario: Escape cancels edit
 *     Given the input is in edit mode
 *     When the user presses Escape
 *     Then the display exits edit mode without seeking
 *
 *   Scenario: Blur cancels edit
 *     Given the input is in edit mode
 *     When the input loses focus
 *     Then the display exits edit mode without seeking
 *
 *   Scenario: Numpad entry accepted
 *     Given the input is in edit mode
 *     When the user types digits (numpad or regular)
 *     Then the digits are accepted as timecode input
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TimecodeInput } from './TimecodeInput';

// =============================================================================
// Test Helpers
// =============================================================================

function defaultProps(overrides: Partial<React.ComponentProps<typeof TimecodeInput>> = {}) {
  return {
    currentTime: 61.5, // 00:01:01:15 at 30fps
    duration: 300,
    fps: 30,
    onSeek: vi.fn(),
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('TimecodeInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Display mode
  // ---------------------------------------------------------------------------

  describe('display mode', () => {
    it('should show SMPTE timecode when not editing', () => {
      render(<TimecodeInput {...defaultProps()} />);
      const display = screen.getByTestId('timecode-display');
      expect(display.textContent).toBe('00:01:01:15');
    });

    it('should show 00:00:00:00 for zero time', () => {
      render(<TimecodeInput {...defaultProps({ currentTime: 0 })} />);
      expect(screen.getByTestId('timecode-display').textContent).toBe('00:00:00:00');
    });

    it('should be accessible with aria-label', () => {
      render(<TimecodeInput {...defaultProps()} />);
      expect(screen.getByLabelText('Click to enter timecode')).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Entering edit mode
  // ---------------------------------------------------------------------------

  describe('entering edit mode', () => {
    it('should switch to input when clicked', async () => {
      const user = userEvent.setup();
      render(<TimecodeInput {...defaultProps()} />);

      await user.click(screen.getByTestId('timecode-display'));

      const input = screen.getByTestId('timecode-input');
      expect(input).toBeInTheDocument();
      expect(input).toHaveValue('00:01:01:15');
    });

    it('should not show display button while editing', async () => {
      const user = userEvent.setup();
      render(<TimecodeInput {...defaultProps()} />);

      await user.click(screen.getByTestId('timecode-display'));

      expect(screen.queryByTestId('timecode-display')).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Valid timecode entry
  // ---------------------------------------------------------------------------

  describe('valid timecode entry', () => {
    it('should jump playhead when Enter pressed with valid timecode', async () => {
      const onSeek = vi.fn();
      const user = userEvent.setup();
      render(<TimecodeInput {...defaultProps({ onSeek })} />);

      await user.click(screen.getByTestId('timecode-display'));
      const input = screen.getByTestId('timecode-input');

      await user.clear(input);
      await user.type(input, '00:02:00:00');
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onSeek).toHaveBeenCalledWith(120);
      // Should exit edit mode
      expect(screen.queryByTestId('timecode-input')).not.toBeInTheDocument();
      expect(screen.getByTestId('timecode-display')).toBeInTheDocument();
    });

    it('should accept zero timecode', async () => {
      const onSeek = vi.fn();
      const user = userEvent.setup();
      render(<TimecodeInput {...defaultProps({ onSeek })} />);

      await user.click(screen.getByTestId('timecode-display'));
      const input = screen.getByTestId('timecode-input');

      fireEvent.change(input, { target: { value: '00:00:00:00' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onSeek).toHaveBeenCalledWith(0);
    });

    it('should accept timecode with frames', async () => {
      const onSeek = vi.fn();
      const user = userEvent.setup();
      render(<TimecodeInput {...defaultProps({ onSeek })} />);

      await user.click(screen.getByTestId('timecode-display'));
      const input = screen.getByTestId('timecode-input');

      fireEvent.change(input, { target: { value: '00:00:10:15' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      // 10 seconds + 15/30 = 10.5 seconds
      expect(onSeek).toHaveBeenCalledWith(10.5);
    });
  });

  // ---------------------------------------------------------------------------
  // Invalid timecode
  // ---------------------------------------------------------------------------

  describe('invalid timecode', () => {
    it('should show error for malformed input', async () => {
      const onSeek = vi.fn();
      const user = userEvent.setup();
      render(<TimecodeInput {...defaultProps({ onSeek })} />);

      await user.click(screen.getByTestId('timecode-display'));
      const input = screen.getByTestId('timecode-input');

      await user.clear(input);
      await user.type(input, 'not-a-timecode');
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onSeek).not.toHaveBeenCalled();
      expect(input).toHaveAttribute('aria-invalid', 'true');
      // Should remain in edit mode
      expect(screen.getByTestId('timecode-input')).toBeInTheDocument();
    });

    it('should show error for out-of-range seconds', async () => {
      const onSeek = vi.fn();
      const user = userEvent.setup();
      render(<TimecodeInput {...defaultProps({ onSeek })} />);

      await user.click(screen.getByTestId('timecode-display'));
      const input = screen.getByTestId('timecode-input');

      await user.clear(input);
      await user.type(input, '00:00:60:00'); // seconds=60, invalid
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onSeek).not.toHaveBeenCalled();
      expect(input).toHaveAttribute('aria-invalid', 'true');
    });

    it('should show error for frames >= fps', async () => {
      const onSeek = vi.fn();
      const user = userEvent.setup();
      render(<TimecodeInput {...defaultProps({ onSeek, fps: 30 })} />);

      await user.click(screen.getByTestId('timecode-display'));
      const input = screen.getByTestId('timecode-input');

      await user.clear(input);
      await user.type(input, '00:00:00:30'); // frame=30, fps=30 → invalid
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onSeek).not.toHaveBeenCalled();
      expect(input).toHaveAttribute('aria-invalid', 'true');
    });

    it('should show error for empty SMPTE segments', async () => {
      const onSeek = vi.fn();
      const user = userEvent.setup();
      render(<TimecodeInput {...defaultProps({ onSeek })} />);

      await user.click(screen.getByTestId('timecode-display'));
      const input = screen.getByTestId('timecode-input');

      await user.clear(input);
      await user.type(input, '00::10:00');
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onSeek).not.toHaveBeenCalled();
      expect(input).toHaveAttribute('aria-invalid', 'true');
    });
  });

  // ---------------------------------------------------------------------------
  // Timecode beyond duration
  // ---------------------------------------------------------------------------

  describe('timecode beyond duration', () => {
    it('should show error when timecode exceeds duration', async () => {
      const onSeek = vi.fn();
      const user = userEvent.setup();
      render(<TimecodeInput {...defaultProps({ onSeek, duration: 60 })} />);

      await user.click(screen.getByTestId('timecode-display'));
      const input = screen.getByTestId('timecode-input');

      await user.clear(input);
      await user.type(input, '00:02:00:00'); // 120s > 60s duration
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onSeek).not.toHaveBeenCalled();
      expect(input).toHaveAttribute('aria-invalid', 'true');
    });
  });

  // ---------------------------------------------------------------------------
  // Escape cancels
  // ---------------------------------------------------------------------------

  describe('escape cancels edit', () => {
    it('should exit edit mode without seeking on Escape', async () => {
      const onSeek = vi.fn();
      const user = userEvent.setup();
      render(<TimecodeInput {...defaultProps({ onSeek })} />);

      await user.click(screen.getByTestId('timecode-display'));
      const input = screen.getByTestId('timecode-input');

      await user.clear(input);
      await user.type(input, '00:05:00:00');
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(onSeek).not.toHaveBeenCalled();
      expect(screen.queryByTestId('timecode-input')).not.toBeInTheDocument();
      expect(screen.getByTestId('timecode-display')).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Blur cancels
  // ---------------------------------------------------------------------------

  describe('blur cancels edit', () => {
    it('should exit edit mode when input loses focus', async () => {
      const onSeek = vi.fn();
      const user = userEvent.setup();
      render(<TimecodeInput {...defaultProps({ onSeek })} />);

      await user.click(screen.getByTestId('timecode-display'));
      expect(screen.getByTestId('timecode-input')).toBeInTheDocument();

      fireEvent.blur(screen.getByTestId('timecode-input'));

      expect(onSeek).not.toHaveBeenCalled();
      expect(screen.queryByTestId('timecode-input')).not.toBeInTheDocument();
      expect(screen.getByTestId('timecode-display')).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Numpad entry
  // ---------------------------------------------------------------------------

  describe('numpad entry', () => {
    it('should accept numeric input and seek correctly', async () => {
      const onSeek = vi.fn();
      const user = userEvent.setup();
      render(<TimecodeInput {...defaultProps({ onSeek })} />);

      await user.click(screen.getByTestId('timecode-display'));
      const input = screen.getByTestId('timecode-input');

      await user.clear(input);
      await user.type(input, '00:00:10:00');
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onSeek).toHaveBeenCalledWith(10);
    });
  });

  // ---------------------------------------------------------------------------
  // Keyboard event isolation
  // ---------------------------------------------------------------------------

  describe('keyboard event isolation', () => {
    it('should stop propagation on Enter to prevent parent handlers', async () => {
      const user = userEvent.setup();
      const parentHandler = vi.fn();

      render(
        <div onKeyDown={parentHandler}>
          <TimecodeInput {...defaultProps()} />
        </div>,
      );

      await user.click(screen.getByTestId('timecode-display'));
      const input = screen.getByTestId('timecode-input');

      await user.type(input, 'a');
      // Parent should NOT receive the keydown because stopPropagation is called
      expect(parentHandler).not.toHaveBeenCalled();
    });
  });

  describe('disabled state', () => {
    it('should not enter edit mode when disabled', async () => {
      const user = userEvent.setup();
      render(<TimecodeInput {...defaultProps({ disabled: true })} />);

      const display = screen.getByTestId('timecode-display');
      expect(display).toBeDisabled();

      await user.click(display);

      expect(screen.queryByTestId('timecode-input')).not.toBeInTheDocument();
    });
  });
});
