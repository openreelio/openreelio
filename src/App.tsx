/**
 * OpenReelio Application
 *
 * Main application component with conditional rendering based on project state.
 * Shows WelcomeScreen when no project is loaded, Editor when project is active.
 */

import { useCallback, useState, useEffect, useMemo } from 'react';
import { open, confirm } from '@tauri-apps/plugin-dialog';
import { isTauri as isTauriApi } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { MainLayout, Header, Sidebar, BottomPanel, Panel } from './components/layout';
import { AISidebar } from './components/features/ai';
import {
  ErrorBoundary,
  TimelineErrorBoundary,
  PreviewErrorBoundary,
  ExplorerErrorBoundary,
  InspectorErrorBoundary,
  AIErrorBoundary,
} from './components/shared';
import { WelcomeScreen } from './components/features/welcome';
import { ProjectCreationDialog, type ProjectCreateData } from './components/features/project';
import { SetupWizard } from './components/features/setup';
import { ExportDialog } from './components/features/export';
import { Inspector, type SelectedCaption } from './components/features/inspector';
import { ProjectExplorer } from './components/explorer';
import { UnifiedPreviewPlayer } from './components/preview';
import { Timeline } from './components/timeline';
import { FFmpegWarning, ToastContainer, type ToastVariant } from './components/ui';
import {
  useProjectStore,
  usePlaybackStore,
  useTimelineStore,
  useSettingsStore,
  setupProxyEventListeners,
  cleanupProxyEventListeners,
} from './stores';
import { initializeAgentSystem } from './stores/aiStore';
import {
  useTimelineActions,
  useFFmpegStatus,
  useAutoSave,
  useKeyboardShortcuts,
  useAudioPlayback,
  useToast,
  useSettings,
} from './hooks';
import { UpdateBanner } from './components/features/update';
import { createLogger, initializeLogger } from './services/logger';
import {
  loadRecentProjects,
  addRecentProject,
  removeRecentProjectByPath,
  buildProjectPath,
  validateProjectName,
  getUserFriendlyError,
  type RecentProject,
} from './utils';
import { updateService } from './services/updateService';
import { isTauriRuntime } from './services/framePaths';

// Initialize logger on module load
initializeLogger();

// Create module logger
const logger = createLogger('App');

// =============================================================================
// Console Component (Bottom Panel Content)
// =============================================================================

function ConsolePanel(): JSX.Element {
  return (
    <div
      data-testid="console-panel"
      className="h-full bg-editor-bg rounded border border-editor-border p-2 font-mono text-xs text-editor-text-muted overflow-auto"
    >
      <p>OpenReelio initialized.</p>
      <p>Ready to edit.</p>
    </div>
  );
}

// =============================================================================
// Editor View (Main Editing Interface)
// =============================================================================

interface EditorViewProps {
  /** Currently active sequence for timeline (null if none active) */
  sequence: import('./types').Sequence | null;
}

