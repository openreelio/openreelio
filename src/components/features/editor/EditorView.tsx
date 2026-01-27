/**
 * EditorView Component
 *
 * Main editing interface that displays when a project is loaded.
 * Contains the preview player, timeline, project explorer, inspector,
 * and AI sidebar in a multi-panel layout.
 */

import { useCallback, useState, useEffect, useMemo } from 'react';
import { MainLayout, Header, Sidebar, BottomPanel, Panel } from '@/components/layout';
import { AISidebar } from '@/components/features/ai';
import {
  TimelineErrorBoundary,
  PreviewErrorBoundary,
  ExplorerErrorBoundary,
  InspectorErrorBoundary,
  AIErrorBoundary,
} from '@/components/shared';
import { ExportDialog } from '@/components/features/export';
import { Inspector, type SelectedCaption } from '@/components/features/inspector';
import { ProjectExplorer } from '@/components/explorer';
import { UnifiedPreviewPlayer } from '@/components/preview';
import { Timeline } from '@/components/timeline';
import {
  useProjectStore,
  usePlaybackStore,
  useTimelineStore,
} from '@/stores';
import {
  useTimelineActions,
  useKeyboardShortcuts,
  useAudioPlayback,
} from '@/hooks';
import { createLogger } from '@/services/logger';
import type { Sequence } from '@/types';

const logger = createLogger('EditorView');

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
// EditorView Component
// =============================================================================

export interface EditorViewProps {
  /** Currently active sequence for timeline (null if none active) */
  sequence: Sequence | null;
}

export function EditorView({ sequence }: EditorViewProps): JSX.Element {
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

  // Get selected asset for inspector (memoized to prevent unnecessary re-renders)
  const inspectorAsset = useMemo(() => {
    const selectedAsset = selectedAssetId ? assets.get(selectedAssetId) : undefined;
    if (!selectedAsset) return undefined;

    return {
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
    };
  }, [selectedAssetId, assets]);

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
