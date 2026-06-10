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
import {
  useProjectStore,
  usePlaybackStore,
  useTimelineStore,
  useAudioMixerStore,
  useEditorToolStore,
} from '@/stores';
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
import { serializeEffectPresetKeyframes } from '@/hooks/useEffectPresets';
import { useFullscreenPreview } from '@/hooks/useFullscreenPreview';
import { useInterchangeExport } from '@/hooks/useInterchangeExport';
import { CommandPalette } from '@/components/features/command-palette';
import { PasteAttributesDialog } from '@/components/features/effects/PasteAttributesDialog';
import {
  RemoveAttributesDialog,
  type RemoveAttributesResult,
} from '@/components/features/effects/RemoveAttributesDialog';
import {
  TransitionPicker,
  type TransitionConfig,
} from '@/components/features/effects/TransitionPicker';
import type { VisualEffectPreset } from '@/components/features/effects';
import { useToastStore } from '@/hooks/useToast';
import { useTerminalStore } from '@/stores/terminalStore';
import { useWaveformCacheStore } from '@/stores/waveformCacheStore';
import { revealWorkspacePanel } from '@/stores/workspaceLayoutStore';
import { useDockableAIPanel } from './hooks/useDockableAIPanel';
import { dbToLinear, linearToDb } from '@/utils/audioMeter';
import { resolveAutoDuckTargets } from '@/utils/audioDucking';
import {
  applyClipTransformToEditableTextData,
  extractTextDataFromClipWithMap,
} from '@/utils/textRenderer';
import {
  getClipSourceTimeAtTimelineTime,
  getClipTimelineDurationSec,
  getClipTimelineEndSec,
} from '@/utils/clipTiming';
import {
  getDefaultTrackInsertPosition,
  getNextTrackName,
  trackHasOverlap,
} from '@/hooks/timelineActions/helpers';
import { commands } from '@/bindings';
import { createLogger } from '@/services/logger';
import { startPlayheadBackendSync } from '@/services/playheadBackendSync';
import { isVideoGenerationEnabled } from '@/config/featureFlags';
import { getSplitTargetsAtTime } from '@/utils/clipLinking';
import { getClipTransitionEffect } from '@/utils/transitions';
import type {
  BlendMode,
  AttributeSelection,
  Clip,
  ClipId,
  Effect,
  EffectId,
  EffectPreset,
  EffectType,
  FileTreeEntry,
  Sequence,
  SimpleParamValue,
  SlowMotionInterpolation,
  TextClipData,
  Track,
  Transform,
  TransformKeyframe,
  TimeRemapCurve,
} from '@/types';
import { EFFECT_TYPE_LABELS, isAudioEffect } from '@/types';
import type { AddTextPayload } from '@/components/features/text';
import type { TextPlacementCommitPayload } from '@/components/preview/TextPlacementOverlay';
import type { AudioMixerPanelProps, ChannelLevels } from '@/components/features/mixer';
import {
  createSynchronizedMulticamGroup,
  type MulticamGroup,
  type MulticamSyncClipSource,
} from '@/utils/multicam';
import { createTextClipData, isTextClip, hasActiveTimeRemap } from '@/types';
import { createEditorPanelContent } from './EditorPanels';
import { BottomTerminalControls } from './BottomTerminalControls';
import { normalizeCaptionStyle, parseCaptionPositionValue } from '@/utils/captionStyle';

const logger = createLogger('EditorView');
const AI_AUTO_COLLAPSE_BREAKPOINT = 1440;
/** FFmpeg JPEG quality (1=best, 31=worst). Default: 2 for high quality frame export. */
const JPEG_EXPORT_QUALITY = 2;
const AUTO_TIMELINE_INSERT_TRACK_ID = '__openreelio_auto_timeline_track__';
const DEFAULT_PREVIEW_TEXT_DURATION_SEC = 5;
const DEFAULT_TRANSITION_TYPE: TransitionConfig['type'] = 'cross_dissolve';
const DEFAULT_TRANSITION_DURATION_SEC = 1;
const PLAY_AROUND_PRE_ROLL_SEC = 2;
const PLAY_AROUND_POST_ROLL_SEC = 2;

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

const MIXER_VOLUME_COMMAND_DEBOUNCE_MS = 150;
const MIXER_PAN_COMMAND_DEBOUNCE_MS = 150;

export interface EditorViewProps {
  /** Currently active sequence for timeline (null if none active) */
  sequence: Sequence | null;
  /** App version string displayed in header */
  appVersion?: string;
}

function isTimelineInsertableAssetKind(
  kind: FileTreeEntry['kind'],
): kind is 'video' | 'audio' | 'image' {
  return kind === 'video' || kind === 'audio' || kind === 'image';
}

function isUnlockedTrack(track: Track): boolean {
  return !track.locked;
}

interface ClipRef {
  trackId: string;
  clipId: string;
}

interface ClipMatch extends ClipRef {
  clip: Clip;
}

interface TimelineRange {
  startSec: number;
  endSec: number;
}

interface TransitionPickerContext {
  clipIds: string[];
  transitionId?: string;
  initialConfig?: TransitionConfig;
}

interface RemoveAttributesContext {
  clipIds: string[];
}

function resolveClipRefs(
  sequence: Sequence | null,
  clipIds: string[],
  options: { includeLockedTracks?: boolean; visualOnly?: boolean } = {},
): ClipRef[] {
  if (!sequence || clipIds.length === 0) {
    return [];
  }

  const requestedClipIds = new Set(clipIds);
  const refs: ClipRef[] = [];

  for (const track of sequence.tracks) {
    if (!options.includeLockedTracks && track.locked) {
      continue;
    }
    if (options.visualOnly && track.kind !== 'video' && track.kind !== 'overlay') {
      continue;
    }

    for (const clip of track.clips) {
      if (requestedClipIds.has(clip.id)) {
        refs.push({ trackId: track.id, clipId: clip.id });
      }
    }
  }

  return refs;
}

function resolveClipMatches(
  sequence: Sequence | null,
  clipIds: string[],
  options: { includeLockedTracks?: boolean; visualOnly?: boolean } = {},
): ClipMatch[] {
  if (!sequence || clipIds.length === 0) {
    return [];
  }

  const requestedClipIds = new Set(clipIds);
  const matches: ClipMatch[] = [];

  for (const track of sequence.tracks) {
    if (!options.includeLockedTracks && track.locked) continue;
    if (options.visualOnly && track.kind !== 'video' && track.kind !== 'overlay') continue;

    for (const clip of track.clips) {
      if (requestedClipIds.has(clip.id)) {
        matches.push({ trackId: track.id, clipId: clip.id, clip });
      }
    }
  }

  return matches;
}

