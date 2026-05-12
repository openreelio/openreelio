export type ErrorSeverity = 'warning' | 'error' | 'critical';

export type ErrorCategory = 'network' | 'ffmpeg' | 'render' | 'ipc' | 'unknown';

export interface ErrorOverlayProps {
  /** The error to display */
  error: Error | null;
  /** Error severity level */
  severity?: ErrorSeverity;
  /** Custom title for the error */
  title?: string;
  /** Callback when dismissed */
  onDismiss?: () => void;
  /** Callback for retry action */
  onRetry?: () => void;
  /** Custom label for retry button */
  retryLabel?: string;
  /** Whether to show error details (stack trace) */
  showDetails?: boolean;
  /** React component stack (from error boundary) */
  componentStack?: string;
}

export interface UseErrorOverlayOptions {
  /** Default severity for errors */
  defaultSeverity?: ErrorSeverity;
}

export interface ErrorState {
  error: Error;
  severity: ErrorSeverity;
  title?: string;
}

export interface ShowErrorOptions {
  severity?: ErrorSeverity;
  title?: string;
}

/**
 * Categorizes an error based on its message and name.
 * Used to provide more helpful error messages and recovery suggestions.
 */
export function categorizeError(error: Error): ErrorCategory {
  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  if (
    message.includes('fetch') ||
    message.includes('network') ||
    message.includes('cors') ||
    message.includes('timeout')
  ) {
    return 'network';
  }

  if (message.includes('ffmpeg') || message.includes('encoder') || message.includes('codec')) {
    return 'ffmpeg';
  }

  if (name === 'chunkloaderror' || message.includes('chunk') || message.includes('loading')) {
    return 'render';
  }

  if (message.includes('ipc') || message.includes('invoke') || message.includes('tauri')) {
    return 'ipc';
  }

  return 'unknown';
}

/**
 * Get user-friendly title based on error category.
 */
export function getErrorTitle(category: ErrorCategory): string {
  switch (category) {
    case 'network':
      return 'Network Error';
    case 'ffmpeg':
      return 'Video Processing Error';
    case 'render':
      return 'Render Error';
    case 'ipc':
      return 'Application Error';
    default:
      return 'Error';
  }
}

/**
 * Get recovery suggestion based on error category.
 */
export function getRecoverySuggestion(category: ErrorCategory): string {
  switch (category) {
    case 'network':
      return 'Please check your internet connection and try again.';
    case 'ffmpeg':
      return 'There was an issue processing the video. Try a different format or codec.';
    case 'render':
      return 'The application encountered a rendering issue. Please reload.';
    case 'ipc':
      return 'Communication with the backend failed. Please restart the application.';
    default:
      return 'An unexpected error occurred.';
  }
}
