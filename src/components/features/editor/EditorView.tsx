/**
 * EditorView Component
 *
 * Main editing interface that displays when a project is loaded.
 * Contains the preview player, timeline, project explorer, inspector,
 * and AI sidebar in a multi-panel layout.
 */

import {
  lazy,
  Suspense,
  useCallback,
  useRef,
  useState,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import {
  Header,
  HeaderPopoverAction,
  DockableEditorLayout,
  WorkspacePresetSelector,
} from '@/components/layout';
import {
  findPanelZone,
  useWorkspaceLayoutStore,
  type PanelId,
} from '@/stores/workspaceLayoutStore';
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
import { SourceMonitor } from '@/components/features/preview/SourceMonitor';
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
import { useAudioDucking } from '@/hooks/useAudioDucking';
import { useAudioScrubbing } from '@/hooks/useAudioScrubbing';
import { useCommandPalette } from '@/hooks/useCommandPalette';
import { useFullscreenPreview } from '@/hooks/useFullscreenPreview';
import { useInterchangeExport } from '@/hooks/useInterchangeExport';
import { CommandPalette } from '@/components/features/command-palette';
import { useToastStore } from '@/hooks/useToast';
import { useDockableAIPanel } from './hooks/useDockableAIPanel';
import { dbToLinear, linearToDb } from '@/utils/audioMeter';
import { resolveAutoDuckTargets } from '@/utils/audioDucking';
import { extractTextDataFromClipWithMap } from '@/utils/textRenderer';
import { commands } from '@/bindings';
import { createLogger } from '@/services/logger';
import { startPlayheadBackendSync } from '@/services/playheadBackendSync';
import { isVideoGenerationEnabled } from '@/config/featureFlags';
import { getSplitTargetsAtTime } from '@/utils/clipLinking';
import { Terminal, Sliders, Camera } from 'lucide-react';
import type {
  BlendMode,
  CaptionPosition,
  ClipId,
  Effect,
  EffectId,
  Sequence,
  SimpleParamValue,
  TextClipData,
} from '@/types';
import type { AddTextPayload } from '@/components/features/text';
import type { ChannelLevels } from '@/components/features/mixer';
import type { MulticamGroup } from '@/utils/multicam';
import { isTextClip, hasActiveTimeRemap } from '@/types';

const logger = createLogger('EditorView');
const AI_AUTO_COLLAPSE_BREAKPOINT = 1440;
/** FFmpeg JPEG quality (1=best, 31=worst). Default: 2 for high quality frame export. */
const JPEG_EXPORT_QUALITY = 2;
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

const AgentArtifactReviewPanelLazy = lazy(async () => {
  const module = await import('@/components/features/agent/AgentArtifactReviewPanel');
  return { default: module.AgentArtifactReviewPanel };
});

const UndoHistoryPanel = lazy(async () => {
  const module = await import('@/components/features/history');
  return { default: module.UndoHistoryPanel };
});

const TranscriptEditorPanel = lazy(async () => {
  const module = await import('@/components/features/transcript');
  return { default: module.TranscriptEditor };
});

const PerformancePanelLazy = lazy(async () => {
  const module = await import('@/components/features/dev');
  return { default: module.PerformancePanel };
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
  const { selectedAssetId, assets, effects, executeCommand } = useProjectStore();
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const { selectedClipIds, linkedSelectionEnabled } = useTimelineStore();
  const aiPanelZoneId = useWorkspaceLayoutStore(
    (state) => findPanelZone(state.layout, 'ai-assistant') ?? 'right',
  );
  const sequenceNavigationStack = useProjectStore((s) => s.sequenceNavigationStack);
  const sequences = useProjectStore((s) => s.sequences);
  const popSequence = useProjectStore((s) => s.popSequence);

  // Fullscreen preview & snapshot
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const { isFullscreen, toggleFullscreen, captureSnapshot } =
    useFullscreenPreview(previewContainerRef);

  // Export dialog state
  const [showExportDialog, setShowExportDialog] = useState(false);

  // Interchange export (EDL/FCPXML) — uses native file dialog directly
  const {
    status: interchangeExportStatus,
    exportEdl: startEdlExport,
    exportFcpxml: startFcpxmlExport,
    reset: resetInterchangeExport,
  } = useInterchangeExport();

  // Add Text dialog state
  const [showAddTextDialog, setShowAddTextDialog] = useState(false);

  // Mixer visibility state (toggled from timeline header)
  const [showMixer, setShowMixer] = useState(false);
  const handleToggleMixer = useCallback(() => setShowMixer((prev) => !prev), []);

  // AI Sidebar state
  const {
    width: aiSidebarWidth,
    setWidth: setAiSidebarWidth,
    toggle: toggleAiSidebar,
  } = useDockableAIPanel({
    autoCollapseBreakpoint: AI_AUTO_COLLAPSE_BREAKPOINT,
    initialWidth: 320,
  });
  const aiSidebarLayoutMode = aiPanelZoneId === 'right' ? 'sidebar' : 'panel';

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

  // Audio ducking
  const { applyDucking, isApplying: isAutoDucking } = useAudioDucking();

  const handleAutoDuck = useCallback(async () => {
    if (!sequence) return;

    const resolution = resolveAutoDuckTargets(sequence, selectedClipIds);
    if (!resolution.ok) {
      logger.warn('Auto-duck target resolution failed', { reason: resolution.reason });
      useToastStore.getState().addToast({
        message: resolution.reason,
        variant: 'warning',
      });
      return;
    }

    try {
      await applyDucking(
        sequence.id,
        resolution.targets.speechTrackId,
        resolution.targets.musicTrackId,
        resolution.targets.musicClipId,
      );
    } catch (err) {
      logger.error('Auto-duck failed', { reason: String(err) });
      useToastStore.getState().addToast({
        message: 'Auto-duck failed. Check the selected tracks and try again.',
        variant: 'error',
      });
    }
  }, [sequence, selectedClipIds, applyDucking]);

  useEffect(() => {
    if (interchangeExportStatus.type === 'completed') {
      const formatLabel =
        interchangeExportStatus.result.format === 'fcpxml'
          ? 'FCPXML'
          : interchangeExportStatus.result.format.toUpperCase();

      useToastStore.getState().addToast({
        message: `Exported ${formatLabel} to ${interchangeExportStatus.result.outputPath}`,
        variant: 'success',
      });
      resetInterchangeExport();
      return;
    }

    if (interchangeExportStatus.type === 'failed') {
      useToastStore.getState().addToast({
        message: interchangeExportStatus.error,
        variant: 'error',
      });
      resetInterchangeExport();
    }
  }, [interchangeExportStatus, resetInterchangeExport]);

  // Audio playback integration
  // The hook handles audio scheduling, volume control, and clip synchronization
  // It uses Web Audio API for precise timing and responds to playback store changes
  const { initAudio, isAudioReady } = useAudioPlayback({
    sequence,
    assets,
    enabled: true, // Always enabled when in editor view
  });

  // Audio scrubbing: plays short snippets when dragging playhead while paused
  useAudioScrubbing({ sequence, assets });

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

  useEffect(() => {
    setMixerMasterVolume(sequence?.masterVolumeDb ?? 0);
  }, [sequence?.id, sequence?.masterVolumeDb, setMixerMasterVolume]);

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
    handleCloseGap,
    handleCloseAllGaps,
    handleRippleDeleteClips,
    handleLiftClips,
    handleInsertEditFromSource,
    handleOverwriteEditFromSource,
    handleSetClipSpeed,
    handleReverseClip,
    handleCreateFreezeFrame,
    handleToggleClipEnabled,
    handleLinkClips,
    handleUnlinkClips,
    handleDetachAudio,
    handleCreateCompoundClip,
    handleUnnestCompoundClip,
    handleCreateAdjustmentLayer,
    handleGroupClips,
    handleUngroupClips,
    handleCopyEffects,
    handlePasteEffects,
    handlePasteAttributes,
    handleRemoveAttributes,
  } = useTimelineActions({ sequence });

  // Text clip operations
  const { addTextClip, updateTextClip } = useTextClip();
  const textClipDataById = useSequenceTextClipData(sequence);

  // Double-click handler: open compound clip's nested sequence
  const pushSequence = useProjectStore((s) => s.pushSequence);
  const handleClipDoubleClick = useCallback(
    (clipId: string) => {
      if (!sequence) return;
      for (const track of sequence.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip?.compoundSequenceId) {
          pushSequence(clip.compoundSequenceId);
          return;
        }
      }
    },
    [sequence, pushSequence],
  );

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

  // Match Frame: F key — timeline clip → source monitor
  const handleMatchFrame = useCallback(() => {
    void commands.matchFrame({ timeSec: currentTime });
  }, [currentTime]);

  // Reverse Match Frame: Shift+F — source monitor → timeline seek
  const handleReverseMatchFrame = useCallback(() => {
    void commands.reverseMatchFrame().then((result) => {
      if (result.status === 'ok') {
        usePlaybackStore.getState().seek(result.data.timelineSec);
      }
    });
  }, []);

  const handleCopySelectedClipEffects = useCallback(() => {
    if (!sequence || selectedClipIds.length !== 1) {
      return;
    }

    const clipId = selectedClipIds[0];
    const track = sequence.tracks.find((candidate) =>
      candidate.clips.some((clip) => clip.id === clipId),
    );
    if (!track) {
      return;
    }

    void handleCopyEffects(clipId, track.id);
  }, [handleCopyEffects, selectedClipIds, sequence]);

  const handlePasteEffectsToSelection = useCallback(() => {
    if (selectedClipIds.length === 0) {
      return;
    }

    void handlePasteEffects(selectedClipIds);
  }, [handlePasteEffects, selectedClipIds]);

  // Command Palette
  const handleToggleClipEnabledForPalette = useCallback(() => {
    if (!sequence || selectedClipIds.length === 0) return;
    const promises: Promise<void>[] = [];
    for (const clipId of selectedClipIds) {
      const track = sequence.tracks.find((t) => t.clips.some((c) => c.id === clipId));
      if (track) {
        promises.push(handleToggleClipEnabled(clipId, track.id));
      }
    }
    if (promises.length > 0) {
      Promise.all(promises).catch((error) => {
        logger.error('Failed to toggle clip enabled state', { error });
      });
    }
  }, [sequence, selectedClipIds, handleToggleClipEnabled]);

  // Interchange export handlers (EDL/FCPXML) — defined before useCommandPalette
  const handleExportEdl = useCallback(() => {
    if (sequence?.id && sequence?.name) {
      void startEdlExport(sequence.id, sequence.name);
    }
  }, [sequence?.id, sequence?.name, startEdlExport]);

  const handleExportFcpxml = useCallback(() => {
    if (sequence?.id && sequence?.name) {
      void startFcpxmlExport(sequence.id, sequence.name);
    }
  }, [sequence?.id, sequence?.name, startFcpxmlExport]);

  const commandPalette = useCommandPalette({
    onSplitAtPlayhead: handleSplitAtPlayhead,
    onDeleteClips: () => {
      if (selectedClipIds.length > 0) handleDeleteClips?.(selectedClipIds);
    },
    onExport: () => setShowExportDialog(true),
    onExportEdl: handleExportEdl,
    onExportFcpxml: handleExportFcpxml,
    onExportFrame: () => void handleExportFrame(),
    onExportAudio: () => void handleExportAudio(),
    onMatchFrame: handleMatchFrame,
    onReverseMatchFrame: handleReverseMatchFrame,
    onCopyEffects: handleCopySelectedClipEffects,
    onPasteEffects: handlePasteEffectsToSelection,
    onToggleClipEnabled: handleToggleClipEnabledForPalette,
    onToggleMixer: handleToggleMixer,
    onAddText: () => setShowAddTextDialog(true),
    onAutoDuck: handleAutoDuck,
  });

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
    onMatchFrame: handleMatchFrame,
    onReverseMatchFrame: handleReverseMatchFrame,
    onCopyEffects: handleCopySelectedClipEffects,
    onPasteEffects: handlePasteEffectsToSelection,
    onToggleCommandPalette: commandPalette.isOpen ? commandPalette.close : commandPalette.open,
    onToggleClipEnabled: handleToggleClipEnabledForPalette,
    onToggleFullscreen: toggleFullscreen,
    onCaptureSnapshot: captureSnapshot,
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
        sequenceId: sequence.id,
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
        effects: clip.effects
          .map((effectId) => effects.get(effectId))
          .filter((effect): effect is Effect => effect !== undefined),
        blendMode: clip.blendMode,
        speed: clip.speed,
        reverse: clip.reverse,
        hasTimeRemap: hasActiveTimeRemap(clip),
      };
    }
    return undefined;
  }, [sequence, selectedClipIds, assets, effects]);

  // Blend mode operations
  const { setClipBlendMode } = useBlendMode();

  const handleClipBlendModeChange = useCallback(
    (clipId: string, trackId: string, blendMode: BlendMode) => {
      setClipBlendMode(trackId, clipId, blendMode);
    },
    [setClipBlendMode],
  );

  const handleEffectChange = useCallback(
    (effectId: EffectId, params: Record<string, SimpleParamValue>) => {
      void executeCommand({
        type: 'UpdateEffect',
        payload: {
          effectId,
          params,
        },
      }).catch((error) => {
        logger.error('Failed to update effect params', { effectId, error });
      });
    },
    [executeCommand],
  );

  const handleEffectToggle = useCallback(
    (_clipId: string, effectId: EffectId, enabled: boolean) => {
      void executeCommand({
        type: 'UpdateEffect',
        payload: {
          effectId,
          enabled,
        },
      }).catch((error) => {
        logger.error('Failed to toggle effect', { effectId, enabled, error });
      });
    },
    [executeCommand],
  );

  const handleEffectRemove = useCallback(
    (clipId: string, effectId: EffectId) => {
      if (!sequence || !inspectorClip) {
        logger.warn('Skipped remove effect without active clip context', {
          clipId,
          effectId,
        });
        return;
      }

      void executeCommand({
        type: 'RemoveEffect',
        payload: {
          sequenceId: sequence.id,
          trackId: inspectorClip.place.trackId,
          clipId,
          effectId,
        },
      }).catch((error) => {
        logger.error('Failed to remove effect', { clipId, effectId, error });
      });
    },
    [executeCommand, inspectorClip, sequence],
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

  // Frame export handler
  const handleExportFrame = useCallback(async () => {
    if (!sequence?.id) return;

    try {
      const { save: showSaveDialog } = await import('@tauri-apps/plugin-dialog');
      const outputPath = await showSaveDialog({
        title: 'Export Current Frame',
        defaultPath: `frame_${Math.floor(currentTime * 1000)}ms.png`,
        filters: [
          { name: 'PNG Image', extensions: ['png'] },
          { name: 'JPEG Image', extensions: ['jpg', 'jpeg'] },
          { name: 'TIFF Image', extensions: ['tiff', 'tif'] },
        ],
      });

      if (!outputPath) return;

      // Determine format from extension
      const ext = outputPath.split('.').pop()?.toLowerCase() ?? 'png';
      const format =
        ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext === 'tif' || ext === 'tiff' ? 'tiff' : 'png';

      const result = await commands.exportFrame(
        sequence.id,
        currentTime,
        format,
        outputPath,
        format === 'jpeg' ? JPEG_EXPORT_QUALITY : null,
      );

      if (result.status === 'ok') {
        useToastStore.getState().addToast({
          variant: 'success',
          message: `Frame exported to ${result.data.outputPath}`,
        });
      } else {
        useToastStore.getState().addToast({
          variant: 'error',
          message: `Frame export failed: ${result.error}`,
        });
      }
    } catch (error) {
      useToastStore.getState().addToast({
        variant: 'error',
        message: `Frame export failed: ${String(error)}`,
      });
    }
  }, [sequence?.id, currentTime]);

  // Audio-only export handler
  const handleExportAudio = useCallback(async () => {
    if (!sequence?.id) return;

    try {
      const { save: showSaveDialog } = await import('@tauri-apps/plugin-dialog');
      const outputPath = await showSaveDialog({
        title: 'Export Audio Only',
        defaultPath: `${sequence.name ?? 'audio'}_audio.wav`,
        filters: [
          { name: 'WAV Audio', extensions: ['wav'] },
          { name: 'MP3 Audio', extensions: ['mp3'] },
          { name: 'FLAC Audio', extensions: ['flac'] },
        ],
      });

      if (!outputPath) return;

      const ext = outputPath.split('.').pop()?.toLowerCase() ?? 'wav';
      const format = ext === 'mp3' ? 'mp3' : ext === 'flac' ? 'flac' : 'wav';

      const result = await commands.exportAudioOnly(sequence.id, format, outputPath, null, null);

      if (result.status === 'ok') {
        useToastStore.getState().addToast({
          variant: 'info',
          message: `Audio export started: ${outputPath}`,
        });
      } else {
        useToastStore.getState().addToast({
          variant: 'error',
          message: `Audio export failed: ${result.error}`,
        });
      }
    } catch (error) {
      useToastStore.getState().addToast({
        variant: 'error',
        message: `Audio export failed: ${String(error)}`,
      });
    }
  }, [sequence?.id, sequence?.name]);

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
      if (sequence?.id) {
        void executeCommand({
          type: 'SetMasterVolume',
          payload: { sequenceId: sequence.id, volumeDb },
        });
      }
    },
    [setMixerMasterVolume, executeCommand, sequence?.id],
  );

  const handleMasterMuteToggle = useCallback(() => {
    toggleMasterMute();
  }, [toggleMasterMute]);

  // Bottom panel tabs (kept for backward compat — used in panelContent)
  const videoGenEnabled = isVideoGenerationEnabled();

  // =========================================================================
  // Dockable Layout — Panel Content Registry
  // =========================================================================

  const panelContent = useMemo<Partial<Record<PanelId, ReactNode>>>(
    () => ({
      explorer: (
        <ExplorerErrorBoundary
          onError={(error) => logger.error('ProjectExplorer error', { error })}
        >
          <div className="h-full overflow-auto p-4">
            <ProjectExplorer />
          </div>
        </ExplorerErrorBoundary>
      ),

      'source-monitor': (
        <PreviewErrorBoundary onError={(error) => logger.error('SourceMonitor error', { error })}>
          <SourceMonitor className="h-full w-full" />
        </PreviewErrorBoundary>
      ),

      'program-monitor': (
        <div
          ref={previewContainerRef}
          className={`h-full w-full relative ${isFullscreen ? 'bg-black' : ''}`}
        >
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
          <button
            type="button"
            data-testid="snapshot-button"
            className="absolute top-2 right-2 p-1.5 rounded bg-black/40 hover:bg-black/60 text-white/70 hover:text-white transition-colors z-10"
            onClick={captureSnapshot}
            title="Capture Snapshot (Ctrl+Shift+S)"
            aria-label="Capture preview snapshot"
          >
            <Camera className="w-4 h-4" />
          </button>
        </div>
      ),

      timeline: (
        <div className="h-full min-h-0 p-3">
          <section className="flex h-full flex-col overflow-hidden rounded-xl border border-editor-border bg-editor-panel">
            <div className="flex items-center justify-between border-b border-editor-border px-3 py-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-editor-text-muted">
                Timeline
              </h2>
              <button
                type="button"
                onClick={handleToggleMixer}
                className={`rounded p-1 transition-colors ${
                  showMixer
                    ? 'bg-editor-border text-editor-text'
                    : 'text-editor-text-muted hover:text-editor-text hover:bg-editor-border/50'
                }`}
                title={showMixer ? 'Hide Mixer' : 'Show Mixer'}
                aria-label={showMixer ? 'Hide Mixer' : 'Show Mixer'}
                aria-pressed={showMixer}
              >
                <Sliders className="h-3.5 w-3.5" />
              </button>
            </div>
            {sequenceNavigationStack.length > 0 && (
              <div className="flex items-center gap-1 px-3 py-1 bg-gray-800 border-b border-gray-700 text-xs text-gray-300">
                <button
                  className="hover:text-white transition-colors"
                  onClick={popSequence}
                  title="Back to parent sequence"
                >
                  &larr; Back
                </button>
                <span className="text-gray-500">/</span>
                {sequenceNavigationStack.map((seqId) => {
                  const seq = sequences.get(seqId);
                  return (
                    <span key={seqId} className="text-gray-400">
                      {seq?.name ?? seqId}
                      <span className="text-gray-500 mx-1">/</span>
                    </span>
                  );
                })}
                <span className="text-white font-medium">{sequence?.name ?? 'Inner Sequence'}</span>
              </div>
            )}
            <div className="min-h-0 flex-1">
              <TimelineErrorBoundary onError={(error) => logger.error('Timeline error', { error })}>
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
                  onCloseGap={handleCloseGap}
                  onCloseAllGaps={handleCloseAllGaps}
                  onRippleDeleteClips={handleRippleDeleteClips}
                  onLiftClips={handleLiftClips}
                  onInsertEditFromSource={handleInsertEditFromSource}
                  onOverwriteEditFromSource={handleOverwriteEditFromSource}
                  onClipSpeedChange={handleSetClipSpeed}
                  onClipReverse={handleReverseClip}
                  onClipFreezeFrame={handleCreateFreezeFrame}
                  onClipToggleEnabled={handleToggleClipEnabled}
                  onClipLink={handleLinkClips}
                  onClipUnlink={handleUnlinkClips}
                  onClipDetachAudio={handleDetachAudio}
                  onCreateCompoundClip={handleCreateCompoundClip}
                  onUnnestCompoundClip={handleUnnestCompoundClip}
                  onCreateAdjustmentLayer={handleCreateAdjustmentLayer}
                  onClipGroup={handleGroupClips}
                  onClipUngroup={handleUngroupClips}
                  onCopyEffects={handleCopyEffects}
                  onPasteEffects={handlePasteEffects}
                  onPasteAttributes={handlePasteAttributes}
                  onRemoveAttributes={handleRemoveAttributes}
                  onClipDoubleClick={handleClipDoubleClick}
                />
              </TimelineErrorBoundary>
            </div>
            {showMixer && (
              <div
                className="shrink-0 border-t border-editor-border bg-editor-sidebar"
                style={{ height: '220px' }}
              >
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
                    onAutoDuck={handleAutoDuck}
                    isAutoDucking={isAutoDucking}
                    compact
                    className="h-full"
                  />
                </Suspense>
              </div>
            )}
          </section>
        </div>
      ),

      inspector: (
        <InspectorErrorBoundary onError={(error) => logger.error('Inspector error', { error })}>
          <div className="h-full overflow-auto p-4">
            <Inspector
              selectedClip={inspectorClip}
              selectedAsset={inspectorAsset}
              selectedTextClip={selectedTextClip}
              selectedCaption={selectedCaption}
              onClipBlendModeChange={handleClipBlendModeChange}
              onClipSpeedChange={handleSetClipSpeed}
              onClipReverseToggle={handleReverseClip}
              onFreezeFrame={handleCreateFreezeFrame}
              onTextDataChange={onTextDataChange}
              onCaptionChange={onCaptionChange}
              onEffectChange={handleEffectChange}
              onEffectToggle={handleEffectToggle}
              onEffectRemove={handleEffectRemove}
            />
          </div>
        </InspectorErrorBoundary>
      ),

      'audio-mixer': (
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
            onAutoDuck={handleAutoDuck}
            isAutoDucking={isAutoDucking}
            className="h-full"
          />
        </Suspense>
      ),

      'ai-assistant': (
        <AIErrorBoundary onError={(error) => logger.error('AISidebar error', { error })}>
          <AISidebar
            collapsed={false}
            onToggle={toggleAiSidebar}
            width={aiSidebarLayoutMode === 'sidebar' ? aiSidebarWidth : undefined}
            onWidthChange={aiSidebarLayoutMode === 'sidebar' ? setAiSidebarWidth : undefined}
            layoutMode={aiSidebarLayoutMode}
          />
        </AIErrorBoundary>
      ),

      comparison: (
        <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
          <ReferenceComparisonPanel />
        </Suspense>
      ),

      'agent-review': (
        <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
          <AgentArtifactReviewPanelLazy />
        </Suspense>
      ),

      history: (
        <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
          <UndoHistoryPanel />
        </Suspense>
      ),

      transcript: (
        <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
          <TranscriptEditorPanel />
        </Suspense>
      ),

      generation: videoGenEnabled ? (
        <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
          <VideoGenerationPanel compact className="h-full" />
        </Suspense>
      ) : undefined,

      performance: (
        <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
          <PerformancePanelLazy />
        </Suspense>
      ),
    }),
    [
      sequence,
      inspectorClip,
      inspectorAsset,
      selectedTextClip,
      selectedCaption,
      showMixer,
      isFullscreen,
      aiSidebarWidth,
      aiSidebarLayoutMode,
      sequenceNavigationStack,
      sequences,
      videoGenEnabled,
      trackLevels,
      trackPans,
      soloedTrackIds,
      masterVolume,
      masterMuted,
      masterLevels,
      isAutoDucking,
      textClipDataById,
      pendingWorkspaceDrops,
      handleToggleMixer,
      handleClipMove,
      handleClipTrim,
      handleClipSplit,
      handleClipDuplicate,
      handleClipPaste,
      handleClipAudioUpdate,
      handleAssetDrop,
      handleDeleteClips,
      handleTrackCreate,
      handleTrackDelete,
      handleTrackMuteToggle,
      handleTrackLockToggle,
      handleTrackVisibilityToggle,
      handleTrackReorder,
      handleOpenAddText,
      handleCloseGap,
      handleCloseAllGaps,
      handleRippleDeleteClips,
      handleLiftClips,
      handleInsertEditFromSource,
      handleOverwriteEditFromSource,
      handleSetClipSpeed,
      handleReverseClip,
      handleCreateFreezeFrame,
      handleToggleClipEnabled,
      handleLinkClips,
      handleUnlinkClips,
      handleDetachAudio,
      handleCreateCompoundClip,
      handleUnnestCompoundClip,
      handleCreateAdjustmentLayer,
      handleGroupClips,
      handleUngroupClips,
      handleCopyEffects,
      handlePasteEffects,
      handlePasteAttributes,
      handleRemoveAttributes,
      handleClipDoubleClick,
      handleClipBlendModeChange,
      onTextDataChange,
      onCaptionChange,
      handleEffectChange,
      handleEffectToggle,
      handleEffectRemove,
      captureSnapshot,
      toggleAiSidebar,
      setAiSidebarWidth,
      popSequence,
      handleMixerVolumeChange,
      handleMixerPanChange,
      handleMixerMuteToggle,
      handleMixerSoloToggle,
      handleMasterVolumeChange,
      handleMasterMuteToggle,
      handleAutoDuck,
    ],
  );

  const headerElement = useMemo(
    () => (
      <Header
        onExport={handleOpenExport}
        onExportEdl={handleExportEdl}
        onExportFcpxml={handleExportFcpxml}
        onExportFrame={() => void handleExportFrame()}
        onExportAudio={() => void handleExportAudio()}
        version={appVersion}
        utilityActions={
          <>
            <WorkspacePresetSelector />
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
                <p>[layout] Workspace ready.</p>
                <p>[sequence] {sequence?.name ?? 'No active sequence'}</p>
              </div>
            </HeaderPopoverAction>
          </>
        }
      />
    ),
    [
      sequence?.name,
      appVersion,
      handleOpenExport,
      handleExportEdl,
      handleExportFcpxml,
      handleExportFrame,
      handleExportAudio,
    ],
  );

  return (
    <>
      <DockableEditorLayout header={headerElement} panelContent={panelContent} />

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

      {/* Command Palette */}
      <CommandPalette palette={commandPalette} />
    </>
  );
}
