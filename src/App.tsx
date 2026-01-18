/**
 * OpenReelio Application
 *
 * Main application component with conditional rendering based on project state.
 * Shows WelcomeScreen when no project is loaded, Editor when project is active.
 */

import { useCallback, useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { MainLayout, Header, Sidebar, BottomPanel, Panel } from './components/layout';
import { WelcomeScreen } from './components/features/welcome';
import { Inspector } from './components/features/inspector';
import { ProjectExplorer } from './components/explorer';
import { PreviewPlayer } from './components/preview';
import { Timeline } from './components/timeline';
import { FFmpegWarning } from './components/ui';
import { useProjectStore, usePlaybackStore } from './stores';
import { usePreviewSource, useTimelineActions, useFFmpegStatus, useAutoSave } from './hooks';
import { loadRecentProjects, addRecentProject, type RecentProject } from './utils';

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
  const { currentTime, isPlaying, setCurrentTime, setIsPlaying, setDuration } =
    usePlaybackStore();
  const previewSource = usePreviewSource();

  // Timeline action callbacks
  const {
    handleClipMove,
    handleClipTrim,
    handleClipSplit,
    handleAssetDrop,
    handleDeleteClips,
  } = useTimelineActions({ sequence });

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
          ? { width: selectedAsset.video.width, height: selectedAsset.video.height }
          : undefined,
      }
    : undefined;

  return (
    <MainLayout
      header={<Header />}
      leftSidebar={
        <Sidebar title="Project Explorer" position="left">
          <ProjectExplorer />
        </Sidebar>
      }
      rightSidebar={
        <Sidebar title="Inspector" position="right" width={288}>
          <Inspector selectedAsset={inspectorAsset} />
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
          <PreviewPlayer
            src={previewSource?.src}
            poster={previewSource?.thumbnail}
            className="h-full"
            playhead={currentTime}
            isPlaying={isPlaying}
            onPlayheadChange={setCurrentTime}
            onPlayStateChange={setIsPlaying}
            onDurationChange={setDuration}
          />
        </div>
        <div className="flex-1">
          <Panel title="Timeline" variant="default" className="h-full">
            <Timeline
              sequence={sequence}
              onClipMove={handleClipMove}
              onClipTrim={handleClipTrim}
              onClipSplit={handleClipSplit}
              onAssetDrop={handleAssetDrop}
              onDeleteClips={handleDeleteClips}
            />
          </Panel>
        </div>
      </div>
    </MainLayout>
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
      console.error('Auto-save failed:', error);
    },
  });

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleDismissFFmpegWarning = useCallback(() => {
    setShowFFmpegWarning(false);
    setFFmpegWarningDismissed(true);
  }, []);

  const handleNewProject = useCallback(async () => {
    // Open folder picker for project location
    const selectedPath = await open({
      directory: true,
      multiple: false,
      title: 'Select Project Location',
    });

    if (selectedPath && typeof selectedPath === 'string') {
      // For now, use folder name as project name
      const folderName = selectedPath.split(/[/\\]/).pop() || 'Untitled';
      try {
        await createProject(folderName, selectedPath);
        // Add to recent projects
        const updated = addRecentProject({ name: folderName, path: selectedPath });
        setRecentProjects(updated);
      } catch (error) {
        console.error('Failed to create project:', error);
      }
    }
  }, [createProject]);

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
          const updated = addRecentProject({ name: folderName, path: projectPath });
          setRecentProjects(updated);
        } catch (error) {
          console.error('Failed to open project:', error);
        }
      }
    },
    [loadProject]
  );

  // ===========================================================================
  // Render
  // ===========================================================================

  // Show Welcome Screen when no project is loaded
  if (!isLoaded) {
    return (
      <>
        <WelcomeScreen
          onNewProject={() => void handleNewProject()}
          onOpenProject={(path) => void handleOpenProject(path)}
          recentProjects={recentProjects}
          isLoading={isLoading}
        />
        <FFmpegWarning
          isOpen={showFFmpegWarning}
          onDismiss={handleDismissFFmpegWarning}
          allowDismiss={true}
        />
      </>
    );
  }

  // Show Editor when project is loaded
  const activeSequence = getActiveSequence();

  return (
    <>
      <EditorView sequence={activeSequence ?? null} />
      <FFmpegWarning
        isOpen={showFFmpegWarning}
        onDismiss={handleDismissFFmpegWarning}
        allowDismiss={true}
      />
    </>
  );
}

export default App;
