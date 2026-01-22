/**
 * DropIndicator Component Tests
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DropIndicator } from './DropIndicator';
import type { DropValidity } from '@/utils/dropValidity';

// =============================================================================
// Test Helpers
// =============================================================================

const validDrop: DropValidity = { isValid: true };

const invalidDropOverlap: DropValidity = {
  isValid: false,
  reason: 'overlap',
  message: 'Clips would overlap',
  conflictingClipId: 'clip-1',
};

const invalidDropLocked: DropValidity = {
  isValid: false,
  reason: 'locked_track',
  message: 'Track is locked',
};

// =============================================================================
// Tests
// =============================================================================

describe('DropIndicator', () => {
  describe('rendering', () => {
    it('should render the indicator element', () => {
      render(<DropIndicator position={100} validity={validDrop} time={5.0} />);

      const indicator = screen.getByTestId('drop-indicator');
      expect(indicator).toBeInTheDocument();
    });

    it('should position indicator at specified position', () => {
      render(<DropIndicator position={200} validity={validDrop} time={5.0} />);

      const indicator = screen.getByTestId('drop-indicator');
      expect(indicator).toHaveStyle({ left: '200px' });
    });

    it('should set height based on trackHeight prop', () => {
      render(
        <DropIndicator
          position={100}
          validity={validDrop}
          time={5.0}
          trackHeight={80}
        />
      );

      const indicator = screen.getByTestId('drop-indicator');
      expect(indicator).toHaveStyle({ height: '80px' });
    });
  });

  describe('valid drop state', () => {
    it('should have valid data attribute when drop is valid', () => {
      render(<DropIndicator position={100} validity={validDrop} time={5.0} />);

      const indicator = screen.getByTestId('drop-indicator');
      expect(indicator).toHaveAttribute('data-valid', 'true');
    });

    it('should show time tooltip for valid drops', () => {
      render(<DropIndicator position={100} validity={validDrop} time={10.5} />);

      const timeTooltip = screen.getByTestId('drop-indicator-time');
      expect(timeTooltip).toBeInTheDocument();
      expect(timeTooltip.textContent).toContain('10');
    });

    it('should not show error message for valid drops', () => {
      render(<DropIndicator position={100} validity={validDrop} time={5.0} />);

      expect(screen.queryByTestId('drop-indicator-error')).not.toBeInTheDocument();
    });
  });

  describe('invalid drop state', () => {
    it('should have invalid data attribute when drop is invalid', () => {
      render(
        <DropIndicator position={100} validity={invalidDropOverlap} time={5.0} />
      );

      const indicator = screen.getByTestId('drop-indicator');
      expect(indicator).toHaveAttribute('data-valid', 'false');
    });

    it('should show error message for invalid drops', () => {
      render(
        <DropIndicator position={100} validity={invalidDropOverlap} time={5.0} />
      );

      const errorMessage = screen.getByTestId('drop-indicator-error');
      expect(errorMessage).toBeInTheDocument();
      expect(errorMessage.textContent).toBe('Clips would overlap');
    });

    it('should show locked track message', () => {
      render(
        <DropIndicator position={100} validity={invalidDropLocked} time={5.0} />
      );

      const errorMessage = screen.getByTestId('drop-indicator-error');
      expect(errorMessage.textContent).toBe('Track is locked');
    });
  });

  describe('time tooltip', () => {
    it('should format time correctly', () => {
      render(<DropIndicator position={100} validity={validDrop} time={65.5} />);

      const timeTooltip = screen.getByTestId('drop-indicator-time');
      // formatDuration(65.5) should output something like "1:05" or "01:05"
      expect(timeTooltip.textContent).toMatch(/1.*05/);
    });

    it('should hide time tooltip when showTimeTooltip is false', () => {
      render(
        <DropIndicator
          position={100}
          validity={validDrop}
          time={5.0}
          showTimeTooltip={false}
        />
      );

      expect(screen.queryByTestId('drop-indicator-time')).not.toBeInTheDocument();
    });
  });

  describe('error message visibility', () => {
    it('should hide error message when showErrorMessage is false', () => {
      render(
        <DropIndicator
          position={100}
          validity={invalidDropOverlap}
          time={5.0}
          showErrorMessage={false}
        />
      );

      expect(screen.queryByTestId('drop-indicator-error')).not.toBeInTheDocument();
    });

    it('should not show error message if message is undefined', () => {
      const invalidNoMessage: DropValidity = {
        isValid: false,
        reason: 'overlap',
        // No message
      };

      render(
        <DropIndicator position={100} validity={invalidNoMessage} time={5.0} />
      );

      expect(screen.queryByTestId('drop-indicator-error')).not.toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('should be non-interactive (pointer-events-none)', () => {
      render(<DropIndicator position={100} validity={validDrop} time={5.0} />);

      const indicator = screen.getByTestId('drop-indicator');
      expect(indicator).toHaveClass('pointer-events-none');
    });
  });
});
