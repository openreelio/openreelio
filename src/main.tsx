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
function RootErrorFallback({ error, resetError }: { error: Error; resetError: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        backgroundColor: '#0d0d1a',
        color: '#ecf0f1',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: '20px',
        textAlign: 'center',
      }}
    >
      <h1 style={{ color: '#e74c3c', marginBottom: '16px' }}>
        OpenReelio encountered an error
      </h1>
      <p style={{ color: '#bdc3c7', marginBottom: '24px', maxWidth: '500px' }}>
        Something went wrong. Your work may have been auto-saved.
        Please try reloading the application.
      </p>
      <div style={{ display: 'flex', gap: '12px' }}>
        <button
          onClick={resetError}
          style={{
            padding: '12px 24px',
            backgroundColor: '#3498db',
            border: 'none',
            borderRadius: '6px',
            color: 'white',
            cursor: 'pointer',
            fontSize: '14px',
          }}
        >
          Try Again
        </button>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '12px 24px',
            backgroundColor: '#7f8c8d',
            border: 'none',
            borderRadius: '6px',
            color: 'white',
            cursor: 'pointer',
            fontSize: '14px',
          }}
        >
          Reload Application
        </button>
      </div>
      {import.meta.env.DEV && (
        <details
          style={{
            marginTop: '24px',
            padding: '16px',
            backgroundColor: '#1a1a2e',
            borderRadius: '8px',
            maxWidth: '600px',
            textAlign: 'left',
          }}
        >
          <summary style={{ cursor: 'pointer', color: '#95a5a6' }}>
            Error Details (Development Only)
          </summary>
          <pre
            style={{
              marginTop: '12px',
              padding: '12px',
              overflow: 'auto',
              fontSize: '11px',
              color: '#e74c3c',
              backgroundColor: '#0d0d1a',
              borderRadius: '4px',
            }}
          >
            {error.stack ?? error.message}
          </pre>
        </details>
      )}
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
  </React.StrictMode>
);
