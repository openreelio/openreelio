/**
 * TimecodeDisplay Component Tests
 *
 * Tests for the professional timecode display component.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TimecodeDisplay, CurrentTimeDisplay } from './TimecodeDisplay';

describe('TimecodeDisplay', () => {
  describe('SMPTE Format', () => {
    it('should display SMPTE timecode at 30fps', () => {
      render(<TimecodeDisplay time={125.5} format="smpte" fps={30} />);
      const display = screen.getByTestId('timecode-display');
      expect(display).toHaveTextContent('00:02:05:15');
    });

    it('should display SMPTE timecode at 24fps', () => {
      render(<TimecodeDisplay time={125.5} format="smpte" fps={24} />);
      const display = screen.getByTestId('timecode-display');
      expect(display).toHaveTextContent('00:02:05:12');
    });

    it('should handle zero time', () => {
      render(<TimecodeDisplay time={0} format="smpte" fps={30} />);
      const display = screen.getByTestId('timecode-display');
      expect(display).toHaveTextContent('00:00:00:00');
    });

    it('should handle negative time as zero', () => {
      render(<TimecodeDisplay time={-5} format="smpte" fps={30} />);
      const display = screen.getByTestId('timecode-display');
      expect(display).toHaveTextContent('00:00:00:00');
    });

    it('should handle NaN time as zero', () => {
      render(<TimecodeDisplay time={NaN} format="smpte" fps={30} />);
      const display = screen.getByTestId('timecode-display');
      expect(display).toHaveTextContent('00:00:00:00');
    });

    it('should handle large time values', () => {
      render(<TimecodeDisplay time={3725.5} format="smpte" fps={30} />);
      const display = screen.getByTestId('timecode-display');
      expect(display).toHaveTextContent('01:02:05:15');
    });
  });

  describe('Timestamp Format', () => {
    it('should display timestamp without hours', () => {
      render(<TimecodeDisplay time={125} format="timestamp" />);
      const display = screen.getByTestId('timecode-display');
      expect(display).toHaveTextContent('02:05');
    });

    it('should display timestamp with hours when requested', () => {
      render(<TimecodeDisplay time={3725} format="timestamp" showHours />);
      const display = screen.getByTestId('timecode-display');
      // Hours are not zero-padded in timestamp format (e.g., "1:02:05" not "01:02:05")
      expect(display).toHaveTextContent('1:02:05');
    });

    it('should auto-show hours for times >= 1 hour', () => {
      render(<TimecodeDisplay time={3725} format="timestamp" />);
      const display = screen.getByTestId('timecode-display');
      expect(display).toHaveTextContent('1:02:05');
    });
  });

  describe('Timestamp-MS Format', () => {
    it('should display timestamp with milliseconds', () => {
      render(<TimecodeDisplay time={125.567} format="timestamp-ms" msPrecision={3} />);
      const display = screen.getByTestId('timecode-display');
      expect(display).toHaveTextContent('02:05.567');
    });

    it('should respect millisecond precision', () => {
      render(<TimecodeDisplay time={125.567} format="timestamp-ms" msPrecision={2} />);
      const display = screen.getByTestId('timecode-display');
      expect(display).toHaveTextContent('02:05.57');
    });

    it('should display with hours when requested', () => {
      render(<TimecodeDisplay time={3725.567} format="timestamp-ms" showHours msPrecision={3} />);
      const display = screen.getByTestId('timecode-display');
      // Hours are not zero-padded in timestamp-ms format
      expect(display).toHaveTextContent('1:02:05.567');
    });
  });

  describe('Frames Format', () => {
    it('should display total frame count', () => {
      render(<TimecodeDisplay time={10} format="frames" fps={30} />);
      const display = screen.getByTestId('timecode-display');
      expect(display).toHaveTextContent('000300');
    });

    it('should pad frame count to 6 digits', () => {
      render(<TimecodeDisplay time={1} format="frames" fps={30} />);
      const display = screen.getByTestId('timecode-display');
      expect(display).toHaveTextContent('000030');
    });
  });

  describe('Seconds Format', () => {
    it('should display time in seconds with decimal', () => {
      render(<TimecodeDisplay time={125.567} format="seconds" />);
      const display = screen.getByTestId('timecode-display');
      expect(display).toHaveTextContent('125.567s');
    });
  });

  describe('Size Variants', () => {
    it('should apply small size class', () => {
      render(<TimecodeDisplay time={0} size="sm" />);
      const display = screen.getByTestId('timecode-display');
      expect(display).toHaveClass('text-xs');
    });

    it('should apply medium size class', () => {
      render(<TimecodeDisplay time={0} size="md" />);
      const display = screen.getByTestId('timecode-display');
      expect(display).toHaveClass('text-sm');
    });

    it('should apply large size class', () => {
      render(<TimecodeDisplay time={0} size="lg" />);
      const display = screen.getByTestId('timecode-display');
      expect(display).toHaveClass('text-base');
    });
  });

  describe('Label', () => {
    it('should display label when provided', () => {
      render(<TimecodeDisplay time={125} format="timestamp" label="Current:" />);
      const display = screen.getByTestId('timecode-display');
      expect(display).toHaveTextContent('Current:');
      expect(display).toHaveTextContent('02:05');
    });
  });

  describe('Custom Class', () => {
    it('should apply custom className', () => {
      render(<TimecodeDisplay time={0} className="custom-class" />);
      const display = screen.getByTestId('timecode-display');
      expect(display).toHaveClass('custom-class');
    });
  });
});

describe('CurrentTimeDisplay', () => {
  it('should display current time only', () => {
    render(<CurrentTimeDisplay time={125.5} fps={30} showDuration={false} />);
    const display = screen.getByTestId('current-time-display');
    expect(display).toHaveTextContent('00:02:05:15');
    expect(display).not.toHaveTextContent('/');
  });

  it('should display current time and duration', () => {
    render(<CurrentTimeDisplay time={125.5} duration={300} fps={30} showDuration />);
    const display = screen.getByTestId('current-time-display');
    expect(display).toHaveTextContent('00:02:05:15');
    expect(display).toHaveTextContent('/');
    expect(display).toHaveTextContent('00:05:00:00');
  });

  it('should not show duration separator when duration is 0', () => {
    render(<CurrentTimeDisplay time={125.5} duration={0} fps={30} showDuration />);
    const display = screen.getByTestId('current-time-display');
    expect(display).not.toHaveTextContent('/');
  });

  it('should apply custom className', () => {
    render(<CurrentTimeDisplay time={0} className="my-class" />);
    const display = screen.getByTestId('current-time-display');
    expect(display).toHaveClass('my-class');
  });
});
