 
/**
 * withErrorBoundary HOC
 *
 * Higher-order component helper for wrapping components in an ErrorBoundary.
 */

import type { ComponentType, ErrorInfo, FC, ReactNode } from 'react';
import { ErrorBoundary, type FallbackProps } from './ErrorBoundary';

/** Options for withErrorBoundary HOC */
export interface WithErrorBoundaryOptions {
  fallback?: ReactNode;
  fallbackRender?: (props: FallbackProps) => ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  onReset?: () => void;
  showReloadButton?: boolean;
  showDetails?: boolean;
}

/**
 * Higher-order component that wraps a component with an error boundary.
 *
 * @param WrappedComponent - Component to wrap
 * @param options - ErrorBoundary options
 * @returns Wrapped component with error boundary
 */
export function withErrorBoundary<P extends object>(
  WrappedComponent: ComponentType<P>,
  options: WithErrorBoundaryOptions,
): FC<P> {
  const displayName = WrappedComponent.displayName || WrappedComponent.name || 'Component';

  const ComponentWithBoundary: FC<P> = (props: P) => (
    <ErrorBoundary {...options}>
      <WrappedComponent {...props} />
    </ErrorBoundary>
  );

  ComponentWithBoundary.displayName = `withErrorBoundary(${displayName})`;

  return ComponentWithBoundary;
}

