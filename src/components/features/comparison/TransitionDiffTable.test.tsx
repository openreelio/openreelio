/**
 * TransitionDiffTable Component Tests
 *
 * Tests for the transition comparison table that shows match indicators
 * between reference ESD and current timeline output.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TransitionDiffTable, type TransitionDiffRow } from './TransitionDiffTable';

// =============================================================================
// Test Data
// =============================================================================

function createRows(): TransitionDiffRow[] {
  return [
    { type: 'dissolve', referenceCount: 5, outputCount: 5 },
    { type: 'cut', referenceCount: 10, outputCount: 8 },
    { type: 'fade_in', referenceCount: 2, outputCount: 0 },
  ];
}

// =============================================================================
// Tests
// =============================================================================

describe('TransitionDiffTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering
  // ===========================================================================

  describe('rendering', () => {
    it('should render transition rows with formatted type names', () => {
      render(<TransitionDiffTable rows={createRows()} />);

      // formatTransitionType converts 'dissolve' -> 'Dissolve', 'fade_in' -> 'Fade In'
      expect(screen.getByText('Dissolve')).toBeInTheDocument();
      expect(screen.getByText('Cut')).toBeInTheDocument();
      expect(screen.getByText('Fade In')).toBeInTheDocument();
    });

    it('should display reference and output counts', () => {
      render(<TransitionDiffTable rows={[{ type: 'cut', referenceCount: 10, outputCount: 8 }]} />);

      expect(screen.getByText('10')).toBeInTheDocument();
      expect(screen.getByText('8')).toBeInTheDocument();
    });

    it('should render table headers', () => {
      render(<TransitionDiffTable rows={createRows()} />);

      expect(screen.getByText('Type')).toBeInTheDocument();
      expect(screen.getByText('Ref')).toBeInTheDocument();
      expect(screen.getByText('Output')).toBeInTheDocument();
      expect(screen.getByText('Match')).toBeInTheDocument();
    });

    it('should render with data-testid on the table container', () => {
      render(<TransitionDiffTable rows={createRows()} />);

      expect(screen.getByTestId('transition-diff-table')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Empty state
  // ===========================================================================

  describe('empty state', () => {
    it('should show empty state when no rows provided', () => {
      render(<TransitionDiffTable rows={[]} />);

      expect(screen.getByTestId('transition-diff-empty')).toBeInTheDocument();
      expect(screen.getByText('No transition data available')).toBeInTheDocument();
    });

    it('should not render table when rows are empty', () => {
      render(<TransitionDiffTable rows={[]} />);

      expect(screen.queryByTestId('transition-diff-table')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Match status indicators
  // ===========================================================================

  describe('match indicators', () => {
    it('should display Exact label when counts match', () => {
      render(<TransitionDiffTable rows={[{ type: 'dissolve', referenceCount: 5, outputCount: 5 }]} />);

      expect(screen.getByText('Exact')).toBeInTheDocument();
      const indicator = screen.getByLabelText('Exact');
      expect(indicator).toBeInTheDocument();
    });

    it('should display Close label when difference is within 2', () => {
      render(<TransitionDiffTable rows={[{ type: 'cut', referenceCount: 10, outputCount: 8 }]} />);

      expect(screen.getByText('Close')).toBeInTheDocument();
      const indicator = screen.getByLabelText('Close');
      expect(indicator).toBeInTheDocument();
    });

    it('should display Missing label when output is zero and reference is positive', () => {
      render(<TransitionDiffTable rows={[{ type: 'fade_in', referenceCount: 2, outputCount: 0 }]} />);

      expect(screen.getByText('Missing')).toBeInTheDocument();
      const indicator = screen.getByLabelText('Missing');
      expect(indicator).toBeInTheDocument();
    });

    it('should display Missing label when difference exceeds 2', () => {
      render(<TransitionDiffTable rows={[{ type: 'wipe', referenceCount: 10, outputCount: 3 }]} />);

      expect(screen.getByText('Missing')).toBeInTheDocument();
    });

    it('should show multiple indicators for multiple rows', () => {
      render(<TransitionDiffTable rows={createRows()} />);

      // 3 rows: exact (dissolve), close (cut), missing (fade_in)
      expect(screen.getByText('Exact')).toBeInTheDocument();
      expect(screen.getByText('Close')).toBeInTheDocument();
      expect(screen.getByText('Missing')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle single row', () => {
      render(<TransitionDiffTable rows={[{ type: 'cut', referenceCount: 0, outputCount: 0 }]} />);

      expect(screen.getByText('Cut')).toBeInTheDocument();
      expect(screen.getByText('Exact')).toBeInTheDocument();
    });

    it('should accept className prop', () => {
      render(<TransitionDiffTable rows={createRows()} className="custom-class" />);

      const table = screen.getByTestId('transition-diff-table');
      expect(table.className).toContain('custom-class');
    });
  });
});
