/**
 * EsdSummaryView Component Tests
 *
 * Tests for the compact ESD summary card that shows key metrics,
 * a mini pacing sparkline, and an "Apply Style" action.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EsdSummaryView } from './EsdSummaryView';
import type { EditingStyleDocument } from '@/bindings';

// =============================================================================
// Canvas Mock (PacingSparkline uses ctx.scale, strokeStyle, etc.)
// =============================================================================

const originalGetContext = HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  const mockContext = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    scale: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    setLineDash: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
    drawImage: vi.fn(),
  };

  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => mockContext,
  ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

// =============================================================================
// Test Data
// =============================================================================

function createMockEsd(overrides?: Partial<EditingStyleDocument>): EditingStyleDocument {
  return {
    id: 'esd-1',
    name: 'Test ESD',
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
      typeFrequency: { cut: 3 },
      dominantType: 'cut',
    },
    pacingCurve: [
      { normalizedPosition: 0, normalizedDuration: 0.5 },
      { normalizedPosition: 0.5, normalizedDuration: 0.75 },
      { normalizedPosition: 1, normalizedDuration: 0.25 },
    ],
    syncPoints: [],
    contentMap: [],
    cameraPatterns: [],
    ...overrides,
  } as EditingStyleDocument;
}

// =============================================================================
// Tests
// =============================================================================

describe('EsdSummaryView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering
  // ===========================================================================

  describe('rendering', () => {
    it('should display ESD name', () => {
      render(<EsdSummaryView esd={createMockEsd()} onApply={vi.fn()} />);

      expect(screen.getByText('Test ESD')).toBeInTheDocument();
    });

    it('should display tempo classification badge', () => {
      render(<EsdSummaryView esd={createMockEsd()} onApply={vi.fn()} />);

      expect(screen.getByText('moderate')).toBeInTheDocument();
    });

    it('should display shot count from rhythm profile', () => {
      render(<EsdSummaryView esd={createMockEsd()} onApply={vi.fn()} />);

      // 4 shots (shotDurations has 4 entries)
      expect(screen.getByText('4')).toBeInTheDocument();
      expect(screen.getByText('shots')).toBeInTheDocument();
    });

    it('should display dominant transition type', () => {
      render(<EsdSummaryView esd={createMockEsd()} onApply={vi.fn()} />);

      expect(screen.getByText('cut')).toBeInTheDocument();
      expect(screen.getByText('dominant')).toBeInTheDocument();
    });

    it('should render the pacing sparkline canvas', () => {
      render(<EsdSummaryView esd={createMockEsd()} onApply={vi.fn()} />);

      expect(screen.getByTestId('pacing-sparkline')).toBeInTheDocument();
    });

    it('should render the Apply Style button', () => {
      render(<EsdSummaryView esd={createMockEsd()} onApply={vi.fn()} />);

      expect(screen.getByRole('button', { name: /apply style/i })).toBeInTheDocument();
    });

    it('should render the summary view container', () => {
      render(<EsdSummaryView esd={createMockEsd()} onApply={vi.fn()} />);

      expect(screen.getByTestId('esd-summary-view')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Tempo badge variants
  // ===========================================================================

  describe('tempo badge styles', () => {
    it('should display fast tempo classification', () => {
      const esd = createMockEsd({
        rhythmProfile: {
          shotDurations: [0.5, 0.8, 1.0],
          meanDuration: 0.77,
          medianDuration: 0.8,
          stdDeviation: 0.2,
          minDuration: 0.5,
          maxDuration: 1.0,
          tempoClassification: 'fast',
        },
      });

      render(<EsdSummaryView esd={esd} onApply={vi.fn()} />);

      expect(screen.getByText('fast')).toBeInTheDocument();
    });

    it('should display slow tempo classification', () => {
      const esd = createMockEsd({
        rhythmProfile: {
          shotDurations: [5, 8, 10],
          meanDuration: 7.67,
          medianDuration: 8,
          stdDeviation: 2.05,
          minDuration: 5,
          maxDuration: 10,
          tempoClassification: 'slow',
        },
      });

      render(<EsdSummaryView esd={esd} onApply={vi.fn()} />);

      expect(screen.getByText('slow')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Apply Style interaction
  // ===========================================================================

  describe('apply style action', () => {
    it('should call onApply with ESD id when Apply Style button is clicked', () => {
      const onApply = vi.fn();
      render(<EsdSummaryView esd={createMockEsd()} onApply={onApply} />);

      const button = screen.getByRole('button', { name: /apply style/i });
      fireEvent.click(button);

      expect(onApply).toHaveBeenCalledTimes(1);
      expect(onApply).toHaveBeenCalledWith('esd-1');
    });

    it('should call onApply with correct id for different ESDs', () => {
      const onApply = vi.fn();
      const esd = createMockEsd({ id: 'esd-custom-42' });

      render(<EsdSummaryView esd={esd} onApply={onApply} />);

      fireEvent.click(screen.getByRole('button', { name: /apply style/i }));

      expect(onApply).toHaveBeenCalledWith('esd-custom-42');
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle ESD with empty pacing curve', () => {
      const esd = createMockEsd({ pacingCurve: [] });

      render(<EsdSummaryView esd={esd} onApply={vi.fn()} />);

      expect(screen.getByTestId('pacing-sparkline')).toBeInTheDocument();
    });

    it('should handle ESD with zero shots', () => {
      const esd = createMockEsd({
        rhythmProfile: {
          shotDurations: [],
          meanDuration: 0,
          medianDuration: 0,
          stdDeviation: 0,
          minDuration: 0,
          maxDuration: 0,
          tempoClassification: 'moderate',
        },
      });

      render(<EsdSummaryView esd={esd} onApply={vi.fn()} />);

      expect(screen.getByText('0')).toBeInTheDocument();
    });

    it('should format underscore-separated dominant transition types', () => {
      const esd = createMockEsd({
        transitionInventory: {
          transitions: [],
          typeFrequency: { fade_in: 5 },
          dominantType: 'fade_in',
        },
      });

      render(<EsdSummaryView esd={esd} onApply={vi.fn()} />);

      // dominantType.replace(/_/g, ' ') -> 'fade in'
      expect(screen.getByText('fade in')).toBeInTheDocument();
    });

    it('should accept className prop', () => {
      render(
        <EsdSummaryView esd={createMockEsd()} onApply={vi.fn()} className="custom-class" />,
      );

      const container = screen.getByTestId('esd-summary-view');
      expect(container.className).toContain('custom-class');
    });
  });
});
