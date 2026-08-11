/**
 * OpenReelio Application
 *
 * Main application component with conditional rendering based on project state.
 * Shows WelcomeScreen when no project is loaded, Editor when project is active.
 */

import { lazy, Suspense, useCallback, useState, useEffect, useMemo } from 'react';
import { ErrorBoundary } from './components/shared';
import { FFmpegWarning, ToastContainer, type ToastVariant } from './components/ui';
import { useProjectStore, setupProxyEventListeners, cleanupProxyEventListeners } from './stores';
import {
  useFFmpegStatus,
  useAutoSave,
  useToast,
  useSettings,
  useProjectHandlers,
  useAppLifecycle,
} from './hooks';
import { UpdateBanner } from './components/features/update';
import { AppFrame } from './components/layout';
import { createLogger, initializeLogger } from './services/logger';
import {
  loadRecentProjects,
  clearRecentProjects,
  getUserFriendlyError,
  type RecentProject,
} from './utils';
import { updateService } from './services/updateService';
import { isTauriRuntime } from './services/framePaths';
import { APP_VERSION, normalizeAppVersion } from './config/appVersion';

// Initialize logger on module load
initializeLogger();

// Create module logger
const logger = createLogger('App');

const WelcomeScreen = lazy(async () => {
  const module = await import('./components/features/welcome');
  return { default: module.WelcomeScreen };
});

const SetupWizard = lazy(async () => {
  const module = await import('./components/features/setup');
  return { default: module.SetupWizard };
});

const EditorView = lazy(async () => {
  const module = await import('./components/features/editor');
  return { default: module.EditorView };
});

function ScreenLoadingFallback(): JSX.Element {
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-editor-bg text-editor-text-muted">
      Loading interface...
    </div>
  );
}

// =============================================================================
// Main Application Component
// =============================================================================

