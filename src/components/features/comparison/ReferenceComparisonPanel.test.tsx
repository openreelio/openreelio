/**
 * ReferenceComparisonPanel Component Tests
 *
 * Tests for the main panel that orchestrates reference style comparison UI.
 * Mocks the useReferenceComparison hook to isolate component behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReferenceComparisonPanel } from './ReferenceComparisonPanel';
import type { UseReferenceComparisonReturn } from '@/hooks/useReferenceComparison';
import type { EditingStyleDocument } from '@/bindings';

// =============================================================================
// Hook Mock
// =============================================================================

const mockHookReturn: UseReferenceComparisonReturn = {
  esd: null,
  referenceCurve: [],
  outputCurve: [],
  outputStructure: [],
  correlation: 0,
  transitionDiffs: [],
  isLoading: false,
  error: null,
};

vi.mock('@/hooks/useReferenceComparison', () => ({
  useReferenceComparison: vi.fn(() => mockHookReturn),
}));

// Import after mock is defined
import { useReferenceComparison } from '@/hooks/useReferenceComparison';

// =============================================================================
// Test Data
// =============================================================================

function createMockEsd(): EditingStyleDocument {
  return {
    id: 'esd-1',
    name: 'Test Reference',
    sourceAssetId: 'asset-1',
    createdAt: '2026-03-07T00:00:00Z',
    version: '1.0',
    rhythmProfile: {
      shotDurations: [2, 3, 1, 4],
      meanDuration: 2.5,
      medianDuration: 2.5,
      stdDeviation: 1.1,
      minDuration: 1,
      maxDuration: 4,
      tempoClassification: 'moderate',
    },
    transitionInventory: {
      transitions: [],
      typeFrequency: { cut: 3, dissolve: 1 },
      dominantType: 'cut',
    },
    pacingCurve: [
      { normalizedPosition: 0.25, normalizedDuration: 0.5 },
      { normalizedPosition: 0.75, normalizedDuration: 0.8 },
    ],
    syncPoints: [],
    contentMap: [
      { startSec: 0, endSec: 5, segmentType: 'talk', confidence: 0.9 },
      { startSec: 5, endSec: 10, segmentType: 'montage', confidence: 0.85 },
    ],
    cameraPatterns: [],
  } as unknown as EditingStyleDocument;
}

function createLoadedHookReturn(): UseReferenceComparisonReturn {
  return {
    esd: createMockEsd(),
    referenceCurve: [
      { time: 0.25, value: 0.5 },
      { time: 0.75, value: 0.8 },
    ],
    outputCurve: [
      { time: 0.2, value: 0.4 },
      { time: 0.8, value: 0.7 },
    ],
    outputStructure: [
      { startSec: 0, endSec: 4, segmentType: 'talk' },
      { startSec: 4, endSec: 9, segmentType: 'montage' },
    ],
    correlation: 0.85,
    transitionDiffs: [
      { type: 'cut', referenceCount: 3, outputCount: 3 },
      { type: 'dissolve', referenceCount: 1, outputCount: 0 },
    ],
    isLoading: false,
    error: null,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('ReferenceComparisonPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default empty state
    vi.mocked(useReferenceComparison).mockReturnValue({ ...mockHookReturn });
  });

  // ===========================================================================
  // Empty state (no esdId)
  // ===========================================================================

  describe('empty state', () => {
    it('should show empty state when no esdId provided', () => {
      render(<ReferenceComparisonPanel />);

      expect(screen.getByTestId('comparison-empty')).toBeInTheDocument();
      expect(
        screen.getByText('Analyze a reference video to compare editing styles'),
      ).toBeInTheDocument();
    });

    it('should show empty state when esdId is undefined', () => {
      render(<ReferenceComparisonPanel esdId={undefined} />);

      expect(screen.getByTestId('comparison-empty')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Loading state
  // ===========================================================================

  describe('loading state', () => {
    it('should show loading indicator when isLoading is true', () => {
      vi.mocked(useReferenceComparison).mockReturnValue({
        ...mockHookReturn,
        isLoading: true,
      });

      render(<ReferenceComparisonPanel esdId="esd-1" />);

      expect(screen.getByTestId('comparison-loading')).toBeInTheDocument();
      expect(screen.getByText('Loading style document...')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Error state
  // ===========================================================================

  describe('error state', () => {
    it('should show error message when error occurs', () => {
      vi.mocked(useReferenceComparison).mockReturnValue({
        ...mockHookReturn,
        error: 'ESD "esd-1" not found',
      });

      render(<ReferenceComparisonPanel esdId="esd-1" />);

      expect(screen.getByTestId('comparison-error')).toBeInTheDocument();
      expect(screen.getByText('ESD "esd-1" not found')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Loaded state with comparison data
  // ===========================================================================

  describe('loaded state', () => {
    it('should render comparison panel when ESD is loaded', () => {
      vi.mocked(useReferenceComparison).mockReturnValue(createLoadedHookReturn());

      render(<ReferenceComparisonPanel esdId="esd-1" />);

      expect(screen.getByTestId('reference-comparison-panel')).toBeInTheDocument();
    });

    it('should render content structure section', () => {
      vi.mocked(useReferenceComparison).mockReturnValue(createLoadedHookReturn());

      render(<ReferenceComparisonPanel esdId="esd-1" />);

      expect(screen.getByText('Content Structure')).toBeInTheDocument();
    });

    it('should render pacing comparison section with chart', () => {
      vi.mocked(useReferenceComparison).mockReturnValue(createLoadedHookReturn());

      render(<ReferenceComparisonPanel esdId="esd-1" />);

      expect(screen.getByText('Pacing Comparison')).toBeInTheDocument();
      expect(screen.getByTestId('pacing-curve-chart')).toBeInTheDocument();
    });

    it('should render transition types section with diff table', () => {
      vi.mocked(useReferenceComparison).mockReturnValue(createLoadedHookReturn());

      render(<ReferenceComparisonPanel esdId="esd-1" />);

      expect(screen.getByText('Transition Types')).toBeInTheDocument();
      expect(screen.getByTestId('transition-diff-table')).toBeInTheDocument();
    });

    it('should render segment legend for content map segment types', () => {
      vi.mocked(useReferenceComparison).mockReturnValue(createLoadedHookReturn());

      render(<ReferenceComparisonPanel esdId="esd-1" />);

      // Content map has 'talk' and 'montage' segments
      expect(screen.getByText('Talk')).toBeInTheDocument();
      expect(screen.getByText('Montage')).toBeInTheDocument();
    });

    it('should render structure bar with Reference label', () => {
      vi.mocked(useReferenceComparison).mockReturnValue(createLoadedHookReturn());

      render(<ReferenceComparisonPanel esdId="esd-1" />);

      expect(screen.getByText('Reference')).toBeInTheDocument();
    });

    it('should render structure bar with Output label', () => {
      vi.mocked(useReferenceComparison).mockReturnValue(createLoadedHookReturn());

      render(<ReferenceComparisonPanel esdId="esd-1" />);

      expect(screen.getAllByText('Output').length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Null ESD after loading (edge case)
  // ===========================================================================

  describe('null esd edge case', () => {
    it('should render the empty state when esd is null after loading completes', () => {
      vi.mocked(useReferenceComparison).mockReturnValue({
        ...mockHookReturn,
        esd: null,
        isLoading: false,
        error: null,
      });

      render(<ReferenceComparisonPanel esdId="esd-1" />);

      expect(screen.queryByTestId('reference-comparison-panel')).not.toBeInTheDocument();
      expect(screen.getByTestId('comparison-empty')).toBeInTheDocument();
      expect(screen.queryByTestId('comparison-loading')).not.toBeInTheDocument();
      expect(screen.queryByTestId('comparison-error')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Hook invocation
  // ===========================================================================

  describe('hook integration', () => {
    it('should pass esdId to useReferenceComparison', () => {
      render(<ReferenceComparisonPanel esdId="esd-42" />);

      expect(useReferenceComparison).toHaveBeenCalledWith('esd-42');
    });

    it('should pass undefined to hook when esdId is not provided', () => {
      render(<ReferenceComparisonPanel />);

      expect(useReferenceComparison).toHaveBeenCalledWith(undefined);
    });
  });

  // ===========================================================================
  // className prop
  // ===========================================================================

  describe('className prop', () => {
    it('should pass className to empty state container', () => {
      render(<ReferenceComparisonPanel className="test-class" />);

      const container = screen.getByTestId('comparison-empty');
      expect(container.className).toContain('test-class');
    });

    it('should pass className to loaded state container', () => {
      vi.mocked(useReferenceComparison).mockReturnValue(createLoadedHookReturn());

      render(<ReferenceComparisonPanel esdId="esd-1" className="test-class" />);

      const container = screen.getByTestId('reference-comparison-panel');
      expect(container.className).toContain('test-class');
    });
  });
});
