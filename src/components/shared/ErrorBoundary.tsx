/**
 * ErrorBoundary Component
 *
 * Catches JavaScript errors anywhere in the child component tree,
 * logs those errors, and displays a fallback UI instead of crashing.
 *
 * Features:
 * - Customizable fallback UI
 * - Error callback for logging/reporting
 * - Retry functionality
 * - Optional reload button
 * - Development mode error details
 *
 * @example
 * ```tsx
 * <ErrorBoundary
 *   fallback={<div>Something went wrong</div>}
 *   onError={(error, info) => logError(error, info)}
 * >
 *   <MyComponent />
 * </ErrorBoundary>
 * ```
 */

import { Component, type ReactNode, type ErrorInfo } from 'react';

// =============================================================================
// Types
// =============================================================================

/** Props passed to fallback render function */
export interface FallbackProps {
  /** The error that was caught */
  error: Error;
  /** Function to reset the error state and retry */
  resetError: () => void;
}

/** ErrorBoundary component props */
export interface ErrorBoundaryProps {
  /** Child components to render */
  children: ReactNode;
  /** Static fallback UI to display on error */
  fallback?: ReactNode;
  /** Render function for dynamic fallback UI */
  fallbackRender?: (props: FallbackProps) => ReactNode;
  /** Callback when an error is caught */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Callback when the error is reset */
  onReset?: () => void;
  /** Show reload page button */
  showReloadButton?: boolean;
  /** Show error details (stack trace) */
  showDetails?: boolean;
}

/** ErrorBoundary component state */
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Error boundary component that catches errors in its children.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  /**
   * Update state when an error is caught.
   */
  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
    };
  }

  /**
   * Log error information and call onError callback.
   */
  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });

    // Call onError callback if provided
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  /**
   * Reset the error state to allow retry.
   */
  resetError = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });

    // Call onReset callback if provided
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  /**
   * Reload the page.
   */
  handleReload = (): void => {
    window.location.reload();
  };

  /**
   * Render the error fallback UI.
   */
  renderFallback(): ReactNode {
    const { fallback, fallbackRender, showReloadButton, showDetails } = this.props;
    const { error, errorInfo } = this.state;

    // Use fallbackRender if provided
    if (fallbackRender && error) {
      return fallbackRender({ error, resetError: this.resetError });
    }

    // Use static fallback if provided
    if (fallback) {
      return fallback;
    }

    // Default fallback UI
    return (
      <div
        role="alert"
        style={{
          padding: '20px',
          margin: '20px',
          backgroundColor: '#1a1a2e',
          border: '1px solid #e74c3c',
          borderRadius: '8px',
          color: '#ecf0f1',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <h2
          style={{
            margin: '0 0 10px 0',
            color: '#e74c3c',
            fontSize: '18px',
          }}
        >
          Something went wrong
        </h2>

        {error && (
          <p
            style={{
              margin: '0 0 15px 0',
              color: '#bdc3c7',
              fontSize: '14px',
            }}
          >
            {error.message}
          </p>
        )}

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={this.resetError}
            style={{
              padding: '8px 16px',
              backgroundColor: '#3498db',
              border: 'none',
              borderRadius: '4px',
              color: 'white',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            Try Again
          </button>

          {showReloadButton && (
            <button
              onClick={this.handleReload}
              style={{
                padding: '8px 16px',
                backgroundColor: '#7f8c8d',
                border: 'none',
                borderRadius: '4px',
                color: 'white',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              Reload Page
            </button>
          )}
        </div>

        {/* Only show error details in development mode, regardless of showDetails prop */}
        {showDetails && import.meta.env.DEV && error && errorInfo && (
          <details
            style={{
              marginTop: '15px',
              padding: '10px',
              backgroundColor: '#0d0d1a',
              borderRadius: '4px',
            }}
          >
            <summary
              style={{
                cursor: 'pointer',
                color: '#95a5a6',
                fontSize: '12px',
              }}
            >
              Error Details
            </summary>
            <pre
              style={{
                marginTop: '10px',
                padding: '10px',
                overflow: 'auto',
                fontSize: '11px',
                color: '#e74c3c',
                backgroundColor: '#1a1a2e',
                borderRadius: '4px',
              }}
            >
              {error.stack}
            </pre>
            <pre
              style={{
                marginTop: '10px',
                padding: '10px',
                overflow: 'auto',
                fontSize: '11px',
                color: '#95a5a6',
                backgroundColor: '#1a1a2e',
                borderRadius: '4px',
              }}
            >
              {errorInfo.componentStack}
            </pre>
          </details>
        )}
      </div>
    );
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.renderFallback();
    }

    return this.props.children;
  }
}

// =============================================================================
// Exports
// =============================================================================

export default ErrorBoundary;