function getClipTimelineRange(clip: Clip): TimelineRange {
  return {
    startSec: clip.place.timelineInSec,
    endSec: getClipTimelineEndSec(clip),
  };
}

function getSelectedOrPlayheadRange(
  sequence: Sequence | null,
  selectedClipIds: string[],
  currentTime: number,
): TimelineRange | null {
  if (!sequence) return null;

  const selectedMatches = resolveClipMatches(sequence, selectedClipIds);
  if (selectedMatches.length > 0) {
    const starts = selectedMatches.map(({ clip }) => clip.place.timelineInSec);
    const ends = selectedMatches.map(({ clip }) => getClipTimelineEndSec(clip));
    return { startSec: Math.min(...starts), endSec: Math.max(...ends) };
  }

  for (const track of sequence.tracks) {
    if (track.locked || track.muted || !track.visible) continue;

    const clip = track.clips.find((candidate) => {
      const range = getClipTimelineRange(candidate);
      return currentTime >= range.startSec && currentTime < range.endSec;
    });
    if (clip) {
      return getClipTimelineRange(clip);
    }
  }

  const duration = getSequenceDurationSec(sequence);
  return {
    startSec: Math.max(0, currentTime - PLAY_AROUND_PRE_ROLL_SEC),
    endSec: Math.min(duration, currentTime + PLAY_AROUND_POST_ROLL_SEC),
  };
}

function getNearestEditPoint(sequence: Sequence | null, currentTime: number): number | null {
  if (!sequence) return null;

  const editPoints: number[] = [];
  for (const track of sequence.tracks) {
    if (track.locked || track.muted || !track.visible) continue;

    for (const clip of track.clips) {
      editPoints.push(clip.place.timelineInSec, getClipTimelineEndSec(clip));
    }
  }

  if (editPoints.length === 0) {
    return null;
  }

  return editPoints.reduce((nearest, point) =>
    Math.abs(point - currentTime) < Math.abs(nearest - currentTime) ? point : nearest,
  );
}

function getSequenceDurationSec(sequence: Sequence): number {
  return sequence.tracks.reduce((duration, track) => {
    return Math.max(
      duration,
      ...track.clips.map((clip) => getClipTimelineEndSec(clip)),
      ...sequence.markers.map((marker) => marker.timeSec),
    );
  }, 0);
}

function getTransitionParams(config: TransitionConfig): Record<string, SimpleParamValue> {
  const params: Record<string, SimpleParamValue> = {
    duration: config.duration,
  };

  if (config.direction) {
    params.direction = config.direction;
  }
  if (config.zoomType) {
    params.zoom_type = config.zoomType;
  }

  return params;
}

function getTransitionConfigFromEffect(effect: Effect): TransitionConfig | undefined {
  if (
    effect.effectType !== 'cross_dissolve' &&
    effect.effectType !== 'fade' &&
    effect.effectType !== 'wipe' &&
    effect.effectType !== 'slide' &&
    effect.effectType !== 'zoom'
  ) {
    return undefined;
  }

  const rawDuration = effect.params.duration;
  const duration =
    typeof rawDuration === 'number' && Number.isFinite(rawDuration) ? rawDuration : 1;
  const config: TransitionConfig = { type: effect.effectType, duration };

  if (
    (effect.effectType === 'wipe' || effect.effectType === 'slide') &&
    (effect.params.direction === 'left' ||
      effect.params.direction === 'right' ||
      effect.params.direction === 'up' ||
      effect.params.direction === 'down')
  ) {
    config.direction = effect.params.direction;
  }

  if (
    effect.effectType === 'zoom' &&
    (effect.params.zoom_type === 'in' || effect.params.zoom_type === 'out')
  ) {
    config.zoomType = effect.params.zoom_type;
  }

  return config;
}

function getEffectSelectionKey(effect: Effect): string {
  if (typeof effect.effectType === 'object' && 'custom' in effect.effectType) {
    return `custom:${effect.effectType.custom}`;
  }
  return `type:${effect.effectType}`;
}

