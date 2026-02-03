/**
 * ErrorOverlay Component
 *
 * A modal overlay for displaying critical errors that require user attention.
 * Unlike toast notifications, error overlays are more prominent and may not be dismissable.
 *
 * Features:
 * - Severity levels (warning, error, critical)
 * - Optional retry/recovery action
 * - Error categorization for better UX
 * - Development mode error details
 * - Keyboard accessibility
 *
 * @module components/shared/ErrorOverlay
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react';

// =============================================================================
// Types
// =============================================================================

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

// =============================================================================
// Error Categorization
// =============================================================================

/**
 * Categorizes an error based on its message and name.
 * Used to provide more helpful error messages and recovery suggestions.
 */
export function categorizeError(error: Error): ErrorCategory {
  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  // Network errors
  if (
    message.includes('fetch') ||
    message.includes('network') ||
    message.includes('cors') ||
    message.includes('timeout')
  ) {
    return 'network';
  }

  // FFmpeg errors
  if (
    message.includes('ffmpeg') ||
    message.includes('encoder') ||
    message.includes('codec')
  ) {
    return 'ffmpeg';
  }

  // Render/chunk errors
  if (
    name === 'chunkloaderror' ||
    message.includes('chunk') ||
    message.includes('loading')
  ) {
    return 'render';
  }

  // Tauri IPC errors
  if (
    message.includes('ipc') ||
    message.includes('invoke') ||
    message.includes('tauri')
  ) {
    return 'ipc';
  }

  return 'unknown';
}

/**
 * Get user-friendly title based on error category.
 */
function getErrorTitle(category: ErrorCategory): string {
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
function getRecoverySuggestion(category: ErrorCategory): string {
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

// =============================================================================
// Styles
// =============================================================================

const styles = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
    padding: '20px',
  },
  dialog: {
    base: {
      backgroundColor: '#1a1a2e',
      borderRadius: '12px',
      maxWidth: '500px',
      width: '100%',
      boxShadow: '0 20px 40px rgba(0, 0, 0, 0.4)',
      overflow: 'hidden',
    },
    warning: {
      borderTop: '4px solid #f39c12',
    },
    error: {
      borderTop: '4px solid #e74c3c',
    },
    critical: {
      borderTop: '4px solid #9b59b6',
    },
  },
  header: {
    base: {
      padding: '16px 20px',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
    },
    warning: { backgroundColor: 'rgba(243, 156, 18, 0.1)' },
    error: { backgroundColor: 'rgba(231, 76, 60, 0.1)' },
    critical: { backgroundColor: 'rgba(155, 89, 182, 0.1)' },
  },
  icon: {
    width: '24px',
    height: '24px',
    flexShrink: 0,
  },
  title: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 600,
    color: '#ecf0f1',
  },
  body: {
    padding: '20px',
  },
  message: {
    margin: '0 0 12px 0',
    fontSize: '14px',
    color: '#e74c3c',
    lineHeight: 1.5,
    fontFamily: 'monospace',
  },
  suggestion: {
    margin: '0 0 16px 0',
    fontSize: '14px',
    color: '#bdc3c7',
    lineHeight: 1.5,
  },
  actions: {
    padding: '16px 20px',
    borderTop: '1px solid rgba(255, 255, 255, 0.1)',
    display: 'flex',
    gap: '10px',
    justifyContent: 'flex-end',
  },
  button: {
    base: {
      padding: '10px 20px',
      border: 'none',
      borderRadius: '6px',
      fontSize: '14px',
      fontWeight: 500,
      cursor: 'pointer',
      transition: 'background-color 0.15s ease',
    },
    primary: {
      backgroundColor: '#3498db',
      color: 'white',
    },
    secondary: {
      backgroundColor: '#7f8c8d',
      color: 'white',
    },
    danger: {
      backgroundColor: '#e74c3c',
      color: 'white',
    },
  },
  details: {
    marginTop: '16px',
    padding: '12px',
    backgroundColor: '#0d0d1a',
    borderRadius: '6px',
  },
  summary: {
    cursor: 'pointer',
    fontSize: '12px',
    color: '#95a5a6',
    userSelect: 'none' as const,
  },
  stack: {
    marginTop: '12px',
    padding: '12px',
    backgroundColor: '#1a1a2e',
    borderRadius: '4px',
    fontSize: '11px',
    color: '#e74c3c',
    overflow: 'auto',
    maxHeight: '200px',
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
  },
  componentStack: {
    marginTop: '12px',
    padding: '12px',
    backgroundColor: '#1a1a2e',
    borderRadius: '4px',
    fontSize: '11px',
    color: '#95a5a6',
    overflow: 'auto',
    maxHeight: '150px',
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap' as const,
  },
};

// =============================================================================
// Icons
// =============================================================================