function EditorView({ sequence }: EditorViewProps): JSX.Element {
  const { selectedAssetId, assets } = useProjectStore();
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const setDuration = usePlaybackStore((state) => state.setDuration);
  const { selectedClipIds } = useTimelineStore();

  // Export dialog state
  const [showExportDialog, setShowExportDialog] = useState(false);

  // AI Sidebar state
  const [aiSidebarCollapsed, setAiSidebarCollapsed] = useState(false);
  const [aiSidebarWidth, setAiSidebarWidth] = useState(320);

  // Audio playback integration
  // The hook handles audio scheduling, volume control, and clip synchronization
  // It uses Web Audio API for precise timing and responds to playback store changes
  const { initAudio, isAudioReady } = useAudioPlayback({
    sequence,
    assets,
    enabled: true, // Always enabled when in editor view
  });

  // Initialize audio context on first play interaction
  // Web Audio API requires user gesture to create AudioContext
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  useEffect(() => {
    if (isPlaying && !isAudioReady) {
      void initAudio();
    }
  }, [isPlaying, isAudioReady, initAudio]);

  // Sync sequence duration to playback store
  // Calculate total duration from all clips across all tracks
  useEffect(() => {
    if (!sequence) {
      setDuration(0);
      return;
    }

    let maxEndTime = 0;
    for (const track of sequence.tracks) {
      for (const clip of track.clips) {
        const clipEnd = clip.place.timelineInSec + clip.place.durationSec;
        if (clipEnd > maxEndTime) {
          maxEndTime = clipEnd;
        }
      }
    }

    // Set at least 10 seconds for empty sequences to allow playback testing
    setDuration(Math.max(maxEndTime, 10));
  }, [sequence, setDuration]);

  // Timeline action callbacks
  const {
    handleClipMove,
    handleClipTrim,
    handleClipSplit,
    handleAssetDrop,
    handleDeleteClips,
    handleTrackMuteToggle,
    handleTrackLockToggle,
    handleTrackVisibilityToggle,
    handleUpdateCaption,
  } = useTimelineActions({ sequence });

  // Split at playhead handler for keyboard shortcut
  const handleSplitAtPlayhead = useCallback(() => {
    if (!sequence || selectedClipIds.length !== 1) return;

    const clipId = selectedClipIds[0];
    for (const track of sequence.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) {
        const clipEnd =
          clip.place.timelineInSec +
          (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;

        // Check if playhead is within the clip
        if (currentTime > clip.place.timelineInSec && currentTime < clipEnd) {
          handleClipSplit?.({
            sequenceId: sequence.id,
            trackId: track.id,
            clipId: clip.id,
            splitTime: currentTime,
          });
        }
        break;
      }
    }
  }, [sequence, selectedClipIds, currentTime, handleClipSplit]);

  // Global keyboard shortcuts
  useKeyboardShortcuts({
    enabled: true,
    onDeleteClips: () => {
      if (selectedClipIds.length > 0) {
        handleDeleteClips?.(selectedClipIds);
      }
    },
    onSplitAtPlayhead: handleSplitAtPlayhead,
    onExport: () => setShowExportDialog(true),
  });

  // Get selected asset for inspector
  const selectedAsset = selectedAssetId ? assets.get(selectedAssetId) : undefined;

  // Transform asset to inspector format
  const inspectorAsset = selectedAsset
    ? {
        id: selectedAsset.id,
        name: selectedAsset.name,
        kind: selectedAsset.kind as 'video' | 'audio' | 'image' | 'graphics',
        uri: selectedAsset.uri,
        durationSec: selectedAsset.durationSec,
        resolution: selectedAsset.video
          ? {
              width: selectedAsset.video.width,
              height: selectedAsset.video.height,
            }
          : undefined,
      }
    : undefined;

  // Get selected caption for inspector
  const selectedCaption: SelectedCaption | undefined = useMemo(() => {
    if (!sequence || !selectedClipIds || selectedClipIds.length !== 1) return undefined;
    const clipId = selectedClipIds[0];

    for (const track of sequence.tracks) {
      if (track.kind === 'caption') {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          // Calculate duration adjusting for speed
          const duration = (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;

          return {
            id: clip.id,
            text: clip.label || '', // Using label as text storage for now
            startSec: clip.place.timelineInSec,
            endSec: clip.place.timelineInSec + duration,
            // Style mapping could be added here if Clip supports it
          };
        }
      }
    }
    return undefined;
  }, [sequence, selectedClipIds]);

  // Handle caption updates
  const onCaptionChange = useCallback(
    (captionId: string, property: string, value: unknown) => {
      if (!sequence) return;

      // Find trackId for this caption
      let trackId: string | undefined;
      for (const track of sequence.tracks) {
        if (track.clips.some((c) => c.id === captionId)) {
          trackId = track.id;
          break;
        }
      }

      if (!trackId) return;

      if (property === 'text' && typeof value === 'string') {
        handleUpdateCaption({
          sequenceId: sequence.id,
          trackId,
          captionId,
          text: value,
        });
      }
    },
    [sequence, handleUpdateCaption],
  );

  // Export handlers
  const handleOpenExport = useCallback(() => {
    setShowExportDialog(true);
  }, []);

  const handleCloseExport = useCallback(() => {
    setShowExportDialog(false);
  }, []);

  return (
    <>
      <MainLayout
        header={<Header onExport={handleOpenExport} />}
        leftSidebar={
          <Sidebar title="Project Explorer" position="left">
            <ExplorerErrorBoundary
              onError={(error) => logger.error('ProjectExplorer error', { error })}
            >
              <ProjectExplorer />
            </ExplorerErrorBoundary>
          </Sidebar>
        }
        rightSidebar={
          <>
            <Sidebar title="Inspector" position="right" width={288}>
              <InspectorErrorBoundary onError={(error) => logger.error('Inspector error', { error })}>
                <Inspector
                  selectedAsset={inspectorAsset}
                  selectedCaption={selectedCaption}
                  onCaptionChange={onCaptionChange}
                />
              </InspectorErrorBoundary>
            </Sidebar>
            <AIErrorBoundary onError={(error) => logger.error('AISidebar error', { error })}>
              <AISidebar
                collapsed={aiSidebarCollapsed}
                onToggle={() => setAiSidebarCollapsed(!aiSidebarCollapsed)}
                width={aiSidebarWidth}
                onWidthChange={setAiSidebarWidth}
              />
            </AIErrorBoundary>
          </>
        }
        footer={
          <BottomPanel title="Console">
            <ConsolePanel />
          </BottomPanel>
        }
      >
        {/* Center content split between preview and timeline */}
        <div className="flex flex-col h-full">
          <div className="flex-1 border-b border-editor-border">
            <PreviewErrorBoundary
              onError={(error) => logger.error('UnifiedPreviewPlayer error', { error })}
            >
              <UnifiedPreviewPlayer
                className="h-full w-full"
                showControls
                showTimecode
                showStats={import.meta.env.DEV}
              />
            </PreviewErrorBoundary>
          </div>
          <div className="flex-1 overflow-hidden">
            <Panel title="Timeline" variant="default" className="h-full" noPadding>
              <TimelineErrorBoundary onError={(error) => logger.error('Timeline error', { error })}>
                <Timeline
                  sequence={sequence}
                  onClipMove={handleClipMove}
                  onClipTrim={handleClipTrim}
                  onClipSplit={handleClipSplit}
                  onAssetDrop={handleAssetDrop}
                  onDeleteClips={handleDeleteClips}
                  onTrackMuteToggle={handleTrackMuteToggle}
                  onTrackLockToggle={handleTrackLockToggle}
                  onTrackVisibilityToggle={handleTrackVisibilityToggle}
                />
              </TimelineErrorBoundary>
            </Panel>
          </div>
        </div>
      </MainLayout>

      {/* Export Dialog */}
      <ExportDialog
        isOpen={showExportDialog}
        onClose={handleCloseExport}
        sequenceId={sequence?.id ?? null}
        sequenceName={sequence?.name}
      />
    </>
  );
}

