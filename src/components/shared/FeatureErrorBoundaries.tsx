/**
 * Feature Error Boundaries
 *
 * Specialized error boundaries for major app features with custom fallback UIs.
 * These provide better user experience by showing context-specific error messages
 * and recovery options.
 */

import { type ReactNode, type ErrorInfo, memo } from 'react';
import { Film, Play, FolderOpen, Settings, RefreshCw } from 'lucide-react';
import { ErrorBoundary, type FallbackProps } from './ErrorBoundary';
import { createLogger } from '@/services/logger';

// =============================================================================
// Types
// =============================================================================

interface FeatureErrorBoundaryProps {
  children: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  onReset?: () => void;
}

interface FeatureFallbackProps extends FallbackProps {
  title: string;
  icon: ReactNode;
  testId: string;
}

// =============================================================================
// Logger
// =============================================================================

const logger = createLogger('ErrorBoundary');

// =============================================================================
// Common Fallback Component
// =============================================================================

const FeatureErrorFallback = memo(function FeatureErrorFallback({
  error,
  resetError,
  title,
  icon,
  testId,
}: FeatureFallbackProps) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center h-full min-h-[200px] p-6 bg-editor-bg border border-red-500/30 rounded-lg"
    >
      {/* Icon */}
      <div
        data-testid={testId}
        className="flex items-center justify-center w-16 h-16 mb-4 rounded-full bg-red-500/10 text-red-400"
      >
        {icon}
      </div>

      {/* Title */}
      <h3 className="text-lg font-semibold text-red-400 mb-2">{title}</h3>

      {/* Error message */}
      <p className="text-sm text-editor-text-muted text-center mb-4 max-w-md">
        {error.message || 'An unexpected error occurred'}
      </p>

      {/* Retry button */}
      <button
        onClick={resetError}
        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-500 rounded-md transition-colors"
      >
        <RefreshCw className="w-4 h-4" />
        Retry
      </button>

      {/* Technical details for development */}
      {import.meta.env.DEV && error.stack && (
        <details className="mt-4 w-full max-w-lg">
          <summary className="text-xs text-editor-text-muted cursor-pointer hover:text-editor-text">
            Technical Details
          </summary>
          <pre className="mt-2 p-2 text-xs text-red-300 bg-black/30 rounded overflow-auto max-h-32">
            {error.stack}
          </pre>
        </details>
      )}
    </div>
  );
});

// =============================================================================
// Timeline Error Boundary
// =============================================================================

/**
 * Error boundary for the Timeline component.
 * Shows a timeline-specific fallback with retry option.
 */
export function TimelineErrorBoundary({
  children,
  onError,
  onReset,
}: FeatureErrorBoundaryProps): JSX.Element {
  const handleError = (error: Error, errorInfo: ErrorInfo) => {
    logger.error('Timeline error', { error });
    onError?.(error, errorInfo);
  };

  return (
    <ErrorBoundary
      fallbackRender={(props) => (
        <FeatureErrorFallback
          {...props}
          title="Timeline Error"
          icon={<Film className="w-8 h-8" />}
          testId="timeline-error-icon"
        />
      )}
      onError={handleError}
      onReset={onReset}
    >
      {children}
    </ErrorBoundary>
  );
}

// =============================================================================
// Preview Error Boundary
// =============================================================================

/**
 * Error boundary for the Preview/Player component.
 * Shows a preview-specific fallback with retry option.
 */
export function PreviewErrorBoundary({
  children,
  onError,
  onReset,
}: FeatureErrorBoundaryProps): JSX.Element {
  const handleError = (error: Error, errorInfo: ErrorInfo) => {
    logger.error('Preview error', { error });
    onError?.(error, errorInfo);
  };

  return (
    <ErrorBoundary
      fallbackRender={(props) => (
        <FeatureErrorFallback
          {...props}
          title="Preview Error"
          icon={<Play className="w-8 h-8" />}
          testId="preview-error-icon"
        />
      )}
      onError={handleError}
      onReset={onReset}
    >
      {children}
    </ErrorBoundary>
  );
}

// =============================================================================
// Explorer Error Boundary
// =============================================================================

/**
 * Error boundary for the Asset Explorer component.
 * Shows an explorer-specific fallback with retry option.
 */
export function ExplorerErrorBoundary({
  children,
  onError,
  onReset,
}: FeatureErrorBoundaryProps): JSX.Element {
  const handleError = (error: Error, errorInfo: ErrorInfo) => {
    logger.error('Explorer error', { error });
    onError?.(error, errorInfo);
  };

  return (
    <ErrorBoundary
      fallbackRender={(props) => (
        <FeatureErrorFallback
          {...props}
          title="Asset Explorer Error"
          icon={<FolderOpen className="w-8 h-8" />}
          testId="explorer-error-icon"
        />
      )}
      onError={handleError}
      onReset={onReset}
    >
      {children}
    </ErrorBoundary>
  );
}

// =============================================================================
// Inspector Error Boundary
// =============================================================================

/**
 * Error boundary for the Inspector/Properties panel component.
 * Shows an inspector-specific fallback with retry option.
 */
export function InspectorErrorBoundary({
  children,
  onError,
  onReset,
}: FeatureErrorBoundaryProps): JSX.Element {
  const handleError = (error: Error, errorInfo: ErrorInfo) => {
    logger.error('Inspector error', { error });
    onError?.(error, errorInfo);
  };

  return (
    <ErrorBoundary
      fallbackRender={(props) => (
        <FeatureErrorFallback
          {...props}
          title="Inspector Error"
          icon={<Settings className="w-8 h-8" />}
          testId="inspector-error-icon"
        />
      )}
      onError={handleError}
      onReset={onReset}
    >
      {children}
    </ErrorBoundary>
  );
}
