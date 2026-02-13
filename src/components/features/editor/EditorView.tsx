/**
 * EditorView Component
 *
 * Main editing interface that displays when a project is loaded.
 * Contains the preview player, timeline, project explorer, inspector,
 * and AI sidebar in a multi-panel layout.
 */

import { useCallback, useState, useEffect, useMemo } from 'react';
import { MainLayout, Header, Sidebar, TabbedBottomPanel, Panel, type BottomPanelTab } from '@/components/layout';
import { AISidebar } from '@/components/features/ai';
import {
  TimelineErrorBoundary,
  PreviewErrorBoundary,
  ExplorerErrorBoundary,
  InspectorErrorBoundary,
  AIErrorBoundary,
} from '@/components/shared';
import { ExportDialog } from '@/components/features/export';
import { AddTextDialog, type AddTextPayload } from '@/components/features/text';
import { Inspector, type SelectedCaption } from '@/components/features/inspector';
import { AudioMixerPanel, type ChannelLevels } from '@/components/features/mixer';
import { VideoGenerationPanel } from '@/components/features/generation';
import { ProjectExplorer } from '@/components/explorer';
import { UnifiedPreviewPlayer } from '@/components/preview';
import { Timeline } from '@/components/timeline';
import {
  useProjectStore,
  usePlaybackStore,
  useTimelineStore,
  useAudioMixerStore,
} from '@/stores';
// Direct imports instead of barrel to avoid bundling all 100+ hooks
import { useTimelineActions } from '@/hooks/useTimelineActions';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useAudioPlayback } from '@/hooks/useAudioPlayback';
import { useTextClip } from '@/hooks/useTextClip';
import { useAudioMixer } from '@/hooks/useAudioMixer';
import { useMulticamSession } from '@/hooks/useMulticamSession';
import { dbToLinear, linearToDb } from '@/utils/audioMeter';
import { createLogger } from '@/services/logger';
import { isVideoGenerationEnabled } from '@/config/featureFlags';
import { Terminal, Sliders, Sparkles } from 'lucide-react';
import type { Sequence } from '@/types';
import type { MulticamGroup } from '@/utils/multicam';

