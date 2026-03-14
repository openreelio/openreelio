/**
 * EditorView Component
 *
 * Main editing interface that displays when a project is loaded.
 * Contains the preview player, timeline, project explorer, inspector,
 * and AI sidebar in a multi-panel layout.
 */

import { lazy, Suspense, useCallback, useState, useEffect, useMemo } from 'react';
import {
  MainLayout,
  Header,
  HeaderPopoverAction,
  Sidebar,
  TabbedBottomPanel,
  type BottomPanelTab,
} from '@/components/layout';
import { AISidebar } from '@/components/features/ai';
import {
  TimelineErrorBoundary,
  PreviewErrorBoundary,
  ExplorerErrorBoundary,
  InspectorErrorBoundary,
  AIErrorBoundary,
} from '@/components/shared';
import {
  Inspector,
  type SelectedClip,
  type SelectedCaption,
  type SelectedTextClip,
} from '@/components/features/inspector';
import { ProjectExplorer } from '@/components/explorer';
import { UnifiedPreviewPlayer } from '@/components/preview';
import { Timeline } from '@/components/timeline';
import { useProjectStore, usePlaybackStore, useTimelineStore, useAudioMixerStore } from '@/stores';
// Direct imports instead of barrel to avoid bundling all 100+ hooks
import { useTimelineActions } from '@/hooks/useTimelineActions';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useAudioPlayback } from '@/hooks/useAudioPlayback';
import { useTextClip } from '@/hooks/useTextClip';
import { useSequenceTextClipData } from '@/hooks/useSequenceTextClipData';
import { useAudioMixer } from '@/hooks/useAudioMixer';
import { useMulticamSession } from '@/hooks/useMulticamSession';
import { useBlendMode } from '@/hooks/useBlendMode';
import { useResponsiveSidebarState } from './hooks/useResponsiveSidebarState';
import { dbToLinear, linearToDb } from '@/utils/audioMeter';
import { extractTextDataFromClipWithMap } from '@/utils/textRenderer';
import { createLogger } from '@/services/logger';
import { startPlayheadBackendSync } from '@/services/playheadBackendSync';
import { isVideoGenerationEnabled } from '@/config/featureFlags';
import { getSplitTargetsAtTime } from '@/utils/clipLinking';
import { Terminal, Sliders, Sparkles, GitCompareArrows } from 'lucide-react';
import type { BlendMode, Sequence, CaptionPosition, ClipId, TextClipData } from '@/types';
import type { AddTextPayload } from '@/components/features/text';
import type { ChannelLevels } from '@/components/features/mixer';
import type { MulticamGroup } from '@/utils/multicam';
import { isTextClip } from '@/types';

const logger = createLogger('EditorView');
const AI_AUTO_COLLAPSE_BREAKPOINT = 1440;
const BOTTOM_PANEL_LOADING_FALLBACK = (
  <div className="flex h-full items-center justify-center text-xs text-editor-text-muted">
    Loading panel...
  </div>
);

const ExportDialog = lazy(async () => {
  const module = await import('@/components/features/export');
  return { default: module.ExportDialog };
});

const AddTextDialog = lazy(async () => {
  const module = await import('@/components/features/text');
  return { default: module.AddTextDialog };
});

const AudioMixerPanel = lazy(async () => {
  const module = await import('@/components/features/mixer');
  return { default: module.AudioMixerPanel };
});

const VideoGenerationPanel = lazy(async () => {
  const module = await import('@/components/features/generation');
  return { default: module.VideoGenerationPanel };
});

const ReferenceComparisonPanel = lazy(async () => {
  const module = await import('@/components/features/comparison/ReferenceComparisonPanel');
  return { default: module.ReferenceComparisonPanel };
});

// =============================================================================
// EditorView Component
// =============================================================================

export interface EditorViewProps {
  /** Currently active sequence for timeline (null if none active) */
  sequence: Sequence | null;
  /** App version string displayed in header */
  appVersion?: string;
}

