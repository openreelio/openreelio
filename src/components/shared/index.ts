/**
 * Shared Components Index
 *
 * Components used across multiple features.
 */

export {
  ErrorBoundary,
  type ErrorBoundaryProps,
  type FallbackProps,
} from './ErrorBoundary';

export { withErrorBoundary, type WithErrorBoundaryOptions } from './withErrorBoundary';

export {
  TimelineErrorBoundary,
  PreviewErrorBoundary,
  ExplorerErrorBoundary,
  InspectorErrorBoundary,
  AIErrorBoundary,
  SearchErrorBoundary,
  ExportErrorBoundary,
} from './FeatureErrorBoundaries';

export {
  ErrorOverlay,
  useErrorOverlay,
  categorizeError,
} from './ErrorOverlay';
export type {
  ErrorSeverity,
  ErrorCategory,
  ErrorOverlayProps,
  UseErrorOverlayOptions,
  ErrorState,
} from './ErrorOverlay';