function App(): JSX.Element {
  const { isLoaded, isLoading, getActiveSequence } = useProjectStore();

  // The Setup Wizard is only meaningful inside the actual Tauri runtime.
  // E2E tests (and Vite dev server mode) run in a normal browser environment.
  const isTauri = useMemo(() => isTauriRuntime(), []);

  // Settings for welcome screen behavior
  const { general, isLoaded: settingsLoaded } = useSettings();

  // FFmpeg status check
  const {
    isAvailable: isFFmpegAvailable,
    isLoading: isFFmpegLoading,
    recheck: recheckFFmpeg,
  } = useFFmpegStatus();
  const [showFFmpegWarning, setShowFFmpegWarning] = useState(false);
  const [ffmpegWarningDismissed, setFFmpegWarningDismissed] = useState(false);

  // Toast notifications
  const { toasts, toast, dismissToast } = useToast();

  // Backward-compatible helper for existing call sites
  const addToast = useCallback(
    (message: string, variant: ToastVariant = 'error') => toast({ message, variant }),
    [toast],
  );

  // Recent projects - load from localStorage on mount
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);

  // App version (fetched from backend)
  const [appVersion, setAppVersion] = useState(APP_VERSION);

  // Project handlers (folder-based workflow)
  const { handleOpenFolder } = useProjectHandlers({
    setRecentProjects,
    addToast,
  });

  // Application lifecycle management (close handlers)
  useAppLifecycle();

  // Show FFmpeg warning when check completes and FFmpeg is not available;
  // hide it as soon as FFmpeg becomes available (e.g. after auto-install).
  useEffect(() => {
    if (isFFmpegLoading) {
      return;
    }
    if (isFFmpegAvailable) {
      setShowFFmpegWarning(false);
    } else if (!ffmpegWarningDismissed) {
      setShowFFmpegWarning(true);
    }
  }, [isFFmpegLoading, isFFmpegAvailable, ffmpegWarningDismissed]);

  // Load recent projects and version on mount
  useEffect(() => {
    const projects = loadRecentProjects();
    setRecentProjects(projects);

    updateService
      .getCurrentVersion()
      .then((version) => setAppVersion(normalizeAppVersion(version)))
      .catch((error) => {
        logger.warn('Failed to fetch app version', { error });
      });
  }, []);

  // Auto-save functionality (30 second delay after changes)
  useAutoSave({
    delay: 30_000,
    enabled: true,
    onSaveError: (error) => {
      logger.error('Auto-save failed', { error });
    },
  });

  // Setup proxy event listeners on app mount
  useEffect(() => {
    setupProxyEventListeners().catch((error) => {
      logger.error('Failed to setup proxy event listeners', { error });
    });

    return () => {
      cleanupProxyEventListeners().catch((error) => {
        logger.error('Failed to cleanup proxy event listeners', { error });
      });
    };
  }, []);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleDismissFFmpegWarning = useCallback(() => {
    setShowFFmpegWarning(false);
    setFFmpegWarningDismissed(true);
  }, []);

  // Handle clearing all recent projects
  const handleClearRecentProjects = useCallback(() => {
    clearRecentProjects();
    setRecentProjects([]);
  }, []);

  // Error handler for EditorView - shows toast and offers reload
  const handleEditorError = useCallback(
    (error: Error) => {
      logger.error('Editor view error', { error });
      addToast(
        `${getUserFriendlyError(error, { includeTechnicalDetails: false })} Try reloading the application if the issue persists.`,
        'error',
      );
    },
    [addToast],
  );

  // ===========================================================================
  // Render
  // ===========================================================================

  // Show Setup Wizard on first run (before any project is loaded)
  if (isTauri && settingsLoaded && !general.hasCompletedSetup) {
    return (
      <>
        <AppFrame
          banner={<UpdateBanner checkOnMount={settingsLoaded && general.checkUpdatesOnStartup} />}
        >
          <Suspense fallback={<ScreenLoadingFallback />}>
            <SetupWizard
              onComplete={() => {
                // After setup, refresh to show welcome screen
                logger.info('Setup wizard completed');
              }}
              onSkip={() => {
                logger.info('Setup wizard skipped');
              }}
              version={appVersion}
            />
          </Suspense>
        </AppFrame>
        <ToastContainer toasts={toasts} onClose={dismissToast} />
      </>
    );
  }

  // Show Welcome Screen when no project is loaded
  if (!isLoaded) {
    return (
      <>
        <AppFrame
          banner={<UpdateBanner checkOnMount={settingsLoaded && general.checkUpdatesOnStartup} />}
        >
          <Suspense fallback={<ScreenLoadingFallback />}>
            <WelcomeScreen
              onOpenFolder={(path) => void handleOpenFolder(path)}
              recentProjects={recentProjects}
              isLoading={isLoading}
              version={appVersion}
              onClearRecentProjects={handleClearRecentProjects}
            />
          </Suspense>
        </AppFrame>
        <FFmpegWarning
          isOpen={showFFmpegWarning}
          onDismiss={handleDismissFFmpegWarning}
          allowDismiss={true}
          onRecheck={recheckFFmpeg}
        />
        <ToastContainer toasts={toasts} onClose={dismissToast} />
      </>
    );
  }

  // Show Editor when project is loaded
  const activeSequence = getActiveSequence();

  return (
    <>
      <AppFrame
        banner={<UpdateBanner checkOnMount={settingsLoaded && general.checkUpdatesOnStartup} />}
      >
        <ErrorBoundary
          onError={handleEditorError}
          showDetails={import.meta.env.DEV}
          showReloadButton={true}
          fallbackRender={({ error, resetError }) => (
            <div className="flex h-full min-h-0 flex-col items-center justify-center bg-editor-bg p-4 text-center text-editor-text sm:p-8">
              <div className="text-status-error text-6xl mb-4">⚠️</div>
              <h1 className="text-xl sm:text-2xl font-bold text-status-error mb-2">Editor Error</h1>
              <p className="text-text-secondary mb-6 max-w-md px-4">
                The editor encountered an error. Your recent work may have been auto-saved.
              </p>
              <p className="mb-6 w-full max-w-md break-words overflow-x-auto rounded bg-surface-elevated p-2 font-mono text-sm text-text-muted [overflow-wrap:anywhere]">
                {import.meta.env.DEV
                  ? error.message
                  : getUserFriendlyError(error, { includeTechnicalDetails: false })}
              </p>
              <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 w-full sm:w-auto px-4">
                <button
                  onClick={resetError}
                  className="px-6 py-2 bg-primary-600 hover:bg-primary-500 text-white rounded transition-colors"
                >
                  Try Again
                </button>
                <button
                  onClick={() => window.location.reload()}
                  className="px-6 py-2 bg-surface-active hover:bg-surface-highest text-text-primary rounded transition-colors"
                >
                  Reload Application
                </button>
              </div>
            </div>
          )}
        >
          <Suspense fallback={<ScreenLoadingFallback />}>
            <EditorView sequence={activeSequence ?? null} appVersion={appVersion} />
          </Suspense>
        </ErrorBoundary>
      </AppFrame>
      <FFmpegWarning
        isOpen={showFFmpegWarning}
        onDismiss={handleDismissFFmpegWarning}
        allowDismiss={true}
        onRecheck={recheckFFmpeg}
      />
      <ToastContainer toasts={toasts} onClose={dismissToast} />
    </>
  );
}

export default App;
