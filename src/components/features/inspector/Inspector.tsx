/**
 * Inspector Component
 *
 * Property inspector panel for selected clips and assets.
 * Displays and allows editing of properties.
 * Supports text clips with the TextInspector sub-component.
 */

import { useMemo, useState, useCallback, useEffect } from 'react';
import { TextInspector } from './TextInspector';
import type { SelectedTextClip } from './TextInspector';
import {
  AssetInspectorPanel,
  CaptionInspectorPanel,
  ClipInspectorPanel,
  InspectorEmptyState,
} from './InspectorPanels';
import { useEffectPresets } from '@/hooks/useEffectPresets';
import { useEffectParamDefs } from '@/hooks/useEffectParamDefs';
import type {
  BlendMode,
  Effect,
  EffectId,
  CaptionStyle,
  CaptionPosition,
  AssetKind,
  AudioInfo,
  TextClipData,
  ClipId,
  AudioSettings,
  ProxyStatus,
  SimpleParamValue,
  SlowMotionInterpolation,
  Transform,
  TransformKeyframe,
  TimeRemapCurve,
  VideoInfo,
  WaveformData,
} from '@/types';

// =============================================================================
// Types
// =============================================================================

/** Clip selection data */
export interface SelectedClip {
  id: string;
  sequenceId?: string;
  name: string;
  assetId: string;
  range: {
    sourceInSec: number;
    sourceOutSec: number;
  };
  place: {
    trackId: string;
    timelineInSec: number;
    durationSec?: number;
  };
  /** Effects applied to this clip */
  effects?: Effect[];
  /** Clip transform in normalized canvas coordinates */
  transform?: Transform;
  /** Optional clip motion transform keyframes */
  motionKeyframes?: TransformKeyframe[];
  /** Clip opacity (0.0-1.0) */
  opacity?: number;
  /** Source media dimensions used for fit/fill transform presets */
  sourceSize?: {
    width: number;
    height: number;
  };
  /** Sequence canvas dimensions used for fit/fill transform presets */
  canvasSize?: {
    width: number;
    height: number;
  };
  /** Clip blend mode (default: 'normal') */
  blendMode?: BlendMode;
  /** Playback speed (1.0 = normal) */
  speed?: number;
  /** Whether clip plays in reverse */
  reverse?: boolean;
  /** Whether clip is a freeze frame */
  freezeFrame?: boolean;
  /** Optional variable-speed time remap curve */
  timeRemap?: TimeRemapCurve | null;
  /** Slow-motion interpolation mode */
  slowMotionInterpolation?: SlowMotionInterpolation;
  /** Whether clip has time remap active */
  hasTimeRemap?: boolean;
  /** Clip-level audio settings */
  audio?: AudioSettings;
}

/** Asset selection data */
export interface SelectedAsset {
  id: string;
  name: string;
  kind: AssetKind | 'graphics';
  uri: string;
  durationSec?: number;
  fileSize?: number;
  importedAt?: string;
  resolution?: {
    width: number;
    height: number;
  };
  video?: VideoInfo;
  audio?: AudioInfo;
  proxyStatus?: ProxyStatus;
  proxyUrl?: string;
  proxyJobId?: string;
  thumbnailUrl?: string;
  missing?: boolean;
  relativePath?: string;
  workspaceManaged?: boolean;
  tags?: string[];
}

/** Caption selection data */
export interface SelectedCaption {
  id: string;
  text: string;
  startSec: number;
  endSec: number;
  style?: CaptionStyle;
  position?: CaptionPosition;
}