function getEffectSelectionLabel(effect: Effect): string {
  if (typeof effect.effectType === 'object' && 'custom' in effect.effectType) {
    return effect.effectType.custom;
  }
  return EFFECT_TYPE_LABELS[effect.effectType] ?? effect.effectType.replace(/_/g, ' ');
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

function resolveAvailablePreviewTextTrack(
  sequence: Sequence,
  timelineInSec: number,
  durationSec: number,
): Track | undefined {
  return sequence.tracks.find(
    (track) =>
      track.kind === 'video' &&
      !track.locked &&
      !trackHasOverlap(track, timelineInSec, durationSec),
  );
}

export function EditorView({ sequence, appVersion = '0.1.0' }: EditorViewProps): JSX.Element {
  const {
    selectedAssetId,
    assets,
    effects,
    executeCommand,
    selectAsset,
    proxyJobIdsByAssetId,
    generateAssetThumbnail,
    loadWaveformData,
    generateWaveformForAsset,
    ensureAudioPreviewForAsset,
  } = useProjectStore();
  const waveformUiCacheSize = useWaveformCacheStore((state) => state.cacheSize);
  const clearWaveformUiCache = useWaveformCacheStore((state) => state.clearCache);
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const { selectedClipIds, linkedSelectionEnabled, selectClip } = useTimelineStore();
  const activeTool = useEditorToolStore((state) => state.activeTool);
  const setActiveTool = useEditorToolStore((state) => state.setActiveTool);
  const effectsClipboard = useEditorToolStore((state) => state.effectsClipboard);
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
  const [showPasteAttributesDialog, setShowPasteAttributesDialog] = useState(false);
  const [removeAttributesContext, setRemoveAttributesContext] =
    useState<RemoveAttributesContext | null>(null);
  const [transitionPickerContext, setTransitionPickerContext] =
    useState<TransitionPickerContext | null>(null);

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
  const multicamSession = useMulticamSession({
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
    if (sequence && selectedClipIds.length === 1) {
      const selectedClipId = selectedClipIds[0];
      for (const track of sequence.tracks) {
        const clip = track.clips.find((candidate) => candidate.id === selectedClipId);
        if (clip) {
          pans.set(track.id, clip.audio?.pan ?? 0);
          break;
        }
      }
    }
    return pans;
  }, [mixerTrackStates, selectedClipIds, sequence]);

  const masterVolume = dbToLinear(mixerMasterState.volumeDb);
  const masterMuted = mixerMasterState.muted;
  const masterLevels: ChannelLevels = useMemo(
    () => ({
      left: mixerMasterState.levels.left,
      right: mixerMasterState.levels.right,
    }),
    [mixerMasterState.levels.left, mixerMasterState.levels.right],
  );
  const mixerVolumeCommitTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const mixerPanCommitTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const volumeTimers = mixerVolumeCommitTimersRef.current;
    const panTimers = mixerPanCommitTimersRef.current;
    return () => {
      for (const timer of volumeTimers.values()) {
        clearTimeout(timer);
      }
      for (const timer of panTimers.values()) {
        clearTimeout(timer);
      }
      volumeTimers.clear();
      panTimers.clear();
    };
  }, []);

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
      useToastStore.getState().addToast({
        message: 'Auto-duck applied to the selected music clip.',
        variant: 'success',
      });
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
    handleCaptionTrackLanguageChange,
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
    void commands.matchFrame({ timeSec: currentTime }).then((result) => {
      if (result.status !== 'ok') {
        return;
      }

      selectAsset(result.data.assetId);
      revealWorkspacePanel('source-monitor', 'left');
    });
  }, [currentTime, selectAsset]);

  // Reverse Match Frame: Shift+F — source monitor → timeline seek
  const handleReverseMatchFrame = useCallback(() => {
    void commands.reverseMatchFrame().then((result) => {
      if (result.status === 'ok') {
        usePlaybackStore.getState().seek(result.data.timelineSec);
        selectClip(result.data.clipId, false);
      }
    });
  }, [selectClip]);

  const handleToggleLoopRange = useCallback(() => {
    if (!sequence) return;

    const playback = usePlaybackStore.getState();
    if (playback.loopRange) {
      playback.clearLoopRange();
      playback.setLoop(false);
      return;
    }

    const range = getSelectedOrPlayheadRange(sequence, selectedClipIds, currentTime);
    if (!range || range.endSec <= range.startSec) return;

    playback.setLoopRange(range.startSec, range.endSec);
    playback.setLoop(true);
    if (currentTime < range.startSec || currentTime >= range.endSec) {
      playback.seek(range.startSec, 'loop-range-start');
    }
    playback.setIsPlaying(true, 'loop-range');
  }, [currentTime, selectedClipIds, sequence]);

  const handlePlayAroundEdit = useCallback(() => {
    if (!sequence) return;

    const duration = getSequenceDurationSec(sequence);
    if (duration <= 0) return;

    const editPoint = getNearestEditPoint(sequence, currentTime) ?? currentTime;
    const startSec = Math.max(0, editPoint - PLAY_AROUND_PRE_ROLL_SEC);
    const endSec = Math.min(duration, editPoint + PLAY_AROUND_POST_ROLL_SEC);
    if (endSec <= startSec) return;

    const playback = usePlaybackStore.getState();
    playback.playRangeOnce(startSec, endSec);
    playback.seek(startSec, 'play-around-edit-start');
    playback.setIsPlaying(true, 'play-around-edit');
  }, [currentTime, sequence]);

  const handleRevealSourceClip = useCallback(() => {
    if (!sequence) return;

    const selectedMatch = resolveClipMatches(sequence, selectedClipIds)[0];
    const playheadMatch =
      selectedMatch ??
      resolveClipMatches(
        sequence,
        sequence.tracks.flatMap((track) =>
          track.clips
            .filter((clip) => {
              const range = getClipTimelineRange(clip);
              return currentTime >= range.startSec && currentTime < range.endSec;
            })
            .map((clip) => clip.id),
        ),
      )[0];

    if (!playheadMatch) return;

    const { clip } = playheadMatch;
    const clipRange = getClipTimelineRange(clip);
    const sourceTime =
      currentTime >= clipRange.startSec && currentTime < clipRange.endSec
        ? getClipSourceTimeAtTimelineTime(clip, currentTime)
        : clip.range.sourceInSec;

    selectAsset(clip.assetId);
    revealWorkspacePanel('explorer', 'left');
    revealWorkspacePanel('source-monitor', 'left');
    void commands.setSourceAsset({ assetId: clip.assetId }).then((result) => {
      if (result.status === 'ok') {
        void commands.setSourcePlayhead({ timeSec: sourceTime });
      }
    });
  }, [currentTime, selectAsset, selectedClipIds, sequence]);

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

  const handleToggleClipEnabledForPalette = useCallback(() => {
    if (!sequence || selectedClipIds.length === 0) return;
    const clipRefs = resolveClipRefs(sequence, selectedClipIds);
    const promises = clipRefs.map((ref) => handleToggleClipEnabled(ref.clipId, ref.trackId));
    if (promises.length > 0) {
      Promise.all(promises).catch((error) => {
        logger.error('Failed to toggle clip enabled state', { error });
      });
    }
  }, [sequence, selectedClipIds, handleToggleClipEnabled]);

  const handleLinkSelectedClips = useCallback(() => {
    const clipRefs = resolveClipRefs(sequence, selectedClipIds);
    if (clipRefs.length < 2) return;
    void handleLinkClips(clipRefs.map((ref) => ref.clipId)).catch((error) => {
      logger.error('Failed to link selected clips', { error });
    });
  }, [handleLinkClips, selectedClipIds, sequence]);

  const handleUnlinkSelectedClips = useCallback(() => {
    const clipRefs = resolveClipRefs(sequence, selectedClipIds);
    if (clipRefs.length === 0) return;
    void handleUnlinkClips(clipRefs).catch((error) => {
      logger.error('Failed to unlink selected clips', { error });
    });
  }, [handleUnlinkClips, selectedClipIds, sequence]);

  const handleGroupSelectedClips = useCallback(() => {
    const clipRefs = resolveClipRefs(sequence, selectedClipIds);
    if (clipRefs.length < 2) return;
    void handleGroupClips(clipRefs.map((ref) => ref.clipId)).catch((error) => {
      logger.error('Failed to group selected clips', { error });
    });
  }, [handleGroupClips, selectedClipIds, sequence]);

  const handleCreateSynchronizedMulticamGroup = useCallback(() => {
    if (!sequence) {
      return;
    }

    const matches = resolveClipMatches(sequence, selectedClipIds, { visualOnly: true }).filter(
      ({ clip }) => !isTextClip(clip.assetId),
    );
    if (matches.length < 2) {
      useToastStore.getState().addToast({
        message: 'Select at least two visual clips to create a multicam group.',
        variant: 'warning',
      });
      return;
    }

    const sources: MulticamSyncClipSource[] = matches.map(({ clip, trackId }) => {
      const asset = assets.get(clip.assetId);
      return {
        clip,
        trackId,
        label: clip.label ?? asset?.name,
        color: clip.color,
        hasAudio: Boolean(asset?.audio),
      };
    });

    try {
      const result = createSynchronizedMulticamGroup({
        sequenceId: sequence.id,
        name: `Multicam ${matches.length} Angles`,
        method: 'manual',
        sources,
      });

      setMulticamGroup(result.group);
      useToastStore.getState().addToast({
        message:
          result.warnings.length > 0
            ? result.warnings[0]
            : `Created multicam group with ${result.group.angles.length} angles.`,
        variant: result.warnings.length > 0 ? 'warning' : 'success',
      });
    } catch (error) {
      logger.error('Failed to create multicam group', { error });
      useToastStore.getState().addToast({
        message: error instanceof Error ? error.message : 'Failed to create multicam group.',
        variant: 'warning',
      });
    }
  }, [assets, selectedClipIds, sequence]);

  const handleUngroupSelectedClips = useCallback(() => {
    const clipRefs = resolveClipRefs(sequence, selectedClipIds);
    if (clipRefs.length === 0) return;
    void handleUngroupClips(clipRefs).catch((error) => {
      logger.error('Failed to ungroup selected clips', { error });
    });
  }, [handleUngroupClips, selectedClipIds, sequence]);

  const handleOpenPasteAttributesForSelection = useCallback(() => {
    if (selectedClipIds.length === 0 || !effectsClipboard) {
      return;
    }
    setShowPasteAttributesDialog(true);
  }, [effectsClipboard, selectedClipIds.length]);

  const handleConfirmPasteAttributesForSelection = useCallback(
    (selection: AttributeSelection) => {
      setShowPasteAttributesDialog(false);
      void handlePasteAttributes(selectedClipIds, selection).catch((error) => {
        logger.error('Failed to paste attributes to selected clips', { error });
      });
    },
    [handlePasteAttributes, selectedClipIds],
  );

  const handleOpenRemoveAttributesForSelection = useCallback(() => {
    const clipRefs = resolveClipRefs(sequence, selectedClipIds);
    if (clipRefs.length === 0) return;
    setRemoveAttributesContext({ clipIds: clipRefs.map((ref) => ref.clipId) });
  }, [selectedClipIds, sequence]);

  const handleConfirmRemoveAttributesForSelection = useCallback(
    (result: RemoveAttributesResult) => {
      const clipIds = removeAttributesContext?.clipIds ?? [];
      setRemoveAttributesContext(null);

      if (!sequence || clipIds.length === 0) return;

      const selectedEffectKeys = new Set(result.effectIds);
      const clipRefs = resolveClipRefs(sequence, clipIds);

      void Promise.all(
        clipRefs.map((ref) => {
          const track = sequence.tracks.find((candidate) => candidate.id === ref.trackId);
          const clip = track?.clips.find((candidate) => candidate.id === ref.clipId);
          const effectIds =
            clip?.effects.filter((effectId) => {
              const effect = effects.get(effectId);
              return effect ? selectedEffectKeys.has(getEffectSelectionKey(effect)) : false;
            }) ?? [];

          return handleRemoveAttributes(ref.clipId, ref.trackId, effectIds, {
            resetTransform: result.resetTransform,
            resetOpacity: result.resetOpacity,
            resetBlendMode: result.resetBlendMode,
            resetSpeed: result.resetSpeed,
            resetAudio: result.resetAudio,
          });
        }),
      ).catch((error) => {
        logger.error('Failed to remove attributes from selected clips', { error });
      });
    },
    [effects, handleRemoveAttributes, removeAttributesContext, sequence],
  );

  const handleApplyEffectFromBrowser = useCallback(
    async (effectType: string) => {
      if (!sequence) return;

      const typedEffectType = effectType as EffectType;
      const clipRefs = resolveClipRefs(sequence, selectedClipIds, {
        visualOnly: !isAudioEffect(typedEffectType),
      });

      if (clipRefs.length === 0) {
        useToastStore.getState().addToast({
          variant: 'warning',
          message: isAudioEffect(typedEffectType)
            ? 'Select a clip to apply the audio effect.'
            : 'Select a visual clip to apply the effect.',
        });
        return;
      }

      try {
        for (const ref of clipRefs) {
          await executeCommand({
            type: 'AddEffect',
            payload: {
              sequenceId: sequence.id,
              trackId: ref.trackId,
              clipId: ref.clipId,
              effectType,
              params: {},
            },
          });
        }

        const effectLabel =
          typeof typedEffectType === 'string'
            ? (EFFECT_TYPE_LABELS[typedEffectType] ?? effectType)
            : effectType;

        useToastStore.getState().addToast({
          variant: 'success',
          message: `Applied ${effectLabel} to ${clipRefs.length} clip${clipRefs.length === 1 ? '' : 's'}.`,
        });
      } catch (error) {
        logger.error('Failed to apply effect from browser', { error, effectType });
        useToastStore.getState().addToast({
          variant: 'error',
          message: 'Failed to apply effect to selected clips.',
        });
      }
    },
    [executeCommand, selectedClipIds, sequence],
  );

  const handleApplyEffectPresetFromBrowser = useCallback(
    async (preset: VisualEffectPreset) => {
      if (!sequence) return;

      const clipRefs = resolveClipRefs(sequence, selectedClipIds, { visualOnly: true });
      if (clipRefs.length === 0) {
        useToastStore.getState().addToast({
          variant: 'warning',
          message: 'Select a visual clip to apply the preset.',
        });
        return;
      }

      try {
        for (const ref of clipRefs) {
          for (const effect of preset.effects) {
            const addEffectResult = await executeCommand({
              type: 'AddEffect',
              payload: {
                sequenceId: sequence.id,
                trackId: ref.trackId,
                clipId: ref.clipId,
                effectType: effect.effectType,
                params: effect.params,
              },
            });

            if (effect.defaultMask) {
              const effectId = addEffectResult.createdIds?.[0];
              if (!effectId) {
                throw new Error(`AddEffect did not return an effect id for ${effect.effectType}`);
              }

              await executeCommand({
                type: 'AddMask',
                payload: {
                  sequenceId: sequence.id,
                  trackId: ref.trackId,
                  clipId: ref.clipId,
                  effectId,
                  shape: effect.defaultMask.shape,
                  ...(effect.defaultMask.name ? { name: effect.defaultMask.name } : {}),
                  ...(typeof effect.defaultMask.feather === 'number'
                    ? { feather: effect.defaultMask.feather }
                    : {}),
                  ...(typeof effect.defaultMask.inverted === 'boolean'
                    ? { inverted: effect.defaultMask.inverted }
                    : {}),
                },
              });
            }
          }
        }

        useToastStore.getState().addToast({
          variant: 'success',
          message: `Applied ${preset.name} to ${clipRefs.length} clip${clipRefs.length === 1 ? '' : 's'}.`,
        });
      } catch (error) {
        logger.error('Failed to apply effect preset from browser', { error, presetId: preset.id });
        useToastStore.getState().addToast({
          variant: 'error',
          message: 'Failed to apply preset to selected clips.',
        });
      }
    },
    [executeCommand, selectedClipIds, sequence],
  );

  const handleApplySavedEffectPresetFromBrowser = useCallback(
    async (preset: EffectPreset) => {
      if (!sequence) return;

      const targetIsAudio = isAudioEffect(preset.effectType);
      const clipRefs = resolveClipRefs(sequence, selectedClipIds, { visualOnly: !targetIsAudio });
      if (clipRefs.length === 0) {
        useToastStore.getState().addToast({
          variant: 'warning',
          message: targetIsAudio
            ? 'Select a clip to apply the saved audio preset.'
            : 'Select a visual clip to apply the saved preset.',
        });
        return;
      }

      try {
        const keyframes =
          preset.keyframes && Object.keys(preset.keyframes).length > 0
            ? serializeEffectPresetKeyframes(preset.keyframes)
            : undefined;

        for (const ref of clipRefs) {
          await executeCommand({
            type: 'AddEffect',
            payload: {
              sequenceId: sequence.id,
              trackId: ref.trackId,
              clipId: ref.clipId,
              effectType: preset.effectType,
              params: preset.params,
              ...(keyframes ? { keyframes } : {}),
            },
          });
        }

        useToastStore.getState().addToast({
          variant: 'success',
          message: `Applied ${preset.name} to ${clipRefs.length} clip${clipRefs.length === 1 ? '' : 's'}.`,
        });
      } catch (error) {
        logger.error('Failed to apply saved effect preset from browser', {
          error,
          presetId: preset.id,
        });
        useToastStore.getState().addToast({
          variant: 'error',
          message: 'Failed to apply saved preset to selected clips.',
        });
      }
    },
    [executeCommand, selectedClipIds, sequence],
  );

  const applyTransitionToClipIds = useCallback(
    (clipIds: string[], config: TransitionConfig) => {
      const clipRefs = resolveClipRefs(sequence, clipIds, { visualOnly: true });
      if (!sequence || clipRefs.length === 0) return;

      void Promise.all(
        clipRefs.map((ref) =>
          executeCommand({
            type: 'AddEffect',
            payload: {
              sequenceId: sequence.id,
              trackId: ref.trackId,
              clipId: ref.clipId,
              effectType: config.type,
              params: getTransitionParams(config),
            },
          }),
        ),
      ).catch((error) => {
        logger.error('Failed to apply transition to clips', { error });
        useToastStore.getState().addToast({
          variant: 'error',
          message: 'Failed to apply transition to selected clips.',
        });
      });
    },
    [executeCommand, sequence],
  );

  const handleApplyDefaultTransitionToSelection = useCallback(() => {
    applyTransitionToClipIds(selectedClipIds, {
      type: DEFAULT_TRANSITION_TYPE,
      duration: DEFAULT_TRANSITION_DURATION_SEC,
    });
  }, [applyTransitionToClipIds, selectedClipIds]);

  const handleOpenTransitionPickerForSelection = useCallback(() => {
    const clipRefs = resolveClipRefs(sequence, selectedClipIds, { visualOnly: true });
    if (clipRefs.length === 0) return;
    setTransitionPickerContext({ clipIds: clipRefs.map((ref) => ref.clipId) });
  }, [selectedClipIds, sequence]);

  const handleOpenTransitionPickerForZone = useCallback(
    (_: string, clipBId: string) => {
      const match = resolveClipMatches(sequence, [clipBId], { visualOnly: true })[0];
      const transition = match ? getClipTransitionEffect(match.clip, effects) : undefined;

      setTransitionPickerContext({
        clipIds: [clipBId],
        transitionId: transition?.id,
        initialConfig: transition ? getTransitionConfigFromEffect(transition) : undefined,
      });
    },
    [effects, sequence],
  );

  const handleSelectTransition = useCallback(
    (config: TransitionConfig) => {
      const context = transitionPickerContext;
      const clipIds = context?.clipIds ?? [];
      setTransitionPickerContext(null);

      if (!sequence || clipIds.length === 0) return;

      if (!context?.transitionId) {
        applyTransitionToClipIds(clipIds, config);
        return;
      }

      const clipRefs = resolveClipRefs(sequence, clipIds, { visualOnly: true });
      if (clipRefs.length === 0) return;

      const previousType = context.initialConfig?.type;
      if (previousType && previousType !== config.type) {
        void (async () => {
          for (const ref of clipRefs) {
            await executeCommand({
              type: 'RemoveEffect',
              payload: {
                sequenceId: sequence.id,
                trackId: ref.trackId,
                clipId: ref.clipId,
                effectId: context.transitionId,
              },
            });
            await executeCommand({
              type: 'AddEffect',
              payload: {
                sequenceId: sequence.id,
                trackId: ref.trackId,
                clipId: ref.clipId,
                effectType: config.type,
                params: getTransitionParams(config),
              },
            });
          }
        })().catch((error) => {
          logger.error('Failed to replace transition', { error });
          useToastStore.getState().addToast({
            variant: 'error',
            message: 'Failed to replace transition.',
          });
        });
        return;
      }

      void executeCommand({
        type: 'UpdateEffect',
        payload: {
          effectId: context.transitionId,
          params: getTransitionParams(config),
        },
      }).catch((error) => {
        logger.error('Failed to update transition', { error });
        useToastStore.getState().addToast({
          variant: 'error',
          message: 'Failed to update transition.',
        });
      });
    },
    [applyTransitionToClipIds, executeCommand, sequence, transitionPickerContext],
  );

  // Command Palette
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
    onRevealSourceClip: handleRevealSourceClip,
    onToggleLoopRange: handleToggleLoopRange,
    onPlayAroundEdit: handlePlayAroundEdit,
    onCopyEffects: handleCopySelectedClipEffects,
    onPasteEffects: handlePasteEffectsToSelection,
    onPasteAttributes: handleOpenPasteAttributesForSelection,
    onRemoveAttributes: handleOpenRemoveAttributesForSelection,
    onApplyDefaultTransition: handleApplyDefaultTransitionToSelection,
    onChooseTransition: handleOpenTransitionPickerForSelection,
    onToggleClipEnabled: handleToggleClipEnabledForPalette,
    onLinkClips: handleLinkSelectedClips,
    onUnlinkClips: handleUnlinkSelectedClips,
    onGroupClips: handleGroupSelectedClips,
    onUngroupClips: handleUngroupSelectedClips,
    onCreateMulticamGroup: handleCreateSynchronizedMulticamGroup,
    onToggleMixer: handleToggleMixer,
    onAddText: () => setActiveTool('text'),
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
    onRevealSourceClip: handleRevealSourceClip,
    onToggleLoopRange: handleToggleLoopRange,
    onPlayAroundEdit: handlePlayAroundEdit,
    onCopyEffects: handleCopySelectedClipEffects,
    onPasteEffects: handlePasteEffectsToSelection,
    onPasteAttributes: handleOpenPasteAttributesForSelection,
    onToggleCommandPalette: commandPalette.isOpen ? commandPalette.close : commandPalette.open,
    onToggleClipEnabled: handleToggleClipEnabledForPalette,
    onLinkClips: handleLinkSelectedClips,
    onUnlinkClips: handleUnlinkSelectedClips,
    onGroupClips: handleGroupSelectedClips,
    onUngroupClips: handleUngroupSelectedClips,
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
      fileSize: selectedAsset.fileSize,
      importedAt: selectedAsset.importedAt,
      resolution: selectedAsset.video
        ? {
            width: selectedAsset.video.width,
            height: selectedAsset.video.height,
          }
        : undefined,
      video: selectedAsset.video,
      audio: selectedAsset.audio,
      proxyStatus: selectedAsset.proxyStatus,
      proxyUrl: selectedAsset.proxyUrl,
      proxyJobId: proxyJobIdsByAssetId[selectedAsset.id],
      thumbnailUrl: selectedAsset.thumbnailUrl,
      missing: selectedAsset.missing,
      relativePath: selectedAsset.relativePath,
      workspaceManaged: selectedAsset.workspaceManaged,
      tags: selectedAsset.tags,
    };
  }, [selectedAssetId, assets, proxyJobIdsByAssetId]);

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
        transform: clip.transform,
        motionKeyframes: clip.motionKeyframes,
        opacity: clip.opacity,
        sourceSize: asset?.video
          ? {
              width: asset.video.width,
              height: asset.video.height,
            }
          : undefined,
        canvasSize: sequence.format.canvas,
        blendMode: clip.blendMode,
        speed: clip.speed,
        reverse: clip.reverse,
        freezeFrame: clip.freezeFrame,
        timeRemap: clip.timeRemap,
        slowMotionInterpolation: clip.slowMotionInterpolation,
        hasTimeRemap: hasActiveTimeRemap(clip),
        audio: clip.audio,
      };
    }
    return undefined;
  }, [sequence, selectedClipIds, assets, effects]);

  const removeAttributeEffectEntries = useMemo(() => {
    if (!removeAttributesContext || !sequence) {
      return [];
    }

    const selectedKeys = new Set<string>();
    const entries: Array<{ id: string; label: string }> = [];
    const refs = resolveClipRefs(sequence, removeAttributesContext.clipIds);

    for (const ref of refs) {
      const track = sequence.tracks.find((candidate) => candidate.id === ref.trackId);
      const clip = track?.clips.find((candidate) => candidate.id === ref.clipId);
      if (!clip) continue;

      for (const effectId of clip.effects) {
        const effect = effects.get(effectId);
        if (!effect) continue;
        const key = getEffectSelectionKey(effect);
        if (selectedKeys.has(key)) continue;
        selectedKeys.add(key);
        entries.push({ id: key, label: getEffectSelectionLabel(effect) });
      }
    }

    return entries.sort((a, b) => a.label.localeCompare(b.label));
  }, [effects, removeAttributesContext, sequence]);

  // Blend mode operations
  const { setClipBlendMode } = useBlendMode();

  const handleClipBlendModeChange = useCallback(
    (clipId: string, trackId: string, blendMode: BlendMode) => {
      setClipBlendMode(trackId, clipId, blendMode);
    },
    [setClipBlendMode],
  );

  const handleClipTransformChange = useCallback(
    (clipId: string, trackId: string, transform: Transform) => {
      if (!sequence) {
        return;
      }

      void executeCommand({
        type: 'SetClipTransform',
        payload: {
          sequenceId: sequence.id,
          trackId,
          clipId,
          transform,
        },
      }).catch((error) => {
        logger.error('Failed to update clip transform from inspector', {
          error,
          sequenceId: sequence.id,
          trackId,
          clipId,
        });
      });
    },
    [executeCommand, sequence],
  );

  const handleClipOpacityChange = useCallback(
    (clipId: string, trackId: string, opacity: number) => {
      if (!sequence) {
        return;
      }

      void executeCommand({
        type: 'SetClipOpacity',
        payload: {
          sequenceId: sequence.id,
          trackId,
          clipId,
          opacity,
        },
      }).catch((error) => {
        logger.error('Failed to update clip opacity from inspector', {
          error,
          sequenceId: sequence.id,
          trackId,
          clipId,
        });
      });
    },
    [executeCommand, sequence],
  );

  const handleClipMotionKeyframesChange = useCallback(
    (clipId: string, trackId: string, keyframes: TransformKeyframe[]) => {
      if (!sequence) {
        return;
      }

      void executeCommand({
        type: 'SetClipMotionKeyframes',
        payload: {
          sequenceId: sequence.id,
          trackId,
          clipId,
          keyframes,
        },
      }).catch((error) => {
        logger.error('Failed to update clip motion keyframes from inspector', {
          error,
          sequenceId: sequence.id,
          trackId,
          clipId,
        });
      });
    },
    [executeCommand, sequence],
  );

  const handleTimeRemapChange = useCallback(
    (clipId: string, trackId: string, timeRemap: TimeRemapCurve) => {
      if (!sequence) {
        return;
      }

      void executeCommand({
        type: 'SetTimeRemap',
        payload: {
          sequenceId: sequence.id,
          trackId,
          clipId,
          timeRemap,
        },
      }).catch((error) => {
        logger.error('Failed to update clip time remap from inspector', {
          error,
          sequenceId: sequence.id,
          trackId,
          clipId,
        });
      });
    },
    [executeCommand, sequence],
  );

  const handleTimeRemapClear = useCallback(
    (clipId: string, trackId: string) => {
      if (!sequence) {
        return;
      }

      void executeCommand({
        type: 'ClearTimeRemap',
        payload: {
          sequenceId: sequence.id,
          trackId,
          clipId,
        },
      }).catch((error) => {
        logger.error('Failed to clear clip time remap from inspector', {
          error,
          sequenceId: sequence.id,
          trackId,
          clipId,
        });
      });
    },
    [executeCommand, sequence],
  );

  const handleSlowMotionInterpolationChange = useCallback(
    (clipId: string, trackId: string, interpolation: SlowMotionInterpolation) => {
      if (!sequence) {
        return;
      }

      void executeCommand({
        type: 'SetClipSlowMotionInterpolation',
        payload: {
          sequenceId: sequence.id,
          trackId,
          clipId,
          interpolation,
        },
      }).catch((error) => {
        logger.error('Failed to update clip slow-motion interpolation from inspector', {
          error,
          sequenceId: sequence.id,
          trackId,
          clipId,
          interpolation,
        });
      });
    },
    [executeCommand, sequence],
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
        textData: applyClipTransformToEditableTextData(clip, textData),
        transform: clip.transform,
        timelineInSec: clip.place.timelineInSec,
        durationSec: getClipTimelineDurationSec(clip),
      };
    }

    return undefined;
  }, [sequence, selectedClipIds, textClipDataById]);

  const selectedTextClipId = selectedTextClip?.id;
  const selectedCaptionId = selectedCaption?.id;

  useEffect(() => {
    if (!selectedTextClipId && !selectedCaptionId) {
      return;
    }

    revealWorkspacePanel('inspector', 'right');
  }, [selectedCaptionId, selectedTextClipId]);

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

  const onTextTransformChange = useCallback(
    (clipId: ClipId, transform: Transform): void => {
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

      void executeCommand({
        type: 'SetClipTransform',
        payload: {
          sequenceId: sequence.id,
          trackId,
          clipId,
          transform,
        },
      }).catch((error) => {
        logger.error('Failed to update text clip transform from inspector', {
          error,
          sequenceId: sequence.id,
          trackId,
          clipId,
        });
      });
    },
    [executeCommand, sequence],
  );

  const onTextTimingChange = useCallback(
    (clipId: ClipId, timing: { timelineInSec?: number; durationSec?: number }): void => {
      if (!sequence) {
        return;
      }

      let trackId: string | undefined;
      let selectedClip: Clip | undefined;
      for (const track of sequence.tracks) {
        const clip = track.clips.find((candidate) => candidate.id === clipId);
        if (clip) {
          trackId = track.id;
          selectedClip = clip;
          break;
        }
      }

      if (!trackId || !selectedClip) {
        return;
      }

      void (async () => {
        if (timing.timelineInSec !== undefined) {
          await executeCommand({
            type: 'MoveClip',
            payload: {
              sequenceId: sequence.id,
              trackId,
              clipId,
              newTimelineIn: Math.max(0, timing.timelineInSec),
            },
          });
        }

        if (timing.durationSec !== undefined) {
          const speed =
            Number.isFinite(selectedClip.speed) && selectedClip.speed > 0 ? selectedClip.speed : 1;
          const newSourceOut =
            selectedClip.range.sourceInSec + Math.max(0.01, timing.durationSec) * speed;
          await executeCommand({
            type: 'TrimClip',
            payload: {
              sequenceId: sequence.id,
              trackId,
              clipId,
              newSourceOut,
            },
          });
        }
      })().catch((error) => {
        logger.error('Failed to update text clip timing from inspector', {
          error,
          sequenceId: sequence.id,
          trackId,
          clipId,
          timing,
        });
      });
    },
    [executeCommand, sequence],
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
      } else if (property === 'style' && value && typeof value === 'object') {
        handleUpdateCaption({
          sequenceId: sequence.id,
          trackId,
          captionId,
          style: normalizeCaptionStyle(value as Record<string, unknown>),
        });
      } else if (property === 'position') {
        const normalizedPosition = parseCaptionPositionValue(value);
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
    setActiveTool('text');
  }, [setActiveTool]);

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

  const handlePreviewTextPlacementCommit = useCallback(
    async ({ content, position }: TextPlacementCommitPayload) => {
      if (!sequence) {
        return;
      }

      const trimmedContent = content.trim();
      if (!trimmedContent) {
        return;
      }

      const timelineIn = Math.max(0, currentTime);
      const duration = DEFAULT_PREVIEW_TEXT_DURATION_SEC;
      let trackId = resolveAvailablePreviewTextTrack(sequence, timelineIn, duration)?.id;

      try {
        if (!trackId) {
          const sequenceSnapshot =
            useProjectStore.getState().sequences.get(sequence.id) ?? sequence;
          const createTrackResult = await executeCommand({
            type: 'CreateTrack',
            payload: {
              sequenceId: sequence.id,
              kind: 'video',
              name: getNextTrackName(sequenceSnapshot, 'video'),
              position: getDefaultTrackInsertPosition(sequenceSnapshot, 'video'),
            },
          });

          trackId = createTrackResult.createdIds[0];
        }

        if (!trackId) {
          throw new Error('Text track could not be created');
        }

        const textData = createTextClipData(trimmedContent);
        textData.position = position;
        textData.style = {
          ...textData.style,
          backgroundPadding: 0,
        };
        textData.outline = { color: '#000000', width: 2 };
        textData.shadow = { color: '#000000', offsetX: 2, offsetY: 2, blur: 3 };

        const createdClipId = await addTextClip({
          trackId,
          timelineIn,
          duration,
          textData,
        });

        if (createdClipId) {
          selectClip(createdClipId);
          revealWorkspacePanel('inspector', 'right');
          setActiveTool('select');
        }
      } catch (error) {
        logger.error('Failed to create preview text clip', {
          error,
          sequenceId: sequence.id,
          timelineIn,
        });
        useToastStore.getState().addToast({
          variant: 'error',
          message: 'Text clip could not be created.',
        });
      }
    },
    [addTextClip, currentTime, executeCommand, selectClip, sequence, setActiveTool],
  );

  // Audio Mixer handlers - connected to store and Web Audio
  const handleMixerVolumeChange = useCallback(
    (trackId: string, volumeDb: number) => {
      setTrackVolume(trackId, volumeDb);
      if (sequence?.id) {
        const timerKey = `${sequence.id}:${trackId}`;
        const timers = mixerVolumeCommitTimersRef.current;
        const existingTimer = timers.get(timerKey);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
          timers.delete(timerKey);
          void executeCommand({
            type: 'SetTrackVolume',
            payload: {
              sequenceId: sequence.id,
              trackId,
              volume: Math.max(0, Math.min(2, dbToLinear(volumeDb))),
            },
          });
        }, MIXER_VOLUME_COMMAND_DEBOUNCE_MS);
        timers.set(timerKey, timer);
      }
      logger.debug('Volume change', { trackId, volumeDb });
    },
    [executeCommand, sequence?.id, setTrackVolume],
  );

  const handleMixerPanChange = useCallback(
    (trackId: string, pan: number) => {
      setTrackPan(trackId, pan);
      if (!sequence || selectedClipIds.length !== 1) {
        return;
      }

      const selectedClipId = selectedClipIds[0];
      const track = sequence.tracks.find((candidate) => candidate.id === trackId);
      const clip = track?.clips.find((candidate) => candidate.id === selectedClipId);
      if (!clip) {
        return;
      }

      const timerKey = `${sequence.id}:${trackId}:${clip.id}`;
      const timers = mixerPanCommitTimersRef.current;
      const existingTimer = timers.get(timerKey);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        timers.delete(timerKey);
        void handleClipAudioUpdate({
          sequenceId: sequence.id,
          trackId,
          clipId: clip.id,
          pan: Math.max(-1, Math.min(1, pan)),
        });
      }, MIXER_PAN_COMMAND_DEBOUNCE_MS);
      timers.set(timerKey, timer);
    },
    [handleClipAudioUpdate, selectedClipIds, sequence, setTrackPan],
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
      onCaptionTrackLanguageChange: handleCaptionTrackLanguageChange,
      onTrackReorder: handleTrackReorder,
      onAddText: handleOpenAddText,
      getTextClipData: (clipId) => textClipDataById.get(clipId),
      onCloseGap: handleCloseGap,
      onCloseAllGaps: handleCloseAllGaps,
      onRippleDeleteClips: handleRippleDeleteClips,
      onCreateMulticamGroup: handleCreateSynchronizedMulticamGroup,
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
      showTransitionZones: true,
      onTransitionZoneClick: handleOpenTransitionPickerForZone,
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
      handleCaptionTrackLanguageChange,
      handleTrackReorder,
      handleOpenAddText,
      handleCloseGap,
      handleCloseAllGaps,
      handleRippleDeleteClips,
      handleCreateSynchronizedMulticamGroup,
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
      handleOpenTransitionPickerForZone,
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
      onClipTransformChange: handleClipTransformChange,
      onClipOpacityChange: handleClipOpacityChange,
      onClipMotionKeyframesChange: handleClipMotionKeyframesChange,
      onClipSpeedChange: handleSetClipSpeed,
      onClipReverseToggle: handleReverseClip,
      onFreezeFrame: handleCreateFreezeFrame,
      onTimeRemapChange: handleTimeRemapChange,
      onTimeRemapClear: handleTimeRemapClear,
      onSlowMotionInterpolationChange: handleSlowMotionInterpolationChange,
      onClipAudioChange: (clipId, trackId, patch) => {
        if (!sequence?.id) return;
        void handleClipAudioUpdate({
          sequenceId: sequence.id,
          trackId,
          clipId,
          volumeDb: patch.volumeDb,
          pan: patch.pan,
          muted: patch.muted,
          fadeInSec: patch.fadeInSec,
          fadeOutSec: patch.fadeOutSec,
          audioRole: patch.audioRole,
          audioTags: patch.audioTags,
        });
      },
      onTextDataChange: onTextDataChange,
      onTextTransformChange,
      onTextTimingChange,
      onCaptionChange: onCaptionChange,
      onEffectChange: handleEffectChange,
      onEffectToggle: handleEffectToggle,
      onEffectRemove: handleEffectRemove,
      onGenerateThumbnail: generateAssetThumbnail,
      onLoadWaveformData: loadWaveformData,
      onGenerateWaveform: generateWaveformForAsset,
      onEnsureAudioPreview: ensureAudioPreviewForAsset,
      waveformUiCacheSize,
      onClearWaveformUiCache: clearWaveformUiCache,
    }),
    [
      inspectorClip,
      inspectorAsset,
      selectedTextClip,
      selectedCaption,
      handleClipBlendModeChange,
      handleClipTransformChange,
      handleClipOpacityChange,
      handleClipMotionKeyframesChange,
      handleSetClipSpeed,
      handleReverseClip,
      handleCreateFreezeFrame,
      handleTimeRemapChange,
      handleTimeRemapClear,
      handleSlowMotionInterpolationChange,
      sequence?.id,
      handleClipAudioUpdate,
      onTextDataChange,
      onTextTransformChange,
      onTextTimingChange,
      onCaptionChange,
      handleEffectChange,
      handleEffectToggle,
      handleEffectRemove,
      generateAssetThumbnail,
      loadWaveformData,
      generateWaveformForAsset,
      ensureAudioPreviewForAsset,
      waveformUiCacheSize,
      clearWaveformUiCache,
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
        textPlacementModeActive: activeTool === 'text',
        onTextPlacementCommit: handlePreviewTextPlacementCommit,
        multicamGroup: multicamSession.group ?? multicamGroup,
        multicamCurrentTimeSec: currentTime,
        multicamRecording: multicamSession.isRecording,
        onMulticamAngleSwitch: multicamSession.switchAngle,
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
        onSourceInsertEdit: handleInsertEditFromSource,
        onSourceOverwriteEdit: handleOverwriteEditFromSource,
        onEffectSelect: handleApplyEffectFromBrowser,
        onEffectPresetSelect: handleApplyEffectPresetFromBrowser,
        onSavedEffectPresetSelect: handleApplySavedEffectPresetFromBrowser,
      }),
    [
      sequence,
      isFullscreen,
      captureSnapshot,
      activeTool,
      handlePreviewTextPlacementCommit,
      multicamSession.group,
      multicamSession.isRecording,
      multicamSession.switchAngle,
      multicamGroup,
      currentTime,
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
      handleInsertEditFromSource,
      handleOverwriteEditFromSource,
      handleApplyEffectFromBrowser,
      handleApplyEffectPresetFromBrowser,
      handleApplySavedEffectPresetFromBrowser,
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

      <PasteAttributesDialog
        isOpen={showPasteAttributesDialog}
        clipboardData={effectsClipboard}
        onConfirm={handleConfirmPasteAttributesForSelection}
        onCancel={() => setShowPasteAttributesDialog(false)}
      />

      <RemoveAttributesDialog
        isOpen={removeAttributesContext !== null}
        clipEffects={removeAttributeEffectEntries}
        onConfirm={handleConfirmRemoveAttributesForSelection}
        onCancel={() => setRemoveAttributesContext(null)}
      />

      {transitionPickerContext && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          role="dialog"
          aria-modal="true"
        >
          <div className="h-[520px] w-[520px] max-h-[80vh] max-w-[92vw] rounded-lg border border-editor-border bg-editor-surface shadow-xl">
            <TransitionPicker
              initialConfig={transitionPickerContext.initialConfig}
              onSelect={handleSelectTransition}
              onCancel={() => setTransitionPickerContext(null)}
            />
          </div>
        </div>
      )}

      {/* Command Palette */}
      <CommandPalette palette={commandPalette} />
    </>
  );
}
