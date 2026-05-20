/**
 * EditorView Component
 *
 * Main editing interface that displays when a project is loaded.
 * Contains the preview player, timeline, project explorer, inspector,
 * and AI sidebar in a multi-panel layout.
 */

import { lazy, Suspense, useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { Header, DockableEditorLayout, WorkspacePresetSelector } from '@/components/layout';
import {
  type InspectorProps,
  type SelectedClip,
  type SelectedCaption,
  type SelectedTextClip,
} from '@/components/features/inspector';
import { type AISidebarProps } from '@/components/features/ai';
import { type TimelineProps } from '@/components/timeline';
import { useProjectStore, usePlaybackStore, useTimelineStore, useAudioMixerStore } from '@/stores';
// Direct imports instead of barrel to avoid bundling all 100+ hooks
import { useTimelineActions } from '@/hooks/useTimelineActions';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useAudioPlayback } from '@/hooks/useAudioPlayback';
import { useTextClip } from '@/hooks/useTextClip';
import { useSequenceTextClipData } from '@/hooks/useSequenceTextClipData';
import { useMulticamSession } from '@/hooks/useMulticamSession';
import { useBlendMode } from '@/hooks/useBlendMode';
import { useAudioDucking } from '@/hooks/useAudioDucking';
import { useAudioScrubbing } from '@/hooks/useAudioScrubbing';
import { useCommandPalette } from '@/hooks/useCommandPalette';
import { useFullscreenPreview } from '@/hooks/useFullscreenPreview';
import { useInterchangeExport } from '@/hooks/useInterchangeExport';
import { CommandPalette } from '@/components/features/command-palette';
import { useToastStore } from '@/hooks/useToast';
import { useTerminalStore } from '@/stores/terminalStore';
import { useDockableAIPanel } from './hooks/useDockableAIPanel';
import { dbToLinear, linearToDb } from '@/utils/audioMeter';
import { resolveAutoDuckTargets } from '@/utils/audioDucking';
import { extractTextDataFromClipWithMap } from '@/utils/textRenderer';
import { getClipTimelineDurationSec, getClipTimelineEndSec } from '@/utils/clipTiming';
import { commands } from '@/bindings';
import { createLogger } from '@/services/logger';
import { startPlayheadBackendSync } from '@/services/playheadBackendSync';
import { isVideoGenerationEnabled } from '@/config/featureFlags';
import { getSplitTargetsAtTime } from '@/utils/clipLinking';
import type {
  BlendMode,
  CaptionPosition,
  ClipId,
  Effect,
  EffectId,
  FileTreeEntry,
  Sequence,
  SimpleParamValue,
  TextClipData,
  Track,
} from '@/types';
import type { AddTextPayload } from '@/components/features/text';
import type { AudioMixerPanelProps, ChannelLevels } from '@/components/features/mixer';
import type { MulticamGroup } from '@/utils/multicam';
import { isTextClip, hasActiveTimeRemap } from '@/types';
import { createEditorPanelContent } from './EditorPanels';
import { BottomTerminalControls } from './BottomTerminalControls';

const logger = createLogger('EditorView');
const AI_AUTO_COLLAPSE_BREAKPOINT = 1440;
/** FFmpeg JPEG quality (1=best, 31=worst). Default: 2 for high quality frame export. */
const JPEG_EXPORT_QUALITY = 2;
const AUTO_TIMELINE_INSERT_TRACK_ID = '__openreelio_auto_timeline_track__';

const ExportDialog = lazy(async () => {
  const module = await import('@/components/features/export');
  return { default: module.ExportDialog };
});

