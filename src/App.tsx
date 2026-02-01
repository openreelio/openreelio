/**
 * OpenReelio Application
 *
 * Main application component with conditional rendering based on project state.
 * Shows WelcomeScreen when no project is loaded, Editor when project is active.
 */

import { useCallback, useState, useEffect, useMemo } from 'react';
import { ErrorBoundary } from './components/shared';
import { WelcomeScreen } from './components/features/welcome';
import { ProjectCreationDialog } from './components/features/project';
import { SetupWizard } from './components/features/setup';
import { EditorView } from './components/features/editor';
import { FFmpegWarning, ToastContainer, type ToastVariant } from './components/ui';
import {
  useProjectStore,
  setupProxyEventListeners,
  cleanupProxyEventListeners,
} from './stores';
import { initializeAgentSystem } from './stores/aiStore';
import {
  useFFmpegStatus,
  useAutoSave,
  useToast,
  useSettings,
  useProjectHandlers,
  useAppLifecycle,
} from './hooks';
import { UpdateBanner } from './components/features/update';
import { createLogger, initializeLogger } from './services/logger';
import { loadRecentProjects, clearRecentProjects, type RecentProject } from './utils';
import { updateService } from './services/updateService';
import { isTauriRuntime } from './services/framePaths';

// Initialize logger on module load
initializeLogger();

// Create module logger
const logger = createLogger('App');

// =============================================================================
// Main Application Component
// =============================================================================

function App(): JSX.Element {
  const { isLoaded, isLoading, getActiveSequence } = useProjectStore();

  // The Setup Wizard is only meaningful inside the actual Tauri runtime.
  // E2E tests (and Vite dev server mode) run in a normal browser environment.
  const isTauri = useMemo(() => isTauriRuntime(), []);

  // Settings for welcome screen behavior
  const { general, updateGeneral, isLoaded: settingsLoaded } = useSettings();

  // FFmpeg status check
  const { isAvailable: isFFmpegAvailable, isLoading: isFFmpegLoading } = useFFmpegStatus();
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
  const [appVersion, setAppVersion] = useState('0.1.0');

  // Project handlers (creation, opening)
  const {
    showCreateDialog,
    isCreatingProject,
    handleNewProject,
    handleCreateProject,
    handleCancelCreate,
    handleOpenProject,
  } = useProjectHandlers({
    setRecentProjects,
    addToast,
  });

  // Application lifecycle management (close handlers)
  useAppLifecycle();

  // Show FFmpeg warning when check completes and FFmpeg is not available
  useEffect(() => {
    if (!isFFmpegLoading && !isFFmpegAvailable && !ffmpegWarningDismissed) {
      setShowFFmpegWarning(true);
    }
  }, [isFFmpegLoading, isFFmpegAvailable, ffmpegWarningDismissed]);

  // Load recent projects and version on mount
  useEffect(() => {
    const projects = loadRecentProjects();
    setRecentProjects(projects);

    // Fetch actual version from backend
    updateService
      .getCurrentVersion()
      .then((version) => {
        if (version && version !== 'unknown') {
          setAppVersion(version);
        }
      })
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

  // Initialize AI agent system on app mount
  useEffect(() => {
    initializeAgentSystem();
  }, []);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleDismissFFmpegWarning = useCallback(() => {
    setShowFFmpegWarning(false);
    setFFmpegWarningDismissed(true);
  }, []);

  // Handle "Don't show again" toggle on welcome screen
  const handleDontShowWelcome = useCallback(
    (dontShow: boolean) => {
      void updateGeneral({ showWelcomeOnStartup: !dontShow });
    },
    [updateGeneral],
  );

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
        `Editor error: ${error.message}. Try reloading the page if the issue persists.`,
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
        <ToastContainer toasts={toasts} onClose={dismissToast} />
      </>
    );
  }

  // Show Welcome Screen when no project is loaded
  if (!isLoaded) {
    return (
      <>
        <UpdateBanner checkOnMount={settingsLoaded && general.checkUpdatesOnStartup} />
        <WelcomeScreen
          onNewProject={handleNewProject}
          onOpenProject={(path) => void handleOpenProject(path)}
          recentProjects={recentProjects}
          isLoading={isLoading || isCreatingProject}
          version={appVersion}
          showDontShowOption={settingsLoaded}
          onDontShowAgain={handleDontShowWelcome}
          onClearRecentProjects={handleClearRecentProjects}
        />
        <ProjectCreationDialog
          isOpen={showCreateDialog}
          onCancel={handleCancelCreate}
          onCreate={(data) => void handleCreateProject(data)}
          isCreating={isCreatingProject}
        />
        <FFmpegWarning
          isOpen={showFFmpegWarning}
          onDismiss={handleDismissFFmpegWarning}
          allowDismiss={true}
        />
        <ToastContainer toasts={toasts} onClose={dismissToast} />
      </>
    );
  }

  // Show Editor when project is loaded
  const activeSequence = getActiveSequence();

  return (
    <>
      <UpdateBanner checkOnMount={settingsLoaded && general.checkUpdatesOnStartup} />
      <ErrorBoundary
        onError={handleEditorError}
        showDetails={import.meta.env.DEV}
        showReloadButton={true}
        fallbackRender={({ error, resetError }) => (
          <div className="flex flex-col items-center justify-center h-screen bg-editor-bg text-editor-text p-4 sm:p-8 text-center">
            <div className="text-status-error text-6xl mb-4">⚠️</div>
            <h1 className="text-xl sm:text-2xl font-bold text-status-error mb-2">Editor Error</h1>
            <p className="text-text-secondary mb-6 max-w-md px-4">
              The editor encountered an error. Your recent work may have been auto-saved.
            </p>
            <p className="text-sm text-text-muted mb-6 font-mono bg-surface-elevated p-2 rounded max-w-md w-full overflow-x-auto">
              {error.message}
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
        <EditorView sequence={activeSequence ?? null} />
      </ErrorBoundary>
      <FFmpegWarning
        isOpen={showFFmpegWarning}
        onDismiss={handleDismissFFmpegWarning}
        allowDismiss={true}
      />
      <ToastContainer toasts={toasts} onClose={dismissToast} />
    </>
  );
}

export default App;
