/**
 * Feature Error Boundaries Tests
 *
 * Tests for specialized error boundaries for major app features:
 * - TimelineErrorBoundary
 * - PreviewErrorBoundary
 * - ExplorerErrorBoundary
 * - InspectorErrorBoundary
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  TimelineErrorBoundary,
  PreviewErrorBoundary,
  ExplorerErrorBoundary,
  InspectorErrorBoundary,
  AIErrorBoundary,
  SearchErrorBoundary,
  ExportErrorBoundary,
} from './FeatureErrorBoundaries';

// Suppress console.error for expected errors in tests
const originalError = console.error;
beforeEach(() => {
  console.error = vi.fn();
});
afterEach(() => {
  console.error = originalError;
});

// Component that throws an error
function ThrowingComponent({
  errorMessage = 'Test error',
}: {
  errorMessage?: string;
}): JSX.Element {
  throw new Error(errorMessage);
}

// =============================================================================
// TimelineErrorBoundary Tests
// =============================================================================

describe('TimelineErrorBoundary', () => {
  it('should render children when no error occurs', () => {
    render(
      <TimelineErrorBoundary>
        <div>Timeline content</div>
      </TimelineErrorBoundary>,
    );

    expect(screen.getByText('Timeline content')).toBeInTheDocument();
  });

  it('should display timeline-specific fallback on error', () => {
    render(
      <TimelineErrorBoundary>
        <ThrowingComponent />
      </TimelineErrorBoundary>,
    );

    expect(screen.getByText(/timeline error/i)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('should show retry button', () => {
    render(
      <TimelineErrorBoundary>
        <ThrowingComponent />
      </TimelineErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('should call onError callback when error occurs', () => {
    const onError = vi.fn();

    render(
      <TimelineErrorBoundary onError={onError}>
        <ThrowingComponent />
      </TimelineErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ componentStack: expect.any(String) }),
    );
  });

  it('should display timeline icon in fallback', () => {
    render(
      <TimelineErrorBoundary>
        <ThrowingComponent />
      </TimelineErrorBoundary>,
    );

    // Should have a timeline-related icon or indicator
    expect(screen.getByTestId('timeline-error-icon')).toBeInTheDocument();
  });
});

// =============================================================================
// PreviewErrorBoundary Tests
// =============================================================================

describe('PreviewErrorBoundary', () => {
  it('should render children when no error occurs', () => {
    render(
      <PreviewErrorBoundary>
        <div>Preview content</div>
      </PreviewErrorBoundary>,
    );

    expect(screen.getByText('Preview content')).toBeInTheDocument();
  });

  it('should display preview-specific fallback on error', () => {
    render(
      <PreviewErrorBoundary>
        <ThrowingComponent />
      </PreviewErrorBoundary>,
    );

    expect(screen.getByText(/preview error/i)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('should show retry button', () => {
    render(
      <PreviewErrorBoundary>
        <ThrowingComponent />
      </PreviewErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('should display preview icon in fallback', () => {
    render(
      <PreviewErrorBoundary>
        <ThrowingComponent />
      </PreviewErrorBoundary>,
    );

    expect(screen.getByTestId('preview-error-icon')).toBeInTheDocument();
  });
});

// =============================================================================
// ExplorerErrorBoundary Tests
// =============================================================================

describe('ExplorerErrorBoundary', () => {
  it('should render children when no error occurs', () => {
    render(
      <ExplorerErrorBoundary>
        <div>Explorer content</div>
      </ExplorerErrorBoundary>,
    );

    expect(screen.getByText('Explorer content')).toBeInTheDocument();
  });

  it('should display explorer-specific fallback on error', () => {
    render(
      <ExplorerErrorBoundary>
        <ThrowingComponent />
      </ExplorerErrorBoundary>,
    );

    expect(screen.getByText(/asset explorer error/i)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('should show retry button', () => {
    render(
      <ExplorerErrorBoundary>
        <ThrowingComponent />
      </ExplorerErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('should display folder icon in fallback', () => {
    render(
      <ExplorerErrorBoundary>
        <ThrowingComponent />
      </ExplorerErrorBoundary>,
    );

    expect(screen.getByTestId('explorer-error-icon')).toBeInTheDocument();
  });
});

// =============================================================================
// InspectorErrorBoundary Tests
// =============================================================================

describe('InspectorErrorBoundary', () => {
  it('should render children when no error occurs', () => {
    render(
      <InspectorErrorBoundary>
        <div>Inspector content</div>
      </InspectorErrorBoundary>,
    );

    expect(screen.getByText('Inspector content')).toBeInTheDocument();
  });

  it('should display inspector-specific fallback on error', () => {
    render(
      <InspectorErrorBoundary>
        <ThrowingComponent />
      </InspectorErrorBoundary>,
    );

    expect(screen.getByText(/inspector error/i)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('should show retry button', () => {
    render(
      <InspectorErrorBoundary>
        <ThrowingComponent />
      </InspectorErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('should display settings icon in fallback', () => {
    render(
      <InspectorErrorBoundary>
        <ThrowingComponent />
      </InspectorErrorBoundary>,
    );

    expect(screen.getByTestId('inspector-error-icon')).toBeInTheDocument();
  });
});

// =============================================================================
// AIErrorBoundary Tests
// =============================================================================

describe('AIErrorBoundary', () => {
  it('should render children when no error occurs', () => {
    render(
      <AIErrorBoundary>
        <div>AI content</div>
      </AIErrorBoundary>,
    );

    expect(screen.getByText('AI content')).toBeInTheDocument();
  });

  it('should display AI-specific fallback on error', () => {
    render(
      <AIErrorBoundary>
        <ThrowingComponent />
      </AIErrorBoundary>,
    );

    expect(screen.getByText(/ai assistant error/i)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('should show retry button', () => {
    render(
      <AIErrorBoundary>
        <ThrowingComponent />
      </AIErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('should display AI icon in fallback', () => {
    render(
      <AIErrorBoundary>
        <ThrowingComponent />
      </AIErrorBoundary>,
    );

    expect(screen.getByTestId('ai-error-icon')).toBeInTheDocument();
  });
});

// =============================================================================
// SearchErrorBoundary Tests
// =============================================================================

describe('SearchErrorBoundary', () => {
  it('should render children when no error occurs', () => {
    render(
      <SearchErrorBoundary>
        <div>Search content</div>
      </SearchErrorBoundary>,
    );

    expect(screen.getByText('Search content')).toBeInTheDocument();
  });

  it('should display search-specific fallback on error', () => {
    render(
      <SearchErrorBoundary>
        <ThrowingComponent />
      </SearchErrorBoundary>,
    );

    expect(screen.getByText(/search error/i)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('should show retry button', () => {
    render(
      <SearchErrorBoundary>
        <ThrowingComponent />
      </SearchErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('should display search icon in fallback', () => {
    render(
      <SearchErrorBoundary>
        <ThrowingComponent />
      </SearchErrorBoundary>,
    );

    expect(screen.getByTestId('search-error-icon')).toBeInTheDocument();
  });
});

// =============================================================================
// ExportErrorBoundary Tests
// =============================================================================

describe('ExportErrorBoundary', () => {
  it('should render children when no error occurs', () => {
    render(
      <ExportErrorBoundary>
        <div>Export content</div>
      </ExportErrorBoundary>,
    );

    expect(screen.getByText('Export content')).toBeInTheDocument();
  });

  it('should display export-specific fallback on error', () => {
    render(
      <ExportErrorBoundary>
        <ThrowingComponent />
      </ExportErrorBoundary>,
    );

    expect(screen.getByText(/export error/i)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('should show retry button', () => {
    render(
      <ExportErrorBoundary>
        <ThrowingComponent />
      </ExportErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('should display export icon in fallback', () => {
    render(
      <ExportErrorBoundary>
        <ThrowingComponent />
      </ExportErrorBoundary>,
    );

    expect(screen.getByTestId('export-error-icon')).toBeInTheDocument();
  });
});

// =============================================================================
// Common Behavior Tests
// =============================================================================

describe('common error boundary behavior', () => {
  const boundaries = [
    { name: 'TimelineErrorBoundary', Component: TimelineErrorBoundary },
    { name: 'PreviewErrorBoundary', Component: PreviewErrorBoundary },
    { name: 'ExplorerErrorBoundary', Component: ExplorerErrorBoundary },
    { name: 'InspectorErrorBoundary', Component: InspectorErrorBoundary },
    { name: 'AIErrorBoundary', Component: AIErrorBoundary },
    { name: 'SearchErrorBoundary', Component: SearchErrorBoundary },
    { name: 'ExportErrorBoundary', Component: ExportErrorBoundary },
  ];

  boundaries.forEach(({ name, Component }) => {
    describe(name, () => {
      it('should reset on retry click and re-render children', () => {
        let shouldThrow = true;

        const TestChild = () => {
          if (shouldThrow) {
            throw new Error('Test error');
          }
          return <div>Recovered</div>;
        };

        const { rerender } = render(
          <Component>
            <TestChild />
          </Component>,
        );

        // Should show error state
        expect(screen.getByRole('alert')).toBeInTheDocument();

        // Fix the error condition
        shouldThrow = false;

        // Click retry
        fireEvent.click(screen.getByRole('button', { name: /retry/i }));

        // Force re-render after state reset
        rerender(
          <Component>
            <TestChild />
          </Component>,
        );

        // Should show recovered content
        expect(screen.getByText('Recovered')).toBeInTheDocument();
      });

      it('should have consistent styling', () => {
        render(
          <Component>
            <ThrowingComponent />
          </Component>,
        );

        const alert = screen.getByRole('alert');
        expect(alert).toHaveClass('flex');
      });
    });
  });
});