function normalizeCaptionPositionValue(value: unknown): CaptionPosition | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<CaptionPosition> & Record<string, unknown>;
  if (candidate.type === 'custom') {
    const xPercent = Number(candidate.xPercent);
    const yPercent = Number(candidate.yPercent);
    if (!Number.isFinite(xPercent) || !Number.isFinite(yPercent)) {
      return null;
    }

    return {
      type: 'custom',
      xPercent: Math.max(0, Math.min(100, xPercent)),
      yPercent: Math.max(0, Math.min(100, yPercent)),
    };
  }

  if (candidate.type === 'preset') {
    const vertical =
      candidate.vertical === 'top' || candidate.vertical === 'center'
        ? candidate.vertical
        : 'bottom';
    const marginPercent = Number(candidate.marginPercent);
    if (!Number.isFinite(marginPercent)) {
      return null;
    }

    return {
      type: 'preset',
      vertical,
      marginPercent: Math.max(0, Math.min(50, marginPercent)),
    };
  }

  return null;
}

export function EditorView({ sequence, appVersion = '0.1.0' }: EditorViewProps): JSX.Element {
  const { selectedAssetId, assets } = useProjectStore();
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const { selectedClipIds, linkedSelectionEnabled } = useTimelineStore();

  // Export dialog state
  const [showExportDialog, setShowExportDialog] = useState(false);

  // Add Text dialog state
  const [showAddTextDialog, setShowAddTextDialog] = useState(false);

  // AI Sidebar state
  const {
    collapsed: aiSidebarCollapsed,
    width: aiSidebarWidth,
    setWidth: setAiSidebarWidth,
    toggleCollapsed: toggleAiSidebar,
  } = useResponsiveSidebarState({
    autoCollapseBreakpoint: AI_AUTO_COLLAPSE_BREAKPOINT,
    initialWidth: 320,
  });

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

  // Keep backend runtime playhead state aligned while editor is active.
  useEffect(() => {
    if (!sequence?.id) {
      return;
    }

    const stopSync = startPlayheadBackendSync({
      getSequenceId: () => sequence.id,
    });

    return () => {
      stopSync();
    };
  }, [sequence?.id]);

  // NOTE: Playback duration is set by useTimelineEngine (inside Timeline component)
  // with proper padding. Do NOT set duration here — it would overwrite the padded
  // value and cause the SeekBar and Timeline playhead to use different ranges,
  // breaking bidirectional position sync.

  // Timeline action callbacks
  const {
    handleClipMove,
    handleClipTrim,
    handleClipSplit,
    handleClipDuplicate,
    handleClipPaste,
    handleClipAudioUpdate,
    handleAssetDrop,
    pendingWorkspaceDrops,
    handleDeleteClips,
    handleTrackCreate,
    handleTrackDelete,
    handleTrackMuteToggle,
    handleTrackLockToggle,
    handleTrackVisibilityToggle,
    handleTrackReorder,
    handleUpdateCaption,
  } = useTimelineActions({ sequence });

  // Text clip operations
  const { addTextClip, updateTextClip } = useTextClip();
  const textClipDataById = useSequenceTextClipData(sequence);

  // Split at playhead handler for keyboard shortcut
  const handleSplitAtPlayhead = useCallback(() => {
    if (!sequence || selectedClipIds.length === 0 || !handleClipSplit) {
      return;
    }

    const splitTargets = getSplitTargetsAtTime(
      sequence,
      selectedClipIds,
      currentTime,
      linkedSelectionEnabled,
    );

    for (const splitTarget of splitTargets) {
      handleClipSplit({
        sequenceId: sequence.id,
        trackId: splitTarget.trackId,
        clipId: splitTarget.clipId,
        splitTime: currentTime,
      });
    }
  }, [sequence, selectedClipIds, linkedSelectionEnabled, currentTime, handleClipSplit]);

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

  // Get selected clip for inspector (non-text, non-caption video/audio clips)
  const inspectorClip: SelectedClip | undefined = useMemo(() => {
    if (!sequence || selectedClipIds.length !== 1) return undefined;
    const clipId = selectedClipIds[0];

    for (const track of sequence.tracks) {
      // Skip caption tracks — they use the SelectedCaption path
      if (track.kind === 'caption') continue;

      const clip = track.clips.find((c) => c.id === clipId);
      if (!clip) continue;

      // Skip text clips — they use the SelectedTextClip path
      if (isTextClip(clip.assetId)) return undefined;

      const asset = assets.get(clip.assetId);
      return {
        id: clip.id,
        name: asset?.name ?? clip.assetId,
        assetId: clip.assetId,
        range: {
          sourceInSec: clip.range.sourceInSec,
          sourceOutSec: clip.range.sourceOutSec,
        },
        place: {
          trackId: track.id,
          timelineInSec: clip.place.timelineInSec,
        },
        blendMode: clip.blendMode,
      };
    }
    return undefined;
  }, [sequence, selectedClipIds, assets]);

  // Blend mode operations
  const { setClipBlendMode } = useBlendMode();

  const handleClipBlendModeChange = useCallback(
    (clipId: string, trackId: string, blendMode: BlendMode) => {
      setClipBlendMode(trackId, clipId, blendMode);
    },
    [setClipBlendMode],
  );

  // Get selected caption for inspector
  const selectedCaption: SelectedCaption | undefined = useMemo(() => {
    if (!sequence || !selectedClipIds || selectedClipIds.length !== 1) return undefined;
    const clipId = selectedClipIds[0];

    for (const track of sequence.tracks) {
      if (track.kind === 'caption') {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          // Calculate duration adjusting for speed
          const safeSpeed = clip.speed > 0 ? clip.speed : 1;
          const duration = (clip.range.sourceOutSec - clip.range.sourceInSec) / safeSpeed;

          return {
            id: clip.id,
            text: clip.label || '', // Using label as text storage for now
            startSec: clip.place.timelineInSec,
            endSec: clip.place.timelineInSec + duration,
            style: clip.captionStyle,
            position: clip.captionPosition,
          };
        }
      }
    }
    return undefined;
  }, [sequence, selectedClipIds]);

  const selectedTextClip: SelectedTextClip | undefined = useMemo(() => {
    if (!sequence || selectedClipIds.length !== 1) {
      return undefined;
    }

    const clipId = selectedClipIds[0];
    for (const track of sequence.tracks) {
      const clip = track.clips.find((candidate) => candidate.id === clipId);
      if (!clip) {
        continue;
      }

      if (!isTextClip(clip.assetId)) {
        return undefined;
      }

      const textData = extractTextDataFromClipWithMap(clip, textClipDataById);
      if (!textData) {
        return undefined;
      }

      const safeSpeed = clip.speed > 0 ? clip.speed : 1;
      const duration = (clip.range.sourceOutSec - clip.range.sourceInSec) / safeSpeed;

      return {
        id: clip.id,
        textData,
        timelineInSec: clip.place.timelineInSec,
        durationSec: duration,
      };
    }

    return undefined;
  }, [sequence, selectedClipIds, textClipDataById]);

  const onTextDataChange = useCallback(
    (clipId: ClipId, textData: TextClipData): void => {
      if (!sequence) {
        return;
      }

      let trackId: string | undefined;
      for (const track of sequence.tracks) {
        if (track.clips.some((clip) => clip.id === clipId)) {
          trackId = track.id;
          break;
        }
      }

      if (!trackId) {
        return;
      }

      void updateTextClip({
        trackId,
        clipId,
        textData,
      }).catch((error) => {
        logger.error('Failed to update text clip from inspector', {
          error,
          sequenceId: sequence.id,
          trackId,
          clipId,
        });
      });
    },
    [sequence, updateTextClip],
  );

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
      } else if (property === 'position') {
        const normalizedPosition = normalizeCaptionPositionValue(value);
        if (!normalizedPosition) {
          return;
        }

        handleUpdateCaption({
          sequenceId: sequence.id,
          trackId,
          captionId,
          position: normalizedPosition,
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
    [sequence, addTextClip],
  );

  // Audio Mixer handlers - connected to store and Web Audio
  const handleMixerVolumeChange = useCallback(
    (trackId: string, volumeDb: number) => {
      setTrackVolume(trackId, volumeDb);
      logger.debug('Volume change', { trackId, volumeDb });
    },
    [setTrackVolume],
  );

  const handleMixerPanChange = useCallback(
    (trackId: string, pan: number) => {
      setTrackPan(trackId, pan);
    },
    [setTrackPan],
  );

  const handleMixerMuteToggle = useCallback(
    (trackId: string) => {
      // Toggle mute in mixer store (affects audio output)
      toggleTrackMute(trackId);
      // Also toggle in timeline if we want visual feedback on track header
      if (sequence && handleTrackMuteToggle) {
        handleTrackMuteToggle({ sequenceId: sequence.id, trackId });
      }
    },
    [sequence, handleTrackMuteToggle, toggleTrackMute],
  );

  const handleMixerSoloToggle = useCallback(
    (trackId: string) => {
      toggleSolo(trackId);
    },
    [toggleSolo],
  );

  const handleMasterVolumeChange = useCallback(
    (volumeDb: number) => {
      setMixerMasterVolume(volumeDb);
    },
    [setMixerMasterVolume],
  );

  const handleMasterMuteToggle = useCallback(() => {
    toggleMasterMute();
  }, [toggleMasterMute]);

  // Bottom panel tabs
  const videoGenEnabled = isVideoGenerationEnabled();
  const bottomPanelTabs: BottomPanelTab[] = useMemo(() => {
    const tabs: BottomPanelTab[] = [];

    tabs.push({
      id: 'comparison',
      label: 'Reference',
      icon: <GitCompareArrows className="w-3 h-3" />,
      content: (
        <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
          <ReferenceComparisonPanel />
        </Suspense>
      ),
    });

    if (videoGenEnabled) {
      tabs.push({
        id: 'videogen',
        label: 'Generate',
        icon: <Sparkles className="w-3 h-3" />,
        content: (
          <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
            <VideoGenerationPanel compact className="h-full" />
          </Suspense>
        ),
      });
    }

    return tabs;
  }, [videoGenEnabled]);

  return (
    <>
      <MainLayout
        header={
          <Header
            onExport={handleOpenExport}
            version={appVersion}
            utilityActions={
              <HeaderPopoverAction
                label="Console"
                icon={<Terminal className="h-4 w-4" />}
                panelClassName="w-[340px] max-w-[90vw] p-0"
              >
                <div className="border-b border-editor-border px-3 py-2">
                  <div className="text-xs font-semibold uppercase tracking-wider text-editor-text-muted">
                    Console
                  </div>
                  <p className="mt-1 text-xs text-editor-text-muted">
                    Hidden by default to keep the editing workspace focused.
                  </p>
                </div>
                <div className="max-h-48 overflow-auto bg-editor-bg px-3 py-2 font-mono text-[11px] text-editor-text-muted">
                  <p>[ready] OpenReelio initialized.</p>
                  <p>[layout] Timeline and mixer stay inside the main workspace.</p>
                  <p>[sequence] {sequence?.name ?? 'No active sequence'}</p>
                </div>
              </HeaderPopoverAction>
            }
          />
        }
        leftSidebar={
          <Sidebar title="Project Explorer" position="left" autoCollapseBreakpoint={1280}>
            <ExplorerErrorBoundary
              onError={(error) => logger.error('ProjectExplorer error', { error })}
            >
              <ProjectExplorer />
            </ExplorerErrorBoundary>
          </Sidebar>
        }
        rightSidebar={
          <>
            <Sidebar title="Inspector" position="right" width={288} autoCollapseBreakpoint={1360}>
              <InspectorErrorBoundary
                onError={(error) => logger.error('Inspector error', { error })}
              >
                <Inspector
                  selectedClip={inspectorClip}
                  selectedAsset={inspectorAsset}
                  selectedTextClip={selectedTextClip}
                  selectedCaption={selectedCaption}
                  onClipBlendModeChange={handleClipBlendModeChange}
                  onTextDataChange={onTextDataChange}
                  onCaptionChange={onCaptionChange}
                />
              </InspectorErrorBoundary>
            </Sidebar>
            <AIErrorBoundary onError={(error) => logger.error('AISidebar error', { error })}>
              <AISidebar
                collapsed={aiSidebarCollapsed}
                onToggle={toggleAiSidebar}
                width={aiSidebarWidth}
                onWidthChange={setAiSidebarWidth}
              />
            </AIErrorBoundary>
          </>
        }
        footer={
          <TabbedBottomPanel
            tabs={bottomPanelTabs}
            defaultTab="comparison"
            defaultHeight={144}
            defaultCollapsed
          />
        }
      >
        {/* Center content split between preview and timeline */}
        <div className="flex h-full flex-col">
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
            <div className="flex h-full min-h-0 gap-3 p-3">
              <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-editor-border bg-editor-panel">
                <div className="border-b border-editor-border px-3 py-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-editor-text-muted">
                    Timeline
                  </h2>
                </div>
                <div className="min-h-0 flex-1">
                  <TimelineErrorBoundary
                    onError={(error) => logger.error('Timeline error', { error })}
                  >
                    <Timeline
                      sequence={sequence}
                      onClipMove={handleClipMove}
                      onClipTrim={handleClipTrim}
                      onClipSplit={handleClipSplit}
                      onClipDuplicate={handleClipDuplicate}
                      onClipPaste={handleClipPaste}
                      onClipAudioUpdate={handleClipAudioUpdate}
                      onAssetDrop={handleAssetDrop}
                      pendingAssetDrops={pendingWorkspaceDrops}
                      onDeleteClips={handleDeleteClips}
                      onTrackCreate={handleTrackCreate}
                      onTrackDelete={handleTrackDelete}
                      onTrackMuteToggle={handleTrackMuteToggle}
                      onTrackLockToggle={handleTrackLockToggle}
                      onTrackVisibilityToggle={handleTrackVisibilityToggle}
                      onTrackReorder={handleTrackReorder}
                      onAddText={handleOpenAddText}
                      getTextClipData={(clipId) => textClipDataById.get(clipId)}
                    />
                  </TimelineErrorBoundary>
                </div>
              </section>

              <aside className="hidden w-64 shrink-0 flex-col overflow-hidden rounded-xl border border-editor-border bg-editor-sidebar lg:flex">
                <div className="flex items-center gap-2 border-b border-editor-border px-3 py-2">
                  <Sliders className="h-4 w-4 text-editor-text-muted" />
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-editor-text-muted">
                    Mixer
                  </h2>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
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
                  </Suspense>
                </div>
              </aside>
            </div>
          </div>
        </div>
      </MainLayout>

      {/* Export Dialog */}
      <Suspense fallback={null}>
        <ExportDialog
          isOpen={showExportDialog}
          onClose={handleCloseExport}
          sequenceId={sequence?.id ?? null}
          sequenceName={sequence?.name}
        />
      </Suspense>

      {/* Add Text Dialog */}
      <Suspense fallback={null}>
        <AddTextDialog
          isOpen={showAddTextDialog}
          onClose={handleCloseAddText}
          onAdd={handleAddTextClip}
          tracks={sequence?.tracks ?? []}
          currentTime={currentTime}
        />
      </Suspense>
    </>
  );
}