const AddTextDialog = lazy(async () => {
  const module = await import('@/components/features/text');
  return { default: module.AddTextDialog };
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

function isTimelineInsertableAssetKind(
  kind: FileTreeEntry['kind'],
): kind is 'video' | 'audio' | 'image' {
  return kind === 'video' || kind === 'audio' || kind === 'image';
}

function isUnlockedTrack(track: Track): boolean {
  return !track.locked;
}

function resolveExplorerInsertTrackId(
  sequence: Sequence,
  assetKind: 'video' | 'audio' | 'image',
): string {
  const tracks = sequence.tracks.filter(isUnlockedTrack);
  const preferredTrack =
    assetKind === 'audio'
      ? tracks.find((track) => track.kind === 'audio')
      : (tracks.find((track) => track.kind === 'video') ??
        tracks.find((track) => track.kind === 'overlay'));

  return preferredTrack?.id ?? AUTO_TIMELINE_INSERT_TRACK_ID;
}

export function EditorView({ sequence, appVersion = '0.1.0' }: EditorViewProps): JSX.Element {
  const { selectedAssetId, assets, effects, executeCommand } = useProjectStore();
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const { selectedClipIds, linkedSelectionEnabled } = useTimelineStore();
  const sanitizeSelection = useTimelineStore((state) => state.sanitizeSelection);
  const sequenceNavigationStack = useProjectStore((s) => s.sequenceNavigationStack);
  const sequences = useProjectStore((s) => s.sequences);
  const popSequence = useProjectStore((s) => s.popSequence);
  const toggleTerminal = useTerminalStore((state) => state.toggleTerminal);

  // Fullscreen preview & snapshot
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const { isFullscreen, toggleFullscreen, captureSnapshot } =
    useFullscreenPreview(previewContainerRef);

  // Export dialog state
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportDialogKind, setExportDialogKind] = useState<'video' | 'audio'>('video');

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

  useEffect(() => {
    const validClipIds =
      sequence?.tracks.flatMap((track) => track.clips.map((clip) => clip.id)) ?? [];
    const validTrackIds = sequence?.tracks.map((track) => track.id) ?? [];
    sanitizeSelection(validClipIds, validTrackIds);
  }, [sanitizeSelection, sequence]);

  // AI Sidebar state
  const { toggle: toggleAiSidebar } = useDockableAIPanel({
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
    removeTrack,
    setTrackVolume,
    setTrackPan,
    setMuted,
    toggleMute: toggleTrackMute,
    toggleSolo,
    setMasterVolume: setMixerMasterVolume,
    toggleMasterMute,
  } = mixerStore;

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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const isTextInput =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;

      if (isTextInput) {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key === '`') {
        event.preventDefault();
        void toggleTerminal();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [toggleTerminal]);

  // Audio playback integration
  // The hook handles audio scheduling, volume control, and clip synchronization
  // It uses Web Audio API for precise timing and responds to playback store changes
  const { initAudio, isAudioReady, failedAssets } = useAudioPlayback({
    sequence,
    assets,
    enabled: true, // Always enabled when in editor view
  });

  // Audio scrubbing: plays short snippets when dragging playhead while paused
  useAudioScrubbing({ sequence, assets });

  useEffect(() => {
    if (isAudioReady) {
      return;
    }

    let started = false;
    const handleAudioGesture = () => {
      if (started) {
        return;
      }

      started = true;
      window.removeEventListener('pointerdown', handleAudioGesture, true);
      window.removeEventListener('keydown', handleAudioGesture, true);
      void initAudio().catch((error) => {
        logger.warn('Deferred audio initialization failed', { error });
      });
    };

    window.addEventListener('pointerdown', handleAudioGesture, true);
    window.addEventListener('keydown', handleAudioGesture, true);

    return () => {
      window.removeEventListener('pointerdown', handleAudioGesture, true);
      window.removeEventListener('keydown', handleAudioGesture, true);
    };
  }, [initAudio, isAudioReady]);

  const notifiedAudioFailuresRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const activeFailures = new Set(failedAssets);

    for (const assetId of failedAssets) {
      if (notifiedAudioFailuresRef.current.has(assetId)) {
        continue;
      }

      const asset = assets.get(assetId);
      useToastStore.getState().addToast({
        variant: 'error',
        message: `Audio preview unavailable for ${asset?.name ?? assetId}. The app could not decode the source or generate a compatible preview.`,
      });
      notifiedAudioFailuresRef.current.add(assetId);
    }

    for (const assetId of Array.from(notifiedAudioFailuresRef.current)) {
      if (!activeFailures.has(assetId)) {
        notifiedAudioFailuresRef.current.delete(assetId);
      }
    }
  }, [assets, failedAssets]);

  // Initialize audio context on first play interaction
  // Web Audio API requires user gesture to create AudioContext
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  useEffect(() => {
    if (isPlaying && !isAudioReady) {
      void initAudio();
    }
  }, [isPlaying, isAudioReady, initAudio]);

  useEffect(() => {
    setMixerMasterVolume(sequence?.masterVolumeDb ?? 0);
  }, [sequence?.id, sequence?.masterVolumeDb, setMixerMasterVolume]);

  // Keep live mixer track state aligned with the active sequence without
  // overriding session-local mixer controls like pan/solo.
  useEffect(() => {
    const currentTrackStates = useAudioMixerStore.getState().trackStates;
    const activeTrackIds = new Set(sequence?.tracks.map((track) => track.id) ?? []);

    if (!sequence) {
      for (const trackId of Array.from(currentTrackStates.keys())) {
        removeTrack(trackId);
      }
      return;
    }

    for (const track of sequence.tracks) {
      const volumeDb = linearToDb(track.volume);
      initializeTrack(track.id, volumeDb, 0);
      setMuted(track.id, track.muted);
    }

    for (const trackId of Array.from(currentTrackStates.keys())) {
      if (!activeTrackIds.has(trackId)) {
        removeTrack(trackId);
      }
    }
  }, [sequence, initializeTrack, removeTrack, setMuted]);

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
    onExport: () => {
      setExportDialogKind('video');
      setShowExportDialog(true);
    },
    onExportEdl: handleExportEdl,
    onExportFcpxml: handleExportFcpxml,
    onExportFrame: () => void handleExportFrame(),
    onExportAudio: () => {
      setExportDialogKind('audio');
      setShowExportDialog(true);
    },
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
    onExport: () => {
      setExportDialogKind('video');
      setShowExportDialog(true);
    },
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
          durationSec: clip.place.durationSec,
        },
        effects: clip.effects
          .map((effectId) => effects.get(effectId))
          .filter((effect): effect is Effect => effect !== undefined),
        blendMode: clip.blendMode,
        speed: clip.speed,
        reverse: clip.reverse,
        freezeFrame: clip.freezeFrame,
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
          return {
            id: clip.id,
            text: clip.label || '', // Using label as text storage for now
            startSec: clip.place.timelineInSec,
            endSec: getClipTimelineEndSec(clip),
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

      return {
        id: clip.id,
        textData,
        timelineInSec: clip.place.timelineInSec,
        durationSec: getClipTimelineDurationSec(clip),
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
  const handleOpenExport = useCallback((kind: 'video' | 'audio' = 'video') => {
    setExportDialogKind(kind);
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
  const handleExportAudio = useCallback(() => {
    handleOpenExport('audio');
  }, [handleOpenExport]);

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

  const handleExplorerAssetAddToTimeline = useCallback(
    async (entry: FileTreeEntry): Promise<void> => {
      if (entry.isDirectory || !sequence) {
        return;
      }

      const asset = entry.assetId ? assets.get(entry.assetId) : undefined;
      const assetKind = asset?.kind ?? entry.kind;
      if (!isTimelineInsertableAssetKind(assetKind)) {
        useToastStore.getState().addToast({
          message: 'Only video, audio, and image assets can be added to the timeline.',
          variant: 'warning',
        });
        return;
      }

      await handleAssetDrop({
        ...(entry.assetId ? { assetId: entry.assetId } : {}),
        workspaceRelativePath: entry.relativePath,
        trackId: resolveExplorerInsertTrackId(sequence, assetKind),
        timelinePosition: currentTime,
        assetKind,
      });
    },
    [assets, currentTime, handleAssetDrop, sequence],
  );

  // Bottom panel tabs (kept for backward compat — used in panelContent)
  const videoGenEnabled = isVideoGenerationEnabled();

  // =========================================================================
  // Dockable Layout — Panel Content Registry
  // =========================================================================

  const timelineProps = useMemo<TimelineProps>(
    () => ({
      sequence,
      onClipMove: handleClipMove,
      onClipTrim: handleClipTrim,
      onClipSplit: handleClipSplit,
      onClipDuplicate: handleClipDuplicate,
      onClipPaste: handleClipPaste,
      onClipAudioUpdate: handleClipAudioUpdate,
      onAssetDrop: handleAssetDrop,
      pendingAssetDrops: pendingWorkspaceDrops,
      onDeleteClips: handleDeleteClips,
      onTrackCreate: handleTrackCreate,
      onTrackDelete: handleTrackDelete,
      onTrackMuteToggle: handleTrackMuteToggle,
      onTrackLockToggle: handleTrackLockToggle,
      onTrackVisibilityToggle: handleTrackVisibilityToggle,
      onTrackReorder: handleTrackReorder,
      onAddText: handleOpenAddText,
      getTextClipData: (clipId) => textClipDataById.get(clipId),
      onCloseGap: handleCloseGap,
      onCloseAllGaps: handleCloseAllGaps,
      onRippleDeleteClips: handleRippleDeleteClips,
      onLiftClips: handleLiftClips,
      onInsertEditFromSource: handleInsertEditFromSource,
      onOverwriteEditFromSource: handleOverwriteEditFromSource,
      onClipSpeedChange: handleSetClipSpeed,
      onClipReverse: handleReverseClip,
      onClipFreezeFrame: handleCreateFreezeFrame,
      onClipToggleEnabled: handleToggleClipEnabled,
      onClipLink: handleLinkClips,
      onClipUnlink: handleUnlinkClips,
      onClipDetachAudio: handleDetachAudio,
      onCreateCompoundClip: handleCreateCompoundClip,
      onUnnestCompoundClip: handleUnnestCompoundClip,
      onCreateAdjustmentLayer: handleCreateAdjustmentLayer,
      onClipGroup: handleGroupClips,
      onClipUngroup: handleUngroupClips,
      onCopyEffects: handleCopyEffects,
      onPasteEffects: handlePasteEffects,
      onPasteAttributes: handlePasteAttributes,
      onRemoveAttributes: handleRemoveAttributes,
      onClipDoubleClick: handleClipDoubleClick,
    }),
    [
      sequence,
      textClipDataById,
      pendingWorkspaceDrops,
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
    ],
  );

  const inspectorProps = useMemo<InspectorProps>(
    () => ({
      selectedClip: inspectorClip,
      selectedAsset: inspectorAsset,
      selectedTextClip,
      selectedCaption,
      onClipBlendModeChange: handleClipBlendModeChange,
      onClipSpeedChange: handleSetClipSpeed,
      onClipReverseToggle: handleReverseClip,
      onFreezeFrame: handleCreateFreezeFrame,
      onTextDataChange: onTextDataChange,
      onCaptionChange: onCaptionChange,
      onEffectChange: handleEffectChange,
      onEffectToggle: handleEffectToggle,
      onEffectRemove: handleEffectRemove,
    }),
    [
      inspectorClip,
      inspectorAsset,
      selectedTextClip,
      selectedCaption,
      handleClipBlendModeChange,
      handleSetClipSpeed,
      handleReverseClip,
      handleCreateFreezeFrame,
      onTextDataChange,
      onCaptionChange,
      handleEffectChange,
      handleEffectToggle,
      handleEffectRemove,
    ],
  );

  const audioMixerPanelProps = useMemo<AudioMixerPanelProps>(
    () => ({
      tracks: sequence?.tracks ?? [],
      trackLevels,
      trackPans,
      soloedTrackIds,
      masterVolume,
      masterMuted,
      masterLevels,
      onVolumeChange: handleMixerVolumeChange,
      onPanChange: handleMixerPanChange,
      onMuteToggle: handleMixerMuteToggle,
      onSoloToggle: handleMixerSoloToggle,
      onMasterVolumeChange: handleMasterVolumeChange,
      onMasterMuteToggle: handleMasterMuteToggle,
      onAutoDuck: handleAutoDuck,
      isAutoDucking,
    }),
    [
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
      handleAutoDuck,
      isAutoDucking,
    ],
  );

  const aiSidebarProps = useMemo<AISidebarProps>(
    () => ({
      collapsed: false,
      onToggle: toggleAiSidebar,
      layoutMode: 'panel',
    }),
    [toggleAiSidebar],
  );

  const panelContent = useMemo(
    () =>
      createEditorPanelContent({
        logger,
        sequence,
        previewContainerRef,
        isFullscreen,
        onCaptureSnapshot: captureSnapshot,
        showMixer,
        onToggleMixer: handleToggleMixer,
        sequenceNavigationStack,
        sequences,
        onPopSequence: popSequence,
        timelineProps,
        inspectorProps,
        audioMixerProps: audioMixerPanelProps,
        aiSidebarProps,
        videoGenerationEnabled: videoGenEnabled,
        onExplorerAssetAddToTimeline: handleExplorerAssetAddToTimeline,
      }),
    [
      sequence,
      isFullscreen,
      captureSnapshot,
      showMixer,
      handleToggleMixer,
      sequenceNavigationStack,
      sequences,
      popSequence,
      timelineProps,
      inspectorProps,
      audioMixerPanelProps,
      aiSidebarProps,
      videoGenEnabled,
      handleExplorerAssetAddToTimeline,
    ],
  );

  const headerElement = useMemo(
    () => (
      <Header
        onExport={handleOpenExport}
        onExportEdl={handleExportEdl}
        onExportFcpxml={handleExportFcpxml}
        onExportFrame={() => void handleExportFrame()}
        onExportAudio={handleExportAudio}
        version={appVersion}
        utilityActions={
          <>
            <WorkspacePresetSelector />
          </>
        }
      />
    ),
    [
      appVersion,
      handleOpenExport,
      handleExportEdl,
      handleExportFcpxml,
      handleExportFrame,
      handleExportAudio,
    ],
  );

  const bottomZoneActions = useMemo(() => <BottomTerminalControls />, []);

  return (
    <>
      <DockableEditorLayout
        header={headerElement}
        bottomZoneActions={bottomZoneActions}
        panelContent={panelContent}
      />

      {/* Export Dialog */}
      <Suspense fallback={null}>
        <ExportDialog
          isOpen={showExportDialog}
          onClose={handleCloseExport}
          sequenceId={sequence?.id ?? null}
          sequenceName={sequence?.name}
          initialExportKind={exportDialogKind}
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
