/**
 * ErrorBoundary Component Tests
 *
 * TDD: RED phase - Tests written before implementation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';
import { withErrorBoundary } from './withErrorBoundary';

// Suppress console.error for expected errors in tests
const originalError = console.error;
beforeEach(() => {
  console.error = vi.fn();
});
afterEach(() => {
  console.error = originalError;
});

// Component that throws an error
function ThrowingComponent({ shouldThrow = true }: { shouldThrow?: boolean }) {
  if (shouldThrow) {
    throw new Error('Test error');
  }
  return <div>Normal content</div>;
}

describe('ErrorBoundary', () => {
  describe('normal rendering', () => {
    it('should render children when no error occurs', () => {
      render(
        <ErrorBoundary>
          <div>Child content</div>
        </ErrorBoundary>
      );

      expect(screen.getByText('Child content')).toBeInTheDocument();
    });

    it('should render multiple children', () => {
      render(
        <ErrorBoundary>
          <div>First child</div>
          <div>Second child</div>
        </ErrorBoundary>
      );

      expect(screen.getByText('First child')).toBeInTheDocument();
      expect(screen.getByText('Second child')).toBeInTheDocument();
    });
  });

  describe('error handling', () => {
    it('should catch errors and display fallback UI', () => {
      render(
        <ErrorBoundary>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });

    it('should display the error message', () => {
      render(
        <ErrorBoundary>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      expect(screen.getByText(/test error/i)).toBeInTheDocument();
    });

    it('should display custom fallback when provided', () => {
      const customFallback = <div>Custom error message</div>;

      render(
        <ErrorBoundary fallback={customFallback}>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      expect(screen.getByText('Custom error message')).toBeInTheDocument();
    });

    it('should call onError callback when error occurs', () => {
      const onError = vi.fn();

      render(
        <ErrorBoundary onError={onError}>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          componentStack: expect.any(String),
        })
      );
    });

    it('should include component stack in error info', () => {
      const onError = vi.fn();

      render(
        <ErrorBoundary onError={onError}>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      const [, errorInfo] = onError.mock.calls[0];
      expect(errorInfo.componentStack).toBeDefined();
    });
  });

  describe('recovery', () => {
    it('should display retry button by default', () => {
      render(
        <ErrorBoundary>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });

    it('should reset error state when retry button is clicked', () => {
      let shouldThrow = true;
      const TestComponent = () => {
        if (shouldThrow) {
          throw new Error('Test error');
        }
        return <div>Recovered content</div>;
      };

      const { rerender } = render(
        <ErrorBoundary>
          <TestComponent />
        </ErrorBoundary>
      );

      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();

      // Fix the component before retrying
      shouldThrow = false;

      // Click retry
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));

      // Force re-render after state reset
      rerender(
        <ErrorBoundary>
          <TestComponent />
        </ErrorBoundary>
      );

      expect(screen.getByText('Recovered content')).toBeInTheDocument();
    });

    it('should call onReset callback when retry is clicked', () => {
      const onReset = vi.fn();

      render(
        <ErrorBoundary onReset={onReset}>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      fireEvent.click(screen.getByRole('button', { name: /try again/i }));

      expect(onReset).toHaveBeenCalledTimes(1);
    });

    it('should display reload button when showReloadButton is true', () => {
      render(
        <ErrorBoundary showReloadButton>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
    });
  });

  describe('nested error boundaries', () => {
    it('should catch error in nearest boundary', () => {
      render(
        <ErrorBoundary fallback={<div>Outer fallback</div>}>
          <div>
            <ErrorBoundary fallback={<div>Inner fallback</div>}>
              <ThrowingComponent />
            </ErrorBoundary>
          </div>
        </ErrorBoundary>
      );

      expect(screen.getByText('Inner fallback')).toBeInTheDocument();
      expect(screen.queryByText('Outer fallback')).not.toBeInTheDocument();
    });
  });

  describe('fallback render function', () => {
    it('should pass error to fallback render function', () => {
      const fallbackRender = vi.fn(({ error }) => (
        <div>Error: {error.message}</div>
      ));

      render(
        <ErrorBoundary fallbackRender={fallbackRender}>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      expect(fallbackRender).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.any(Error),
          resetError: expect.any(Function),
        })
      );
      expect(screen.getByText('Error: Test error')).toBeInTheDocument();
    });

    it('should pass resetError function to fallback render', () => {
      let resetFn: (() => void) | null = null;

      const fallbackRender = ({ resetError }: { error: Error; resetError: () => void }) => {
        resetFn = resetError;
        return <button onClick={resetError}>Custom Reset</button>;
      };

      render(
        <ErrorBoundary fallbackRender={fallbackRender}>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      expect(resetFn).toBeDefined();
    });
  });

  describe('error details', () => {
    it('should show error details in development mode', () => {
      render(
        <ErrorBoundary showDetails>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      // Should show technical details
      expect(screen.getByText(/error details/i)).toBeInTheDocument();
    });

    it('should hide error stack by default', () => {
      render(
        <ErrorBoundary>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      // Should not show stack trace
      expect(screen.queryByText(/at ThrowingComponent/)).not.toBeInTheDocument();
    });
  });
});

describe('withErrorBoundary HOC', () => {
  it('should wrap component with error boundary', () => {
    const WrappedComponent = withErrorBoundary(ThrowingComponent, {
      fallback: <div>HOC fallback</div>,
    });

    render(<WrappedComponent shouldThrow />);

    expect(screen.getByText('HOC fallback')).toBeInTheDocument();
  });

  it('should pass props to wrapped component', () => {
    const TestComponent = ({ message }: { message: string }) => (
      <div>{message}</div>
    );
    const WrappedComponent = withErrorBoundary(TestComponent, {});

    render(<WrappedComponent message="Hello World" />);

    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('should preserve component display name', () => {
    const TestComponent = () => <div>Test</div>;
    TestComponent.displayName = 'MyTestComponent';

    const WrappedComponent = withErrorBoundary(TestComponent, {});

    expect(WrappedComponent.displayName).toBe('withErrorBoundary(MyTestComponent)');
  });
});
