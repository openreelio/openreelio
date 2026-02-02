/**
 * Error Overlay Tests
 *
 * Tests for the critical error overlay component.
 * Following TDD methodology - tests written first.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  ErrorOverlay,
  useErrorOverlay,
  categorizeError,
} from './ErrorOverlay';

describe('ErrorOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Basic Rendering
  // ===========================================================================

  describe('basic rendering', () => {
    it('should not render when error is null', () => {
      render(<ErrorOverlay error={null} />);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('should render when error is provided', () => {
      render(<ErrorOverlay error={new Error('Test error')} />);
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });

    it('should display error message', () => {
      render(<ErrorOverlay error={new Error('Something went wrong')} />);
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });

    it('should display custom title', () => {
      render(
        <ErrorOverlay
          error={new Error('Test')}
          title="Custom Error Title"
        />
      );
      expect(screen.getByText('Custom Error Title')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Severity Levels
  // ===========================================================================

  describe('severity levels', () => {
    it('should render warning severity with correct styling', () => {
      render(
        <ErrorOverlay error={new Error('Warning')} severity="warning" />
      );
      const dialog = screen.getByRole('alertdialog');
      expect(dialog).toHaveClass('warning');
    });

    it('should render error severity with correct styling', () => {
      render(
        <ErrorOverlay error={new Error('Error')} severity="error" />
      );
      const dialog = screen.getByRole('alertdialog');
      expect(dialog).toHaveClass('error');
    });

    it('should render critical severity with correct styling', () => {
      render(
        <ErrorOverlay error={new Error('Critical')} severity="critical" />
      );
      const dialog = screen.getByRole('alertdialog');
      expect(dialog).toHaveClass('critical');
    });

    it('should default to error severity', () => {
      render(<ErrorOverlay error={new Error('Default')} />);
      const dialog = screen.getByRole('alertdialog');
      expect(dialog).toHaveClass('error');
    });
  });

  // ===========================================================================
  // Dismiss Behavior
  // ===========================================================================

  describe('dismiss behavior', () => {
    it('should call onDismiss when dismiss button is clicked', () => {
      const onDismiss = vi.fn();
      render(
        <ErrorOverlay
          error={new Error('Test')}
          onDismiss={onDismiss}
        />
      );

      fireEvent.click(screen.getByText('Dismiss'));
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('should not show dismiss button for critical errors', () => {
      render(
        <ErrorOverlay
          error={new Error('Critical')}
          severity="critical"
          onDismiss={vi.fn()}
        />
      );

      expect(screen.queryByText('Dismiss')).not.toBeInTheDocument();
    });

    it('should close on Escape key for non-critical errors', () => {
      const onDismiss = vi.fn();
      render(
        <ErrorOverlay
          error={new Error('Test')}
          severity="warning"
          onDismiss={onDismiss}
        />
      );

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('should not close on Escape key for critical errors', () => {
      const onDismiss = vi.fn();
      render(
        <ErrorOverlay
          error={new Error('Critical')}
          severity="critical"
          onDismiss={onDismiss}
        />
      );

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onDismiss).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Retry/Recovery Action
  // ===========================================================================

  describe('retry/recovery action', () => {
    it('should show retry button when onRetry is provided', () => {
      const onRetry = vi.fn();
      render(
        <ErrorOverlay
          error={new Error('Test')}
          onRetry={onRetry}
        />
      );

      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    it('should call onRetry when retry button is clicked', () => {
      const onRetry = vi.fn();
      render(
        <ErrorOverlay
          error={new Error('Test')}
          onRetry={onRetry}
        />
      );

      fireEvent.click(screen.getByText('Retry'));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('should show custom recovery label', () => {
      render(
        <ErrorOverlay
          error={new Error('Test')}
          onRetry={vi.fn()}
          retryLabel="Try Again"
        />
      );

      expect(screen.getByText('Try Again')).toBeInTheDocument();
    });

    it('should show reload button for critical errors', () => {
      render(
        <ErrorOverlay
          error={new Error('Critical')}
          severity="critical"
        />
      );

      expect(screen.getByText('Reload Application')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Error Details (Development Mode)
  // ===========================================================================

  describe('error details', () => {
    it('should show error details when showDetails is true', () => {
      const error = new Error('Test error');
      error.stack = 'Error: Test error\n    at test.ts:1:1';

      render(
        <ErrorOverlay
          error={error}
          showDetails={true}
        />
      );

      expect(screen.getByText(/Error Details/i)).toBeInTheDocument();
    });

    it('should show stack trace in details', () => {
      const error = new Error('Test error');
      error.stack = 'Error: Test error\n    at test.ts:1:1';

      render(
        <ErrorOverlay
          error={error}
          showDetails={true}
        />
      );

      // Click to expand details
      fireEvent.click(screen.getByText(/Error Details/i));
      expect(screen.getByText(/at test.ts:1:1/)).toBeInTheDocument();
    });

    it('should not show details by default', () => {
      render(
        <ErrorOverlay error={new Error('Test')} />
      );

      expect(screen.queryByText(/Error Details/i)).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Component Stack
  // ===========================================================================

  describe('component stack', () => {
    it('should show component stack when provided', () => {
      render(
        <ErrorOverlay
          error={new Error('Test')}
          componentStack="in MyComponent\nin ParentComponent"
          showDetails={true}
        />
      );

      fireEvent.click(screen.getByText(/Error Details/i));
      expect(screen.getByText(/Component Stack/i)).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Error Categorization
  // ===========================================================================

  describe('error categorization', () => {
    it('should categorize network errors', () => {
      const error = new Error('fetch failed: network error');
      expect(categorizeError(error)).toBe('network');
    });

    it('should categorize FFmpeg errors', () => {
      const error = new Error('FFmpeg process exited with code 1');
      expect(categorizeError(error)).toBe('ffmpeg');
    });

    it('should categorize render errors', () => {
      const error = new Error('ChunkLoadError: Loading chunk failed');
      error.name = 'ChunkLoadError';
      expect(categorizeError(error)).toBe('render');
    });

    it('should categorize Tauri IPC errors', () => {
      const error = new Error('IPC command failed: invoke error');
      expect(categorizeError(error)).toBe('ipc');
    });

    it('should categorize unknown errors', () => {
      const error = new Error('Some random error');
      expect(categorizeError(error)).toBe('unknown');
    });
  });

  // ===========================================================================
  // useErrorOverlay Hook
  // ===========================================================================

  describe('useErrorOverlay hook', () => {
    const TestComponent = () => {
      const { error, showError, clearError, ErrorOverlayComponent } = useErrorOverlay();

      return (
        <div>
          <button
            data-testid="show-error"
            onClick={() => showError(new Error('Hook error'), { severity: 'warning' })}
          >
            Show Error
          </button>
          <button data-testid="clear-error" onClick={clearError}>
            Clear Error
          </button>
          <div data-testid="has-error">{error ? 'yes' : 'no'}</div>
          <ErrorOverlayComponent />
        </div>
      );
    };

    it('should start with no error', () => {
      render(<TestComponent />);
      expect(screen.getByTestId('has-error')).toHaveTextContent('no');
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('should show error when showError is called', () => {
      render(<TestComponent />);

      fireEvent.click(screen.getByTestId('show-error'));

      expect(screen.getByTestId('has-error')).toHaveTextContent('yes');
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      expect(screen.getByText('Hook error')).toBeInTheDocument();
    });

    it('should clear error when clearError is called', () => {
      render(<TestComponent />);

      // Show error first
      fireEvent.click(screen.getByTestId('show-error'));
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();

      // Clear error
      fireEvent.click(screen.getByTestId('clear-error'));
      expect(screen.getByTestId('has-error')).toHaveTextContent('no');
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Accessibility
  // ===========================================================================

  describe('accessibility', () => {
    it('should have role="alertdialog"', () => {
      render(<ErrorOverlay error={new Error('Test')} />);
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });

    it('should have aria-modal="true"', () => {
      render(<ErrorOverlay error={new Error('Test')} />);
      expect(screen.getByRole('alertdialog')).toHaveAttribute('aria-modal', 'true');
    });

    it('should have aria-labelledby pointing to title', () => {
      render(<ErrorOverlay error={new Error('Test')} />);
      const dialog = screen.getByRole('alertdialog');
      expect(dialog).toHaveAttribute('aria-labelledby');
    });

    it('should have aria-describedby pointing to message', () => {
      render(<ErrorOverlay error={new Error('Test')} />);
      const dialog = screen.getByRole('alertdialog');
      expect(dialog).toHaveAttribute('aria-describedby');
    });
  });
});
