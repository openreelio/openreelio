import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/shared';
import { createLogger } from './services/logger';
import './styles/main.css';

const logger = createLogger('Root');

/**
 * Root error fallback for catastrophic failures.
 * Shows a basic UI that allows the user to reload the application.
 */
export function RootErrorFallback({ error, resetError }: { error: Error; resetError: () => void }) {
  return (
    <div className="flex h-screen items-center justify-center bg-editor-bg px-4 py-6 text-editor-text sm:px-8">
      <div className="w-full max-w-2xl rounded-xl border border-editor-border bg-surface-panel p-6 text-center shadow-2xl">
        <h1 className="mb-3 text-xl font-semibold text-status-error sm:text-2xl">
          OpenReelio encountered an error
        </h1>
        <p className="mx-auto mb-6 max-w-xl text-sm text-text-secondary sm:text-base">
          Something went wrong. Your work may have been auto-saved. Please try reloading the
          application.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button
            onClick={resetError}
            className="rounded-md bg-primary-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-500"
          >
            Try Again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="rounded-md bg-surface-active px-5 py-2.5 text-sm font-medium text-editor-text transition-colors hover:bg-surface-highest"
          >
            Reload Application
          </button>
        </div>

        {import.meta.env.DEV && (
          <details className="mt-6 rounded-lg border border-editor-border bg-editor-panel p-4 text-left">
            <summary className="cursor-pointer text-sm text-text-secondary">
              Error Details (Development Only)
            </summary>
            <pre className="mt-3 max-h-64 overflow-auto rounded bg-editor-bg p-3 font-mono text-xs text-status-error">
              {error.stack ?? error.message}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary
      fallbackRender={({ error, resetError }) => (
        <RootErrorFallback error={error} resetError={resetError} />
      )}
      onError={(error, errorInfo) => {
        logger.error('Unhandled application error', {
          error,
          componentStack: errorInfo.componentStack,
        });
      }}
    >
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