/** Inspector component props */
export interface InspectorProps {
  /** Currently selected clip */
  selectedClip?: SelectedClip;
  /** Currently selected text clip */
  selectedTextClip?: SelectedTextClip;
  /** Currently selected asset */
  selectedAsset?: SelectedAsset;
  /** Currently selected caption */
  selectedCaption?: SelectedCaption;
  /** Callback when clip property changes */
  onClipChange?: (clipId: string, property: string, value: unknown) => void;
  /** Callback when clip blend mode changes */
  onClipBlendModeChange?: (clipId: string, trackId: string, blendMode: BlendMode) => void;
  /** Callback when clip transform changes */
  onClipTransformChange?: (clipId: string, trackId: string, transform: Transform) => void;
  /** Callback when clip opacity changes */
  onClipOpacityChange?: (clipId: string, trackId: string, opacity: number) => void;
  /** Callback when clip motion keyframes change */
  onClipMotionKeyframesChange?: (
    clipId: string,
    trackId: string,
    keyframes: TransformKeyframe[],
  ) => void;
  /** Callback when clip speed changes */
  onClipSpeedChange?: (clipId: string, trackId: string, speed: number, reverse: boolean) => void;
  /** Callback when reverse is toggled */
  onClipReverseToggle?: (clipId: string, trackId: string) => void;
  /** Callback when freeze frame is requested */
  onFreezeFrame?: (clipId: string, trackId: string) => void;
  /** Callback when clip time remap changes */
  onTimeRemapChange?: (clipId: string, trackId: string, timeRemap: TimeRemapCurve) => void;
  /** Callback when clip time remap is cleared */
  onTimeRemapClear?: (clipId: string, trackId: string) => void;
  /** Callback when slow-motion interpolation changes */
  onSlowMotionInterpolationChange?: (
    clipId: string,
    trackId: string,
    interpolation: SlowMotionInterpolation,
  ) => void;
  /** Callback when clip-level audio settings change */
  onClipAudioChange?: (
    clipId: string,
    trackId: string,
    patch: Partial<AudioSettings>,
  ) => void | Promise<void>;
  /** Callback when text clip data changes */
  onTextDataChange?: (clipId: ClipId, textData: TextClipData) => void;
  /** Callback when text clip transform changes */
  onTextTransformChange?: (clipId: ClipId, transform: Transform) => void;
  /** Callback when text clip timing changes */
  onTextTimingChange?: (
    clipId: ClipId,
    timing: { timelineInSec?: number; durationSec?: number },
  ) => void;
  /** Callback when caption property changes */
  onCaptionChange?: (captionId: string, property: string, value: unknown) => void;
  /** Callback when an effect is toggled */
  onEffectToggle?: (clipId: string, effectId: EffectId, enabled: boolean) => void;
  /** Callback when effect params change */
  onEffectChange?: (effectId: EffectId, params: Record<string, SimpleParamValue>) => void;
  /** Callback when an effect is removed */
  onEffectRemove?: (clipId: string, effectId: EffectId) => void;
  /** Callback when add effect is requested */
  onAddEffect?: (clipId: string) => void;
  /** Callback when thumbnail generation is requested */
  onGenerateThumbnail?: (assetId: string) => Promise<string | null>;
  /** Callback when cached waveform peak data should be loaded */
  onLoadWaveformData?: (assetId: string) => Promise<WaveformData | null>;
  /** Callback when waveform peak generation is requested */
  onGenerateWaveform?: (assetId: string) => Promise<WaveformData | null>;
  /** Callback when browser-decodable audio preview generation is requested */
  onEnsureAudioPreview?: (assetId: string) => Promise<string | null>;
  /** Number of frontend waveform image cache entries */
  waveformUiCacheSize?: number;
  /** Callback when frontend waveform image cache should be cleared */
  onClearWaveformUiCache?: () => void;
  /** Whether the inspector is read-only */
  readOnly?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function Inspector({
  selectedClip,
  selectedTextClip,
  selectedAsset,
  selectedCaption,
  // onClipChange is reserved for future clip property editing
  onClipBlendModeChange,
  onClipTransformChange,
  onClipOpacityChange,
  onClipMotionKeyframesChange,
  onClipSpeedChange,
  onClipReverseToggle,
  onFreezeFrame,
  onTimeRemapChange,
  onTimeRemapClear,
  onSlowMotionInterpolationChange,
  onClipAudioChange,
  onTextDataChange,
  onTextTransformChange,
  onTextTimingChange,
  onCaptionChange,
  onEffectToggle,
  onEffectChange,
  onEffectRemove,
  onAddEffect,
  onGenerateThumbnail,
  onLoadWaveformData,
  onGenerateWaveform,
  onEnsureAudioPreview,
  waveformUiCacheSize = 0,
  onClearWaveformUiCache,
  readOnly = false,
}: InspectorProps): JSX.Element {
  // ===========================================================================
  // State
  // ===========================================================================

  const [selectedEffectId, setSelectedEffectId] = useState<EffectId | undefined>();
  const [presetSaveTarget, setPresetSaveTarget] = useState<Effect | null>(null);
  const [presetSaveError, setPresetSaveError] = useState<string | null>(null);
  const [isSavingPreset, setIsSavingPreset] = useState(false);
  const { savePreset } = useEffectPresets({ autoLoad: false });

  // ===========================================================================
  // Computed Values
  // ===========================================================================

  const clipDuration = useMemo(() => {
    if (!selectedClip) return null;
    const explicitDuration = selectedClip.place.durationSec ?? 0;
    if (Number.isFinite(explicitDuration) && explicitDuration > 0) {
      return explicitDuration;
    }

    const safeSpeed =
      typeof selectedClip.speed === 'number' && selectedClip.speed > 0 ? selectedClip.speed : 1;
    return (selectedClip.range.sourceOutSec - selectedClip.range.sourceInSec) / safeSpeed;
  }, [selectedClip]);

  const selectedEffect = useMemo(() => {
    if (!selectedClip || !selectedEffectId) {
      return undefined;
    }

    return selectedClip.effects?.find((effect) => effect.id === selectedEffectId);
  }, [selectedClip, selectedEffectId]);
  const selectedEffectParamDefs = useEffectParamDefs(selectedEffect ?? null);

  useEffect(() => {
    if (!selectedEffectId) {
      return;
    }

    const selectedEffectStillExists = selectedClip?.effects?.some(
      (effect) => effect.id === selectedEffectId,
    );
    if (!selectedEffectStillExists) {
      setSelectedEffectId(undefined);
    }
  }, [selectedClip, selectedEffectId]);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleEffectSelect = useCallback((effectId: EffectId) => {
    setSelectedEffectId(effectId);
  }, []);

  const handleEffectToggle = useCallback(
    (effectId: EffectId, enabled: boolean) => {
      if (selectedClip && onEffectToggle) {
        onEffectToggle(selectedClip.id, effectId, enabled);
      }
    },
    [selectedClip, onEffectToggle],
  );

  const handleEffectRemove = useCallback(
    (effectId: EffectId) => {
      if (selectedClip && onEffectRemove) {
        onEffectRemove(selectedClip.id, effectId);
      }
      // Clear selection if removed effect was selected
      if (effectId === selectedEffectId) {
        setSelectedEffectId(undefined);
      }
    },
    [selectedClip, onEffectRemove, selectedEffectId],
  );

  const handleAddEffect = useCallback(() => {
    if (selectedClip && onAddEffect) {
      onAddEffect(selectedClip.id);
    }
  }, [selectedClip, onAddEffect]);

  const handleEffectChange = useCallback(
    (effectId: EffectId, params: Record<string, SimpleParamValue>) => {
      onEffectChange?.(effectId, params);
    },
    [onEffectChange],
  );

  const handleOpenSavePreset = useCallback(() => {
    if (!selectedEffect) {
      return;
    }

    setPresetSaveError(null);
    setPresetSaveTarget(selectedEffect);
  }, [selectedEffect]);

  const handleCloseSavePreset = useCallback(() => {
    if (isSavingPreset) {
      return;
    }

    setPresetSaveError(null);
    setPresetSaveTarget(null);
  }, [isSavingPreset]);

  const handleConfirmSavePreset = useCallback(
    async (name: string, description: string | undefined) => {
      if (!presetSaveTarget) {
        return;
      }

      try {
        setIsSavingPreset(true);
        setPresetSaveError(null);
        await savePreset(
          name,
          description,
          presetSaveTarget.effectType,
          presetSaveTarget.params,
          Object.keys(presetSaveTarget.keyframes ?? {}).length > 0
            ? presetSaveTarget.keyframes
            : undefined,
        );
        setPresetSaveTarget(null);
      } catch (error) {
        setPresetSaveError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsSavingPreset(false);
      }
    },
    [presetSaveTarget, savePreset],
  );

  const handleBlendModeChange = useCallback(
    (mode: BlendMode) => {
      if (selectedClip && onClipBlendModeChange) {
        onClipBlendModeChange(selectedClip.id, selectedClip.place.trackId, mode);
      }
    },
    [selectedClip, onClipBlendModeChange],
  );

  const handleClipTransformChange = useCallback(
    (transform: Transform) => {
      if (selectedClip && onClipTransformChange) {
        onClipTransformChange(selectedClip.id, selectedClip.place.trackId, transform);
      }
    },
    [selectedClip, onClipTransformChange],
  );

  const handleClipOpacityChange = useCallback(
    (opacity: number) => {
      if (selectedClip && onClipOpacityChange) {
        onClipOpacityChange(selectedClip.id, selectedClip.place.trackId, opacity);
      }
    },
    [selectedClip, onClipOpacityChange],
  );

  const handleClipMotionKeyframesChange = useCallback(
    (keyframes: TransformKeyframe[]) => {
      if (selectedClip && onClipMotionKeyframesChange) {
        onClipMotionKeyframesChange(selectedClip.id, selectedClip.place.trackId, keyframes);
      }
    },
    [selectedClip, onClipMotionKeyframesChange],
  );

  const handleClipAudioChange = useCallback(
    (patch: Partial<AudioSettings>) => {
      if (selectedClip && onClipAudioChange) {
        void onClipAudioChange(selectedClip.id, selectedClip.place.trackId, patch);
      }
    },
    [selectedClip, onClipAudioChange],
  );

  // ===========================================================================
  // Render Empty State
  // ===========================================================================

  if (!selectedClip && !selectedTextClip && !selectedAsset && !selectedCaption) {
    return <InspectorEmptyState />;
  }

  // ===========================================================================
  // Render Text Clip Properties (Priority over regular clips)
  // ===========================================================================

  if (selectedTextClip) {
    return (
      <TextInspector
        selectedTextClip={selectedTextClip}
        onTextDataChange={onTextDataChange ?? (() => {})}
        onTextTransformChange={onTextTransformChange}
        onTextTimingChange={onTextTimingChange}
        readOnly={readOnly}
      />
    );
  }

  // ===========================================================================
  // Render Caption Properties
  // ===========================================================================

  if (selectedCaption) {
    return (
      <CaptionInspectorPanel
        selectedCaption={selectedCaption}
        onCaptionChange={onCaptionChange}
        readOnly={readOnly}
      />
    );
  }

  // ===========================================================================
  // Render Clip Properties
  // ===========================================================================

  if (selectedClip) {
    return (
      <ClipInspectorPanel
        selectedClip={selectedClip}
        clipDuration={clipDuration ?? 0}
        readOnly={readOnly}
        canChangeBlendMode={Boolean(onClipBlendModeChange)}
        canChangeTransform={Boolean(onClipTransformChange)}
        canChangeOpacity={Boolean(onClipOpacityChange)}
        canChangeMotionKeyframes={Boolean(onClipMotionKeyframesChange)}
        canChangeAudio={Boolean(onClipAudioChange)}
        canEditEffects={Boolean(onEffectChange)}
        selectedEffectId={selectedEffectId}
        selectedEffect={selectedEffect}
        selectedEffectParamDefs={selectedEffectParamDefs}
        presetSaveTarget={presetSaveTarget}
        presetSaveError={presetSaveError}
        isSavingPreset={isSavingPreset}
        onBlendModeChange={handleBlendModeChange}
        onTransformChange={handleClipTransformChange}
        onOpacityChange={handleClipOpacityChange}
        onMotionKeyframesChange={handleClipMotionKeyframesChange}
        onClipAudioChange={handleClipAudioChange}
        onClipSpeedChange={onClipSpeedChange}
        onClipReverseToggle={onClipReverseToggle}
        onFreezeFrame={onFreezeFrame}
        onTimeRemapChange={onTimeRemapChange}
        onTimeRemapClear={onTimeRemapClear}
        onSlowMotionInterpolationChange={onSlowMotionInterpolationChange}
        onSelectEffect={handleEffectSelect}
        onToggleEffect={onEffectToggle ? handleEffectToggle : undefined}
        onRemoveEffect={onEffectRemove ? handleEffectRemove : undefined}
        onAddEffect={onAddEffect ? handleAddEffect : undefined}
        onEffectChange={handleEffectChange}
        onOpenSavePreset={handleOpenSavePreset}
        onConfirmSavePreset={handleConfirmSavePreset}
        onCloseSavePreset={handleCloseSavePreset}
      />
    );
  }

  // ===========================================================================
  // Render Asset Properties
  // ===========================================================================

  if (selectedAsset) {
    return (
      <AssetInspectorPanel
        selectedAsset={selectedAsset}
        onGenerateThumbnail={onGenerateThumbnail}
        onLoadWaveformData={onLoadWaveformData}
        onGenerateWaveform={onGenerateWaveform}
        onEnsureAudioPreview={onEnsureAudioPreview}
        waveformUiCacheSize={waveformUiCacheSize}
        onClearWaveformUiCache={onClearWaveformUiCache}
        readOnly={readOnly}
      />
    );
  }

  return <></>;
}
