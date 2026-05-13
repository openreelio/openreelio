/**
 * Shared Components Index
 *
 * Components used across multiple features.
 */

export { ErrorBoundary, type ErrorBoundaryProps, type FallbackProps } from './ErrorBoundary';

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

export { ErrorOverlay } from './ErrorOverlay';
export { useErrorOverlay } from './useErrorOverlay';
export { categorizeError } from './errorOverlayModel';
export type {
  ErrorSeverity,
  ErrorCategory,
  ErrorOverlayProps,
  UseErrorOverlayOptions,
  ErrorState,
} from './errorOverlayModel';