const logger = createLogger('EditorView');

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
  const { selectedClipIds } = useTimelineStore();

  // Export dialog state
  const [showExportDialog, setShowExportDialog] = useState(false);

  // Add Text dialog state
  const [showAddTextDialog, setShowAddTextDialog] = useState(false);

  // AI Sidebar state
  const [aiSidebarCollapsed, setAiSidebarCollapsed] = useState(false);
  const [aiSidebarWidth, setAiSidebarWidth] = useState(320);

  // Multicam session state
  const [multicamGroup, setMulticamGroup] = useState<MulticamGroup | null>(null);
  const [multicamMode] = useState<'view' | 'record'>('view');
  useMulticamSession({
    group: multicamGroup,
    mode: multicamMode,
    onChange: setMulticamGroup,
  });

  // Audio Mixer state from store
  const mixerStore = useAudioMixerStore();
  const {
    trackStates: mixerTrackStates,
    soloedTrackIds,
    masterState: mixerMasterState,
    initializeTrack,
    setTrackVolume,
    setTrackPan,
    toggleMute: toggleTrackMute,
    toggleSolo,
    setMasterVolume: setMixerMasterVolume,
    toggleMasterMute,
  } = mixerStore;

  // Audio mixer Web Audio integration
  const {
    isReady: isAudioMixerReady,
    initialize: initAudioMixer,
    connectTrack,
    disconnectTrack,
    startMetering,
    stopMetering,
  } = useAudioMixer({ enabled: true });

  // Convert store state to props for AudioMixerPanel
  const trackLevels = useMemo(() => {
    const levels = new Map<string, ChannelLevels>();
    for (const [trackId, state] of mixerTrackStates) {
      levels.set(trackId, { left: state.levels.left, right: state.levels.right });
    }
    return levels;
  }, [mixerTrackStates]);

  const trackPans = useMemo(() => {
    const pans = new Map<string, number>();
    for (const [trackId, state] of mixerTrackStates) {
      pans.set(trackId, state.pan);
    }
    return pans;
  }, [mixerTrackStates]);

  const masterVolume = dbToLinear(mixerMasterState.volumeDb);
  const masterMuted = mixerMasterState.muted;
  const masterLevels: ChannelLevels = useMemo(
    () => ({
      left: mixerMasterState.levels.left,
      right: mixerMasterState.levels.right,
    }),
    [mixerMasterState.levels.left, mixerMasterState.levels.right],
  );

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

  // Initialize audio mixer on first play
  useEffect(() => {
    if (isPlaying && !isAudioMixerReady) {
      void initAudioMixer();
    }
  }, [isPlaying, isAudioMixerReady, initAudioMixer]);

  // Initialize mixer tracks when sequence changes
  useEffect(() => {
    if (!sequence) return;

    // Initialize each track in the mixer store
    for (const track of sequence.tracks) {
      const volumeDb = linearToDb(track.volume);
      initializeTrack(track.id, volumeDb, 0);

      // Connect to audio mixer if ready
      if (isAudioMixerReady) {
        connectTrack(track.id);
      }
    }

    // Cleanup: disconnect removed tracks
    return () => {
      if (!sequence) return;
      for (const track of sequence.tracks) {
        disconnectTrack(track.id);
      }
    };
  }, [sequence, isAudioMixerReady, initializeTrack, connectTrack, disconnectTrack]);

  // Start/stop metering based on playback state
  useEffect(() => {
    if (isPlaying && isAudioMixerReady) {
      startMetering();
    } else {
      stopMetering();
    }
  }, [isPlaying, isAudioMixerReady, startMetering, stopMetering]);

  // NOTE: Playback duration is set by useTimelineEngine (inside Timeline component)
  // with proper padding. Do NOT set duration here — it would overwrite the padded
  // value and cause the SeekBar and Timeline playhead to use different ranges,
  // breaking bidirectional position sync.

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

  // Text clip operations
  const { addTextClip } = useTextClip();

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

  // Add Text handlers
  const handleOpenAddText = useCallback(() => {
    setShowAddTextDialog(true);
  }, []);

  const handleCloseAddText = useCallback(() => {
    setShowAddTextDialog(false);
  }, []);

  const handleAddTextClip = useCallback(
    async (payload: AddTextPayload) => {
      if (!sequence) return;

      await addTextClip({
        trackId: payload.trackId,
        timelineIn: payload.timelineIn,
        duration: payload.duration,
        textData: payload.textData,
      });
    },
    [sequence, addTextClip]
  );

  // Audio Mixer handlers - connected to store and Web Audio
  const handleMixerVolumeChange = useCallback((trackId: string, volumeDb: number) => {
    setTrackVolume(trackId, volumeDb);
    logger.debug('Volume change', { trackId, volumeDb });
  }, [setTrackVolume]);

  const handleMixerPanChange = useCallback((trackId: string, pan: number) => {
    setTrackPan(trackId, pan);
  }, [setTrackPan]);

  const handleMixerMuteToggle = useCallback((trackId: string) => {
    // Toggle mute in mixer store (affects audio output)
    toggleTrackMute(trackId);
    // Also toggle in timeline if we want visual feedback on track header
    if (sequence && handleTrackMuteToggle) {
      handleTrackMuteToggle({ sequenceId: sequence.id, trackId });
    }
  }, [sequence, handleTrackMuteToggle, toggleTrackMute]);

  const handleMixerSoloToggle = useCallback((trackId: string) => {
    toggleSolo(trackId);
  }, [toggleSolo]);

  const handleMasterVolumeChange = useCallback((volumeDb: number) => {
    setMixerMasterVolume(volumeDb);
  }, [setMixerMasterVolume]);

  const handleMasterMuteToggle = useCallback(() => {
    toggleMasterMute();
  }, [toggleMasterMute]);

  // Bottom panel tabs
  const videoGenEnabled = isVideoGenerationEnabled();
  const bottomPanelTabs: BottomPanelTab[] = useMemo(() => {
    const tabs: BottomPanelTab[] = [
      {
        id: 'console',
        label: 'Console',
        icon: <Terminal className="w-3 h-3" />,
        content: (
          <div className="h-full p-2 font-mono text-xs text-editor-text-muted overflow-auto">
            <p>OpenReelio initialized.</p>
            <p>Ready to edit.</p>
          </div>
        ),
      },
      {
        id: 'mixer',
        label: 'Mixer',
        icon: <Sliders className="w-3 h-3" />,
        content: (
          <AudioMixerPanel
            tracks={sequence?.tracks ?? []}
            trackLevels={trackLevels}
            trackPans={trackPans}
            soloedTrackIds={soloedTrackIds}
            masterVolume={masterVolume}
            masterMuted={masterMuted}
            masterLevels={masterLevels}
            onVolumeChange={handleMixerVolumeChange}
            onPanChange={handleMixerPanChange}
            onMuteToggle={handleMixerMuteToggle}
            onSoloToggle={handleMixerSoloToggle}
            onMasterVolumeChange={handleMasterVolumeChange}
            onMasterMuteToggle={handleMasterMuteToggle}
            compact
            className="h-full"
          />
        ),
      },
    ];

    if (videoGenEnabled) {
      tabs.push({
        id: 'videogen',
        label: 'Generate',
        icon: <Sparkles className="w-3 h-3" />,
        content: (
          <VideoGenerationPanel compact className="h-full" />
        ),
      });
    }

    return tabs;
  }, [
    videoGenEnabled,
    sequence?.tracks,
    trackLevels,
    trackPans,
    soloedTrackIds,
    masterVolume,
    masterMuted,
    masterLevels,
    handleMixerVolumeChange,
    handleMixerPanChange,
    handleMixerMuteToggle,
    handleMixerSoloToggle,
    handleMasterVolumeChange,
    handleMasterMuteToggle,
  ]);

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
          <TabbedBottomPanel
            tabs={bottomPanelTabs}
            defaultTab="console"
            defaultHeight={160}
          />
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
                  onAddText={handleOpenAddText}
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

      {/* Add Text Dialog */}
      <AddTextDialog
        isOpen={showAddTextDialog}
        onClose={handleCloseAddText}
        onAdd={handleAddTextClip}
        tracks={sequence?.tracks ?? []}
        currentTime={currentTime}
      />
    </>
  );
}