// =============================================================================
// Main Application Component
// =============================================================================

function App(): JSX.Element {
  const { isLoaded, isLoading, createProject, loadProject, getActiveSequence } = useProjectStore();

  // The Setup Wizard is only meaningful inside the actual Tauri runtime.
  // E2E tests (and Vite dev server mode) run in a normal browser environment.
  const isTauri = useMemo(() => isTauriRuntime(), []);

  // Settings for welcome screen behavior
  const { general, updateGeneral, isLoaded: settingsLoaded } = useSettings();

  // FFmpeg status check
  const { isAvailable: isFFmpegAvailable, isLoading: isFFmpegLoading } = useFFmpegStatus();
  const [showFFmpegWarning, setShowFFmpegWarning] = useState(false);
  const [ffmpegWarningDismissed, setFFmpegWarningDismissed] = useState(false);

  // Project creation dialog state
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);

  // Toast notifications
  const { toasts, toast, dismissToast } = useToast();

  // Backward-compatible helper for existing call sites in this component
  const addToast = useCallback(
    (message: string, variant: ToastVariant = 'error') => toast({ message, variant }),
    [toast],
  );

  // Show FFmpeg warning when check completes and FFmpeg is not available
  // Only show once per session (until dismissed)
  // Use effect to avoid state update during render
  useEffect(() => {
    if (!isFFmpegLoading && !isFFmpegAvailable && !ffmpegWarningDismissed) {
      setShowFFmpegWarning(true);
    }
  }, [isFFmpegLoading, isFFmpegAvailable, ffmpegWarningDismissed]);

  // Recent projects - load from localStorage on mount
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);

  // App version (fetched from backend)
  const [appVersion, setAppVersion] = useState('0.1.0');

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
  // Note: isSaving could be used in future to show saving indicator in header
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

  // Handle app close: save project and settings before closing
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupCloseHandler = async () => {
      try {
        const currentWindow = getCurrentWindow();

        unlisten = await currentWindow.onCloseRequested(async (event) => {
          const { isDirty, saveProject, meta } = useProjectStore.getState();

          // Check if there are unsaved changes
          if (isDirty && meta?.path) {
            // Prevent immediate close
            event.preventDefault();

            // Ask user what to do
            const shouldSave = await confirm(
              'You have unsaved changes. Do you want to save before closing?',
              {
                title: 'Unsaved Changes',
                kind: 'warning',
                okLabel: 'Save and Close',
                cancelLabel: 'Close Without Saving',
              },
            );

            if (shouldSave) {
              try {
                await saveProject();
                logger.info('Project saved before closing');
              } catch (saveError) {
                logger.error('Failed to save project before closing', { error: saveError });
                // Ask if they still want to close
                const forceClose = await confirm(
                  'Failed to save project. Close anyway?',
                  {
                    title: 'Save Failed',
                    kind: 'error',
                    okLabel: 'Close Anyway',
                    cancelLabel: 'Cancel',
                  },
                );
                if (!forceClose) {
                  return; // Don't close
                }
              }
            }

            // Flush settings
            const { flushPendingUpdates } = useSettingsStore.getState();
            try {
              await flushPendingUpdates();
            } catch (flushError) {
              logger.error('Failed to flush settings on close', { error: flushError });
            }

            // Now close the window
            await currentWindow.close();
          } else {
            // No unsaved changes, just flush settings
            const { flushPendingUpdates } = useSettingsStore.getState();
            try {
              await flushPendingUpdates();
            } catch (flushError) {
              logger.error('Failed to flush settings on close', { error: flushError });
            }
          }
        });
      } catch (error) {
        logger.error('Failed to setup close handler', { error });
      }
    };

    if (isTauriApi()) {
      void setupCloseHandler();
    }

    // Also handle browser beforeunload as fallback
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const { isDirty, meta } = useProjectStore.getState();

      if (isDirty && meta?.path) {
        // Show browser's native confirmation dialog
        e.preventDefault();
        e.returnValue = 'You have unsaved changes.';
        return 'You have unsaved changes.';
      }

      // Synchronously trigger flush - the promise won't complete before unload,
      // but starting it gives the best chance of saving
      const { flushPendingUpdates } = useSettingsStore.getState();
      flushPendingUpdates().catch((flushError: unknown) => {
        logger.error('Failed to flush pending settings on unload', { error: flushError });
      });
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      if (unlisten) {
        unlisten();
      }
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
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

  // Open the project creation dialog
  const handleNewProject = useCallback(() => {
    setShowCreateDialog(true);
  }, []);

  // Handle project creation from dialog
  const handleCreateProject = useCallback(
    async (data: ProjectCreateData) => {
      // Check if current project has unsaved changes
      const { isDirty: hasUnsavedChanges, meta: currentMeta, saveProject: saveCurrentProject } = useProjectStore.getState();

      if (hasUnsavedChanges && currentMeta?.path) {
        const shouldSave = await confirm(
          'You have unsaved changes in the current project. Do you want to save before creating a new project?',
          {
            title: 'Unsaved Changes',
            kind: 'warning',
            okLabel: 'Save and Continue',
            cancelLabel: 'Discard Changes',
          },
        );

        if (shouldSave) {
          try {
            await saveCurrentProject();
            addToast('Project saved', 'success');
          } catch (saveError) {
            logger.error('Failed to save current project', { error: saveError });
            const forceCreate = await confirm(
              'Failed to save the current project. Create new project anyway?',
              {
                title: 'Save Failed',
                kind: 'error',
                okLabel: 'Create Anyway',
                cancelLabel: 'Cancel',
              },
            );
            if (!forceCreate) {
              return;
            }
          }
        }
      }

      setIsCreatingProject(true);
      try {
        // Validate and sanitize project name to prevent path traversal
        const validation = validateProjectName(data.name);

        // Show warning if name was modified
        if (validation.errors.length > 0 && validation.sanitized) {
          // Log validation warnings but continue with sanitized name
          logger.warn('Project name validation warnings', { errors: validation.errors });
        }

        // Build safe project path using validated name
        const projectPath = buildProjectPath(data.path, data.name);
        const projectName = validation.sanitized || data.name;

        await createProject(projectName, projectPath);

        // Add to recent projects
        const updated = addRecentProject({
          name: projectName,
          path: projectPath,
        });
        setRecentProjects(updated);
        setShowCreateDialog(false);
        addToast(`Project "${projectName}" created successfully`, 'success');
      } catch (error) {
        logger.error('Failed to create project', { error });
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        addToast(`Failed to create project: ${errorMessage}`, 'error');
      } finally {
        setIsCreatingProject(false);
      }
    },
    [createProject, addToast],
  );

  // Cancel project creation
  const handleCancelCreate = useCallback(() => {
    setShowCreateDialog(false);
  }, []);

  const handleOpenProject = useCallback(
    async (path?: string) => {
      // Check if current project has unsaved changes
      const { isDirty: hasUnsavedChanges, meta: currentMeta, saveProject: saveCurrentProject } = useProjectStore.getState();

      if (hasUnsavedChanges && currentMeta?.path) {
        const shouldSave = await confirm(
          'You have unsaved changes in the current project. Do you want to save before opening another project?',
          {
            title: 'Unsaved Changes',
            kind: 'warning',
            okLabel: 'Save and Continue',
            cancelLabel: 'Discard Changes',
          },
        );

        if (shouldSave) {
          try {
            await saveCurrentProject();
            addToast('Project saved', 'success');
          } catch (saveError) {
            logger.error('Failed to save current project', { error: saveError });
            const forceOpen = await confirm(
              'Failed to save the current project. Open new project anyway?',
              {
                title: 'Save Failed',
                kind: 'error',
                okLabel: 'Open Anyway',
                cancelLabel: 'Cancel',
              },
            );
            if (!forceOpen) {
              return;
            }
          }
        }
      }

      let projectPath = path;

      if (!projectPath) {
        // Open file picker for project file
        const selectedPath = await open({
          directory: true,
          multiple: false,
          title: 'Open Project',
        });

        if (selectedPath && typeof selectedPath === 'string') {
          projectPath = selectedPath;
        }
      }

      if (projectPath) {
        try {
          await loadProject(projectPath);
          // Add to recent projects
          const folderName = projectPath.split(/[/\\]/).pop() || 'Untitled';
          const updated = addRecentProject({
            name: folderName,
            path: projectPath,
          });
          setRecentProjects(updated);
          addToast(`Project opened: ${folderName}`, 'success');
        } catch (error) {
          logger.error('Failed to open project', { error, path: projectPath });
          const rawMessage = error instanceof Error ? error.message : String(error);
          const friendlyMessage = getUserFriendlyError(error);

          // If project not found, offer to remove from recent projects
          if (
            rawMessage.toLowerCase().includes('not found') ||
            rawMessage.toLowerCase().includes('no such file') ||
            rawMessage.toLowerCase().includes('project.json')
          ) {
            addToast(`${friendlyMessage} The project may have been moved or deleted.`, 'error');
            // Remove the invalid project from recent projects
            const updated = removeRecentProjectByPath(projectPath);
            setRecentProjects(updated);
          } else {
            addToast(friendlyMessage, 'error');
          }
        }
      }
    },
    [loadProject, addToast],
  );

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
