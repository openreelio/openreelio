/**
 * OpenReelio Application
 *
 * Main application component with conditional rendering based on project state.
 * Shows WelcomeScreen when no project is loaded, Editor when project is active.
 */

import { useCallback, useState, useEffect, useMemo } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { MainLayout, Header, Sidebar, BottomPanel, Panel } from './components/layout';
import { ErrorBoundary } from './components/shared';
import { WelcomeScreen } from './components/features/welcome';
import { ProjectCreationDialog, type ProjectCreateData } from './components/features/project';
import { ExportDialog } from './components/features/export';
import { Inspector, type SelectedCaption } from './components/features/inspector';
import { ProjectExplorer } from './components/explorer';
import { TimelinePreviewPlayer } from './components/preview';
import { Timeline } from './components/timeline';
import { FFmpegWarning, ToastContainer, type ToastData } from './components/ui';
import { useProjectStore, usePlaybackStore, useTimelineStore } from './stores';
import {
  useTimelineActions,
  useFFmpegStatus,
  useAutoSave,
  useKeyboardShortcuts,
  useAudioPlayback,
} from './hooks';
import { createLogger, initializeLogger } from './services/logger';
import {
  loadRecentProjects,
  addRecentProject,
  buildProjectPath,
  validateProjectName,
  type RecentProject,
} from './utils';

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
            <ErrorBoundary
              onError={(error) => logger.error('ProjectExplorer error', { error })}
              showDetails={import.meta.env.DEV}
            >
              <ProjectExplorer />
            </ErrorBoundary>
          </Sidebar>
        }
        rightSidebar={
          <Sidebar title="Inspector" position="right" width={288}>
            <ErrorBoundary
              onError={(error) => logger.error('Inspector error', { error })}
              showDetails={import.meta.env.DEV}
            >
              <Inspector
                selectedAsset={inspectorAsset}
                selectedCaption={selectedCaption}
                onCaptionChange={onCaptionChange}
              />
            </ErrorBoundary>
          </Sidebar>
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
            <ErrorBoundary
              onError={(error) => logger.error('TimelinePreviewPlayer error', { error })}
              showDetails={import.meta.env.DEV}
            >
              <TimelinePreviewPlayer
                className="h-full w-full"
                showControls
                showTimecode
                showStats={import.meta.env.DEV}
              />
            </ErrorBoundary>
          </div>
          <div className="flex-1 overflow-hidden">
            <Panel title="Timeline" variant="default" className="h-full" noPadding>
              <ErrorBoundary
                onError={(error) => logger.error('Timeline error', { error })}
                showDetails={import.meta.env.DEV}
              >
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
              </ErrorBoundary>
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

  // FFmpeg status check
  const { isAvailable: isFFmpegAvailable, isLoading: isFFmpegLoading } = useFFmpegStatus();
  const [showFFmpegWarning, setShowFFmpegWarning] = useState(false);
  const [ffmpegWarningDismissed, setFFmpegWarningDismissed] = useState(false);

  // Project creation dialog state
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);

  // Toast notifications state
  const [toasts, setToasts] = useState<ToastData[]>([]);

  // Helper to add toast notification
  const addToast = useCallback((message: string, variant: ToastData['variant'] = 'error') => {
    const id = `toast-${Date.now()}`;
    setToasts((prev) => [...prev, { id, message, variant }]);
  }, []);

  // Helper to remove toast notification
  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

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

  // Load recent projects on mount
  useEffect(() => {
    const projects = loadRecentProjects();
    setRecentProjects(projects);
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

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleDismissFFmpegWarning = useCallback(() => {
    setShowFFmpegWarning(false);
    setFFmpegWarningDismissed(true);
  }, []);

  // Open the project creation dialog
  const handleNewProject = useCallback(() => {
    setShowCreateDialog(true);
  }, []);

  // Handle project creation from dialog
  const handleCreateProject = useCallback(
    async (data: ProjectCreateData) => {
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
        } catch (error) {
          logger.error('Failed to open project', { error });
        }
      }
    },
    [loadProject],
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

  // Show Welcome Screen when no project is loaded
  if (!isLoaded) {
    return (
      <>
        <WelcomeScreen
          onNewProject={handleNewProject}
          onOpenProject={(path) => void handleOpenProject(path)}
          recentProjects={recentProjects}
          isLoading={isLoading || isCreatingProject}
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
        <ToastContainer toasts={toasts} onClose={removeToast} />
      </>
    );
  }

  // Show Editor when project is loaded
  const activeSequence = getActiveSequence();

  return (
    <>
      <ErrorBoundary
        onError={handleEditorError}
        showDetails={import.meta.env.DEV}
        showReloadButton={true}
        fallbackRender={({ error, resetError }) => (
          <div className="flex flex-col items-center justify-center h-screen bg-editor-bg text-editor-text p-8 text-center">
            <div className="text-red-500 text-6xl mb-4">⚠️</div>
            <h1 className="text-2xl font-bold text-red-400 mb-2">Editor Error</h1>
            <p className="text-editor-text-muted mb-6 max-w-md">
              The editor encountered an error. Your recent work may have been auto-saved.
            </p>
            <p className="text-sm text-editor-text-muted mb-6 font-mono bg-editor-surface p-2 rounded max-w-md truncate">
              {error.message}
            </p>
            <div className="flex gap-4">
              <button
                onClick={resetError}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
              >
                Try Again
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-6 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded transition-colors"
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
      <ToastContainer toasts={toasts} onClose={removeToast} />
    </>
  );
}

export default App;
