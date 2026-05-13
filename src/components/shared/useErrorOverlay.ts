import { createElement, useCallback, useMemo, useState, type ComponentType } from 'react';
import { ErrorOverlay } from './ErrorOverlay';
import type { ErrorState, ShowErrorOptions, UseErrorOverlayOptions } from './errorOverlayModel';

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
    [defaultSeverity],
  );

  const clearError = useCallback(() => {
    setErrorState(null);
  }, []);

  const ErrorOverlayComponent = useMemo<ComponentType>(
    () =>
      function ErrorOverlayWrapper() {
        return createElement(ErrorOverlay, {
          error: errorState?.error ?? null,
          severity: errorState?.severity,
          title: errorState?.title,
          onDismiss: clearError,
        });
      },
    [errorState, clearError],
  );

  return {
    error: errorState?.error ?? null,
    errorState,
    showError,
    clearError,
    ErrorOverlayComponent,
  };
}