const WarningIcon = () => (
  <svg style={styles.icon} viewBox="0 0 24 24" fill="#f39c12">
    <path d="M12 2L1 21h22L12 2zm0 3.99L19.53 19H4.47L12 5.99zM11 10v4h2v-4h-2zm0 6v2h2v-2h-2z" />
  </svg>
);

const ErrorIcon = () => (
  <svg style={styles.icon} viewBox="0 0 24 24" fill="#e74c3c">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
  </svg>
);

const CriticalIcon = () => (
  <svg style={styles.icon} viewBox="0 0 24 24" fill="#9b59b6">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
  </svg>
);

function getSeverityIcon(severity: ErrorSeverity) {
  switch (severity) {
    case 'warning':
      return <WarningIcon />;
    case 'critical':
      return <CriticalIcon />;
    default:
      return <ErrorIcon />;
  }
}

// =============================================================================
// ErrorOverlay Component
// =============================================================================

export function ErrorOverlay({
  error,
  severity = 'error',
  title,
  onDismiss,
  onRetry,
  retryLabel = 'Retry',
  showDetails = false,
  componentStack,
}: ErrorOverlayProps) {
  const titleId = useId();
  const descId = useId();

  // Critical errors cannot be dismissed
  const canDismiss = severity !== 'critical' && !!onDismiss;

  // Handle escape key - must be before early return to satisfy React hook rules
  useEffect(() => {
    if (!error || !canDismiss) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onDismiss?.();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [error, canDismiss, onDismiss]);

  // Handle reload for critical errors - must be before early return
  const handleReload = useCallback(() => {
    window.location.reload();
  }, []);

  // Early return if no error
  if (!error) {
    return null;
  }

  // Categorize error
  const category = categorizeError(error);
  const displayTitle = title ?? getErrorTitle(category);
  const suggestion = getRecoverySuggestion(category);

  return (
    <div style={styles.overlay}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className={severity}
        style={{
          ...styles.dialog.base,
          ...styles.dialog[severity],
        }}
      >
        {/* Header */}
        <div
          style={{
            ...styles.header.base,
            ...styles.header[severity],
          }}
        >
          {getSeverityIcon(severity)}
          <h2 id={titleId} style={styles.title}>
            {displayTitle}
          </h2>
        </div>

        {/* Body */}
        <div style={styles.body}>
          <p id={descId} style={styles.message}>
            {error.message}
          </p>
          <p style={styles.suggestion}>{suggestion}</p>

          {/* Error Details */}
          {showDetails && error.stack && (
            <details style={styles.details}>
              <summary style={styles.summary}>Error Details</summary>
              <pre style={styles.stack}>{error.stack}</pre>
              {componentStack && (
                <>
                  <p style={{ ...styles.summary, marginTop: '12px' }}>
                    Component Stack
                  </p>
                  <pre style={styles.componentStack}>{componentStack}</pre>
                </>
              )}
            </details>
          )}
        </div>

        {/* Actions */}
        <div style={styles.actions}>
          {severity === 'critical' ? (
            <button
              onClick={handleReload}
              style={{ ...styles.button.base, ...styles.button.danger }}
            >
              Reload Application
            </button>
          ) : (
            <>
              {onRetry && (
                <button
                  onClick={onRetry}
                  style={{ ...styles.button.base, ...styles.button.primary }}
                >
                  {retryLabel}
                </button>
              )}
              {canDismiss && (
                <button
                  onClick={onDismiss}
                  style={{ ...styles.button.base, ...styles.button.secondary }}
                >
                  Dismiss
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// useErrorOverlay Hook
// =============================================================================

interface ShowErrorOptions {
  severity?: ErrorSeverity;
  title?: string;
}

/**
 * Hook for managing error overlay state.
 *
 * @example
 * ```tsx
 * const { showError, clearError, ErrorOverlayComponent } = useErrorOverlay();
 *
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   showError(error as Error, { severity: 'error' });
 * }
 *
 * return <ErrorOverlayComponent />;
 * ```
 */
export function useErrorOverlay(options: UseErrorOverlayOptions = {}) {
  const { defaultSeverity = 'error' } = options;
  const [errorState, setErrorState] = useState<ErrorState | null>(null);

  const showError = useCallback(
    (error: Error, opts: ShowErrorOptions = {}) => {
      setErrorState({
        error,
        severity: opts.severity ?? defaultSeverity,
        title: opts.title,
      });
    },
    [defaultSeverity]
  );

  const clearError = useCallback(() => {
    setErrorState(null);
  }, []);

  const ErrorOverlayComponent = useMemo(
    () =>
      function ErrorOverlayWrapper() {
        return (
          <ErrorOverlay
            error={errorState?.error ?? null}
            severity={errorState?.severity}
            title={errorState?.title}
            onDismiss={clearError}
          />
        );
      },
    [errorState, clearError]
  );

  return {
    error: errorState?.error ?? null,
    errorState,
    showError,
    clearError,
    ErrorOverlayComponent,
  };
}

// =============================================================================
// Exports
// =============================================================================

export default ErrorOverlay;
