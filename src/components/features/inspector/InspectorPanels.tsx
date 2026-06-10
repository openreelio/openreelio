import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Clock,
  Database,
  FileText,
  Film,
  Gauge,
  HardDrive,
  Image as ImageIcon,
  Info,
  Italic,
  Maximize,
  Music,
  Palette,
  RefreshCw,
  Square,
  Type,
  Underline,
  XCircle,
  Zap,
} from 'lucide-react';
import { formatDuration, formatFileSize } from '@/utils/formatters';
import {
  captionColorToHex,
  getCaptionFontWeightNumber,
  normalizeCaptionPosition,
  normalizeCaptionStyle,
  parseCaptionHexColor,
} from '@/utils/captionStyle';
import { EffectsList, SaveEffectPresetDialog } from '../effects';
import { BlendModePicker } from '../effects/BlendModePicker';
import { EffectInspector } from '../effects/EffectInspector';
import type {
  BlendMode,
  CaptionColor,
  CaptionPosition,
  CaptionStyle,
  Effect,
  EffectId,
  ParamDef,
  SimpleParamValue,
  SlowMotionInterpolation,
  TextAlignment,
  TimeRemapCurve,
  TimeRemapKeyframe,
  Transform,
  TransformKeyframe,
  Ratio,
  WaveformData,
  AudioSettings,
  AudioRole,
} from '@/types';
import type { SelectedAsset, SelectedCaption, SelectedClip } from './Inspector';

function getAssetIcon(kind: SelectedAsset['kind']): JSX.Element {
  switch (kind) {
    case 'video':
      return <Film className="w-4 h-4" />;
    case 'audio':
      return <Music className="w-4 h-4" />;
    case 'image':
      return <ImageIcon className="w-4 h-4" />;
    case 'graphics':
      return <FileText className="w-4 h-4" />;
    default:
      return <FileText className="w-4 h-4" />;
  }
}

function formatRatioDecimal(ratio: Ratio | undefined, suffix: string): string {
  if (!ratio || ratio.den === 0) return 'Unknown';

  const value = ratio.num / ratio.den;
  if (!Number.isFinite(value)) return 'Unknown';

  const formatted = Number.isInteger(value)
    ? value.toFixed(0)
    : value.toFixed(3).replace(/0+$/, '');
  return `${formatted} ${suffix}`;
}

function formatBitrate(bitsPerSecond: number | undefined): string | undefined {
  if (!bitsPerSecond || bitsPerSecond <= 0) return undefined;

  if (bitsPerSecond >= 1_000_000) {
    return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
  }

  return `${Math.round(bitsPerSecond / 1_000)} Kbps`;
}

function formatChannels(channels: number | undefined): string | undefined {
  if (!channels || channels <= 0) return undefined;
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  return `${channels} channels`;
}

function formatImportedAt(importedAt: string | undefined): string | undefined {
  if (!importedAt) return undefined;

  const date = new Date(importedAt);
  if (Number.isNaN(date.getTime())) return importedAt;

  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function parseAudioTags(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(',')
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function formatProxyStatus(status: SelectedAsset['proxyStatus']): string | undefined {
  switch (status) {
    case 'notNeeded':
      return 'Automatic';
    case 'pending':
      return 'Preparing media';
    case 'generating':
      return 'Optimizing media';
    case 'ready':
      return 'Optimized';
    case 'failed':
      return 'Optimization failed';
    default:
      return undefined;
  }
}

function SpeedInput({
  speed,
  reverse,
  clipId,
  trackId,
  onClipSpeedChange,
  disabled,
}: {
  speed: number;
  reverse: boolean;
  clipId: string;
  trackId: string;
  onClipSpeedChange?: (clipId: string, trackId: string, speed: number, reverse: boolean) => void;
  disabled?: boolean;
}) {
  const [localValue, setLocalValue] = useState(() => Math.round((speed || 1) * 100));

  useEffect(() => {
    setLocalValue(Math.round((speed || 1) * 100));
  }, [speed, clipId, trackId]);

  const commit = useCallback(() => {
    if (
      Number.isFinite(localValue) &&
      localValue >= 10 &&
      localValue <= 10000 &&
      onClipSpeedChange
    ) {
      onClipSpeedChange(clipId, trackId, localValue / 100, reverse);
      return;
    }

    setLocalValue(Math.round((speed || 1) * 100));
  }, [localValue, clipId, trackId, reverse, speed, onClipSpeedChange]);

  return (
    <input
      data-testid="speed-input"
      type="number"
      min={10}
      max={10000}
      step={10}
      className="w-24 bg-editor-input bg-opacity-50 border border-editor-border rounded px-2 py-1 text-sm text-editor-text text-right focus:border-primary-500 focus:ring-1 focus:ring-primary-500 focus:outline-none"
      value={localValue}
      onChange={(e) => setLocalValue(Number(e.target.value))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
      disabled={disabled}
    />
  );
}

const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4] as const;
const SLOW_MOTION_INTERPOLATION_OPTIONS: Array<{
  value: SlowMotionInterpolation;
  label: string;
}> = [
  { value: 'nearest', label: 'Nearest' },
  { value: 'frameBlend', label: 'Frame Blend' },
  { value: 'motionCompensated', label: 'Motion Compensated' },
];

type TimeRemapPreset = 'ramp-up' | 'ramp-down' | 'speed-punch';

function getSourceDurationSec(selectedClip: SelectedClip): number {
  const duration = selectedClip.range.sourceOutSec - selectedClip.range.sourceInSec;
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}

function getEditableClipDurationSec(selectedClip: SelectedClip, clipDuration: number): number {
  if (Number.isFinite(clipDuration) && clipDuration > 0) {
    return clipDuration;
  }

  const sourceDuration = getSourceDurationSec(selectedClip);
  const speed = selectedClip.speed && selectedClip.speed > 0 ? selectedClip.speed : 1;
  return Math.max(0.1, sourceDuration / speed);
}

function buildLinearTimeRemap(selectedClip: SelectedClip, clipDuration: number): TimeRemapCurve {
  const duration = getEditableClipDurationSec(selectedClip, clipDuration);
  return {
    keyframes: [
      {
        timelineTime: 0,
        sourceTime: selectedClip.range.sourceInSec,
        interpolation: 'linear',
      },
      {
        timelineTime: duration,
        sourceTime: selectedClip.range.sourceOutSec,
        interpolation: 'linear',
      },
    ],
  };
}

function buildTimeRemapPreset(
  selectedClip: SelectedClip,
  clipDuration: number,
  preset: TimeRemapPreset,
): TimeRemapCurve {
  const duration = getEditableClipDurationSec(selectedClip, clipDuration);
  const sourceStart = selectedClip.range.sourceInSec;
  const sourceDuration = getSourceDurationSec(selectedClip);
  const sourceAt = (ratio: number) => sourceStart + sourceDuration * ratio;

  if (preset === 'ramp-up') {
    return {
      keyframes: [
        { timelineTime: 0, sourceTime: sourceAt(0), interpolation: 'linear' },
        { timelineTime: duration * 0.5, sourceTime: sourceAt(0.35), interpolation: 'linear' },
        { timelineTime: duration, sourceTime: sourceAt(1), interpolation: 'linear' },
      ],
    };
  }

  if (preset === 'ramp-down') {
    return {
      keyframes: [
        { timelineTime: 0, sourceTime: sourceAt(0), interpolation: 'linear' },
        { timelineTime: duration * 0.5, sourceTime: sourceAt(0.65), interpolation: 'linear' },
        { timelineTime: duration, sourceTime: sourceAt(1), interpolation: 'linear' },
      ],
    };
  }

  return {
    keyframes: [
      { timelineTime: 0, sourceTime: sourceAt(0), interpolation: 'linear' },
      { timelineTime: duration * 0.3, sourceTime: sourceAt(0.2), interpolation: 'linear' },
      { timelineTime: duration * 0.7, sourceTime: sourceAt(0.8), interpolation: 'linear' },
      { timelineTime: duration, sourceTime: sourceAt(1), interpolation: 'linear' },
    ],
  };
}

function normalizeTimeRemapKeyframes(keyframes: TimeRemapKeyframe[]): TimeRemapKeyframe[] {
  return keyframes
    .filter(
      (keyframe) =>
        Number.isFinite(keyframe.timelineTime) &&
        keyframe.timelineTime >= 0 &&
        Number.isFinite(keyframe.sourceTime) &&
        keyframe.sourceTime >= 0,
    )
    .sort((a, b) => a.timelineTime - b.timelineTime);
}

function TimeRemapEditor({
  selectedClip,
  clipDuration,
  readOnly,
  onTimeRemapChange,
  onTimeRemapClear,
}: {
  selectedClip: SelectedClip;
  clipDuration: number;
  readOnly: boolean;
  onTimeRemapChange?: (keyframes: TimeRemapCurve) => void;
  onTimeRemapClear?: () => void;
}) {
  const activeCurve =
    selectedClip.timeRemap && selectedClip.timeRemap.keyframes.length >= 2
      ? selectedClip.timeRemap
      : null;
  const keyframes = activeCurve?.keyframes ?? [];

  const commitKeyframes = useCallback(
    (nextKeyframes: TimeRemapKeyframe[]) => {
      const normalized = normalizeTimeRemapKeyframes(nextKeyframes);
      if (normalized.length >= 2) {
        onTimeRemapChange?.({ keyframes: normalized });
      }
    },
    [onTimeRemapChange],
  );

  const updateKeyframe = useCallback(
    (index: number, patch: Partial<TimeRemapKeyframe>) => {
      if (!activeCurve) return;
      commitKeyframes(
        activeCurve.keyframes.map((keyframe, keyframeIndex) =>
          keyframeIndex === index ? { ...keyframe, ...patch } : keyframe,
        ),
      );
    },
    [activeCurve, commitKeyframes],
  );

  const addKeyframe = useCallback(() => {
    const curve = activeCurve ?? buildLinearTimeRemap(selectedClip, clipDuration);
    const duration = getEditableClipDurationSec(selectedClip, clipDuration);
    const sourceDuration = getSourceDurationSec(selectedClip);
    const midpoint: TimeRemapKeyframe = {
      timelineTime: duration * 0.5,
      sourceTime: selectedClip.range.sourceInSec + sourceDuration * 0.5,
      interpolation: 'linear',
    };
    commitKeyframes([...curve.keyframes, midpoint]);
  }, [activeCurve, clipDuration, commitKeyframes, selectedClip]);

  const removeKeyframe = useCallback(
    (index: number) => {
      if (!activeCurve || activeCurve.keyframes.length <= 2) return;
      commitKeyframes(activeCurve.keyframes.filter((_, keyframeIndex) => keyframeIndex !== index));
    },
    [activeCurve, commitKeyframes],
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Ramp Up', preset: 'ramp-up' as const },
          { label: 'Ramp Down', preset: 'ramp-down' as const },
          { label: 'Speed Punch', preset: 'speed-punch' as const },
        ].map((item) => (
          <button
            key={item.preset}
            type="button"
            className="px-2 py-1.5 rounded border border-editor-border bg-editor-input bg-opacity-50 text-xs text-editor-text hover:bg-opacity-80 disabled:opacity-50"
            onClick={() =>
              onTimeRemapChange?.(buildTimeRemapPreset(selectedClip, clipDuration, item.preset))
            }
            disabled={readOnly || !onTimeRemapChange}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between text-xs text-editor-text-muted">
        <span data-testid="time-remap-keyframe-count">
          {activeCurve ? `${keyframes.length} speed points` : 'No speed ramp'}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-primary-400 hover:text-primary-300 disabled:opacity-50"
            onClick={addKeyframe}
            disabled={readOnly || !onTimeRemapChange}
          >
            Add Point
          </button>
          <button
            type="button"
            className="text-editor-text-muted hover:text-editor-text disabled:opacity-50"
            onClick={onTimeRemapClear}
            disabled={readOnly || !activeCurve || !onTimeRemapClear}
          >
            Clear
          </button>
        </div>
      </div>

      {activeCurve && (
        <div className="space-y-2" data-testid="time-remap-editor">
          <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 text-[11px] uppercase tracking-wide text-editor-text-muted">
            <span>Timeline</span>
            <span>Source</span>
            <span>Mode</span>
            <span />
          </div>
          {keyframes.map((keyframe, index) => (
            <div
              key={`${index}-${keyframe.timelineTime}-${keyframe.sourceTime}`}
              className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center"
            >
              <input
                type="number"
                min={0}
                step={0.1}
                defaultValue={Number(keyframe.timelineTime.toFixed(3))}
                className="min-w-0 bg-editor-input bg-opacity-50 border border-editor-border rounded px-2 py-1 text-xs text-editor-text"
                aria-label={`Speed point ${index + 1} timeline time`}
                onBlur={(event) =>
                  updateKeyframe(index, { timelineTime: Number(event.currentTarget.value) })
                }
                disabled={readOnly || !onTimeRemapChange}
              />
              <input
                type="number"
                min={0}
                step={0.1}
                defaultValue={Number(keyframe.sourceTime.toFixed(3))}
                className="min-w-0 bg-editor-input bg-opacity-50 border border-editor-border rounded px-2 py-1 text-xs text-editor-text"
                aria-label={`Speed point ${index + 1} source time`}
                onBlur={(event) =>
                  updateKeyframe(index, { sourceTime: Number(event.currentTarget.value) })
                }
                disabled={readOnly || !onTimeRemapChange}
              />
              <select
                className="min-w-0 bg-editor-input bg-opacity-50 border border-editor-border rounded px-2 py-1 text-xs text-editor-text"
                value={keyframe.interpolation === 'hold' ? 'hold' : 'linear'}
                aria-label={`Speed point ${index + 1} interpolation`}
                onChange={(event) =>
                  updateKeyframe(index, {
                    interpolation: event.currentTarget.value === 'hold' ? 'hold' : 'linear',
                  })
                }
                disabled={readOnly || !onTimeRemapChange}
              >
                <option value="linear">Linear</option>
                <option value="hold">Hold</option>
              </select>
              <button
                type="button"
                className="px-2 py-1 rounded border border-editor-border text-xs text-editor-text-muted hover:text-editor-text disabled:opacity-50"
                onClick={() => removeKeyframe(index)}
                disabled={readOnly || !onTimeRemapChange || keyframes.length <= 2}
                aria-label={`Remove speed point ${index + 1}`}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const DEFAULT_CLIP_TRANSFORM: Transform = {
  position: { x: 0.5, y: 0.5 },
  scale: { x: 1, y: 1 },
  rotationDeg: 0,
  anchor: { x: 0.5, y: 0.5 },
};

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function finiteOrFallback(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizedToPercent(value: number): number {
  return Math.round(value * 1000) / 10;
}

function percentToNormalized(value: number): number {
  return value / 100;
}

function getSafeClipTransform(transform: Transform | undefined): Transform {
  const positionX = transform?.position.x;
  const positionY = transform?.position.y;
  const scaleX = transform?.scale.x;
  const scaleY = transform?.scale.y;
  const rotationDeg = transform?.rotationDeg;
  const anchorX = transform?.anchor.x;
  const anchorY = transform?.anchor.y;

  return {
    position: {
      x: finiteOrFallback(positionX, DEFAULT_CLIP_TRANSFORM.position.x),
      y: finiteOrFallback(positionY, DEFAULT_CLIP_TRANSFORM.position.y),
    },
    scale: {
      x: finiteOrFallback(scaleX, DEFAULT_CLIP_TRANSFORM.scale.x),
      y: finiteOrFallback(scaleY, DEFAULT_CLIP_TRANSFORM.scale.y),
    },
    rotationDeg: finiteOrFallback(rotationDeg, DEFAULT_CLIP_TRANSFORM.rotationDeg),
    anchor: {
      x: finiteOrFallback(anchorX, DEFAULT_CLIP_TRANSFORM.anchor.x),
      y: finiteOrFallback(anchorY, DEFAULT_CLIP_TRANSFORM.anchor.y),
    },
  };
}

function getFillScale(selectedClip: SelectedClip): number {
  const source = selectedClip.sourceSize;
  const canvas = selectedClip.canvasSize;

  if (
    !source ||
    !canvas ||
    source.width <= 0 ||
    source.height <= 0 ||
    canvas.width <= 0 ||
    canvas.height <= 0
  ) {
    return 1;
  }

  const containScale = Math.min(canvas.width / source.width, canvas.height / source.height);
  const coverScale = Math.max(canvas.width / source.width, canvas.height / source.height);
  if (!Number.isFinite(containScale) || containScale <= 0 || !Number.isFinite(coverScale)) {
    return 1;
  }

  return Math.round((coverScale / containScale) * 1000) / 1000;
}

function scaledTransform(transform: Transform, scale: number): Transform {
  return {
    ...transform,
    scale: {
      x: Math.max(0.01, transform.scale.x * scale),
      y: Math.max(0.01, transform.scale.y * scale),
    },
  };
}

function motionKeyframe(timeOffset: number, transform: Transform): TransformKeyframe {
  return {
    timeOffset,
    transform,
    interpolation: 'linear',
  };
}

function buildMotionPresetKeyframes(
  selectedClip: SelectedClip,
  durationSec: number,
  preset: 'zoomIn' | 'zoomOut' | 'kenBurns',
): TransformKeyframe[] {
  const duration = Math.max(0.1, durationSec);
  const base = getSafeClipTransform(selectedClip.transform);

  if (preset === 'zoomIn') {
    return [motionKeyframe(0, base), motionKeyframe(duration, scaledTransform(base, 1.2))];
  }

  if (preset === 'zoomOut') {
    return [motionKeyframe(0, scaledTransform(base, 1.2)), motionKeyframe(duration, base)];
  }

  const fillScale = Math.max(1.15, getFillScale(selectedClip));
  const start: Transform = {
    ...base,
    position: { x: 0.42, y: 0.5 },
    scale: { x: fillScale, y: fillScale },
  };
  const end: Transform = {
    ...base,
    position: { x: 0.58, y: 0.5 },
    scale: { x: fillScale, y: fillScale },
  };
  return [motionKeyframe(0, start), motionKeyframe(duration, end)];
}

function TransformNumberInput({
  label,
  value,
  min,
  max,
  step,
  unit,
  disabled,
  testId,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  disabled: boolean;
  testId: string;
  onCommit: (value: number) => void;
}): JSX.Element {
  const [localValue, setLocalValue] = useState(() => String(value));

  useEffect(() => {
    setLocalValue(String(value));
  }, [value]);

  const commit = useCallback(() => {
    const parsed = Number(localValue);
    if (!Number.isFinite(parsed)) {
      setLocalValue(String(value));
      return;
    }

    const nextValue = clampNumber(parsed, min, max);
    setLocalValue(String(nextValue));
    onCommit(nextValue);
  }, [localValue, max, min, onCommit, value]);

  return (
    <div className="flex items-center justify-between gap-3">
      <label className="text-xs text-editor-text-muted" htmlFor={testId}>
        {label}
      </label>
      <div className="flex items-center gap-1">
        <input
          id={testId}
          data-testid={testId}
          type="number"
          min={min}
          max={max}
          step={step}
          className="w-20 rounded border border-editor-border bg-editor-input px-2 py-1 text-right text-xs text-editor-text focus:border-primary-500 focus:outline-none disabled:opacity-50"
          value={localValue}
          onChange={(event) => setLocalValue(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commit();
            }
          }}
          disabled={disabled}
        />
        <span className="w-5 text-[11px] text-editor-text-muted">{unit}</span>
      </div>
    </div>
  );
}

function ClipTransformControls({
  selectedClip,
  clipDuration,
  readOnly,
  canChangeTransform,
  canChangeMotionKeyframes,
  onTransformChange,
  onMotionKeyframesChange,
}: {
  selectedClip: SelectedClip;
  clipDuration: number;
  readOnly: boolean;
  canChangeTransform: boolean;
  canChangeMotionKeyframes: boolean;
  onTransformChange: (transform: Transform) => void;
  onMotionKeyframesChange: (keyframes: TransformKeyframe[]) => void;
}): JSX.Element {
  const transform = getSafeClipTransform(selectedClip.transform);
  const disabled = readOnly || !canChangeTransform;
  const motionDisabled = readOnly || !canChangeMotionKeyframes;
  const keyframeCount = selectedClip.motionKeyframes?.length ?? 0;

  const commitTransform = useCallback(
    (nextTransform: Transform) => {
      onTransformChange(nextTransform);
    },
    [onTransformChange],
  );

  const updateTransform = useCallback(
    (patch: Partial<Transform>) => {
      commitTransform({
        ...transform,
        ...patch,
      });
    },
    [commitTransform, transform],
  );

  const resetTransform = useCallback(() => {
    commitTransform(DEFAULT_CLIP_TRANSFORM);
  }, [commitTransform]);

  const fillTransform = useCallback(() => {
    const fillScale = getFillScale(selectedClip);
    commitTransform({
      ...DEFAULT_CLIP_TRANSFORM,
      scale: { x: fillScale, y: fillScale },
    });
  }, [commitTransform, selectedClip]);

  return (
    <div className="mt-4 pt-4 border-t border-editor-border" data-testid="clip-transform-section">
      <h4 className="text-xs font-semibold text-editor-text-muted mb-3 flex items-center gap-2">
        <Maximize className="w-3 h-3" />
        Transform
      </h4>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <TransformNumberInput
          label="Position X"
          testId="clip-position-x-input"
          value={normalizedToPercent(transform.position.x)}
          min={-200}
          max={300}
          step={0.1}
          unit="%"
          disabled={disabled}
          onCommit={(value) =>
            updateTransform({
              position: { ...transform.position, x: percentToNormalized(value) },
            })
          }
        />
        <TransformNumberInput
          label="Position Y"
          testId="clip-position-y-input"
          value={normalizedToPercent(transform.position.y)}
          min={-200}
          max={300}
          step={0.1}
          unit="%"
          disabled={disabled}
          onCommit={(value) =>
            updateTransform({
              position: { ...transform.position, y: percentToNormalized(value) },
            })
          }
        />
        <TransformNumberInput
          label="Scale X"
          testId="clip-scale-x-input"
          value={normalizedToPercent(transform.scale.x)}
          min={1}
          max={1000}
          step={0.1}
          unit="%"
          disabled={disabled}
          onCommit={(value) =>
            updateTransform({
              scale: { ...transform.scale, x: percentToNormalized(value) },
            })
          }
        />
        <TransformNumberInput
          label="Scale Y"
          testId="clip-scale-y-input"
          value={normalizedToPercent(transform.scale.y)}
          min={1}
          max={1000}
          step={0.1}
          unit="%"
          disabled={disabled}
          onCommit={(value) =>
            updateTransform({
              scale: { ...transform.scale, y: percentToNormalized(value) },
            })
          }
        />
        <TransformNumberInput
          label="Rotation"
          testId="clip-rotation-input"
          value={Math.round(transform.rotationDeg * 10) / 10}
          min={-360}
          max={360}
          step={0.1}
          unit="deg"
          disabled={disabled}
          onCommit={(value) => updateTransform({ rotationDeg: value })}
        />
        <TransformNumberInput
          label="Anchor X"
          testId="clip-anchor-x-input"
          value={normalizedToPercent(transform.anchor.x)}
          min={0}
          max={100}
          step={0.1}
          unit="%"
          disabled={disabled}
          onCommit={(value) =>
            updateTransform({
              anchor: { ...transform.anchor, x: percentToNormalized(value) },
            })
          }
        />
        <TransformNumberInput
          label="Anchor Y"
          testId="clip-anchor-y-input"
          value={normalizedToPercent(transform.anchor.y)}
          min={0}
          max={100}
          step={0.1}
          unit="%"
          disabled={disabled}
          onCommit={(value) =>
            updateTransform({
              anchor: { ...transform.anchor, y: percentToNormalized(value) },
            })
          }
        />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <button
          type="button"
          data-testid="clip-fit-button"
          className="rounded border border-editor-border bg-editor-input bg-opacity-50 px-2 py-1.5 text-xs font-medium text-editor-text-muted transition-colors hover:bg-opacity-80 disabled:opacity-50"
          onClick={resetTransform}
          disabled={disabled}
        >
          Fit
        </button>
        <button
          type="button"
          data-testid="clip-fill-button"
          className="rounded border border-editor-border bg-editor-input bg-opacity-50 px-2 py-1.5 text-xs font-medium text-editor-text-muted transition-colors hover:bg-opacity-80 disabled:opacity-50"
          onClick={fillTransform}
          disabled={disabled}
        >
          Fill
        </button>
        <button
          type="button"
          data-testid="clip-reset-transform-button"
          className="rounded border border-editor-border bg-editor-input bg-opacity-50 px-2 py-1.5 text-xs font-medium text-editor-text-muted transition-colors hover:bg-opacity-80 disabled:opacity-50"
          onClick={resetTransform}
          disabled={disabled}
        >
          Reset
        </button>
      </div>
      <div className="mt-4 border-t border-editor-border pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-editor-text-muted">Motion Presets</span>
          <span
            className="text-[11px] text-editor-text-muted"
            data-testid="clip-motion-keyframe-count"
          >
            {keyframeCount} keyframes
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            data-testid="clip-motion-zoom-in-button"
            className="rounded border border-editor-border bg-editor-input bg-opacity-50 px-2 py-1.5 text-xs font-medium text-editor-text-muted transition-colors hover:bg-opacity-80 disabled:opacity-50"
            onClick={() =>
              onMotionKeyframesChange(
                buildMotionPresetKeyframes(selectedClip, clipDuration, 'zoomIn'),
              )
            }
            disabled={motionDisabled}
          >
            Zoom In
          </button>
          <button
            type="button"
            data-testid="clip-motion-zoom-out-button"
            className="rounded border border-editor-border bg-editor-input bg-opacity-50 px-2 py-1.5 text-xs font-medium text-editor-text-muted transition-colors hover:bg-opacity-80 disabled:opacity-50"
            onClick={() =>
              onMotionKeyframesChange(
                buildMotionPresetKeyframes(selectedClip, clipDuration, 'zoomOut'),
              )
            }
            disabled={motionDisabled}
          >
            Zoom Out
          </button>
          <button
            type="button"
            data-testid="clip-motion-ken-burns-button"
            className="rounded border border-editor-border bg-editor-input bg-opacity-50 px-2 py-1.5 text-xs font-medium text-editor-text-muted transition-colors hover:bg-opacity-80 disabled:opacity-50"
            onClick={() =>
              onMotionKeyframesChange(
                buildMotionPresetKeyframes(selectedClip, clipDuration, 'kenBurns'),
              )
            }
            disabled={motionDisabled}
          >
            Ken Burns
          </button>
          <button
            type="button"
            data-testid="clip-motion-clear-button"
            className="rounded border border-editor-border bg-editor-input bg-opacity-50 px-2 py-1.5 text-xs font-medium text-editor-text-muted transition-colors hover:bg-opacity-80 disabled:opacity-50"
            onClick={() => onMotionKeyframesChange([])}
            disabled={motionDisabled || keyframeCount === 0}
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}

interface PropertyRowProps {
  label: string;
  value: string;
  testId?: string;
  icon?: JSX.Element;
}

function PropertyRow({ label, value, testId, icon }: PropertyRowProps): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-editor-border last:border-b-0 min-w-0">
      <span className="text-editor-text-muted text-sm flex items-center gap-2 shrink-0">
        {icon}
        {label}
      </span>
      <span
        data-testid={testId}
        className="text-editor-text text-sm font-medium text-right truncate min-w-0"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

export function InspectorEmptyState(): JSX.Element {
  return (
    <div
      data-testid="inspector"
      role="complementary"
      aria-label="Properties inspector"
      className="flex flex-col items-center justify-center h-full p-4 text-center"
    >
      <Info className="w-12 h-12 text-editor-text-muted opacity-50 mb-3" />
      <p className="text-editor-text-muted text-sm">No selection</p>
      <p className="text-editor-text-muted text-xs mt-1">
        Select a clip or asset to view properties
      </p>
    </div>
  );
}

export interface ClipInspectorPanelProps {
  selectedClip: SelectedClip;
  clipDuration: number;
  readOnly: boolean;
  canChangeBlendMode: boolean;
  canChangeTransform: boolean;
  canChangeOpacity: boolean;
  canChangeMotionKeyframes: boolean;
  canChangeAudio: boolean;
  canEditEffects: boolean;
  selectedEffectId?: EffectId;
  selectedEffect?: Effect;
  selectedEffectParamDefs: ParamDef[];
  presetSaveTarget: Effect | null;
  presetSaveError: string | null;
  isSavingPreset: boolean;
  onBlendModeChange: (mode: BlendMode) => void;
  onTransformChange: (transform: Transform) => void;
  onOpacityChange: (opacity: number) => void;
  onMotionKeyframesChange: (keyframes: TransformKeyframe[]) => void;
  onClipAudioChange: (patch: Partial<AudioSettings>) => void;
  onClipSpeedChange?: (clipId: string, trackId: string, speed: number, reverse: boolean) => void;
  onClipReverseToggle?: (clipId: string, trackId: string) => void;
  onFreezeFrame?: (clipId: string, trackId: string) => void;
  onTimeRemapChange?: (clipId: string, trackId: string, timeRemap: TimeRemapCurve) => void;
  onTimeRemapClear?: (clipId: string, trackId: string) => void;
  onSlowMotionInterpolationChange?: (
    clipId: string,
    trackId: string,
    interpolation: SlowMotionInterpolation,
  ) => void;
  onSelectEffect: (effectId: EffectId) => void;
  onToggleEffect?: (effectId: EffectId, enabled: boolean) => void;
  onRemoveEffect?: (effectId: EffectId) => void;
  onAddEffect?: () => void;
  onEffectChange: (effectId: EffectId, params: Record<string, SimpleParamValue>) => void;
  onOpenSavePreset: () => void;
  onConfirmSavePreset: (name: string, description: string | undefined) => void | Promise<void>;
  onCloseSavePreset: () => void;
}

export function ClipInspectorPanel({
  selectedClip,
  clipDuration,
  readOnly,
  canChangeBlendMode,
  canChangeTransform,
  canChangeOpacity,
  canChangeMotionKeyframes,
  canChangeAudio,
  canEditEffects,
  selectedEffectId,
  selectedEffect,
  selectedEffectParamDefs,
  presetSaveTarget,
  presetSaveError,
  isSavingPreset,
  onBlendModeChange,
  onTransformChange,
  onOpacityChange,
  onMotionKeyframesChange,
  onClipAudioChange,
  onClipSpeedChange,
  onClipReverseToggle,
  onFreezeFrame,
  onTimeRemapChange,
  onTimeRemapClear,
  onSlowMotionInterpolationChange,
  onSelectEffect,
  onToggleEffect,
  onRemoveEffect,
  onAddEffect,
  onEffectChange,
  onOpenSavePreset,
  onConfirmSavePreset,
  onCloseSavePreset,
}: ClipInspectorPanelProps): JSX.Element {
  return (
    <div
      data-testid="inspector"
      role="complementary"
      aria-label="Properties inspector"
      className="p-4"
    >
      <h3 className="text-sm font-semibold text-editor-text mb-4 flex items-center gap-2">
        <Film className="w-4 h-4 text-primary-500" />
        Clip Properties
      </h3>

      <div className="space-y-1">
        <PropertyRow label="Name" value={selectedClip.name} testId="clip-name" />
        <PropertyRow
          label="Duration"
          value={`${clipDuration.toFixed(2)}s`}
          testId="clip-duration"
          icon={<Clock className="w-3 h-3" />}
        />
        <PropertyRow
          label="In Point"
          value={formatDuration(selectedClip.range.sourceInSec)}
          testId="clip-in-point"
        />
        <PropertyRow
          label="Out Point"
          value={formatDuration(selectedClip.range.sourceOutSec)}
          testId="clip-out-point"
        />
        <PropertyRow
          label="Timeline Position"
          value={formatDuration(selectedClip.place.timelineInSec)}
          testId="clip-timeline-position"
        />
      </div>

      <div className="mt-4 pt-4 border-t border-editor-border">
        <BlendModePicker
          value={selectedClip.blendMode ?? 'normal'}
          onChange={onBlendModeChange}
          disabled={readOnly || !canChangeBlendMode}
          label="Blend Mode"
          grouped
          compact
        />
        <div className="mt-3">
          <TransformNumberInput
            label="Opacity"
            testId="clip-opacity-input"
            value={normalizedToPercent(selectedClip.opacity ?? 1)}
            min={0}
            max={100}
            step={1}
            unit="%"
            disabled={readOnly || !canChangeOpacity}
            onCommit={(value) => onOpacityChange(percentToNormalized(value))}
          />
        </div>
      </div>

      <ClipTransformControls
        selectedClip={selectedClip}
        clipDuration={clipDuration}
        readOnly={readOnly}
        canChangeTransform={canChangeTransform}
        canChangeMotionKeyframes={canChangeMotionKeyframes}
        onTransformChange={onTransformChange}
        onMotionKeyframesChange={onMotionKeyframesChange}
      />

      <div className="mt-4 pt-4 border-t border-editor-border">
        <h4 className="text-xs font-semibold text-editor-text-muted mb-3 flex items-center gap-2">
          <Music className="w-3 h-3" />
          Audio
        </h4>
        <div className="space-y-3">
          <NumberField
            label="Gain"
            testId="clip-audio-gain-input"
            value={selectedClip.audio?.volumeDb ?? 0}
            min={-60}
            max={6}
            step={0.5}
            unit="dB"
            disabled={readOnly || !canChangeAudio}
            onChange={(value) => onClipAudioChange({ volumeDb: value })}
          />
          <NumberField
            label="Pan"
            testId="clip-audio-pan-input"
            value={selectedClip.audio?.pan ?? 0}
            min={-1}
            max={1}
            step={0.05}
            disabled={readOnly || !canChangeAudio}
            onChange={(value) => onClipAudioChange({ pan: value })}
          />
          <NumberField
            label="Fade In"
            testId="clip-audio-fade-in-input"
            value={selectedClip.audio?.fadeInSec ?? 0}
            min={0}
            max={clipDuration}
            step={0.1}
            unit="s"
            disabled={readOnly || !canChangeAudio}
            onChange={(value) => onClipAudioChange({ fadeInSec: value })}
          />
          <NumberField
            label="Fade Out"
            testId="clip-audio-fade-out-input"
            value={selectedClip.audio?.fadeOutSec ?? 0}
            min={0}
            max={clipDuration}
            step={0.1}
            unit="s"
            disabled={readOnly || !canChangeAudio}
            onChange={(value) => onClipAudioChange({ fadeOutSec: value })}
          />
          <label className="block text-xs text-editor-text-muted">
            Role
            <select
              data-testid="clip-audio-role-select"
              className="mt-1 w-full rounded border border-editor-border bg-editor-surface px-2 py-1 text-sm text-editor-text"
              value={selectedClip.audio?.audioRole ?? 'none'}
              disabled={readOnly || !canChangeAudio}
              onChange={(event) =>
                onClipAudioChange({ audioRole: event.currentTarget.value as AudioRole })
              }
            >
              <option value="none">None</option>
              <option value="dialogue">Dialogue</option>
              <option value="music">Music</option>
              <option value="sfx">SFX</option>
              <option value="ambience">Ambience</option>
              <option value="voiceover">Voiceover</option>
            </select>
          </label>
          <label className="block text-xs text-editor-text-muted">
            Tags
            <input
              data-testid="clip-audio-tags-input"
              className="mt-1 w-full rounded border border-editor-border bg-editor-surface px-2 py-1 text-sm text-editor-text"
              value={(selectedClip.audio?.audioTags ?? []).join(', ')}
              disabled={readOnly || !canChangeAudio}
              onChange={(event) =>
                onClipAudioChange({ audioTags: parseAudioTags(event.currentTarget.value) })
              }
            />
          </label>
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-editor-border">
        <h4 className="text-xs font-semibold text-editor-text-muted mb-3 flex items-center gap-2">
          <Gauge className="w-3 h-3" />
          Speed
        </h4>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-sm text-editor-text-muted">Speed (%)</label>
            <SpeedInput
              speed={selectedClip.speed ?? 1}
              reverse={selectedClip.reverse ?? false}
              clipId={selectedClip.id}
              trackId={selectedClip.place.trackId}
              onClipSpeedChange={onClipSpeedChange}
              disabled={readOnly || !onClipSpeedChange}
            />
          </div>
          <div className="grid grid-cols-5 gap-2">
            {SPEED_PRESETS.map((speed) => (
              <button
                key={speed}
                type="button"
                data-testid={`speed-preset-${Math.round(speed * 100)}`}
                className={`px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                  Math.abs((selectedClip.speed ?? 1) - speed) < 0.001 && !selectedClip.hasTimeRemap
                    ? 'bg-primary-500 text-white'
                    : 'bg-editor-input bg-opacity-50 text-editor-text-muted border border-editor-border hover:bg-opacity-80'
                }`}
                onClick={() =>
                  onClipSpeedChange?.(
                    selectedClip.id,
                    selectedClip.place.trackId,
                    speed,
                    selectedClip.reverse ?? false,
                  )
                }
                disabled={readOnly || !onClipSpeedChange}
              >
                {Math.round(speed * 100)}%
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              data-testid="reverse-toggle"
              className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                selectedClip.reverse
                  ? 'bg-orange-500 text-white'
                  : 'bg-editor-input bg-opacity-50 text-editor-text-muted border border-editor-border hover:bg-opacity-80'
              }`}
              onClick={() => onClipReverseToggle?.(selectedClip.id, selectedClip.place.trackId)}
              disabled={readOnly || !onClipReverseToggle}
            >
              Reverse
            </button>
            <button
              data-testid="freeze-frame-btn"
              className="flex-1 px-3 py-1.5 rounded text-xs font-medium bg-editor-input bg-opacity-50 text-editor-text-muted border border-editor-border hover:bg-opacity-80 transition-colors"
              onClick={() => onFreezeFrame?.(selectedClip.id, selectedClip.place.trackId)}
              disabled={readOnly || !onFreezeFrame}
            >
              Freeze Frame
            </button>
          </div>
          {selectedClip.hasTimeRemap && (
            <div
              data-testid="time-remap-status"
              className="flex items-center gap-2 text-xs text-teal-400"
            >
              <span className="w-2 h-2 rounded-full bg-teal-400" />
              Time Remap Active
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <label className="text-sm text-editor-text-muted" htmlFor="slow-motion-interpolation">
              Slow Motion
            </label>
            <select
              id="slow-motion-interpolation"
              data-testid="slow-motion-interpolation-select"
              className="w-44 bg-editor-input bg-opacity-50 border border-editor-border rounded px-2 py-1 text-sm text-editor-text focus:border-primary-500 focus:ring-1 focus:ring-primary-500 focus:outline-none"
              value={selectedClip.slowMotionInterpolation ?? 'nearest'}
              onChange={(event) =>
                onSlowMotionInterpolationChange?.(
                  selectedClip.id,
                  selectedClip.place.trackId,
                  event.currentTarget.value as SlowMotionInterpolation,
                )
              }
              disabled={readOnly || !onSlowMotionInterpolationChange}
            >
              {SLOW_MOTION_INTERPOLATION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="rounded border border-editor-border bg-editor-surface bg-opacity-40 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-editor-text-muted">Speed Ramp</span>
              <span className="text-[11px] text-editor-text-muted">
                {getSourceDurationSec(selectedClip).toFixed(2)}s source /{' '}
                {getEditableClipDurationSec(selectedClip, clipDuration).toFixed(2)}s timeline
              </span>
            </div>
            <TimeRemapEditor
              selectedClip={selectedClip}
              clipDuration={clipDuration}
              readOnly={readOnly}
              onTimeRemapChange={(timeRemap) =>
                onTimeRemapChange?.(selectedClip.id, selectedClip.place.trackId, timeRemap)
              }
              onTimeRemapClear={() =>
                onTimeRemapClear?.(selectedClip.id, selectedClip.place.trackId)
              }
            />
          </div>
        </div>
      </div>

      <div className="mt-6 pt-4 border-t border-editor-border">
        <EffectsList
          effects={selectedClip.effects ?? []}
          selectedEffectId={selectedEffectId}
          onSelectEffect={onSelectEffect}
          onToggleEffect={onToggleEffect}
          onRemoveEffect={onRemoveEffect}
          onAddEffect={onAddEffect}
          readOnly={readOnly || !canEditEffects}
        />

        {selectedEffect && !readOnly && (
          <div className="mt-3 space-y-2">
            <button
              type="button"
              className="w-full rounded border border-editor-border bg-editor-input bg-opacity-40 px-3 py-2 text-xs font-medium text-editor-text transition-colors hover:bg-opacity-70"
              onClick={onOpenSavePreset}
              data-testid="save-selected-effect-preset-button"
            >
              Save Selected Effect as Preset
            </button>
            {presetSaveError && (
              <p className="text-xs text-red-400" data-testid="inspector-preset-error">
                {presetSaveError}
              </p>
            )}
          </div>
        )}

        {selectedEffect && (
          <EffectInspector
            effect={selectedEffect}
            paramDefs={selectedEffectParamDefs}
            clipContext={
              selectedClip.sequenceId
                ? {
                    sequenceId: selectedClip.sequenceId,
                    trackId: selectedClip.place.trackId,
                    clipId: selectedClip.id,
                  }
                : undefined
            }
            onChange={onEffectChange}
            onToggle={onToggleEffect}
            onDelete={onRemoveEffect}
            readOnly={readOnly || !canEditEffects}
            className="mt-3 h-auto rounded border border-editor-border bg-editor-bg bg-opacity-40"
          />
        )}
      </div>

      <SaveEffectPresetDialog
        isOpen={presetSaveTarget !== null}
        effect={presetSaveTarget}
        saving={isSavingPreset}
        error={presetSaveError}
        onConfirm={(name, description) => {
          void onConfirmSavePreset(name, description);
        }}
        onCancel={onCloseSavePreset}
      />
    </div>
  );
}

export interface AssetInspectorPanelProps {
  selectedAsset: SelectedAsset;
  onGenerateThumbnail?: (assetId: string) => Promise<string | null>;
  onLoadWaveformData?: (assetId: string) => Promise<WaveformData | null>;
  onGenerateWaveform?: (assetId: string) => Promise<WaveformData | null>;
  onEnsureAudioPreview?: (assetId: string) => Promise<string | null>;
  waveformUiCacheSize?: number;
  onClearWaveformUiCache?: () => void;
  readOnly?: boolean;
}

type CacheStatus = 'unavailable' | 'idle' | 'checking' | 'ready' | 'missing' | 'working' | 'error';

function formatWaveformSummary(data: WaveformData | null): string {
  if (!data) return 'Not generated';
  return `${data.peaks.length.toLocaleString()} peaks @ ${data.samplesPerSecond} Hz`;
}

export function AssetInspectorPanel({
  selectedAsset,
  onGenerateThumbnail,
  onLoadWaveformData,
  onGenerateWaveform,
  onEnsureAudioPreview,
  waveformUiCacheSize = 0,
  onClearWaveformUiCache,
  readOnly = false,
}: AssetInspectorPanelProps): JSX.Element {
  const videoBitrate = formatBitrate(selectedAsset.video?.bitrate);
  const audioBitrate = formatBitrate(selectedAsset.audio?.bitrate);
  const importedAt = formatImportedAt(selectedAsset.importedAt);
  const proxyStatus = formatProxyStatus(selectedAsset.proxyStatus);
  const tagSummary = selectedAsset.tags?.length ? selectedAsset.tags.join(', ') : undefined;
  const canGenerateThumbnail =
    !selectedAsset.missing &&
    (selectedAsset.kind === 'video' ||
      selectedAsset.kind === 'audio' ||
      selectedAsset.kind === 'image');
  const canUseWaveformCache =
    !selectedAsset.missing && (selectedAsset.kind === 'video' || selectedAsset.kind === 'audio');
  const [thumbnailStatus, setThumbnailStatus] = useState<CacheStatus>(
    selectedAsset.thumbnailUrl ? 'ready' : canGenerateThumbnail ? 'missing' : 'unavailable',
  );
  const [waveformStatus, setWaveformStatus] = useState<CacheStatus>(
    canUseWaveformCache ? 'checking' : 'unavailable',
  );
  const [waveformSummary, setWaveformSummary] = useState('Checking');
  const [audioPreviewStatus, setAudioPreviewStatus] = useState<CacheStatus>(
    canUseWaveformCache ? 'idle' : 'unavailable',
  );
  const [audioPreviewPath, setAudioPreviewPath] = useState<string | null>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);

  useEffect(() => {
    setThumbnailStatus(
      selectedAsset.thumbnailUrl ? 'ready' : canGenerateThumbnail ? 'missing' : 'unavailable',
    );
  }, [canGenerateThumbnail, selectedAsset.id, selectedAsset.thumbnailUrl]);

  useEffect(() => {
    let cancelled = false;

    setCacheError(null);
    setAudioPreviewStatus(canUseWaveformCache ? 'idle' : 'unavailable');
    setAudioPreviewPath(null);

    if (!canUseWaveformCache) {
      setWaveformStatus('unavailable');
      setWaveformSummary('Unavailable');
      return () => {
        cancelled = true;
      };
    }

    if (!onLoadWaveformData) {
      setWaveformStatus('idle');
      setWaveformSummary('Unknown');
      return () => {
        cancelled = true;
      };
    }

    setWaveformStatus('checking');
    setWaveformSummary('Checking');

    onLoadWaveformData(selectedAsset.id)
      .then((data) => {
        if (cancelled) return;
        setWaveformStatus(data ? 'ready' : 'missing');
        setWaveformSummary(formatWaveformSummary(data));
      })
      .catch((error) => {
        if (cancelled) return;
        setWaveformStatus('error');
        setWaveformSummary('Error');
        setCacheError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
    };
  }, [canUseWaveformCache, onLoadWaveformData, selectedAsset.id]);

  const handleGenerateThumbnail = useCallback(async () => {
    if (!onGenerateThumbnail) return;

    setCacheError(null);
    setThumbnailStatus('working');

    try {
      const thumbnailUrl = await onGenerateThumbnail(selectedAsset.id);
      setThumbnailStatus(thumbnailUrl ? 'ready' : 'missing');
    } catch (error) {
      setThumbnailStatus('error');
      setCacheError(error instanceof Error ? error.message : String(error));
    }
  }, [onGenerateThumbnail, selectedAsset.id]);

  const handleGenerateWaveform = useCallback(async () => {
    if (!onGenerateWaveform) return;

    setCacheError(null);
    setWaveformStatus('working');
    setWaveformSummary('Generating');

    try {
      const data = await onGenerateWaveform(selectedAsset.id);
      setWaveformStatus(data ? 'ready' : 'missing');
      setWaveformSummary(formatWaveformSummary(data));
    } catch (error) {
      setWaveformStatus('error');
      setWaveformSummary('Error');
      setCacheError(error instanceof Error ? error.message : String(error));
    }
  }, [onGenerateWaveform, selectedAsset.id]);

  const handleEnsureAudioPreview = useCallback(async () => {
    if (!onEnsureAudioPreview) return;

    setCacheError(null);
    setAudioPreviewStatus('working');

    try {
      const previewPath = await onEnsureAudioPreview(selectedAsset.id);
      setAudioPreviewPath(previewPath);
      setAudioPreviewStatus(previewPath ? 'ready' : 'missing');
    } catch (error) {
      setAudioPreviewStatus('error');
      setCacheError(error instanceof Error ? error.message : String(error));
    }
  }, [onEnsureAudioPreview, selectedAsset.id]);

  return (
    <div
      data-testid="inspector"
      role="complementary"
      aria-label="Properties inspector"
      className="p-4"
    >
      <h3 className="text-sm font-semibold text-editor-text mb-4 flex items-center gap-2">
        {getAssetIcon(selectedAsset.kind)}
        <span className="text-primary-500">Asset Properties</span>
      </h3>

      <div className="space-y-1">
        <PropertyRow label="Name" value={selectedAsset.name} testId="asset-name" />
        <PropertyRow label="Type" value={selectedAsset.kind} testId="asset-type" />
        <PropertyRow
          label="Status"
          value={selectedAsset.missing ? 'Missing' : 'Online'}
          testId="asset-status"
        />
        {selectedAsset.durationSec !== undefined && (
          <PropertyRow
            label="Duration"
            value={formatDuration(selectedAsset.durationSec)}
            testId="asset-duration"
            icon={<Clock className="w-3 h-3" />}
          />
        )}
        {selectedAsset.resolution && (
          <PropertyRow
            label="Resolution"
            value={`${selectedAsset.resolution.width} x ${selectedAsset.resolution.height}`}
            testId="asset-resolution"
            icon={<Maximize className="w-3 h-3" />}
          />
        )}
      </div>

      {(selectedAsset.video || selectedAsset.audio) && (
        <div className="mt-4 pt-4 border-t border-editor-border">
          <h4 className="text-xs font-semibold text-editor-text-muted mb-3 flex items-center gap-2">
            <Database className="w-3 h-3" />
            Media Metadata
          </h4>

          <div className="space-y-1">
            {selectedAsset.video && (
              <>
                <PropertyRow
                  label="Video Codec"
                  value={selectedAsset.video.codec}
                  testId="asset-video-codec"
                />
                <PropertyRow
                  label="Frame Rate"
                  value={formatRatioDecimal(selectedAsset.video.fps, 'fps')}
                  testId="asset-fps"
                />
                {videoBitrate && (
                  <PropertyRow
                    label="Video Bitrate"
                    value={videoBitrate}
                    testId="asset-video-bitrate"
                  />
                )}
                <PropertyRow
                  label="Alpha"
                  value={selectedAsset.video.hasAlpha ? 'Yes' : 'No'}
                  testId="asset-alpha"
                />
              </>
            )}

            {selectedAsset.audio && (
              <>
                <PropertyRow
                  label="Audio Codec"
                  value={selectedAsset.audio.codec}
                  testId="asset-audio-codec"
                />
                {formatChannels(selectedAsset.audio.channels) && (
                  <PropertyRow
                    label="Channels"
                    value={formatChannels(selectedAsset.audio.channels) ?? ''}
                    testId="asset-audio-channels"
                  />
                )}
                <PropertyRow
                  label="Sample Rate"
                  value={`${selectedAsset.audio.sampleRate.toLocaleString()} Hz`}
                  testId="asset-sample-rate"
                />
                {audioBitrate && (
                  <PropertyRow
                    label="Audio Bitrate"
                    value={audioBitrate}
                    testId="asset-audio-bitrate"
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}

      <div className="mt-4 pt-4 border-t border-editor-border">
        <h4 className="text-xs font-semibold text-editor-text-muted mb-3 flex items-center gap-2">
          <HardDrive className="w-3 h-3" />
          Project
        </h4>

        <div className="space-y-1">
          {selectedAsset.fileSize !== undefined && (
            <PropertyRow
              label="File Size"
              value={formatFileSize(selectedAsset.fileSize)}
              testId="asset-file-size"
            />
          )}
          {importedAt && (
            <PropertyRow label="Imported" value={importedAt} testId="asset-imported-at" />
          )}
          {proxyStatus && (
            <PropertyRow
              label="Media Optimization"
              value={proxyStatus}
              testId="asset-proxy-status"
            />
          )}
          <PropertyRow
            label="Workspace"
            value={selectedAsset.workspaceManaged ? 'Managed' : 'Registered'}
            testId="asset-workspace"
          />
          {tagSummary && <PropertyRow label="Tags" value={tagSummary} testId="asset-tags" />}
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-editor-border">
        <h4 className="text-xs font-semibold text-editor-text-muted mb-3 flex items-center gap-2">
          <Database className="w-3 h-3" />
          Media Cache
        </h4>

        <div className="space-y-1">
          <PropertyRow
            label="Thumbnail"
            value={
              thumbnailStatus === 'ready'
                ? 'Ready'
                : thumbnailStatus === 'working'
                  ? 'Generating'
                  : thumbnailStatus === 'unavailable'
                    ? 'Unavailable'
                    : 'Missing'
            }
            testId="asset-thumbnail-cache"
          />
          <PropertyRow
            label="Waveform Peaks"
            value={waveformSummary}
            testId="asset-waveform-cache"
          />
          <PropertyRow
            label="Audio Preview"
            value={
              audioPreviewStatus === 'ready'
                ? 'Ready'
                : audioPreviewStatus === 'working'
                  ? 'Generating'
                  : audioPreviewStatus === 'unavailable'
                    ? 'Unavailable'
                    : 'Not generated'
            }
            testId="asset-audio-preview-cache"
          />
          <PropertyRow
            label="UI Waveforms"
            value={`${waveformUiCacheSize.toLocaleString()} entries`}
            testId="asset-waveform-ui-cache"
          />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          {canGenerateThumbnail && (
            <button
              type="button"
              data-testid="asset-regenerate-thumbnail"
              className="flex items-center justify-center gap-2 rounded border border-editor-border bg-editor-input px-2 py-1.5 text-xs font-medium text-editor-text transition-colors hover:border-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => {
                void handleGenerateThumbnail();
              }}
              disabled={readOnly || !onGenerateThumbnail || thumbnailStatus === 'working'}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Thumbnail
            </button>
          )}

          {canUseWaveformCache && (
            <button
              type="button"
              data-testid="asset-generate-waveform"
              className="flex items-center justify-center gap-2 rounded border border-editor-border bg-editor-input px-2 py-1.5 text-xs font-medium text-editor-text transition-colors hover:border-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => {
                void handleGenerateWaveform();
              }}
              disabled={readOnly || !onGenerateWaveform || waveformStatus === 'working'}
            >
              <Music className="h-3.5 w-3.5" />
              Waveform
            </button>
          )}

          {canUseWaveformCache && (
            <button
              type="button"
              data-testid="asset-ensure-audio-preview"
              className="flex items-center justify-center gap-2 rounded border border-editor-border bg-editor-input px-2 py-1.5 text-xs font-medium text-editor-text transition-colors hover:border-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => {
                void handleEnsureAudioPreview();
              }}
              disabled={readOnly || !onEnsureAudioPreview || audioPreviewStatus === 'working'}
            >
              <Zap className="h-3.5 w-3.5" />
              Audio Preview
            </button>
          )}

          <button
            type="button"
            data-testid="asset-clear-waveform-ui-cache"
            className="flex items-center justify-center gap-2 rounded border border-editor-border bg-editor-input px-2 py-1.5 text-xs font-medium text-editor-text transition-colors hover:border-red-400 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onClearWaveformUiCache}
            disabled={readOnly || !onClearWaveformUiCache || waveformUiCacheSize === 0}
          >
            <XCircle className="h-3.5 w-3.5" />
            Clear UI Cache
          </button>
        </div>

        {audioPreviewPath && (
          <p
            data-testid="asset-audio-preview-url"
            className="mt-2 truncate text-xs text-editor-text-muted"
            title={audioPreviewPath}
          >
            Audio: {audioPreviewPath}
          </p>
        )}
        {cacheError && (
          <p data-testid="asset-cache-error" className="mt-2 text-xs text-red-400">
            {cacheError}
          </p>
        )}
      </div>

      <div className="mt-4 pt-4 border-t border-editor-border">
        {selectedAsset.relativePath && (
          <p
            data-testid="asset-relative-path"
            className="mb-2 text-xs text-editor-text-muted truncate"
            title={selectedAsset.relativePath}
          >
            {selectedAsset.relativePath}
          </p>
        )}
        <p className="text-xs text-editor-text-muted truncate" title={selectedAsset.uri}>
          {selectedAsset.uri}
        </p>
      </div>
    </div>
  );
}

type CaptionStyleField = keyof Pick<
  CaptionStyle,
  'color' | 'backgroundColor' | 'outlineColor' | 'shadowColor'
>;

const CAPTION_FONT_FAMILIES = [
  'Arial',
  'Helvetica',
  'Verdana',
  'Inter',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Impact',
  'Noto Sans',
  'Noto Sans KR',
];

function InspectorSection({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: JSX.Element;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="pt-4 border-t border-editor-border first:border-t-0 first:pt-0">
      <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold text-editor-text-muted">
        {icon}
        {title}
      </h4>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  disabled,
  testId,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  testId?: string;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <label className="text-xs text-editor-text-muted">{label}</label>
      <div className="flex items-center gap-1">
        <input
          data-testid={testId}
          type="number"
          min={min}
          max={max}
          step={step}
          className="w-20 rounded border border-editor-border bg-editor-input px-2 py-1 text-right text-xs text-editor-text focus:border-primary-500 focus:outline-none disabled:opacity-50"
          value={Number.isFinite(value) ? value : min}
          onChange={(event) => onChange(Number(event.target.value))}
          disabled={disabled}
        />
        {unit && <span className="w-5 text-[11px] text-editor-text-muted">{unit}</span>}
      </div>
    </div>
  );
}

function ColorField({
  label,
  color,
  onChange,
  disabled,
  testId,
}: {
  label: string;
  color: CaptionColor;
  onChange: (color: CaptionColor) => void;
  disabled?: boolean;
  testId?: string;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <label className="text-xs text-editor-text-muted">{label}</label>
      <input
        data-testid={testId}
        type="color"
        className="h-8 w-12 cursor-pointer rounded border border-editor-border bg-editor-input disabled:cursor-not-allowed disabled:opacity-50"
        value={captionColorToHex(color)}
        onChange={(event) => {
          const parsed = parseCaptionHexColor(event.target.value);
          if (parsed) {
            onChange({ ...parsed, a: color.a });
          }
        }}
        disabled={disabled}
      />
    </div>
  );
}

function StyleToggle({
  title,
  active,
  onClick,
  disabled,
  children,
  testId,
}: {
  title: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    <button
      data-testid={testId}
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded border p-1.5 transition-colors ${
        active
          ? 'border-primary-500 bg-primary-500 text-white'
          : 'border-editor-border bg-editor-input text-editor-text-muted hover:border-primary-500'
      } disabled:opacity-50`}
    >
      {children}
    </button>
  );
}

export interface CaptionInspectorPanelProps {
  selectedCaption: SelectedCaption;
  onCaptionChange?: (captionId: string, property: string, value: unknown) => void;
  readOnly?: boolean;
}

export function CaptionInspectorPanel({
  selectedCaption,
  onCaptionChange,
  readOnly = false,
}: CaptionInspectorPanelProps): JSX.Element {
  const captionPosition = normalizeCaptionPosition(selectedCaption.position);
  const captionStyle = normalizeCaptionStyle(selectedCaption.style);
  const isReadOnly = readOnly || !onCaptionChange;

  const commitCaptionStyle = (updates: Partial<CaptionStyle>): void => {
    onCaptionChange?.(
      selectedCaption.id,
      'style',
      normalizeCaptionStyle({
        ...captionStyle,
        ...updates,
      }),
    );
  };

  const updateCaptionColor = (field: CaptionStyleField, color: CaptionColor | undefined): void => {
    commitCaptionStyle({ [field]: color } as Partial<CaptionStyle>);
  };

  const commitCaptionPosition = (position: CaptionPosition): void => {
    onCaptionChange?.(selectedCaption.id, 'position', position);
  };

  const handlePositionModeChange = (nextMode: string): void => {
    if (nextMode === 'custom') {
      const fromPresetY =
        captionPosition.type === 'preset'
          ? captionPosition.vertical === 'top'
            ? captionPosition.marginPercent
            : captionPosition.vertical === 'center'
              ? 50
              : 100 - captionPosition.marginPercent
          : captionPosition.yPercent;
      commitCaptionPosition({
        type: 'custom',
        xPercent: 50,
        yPercent: Math.max(0, Math.min(100, fromPresetY)),
      });
      return;
    }

    const vertical = nextMode === 'top' || nextMode === 'center' ? nextMode : 'bottom';
    commitCaptionPosition({
      type: 'preset',
      vertical,
      marginPercent: captionPosition.type === 'preset' ? captionPosition.marginPercent : 5,
    });
  };

  const fontWeightValue = getCaptionFontWeightNumber(captionStyle);
  const hasBackground = Boolean(captionStyle.backgroundColor);
  const hasOutline = Boolean(captionStyle.outlineColor && captionStyle.outlineWidth > 0);
  const hasShadow = Boolean(captionStyle.shadowColor);

  return (
    <div
      data-testid="inspector"
      role="complementary"
      aria-label="Properties inspector"
      className="p-4"
    >
      <h3 className="text-sm font-semibold text-editor-text mb-4 flex items-center gap-2">
        <Type className="w-4 h-4 text-primary-500" />
        Caption Properties
      </h3>

      <div className="space-y-5">
        <InspectorSection title="Content" icon={<Type className="w-3 h-3" />}>
          <label className="text-xs font-medium text-editor-text-muted">Content</label>
          <textarea
            data-testid="caption-content-input"
            className="w-full h-24 bg-editor-input bg-opacity-50 border border-editor-border rounded p-2 text-sm text-editor-text focus:border-primary-500 focus:ring-1 focus:ring-primary-500 focus:outline-none resize-none"
            value={selectedCaption.text}
            onChange={(e) => onCaptionChange?.(selectedCaption.id, 'text', e.target.value)}
            placeholder="Enter caption text..."
            disabled={isReadOnly}
          />
        </InspectorSection>

        <InspectorSection title="Timing" icon={<Clock className="w-3 h-3" />}>
          <PropertyRow
            label="Start Time"
            value={formatDuration(selectedCaption.startSec)}
            testId="caption-start"
            icon={<Clock className="w-3 h-3" />}
          />
          <PropertyRow
            label="End Time"
            value={formatDuration(selectedCaption.endSec)}
            testId="caption-end"
            icon={<Clock className="w-3 h-3" />}
          />
          <PropertyRow
            label="Duration"
            value={`${(selectedCaption.endSec - selectedCaption.startSec).toFixed(2)}s`}
            testId="caption-duration"
          />
        </InspectorSection>

        <InspectorSection title="Font" icon={<Type className="w-3 h-3" />}>
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs text-editor-text-muted">Family</label>
            <input
              data-testid="caption-font-family-input"
              type="text"
              list="caption-font-families"
              value={captionStyle.fontFamily}
              className="w-36 rounded border border-editor-border bg-editor-input px-2 py-1 text-xs text-editor-text focus:border-primary-500 focus:outline-none disabled:opacity-50"
              onChange={(event) => commitCaptionStyle({ fontFamily: event.target.value })}
              disabled={isReadOnly}
            />
            <datalist id="caption-font-families">
              {CAPTION_FONT_FAMILIES.map((family) => (
                <option key={family} value={family} />
              ))}
            </datalist>
          </div>

          <NumberField
            label="Size"
            value={captionStyle.fontSize}
            min={1}
            max={500}
            unit="pt"
            testId="caption-font-size"
            onChange={(fontSize) => commitCaptionStyle({ fontSize })}
            disabled={isReadOnly}
          />

          <NumberField
            label="Weight"
            value={fontWeightValue}
            min={100}
            max={900}
            step={100}
            testId="caption-font-weight"
            onChange={(fontWeight) => commitCaptionStyle({ fontWeight, bold: fontWeight >= 600 })}
            disabled={isReadOnly}
          />

          <div className="flex items-center justify-between">
            <label className="text-xs text-editor-text-muted">Style</label>
            <div className="flex gap-1">
              <StyleToggle
                title="Bold"
                active={fontWeightValue >= 600}
                onClick={() =>
                  commitCaptionStyle({
                    fontWeight: fontWeightValue >= 600 ? 400 : 700,
                    bold: fontWeightValue < 600,
                  })
                }
                disabled={isReadOnly}
                testId="caption-bold-toggle"
              >
                <Bold className="h-4 w-4" />
              </StyleToggle>
              <StyleToggle
                title="Italic"
                active={captionStyle.italic}
                onClick={() => commitCaptionStyle({ italic: !captionStyle.italic })}
                disabled={isReadOnly}
                testId="caption-italic-toggle"
              >
                <Italic className="h-4 w-4" />
              </StyleToggle>
              <StyleToggle
                title="Underline"
                active={captionStyle.underline}
                onClick={() => commitCaptionStyle({ underline: !captionStyle.underline })}
                disabled={isReadOnly}
                testId="caption-underline-toggle"
              >
                <Underline className="h-4 w-4" />
              </StyleToggle>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <label className="text-xs text-editor-text-muted">Alignment</label>
            <div className="flex gap-1">
              {(['left', 'center', 'right'] as TextAlignment[]).map((alignment) => (
                <StyleToggle
                  key={alignment}
                  title={`Align ${alignment}`}
                  active={captionStyle.alignment === alignment}
                  onClick={() => commitCaptionStyle({ alignment })}
                  disabled={isReadOnly}
                  testId={`caption-align-${alignment}`}
                >
                  {alignment === 'left' && <AlignLeft className="h-4 w-4" />}
                  {alignment === 'center' && <AlignCenter className="h-4 w-4" />}
                  {alignment === 'right' && <AlignRight className="h-4 w-4" />}
                </StyleToggle>
              ))}
            </div>
          </div>

          <NumberField
            label="Line Height"
            value={captionStyle.lineHeight ?? 1.2}
            min={0.5}
            max={5}
            step={0.1}
            testId="caption-line-height"
            onChange={(lineHeight) => commitCaptionStyle({ lineHeight })}
            disabled={isReadOnly}
          />

          <NumberField
            label="Letter Spacing"
            value={captionStyle.letterSpacing ?? 0}
            min={-100}
            max={200}
            unit="px"
            testId="caption-letter-spacing"
            onChange={(letterSpacing) => commitCaptionStyle({ letterSpacing })}
            disabled={isReadOnly}
          />
        </InspectorSection>

        <InspectorSection title="Fill" icon={<Palette className="w-3 h-3" />}>
          <ColorField
            label="Text Color"
            color={captionStyle.color}
            onChange={(color) => updateCaptionColor('color', color)}
            disabled={isReadOnly}
            testId="caption-text-color"
          />

          <NumberField
            label="Opacity"
            value={Math.round((captionStyle.opacity ?? 1) * 100)}
            min={0}
            max={100}
            unit="%"
            testId="caption-opacity"
            onChange={(opacityPercent) =>
              commitCaptionStyle({ opacity: Math.max(0, Math.min(100, opacityPercent)) / 100 })
            }
            disabled={isReadOnly}
          />

          <div className="flex items-center justify-between">
            <label className="text-xs text-editor-text-muted">Background</label>
            <StyleToggle
              title={hasBackground ? 'Remove background' : 'Add background'}
              active={hasBackground}
              onClick={() =>
                updateCaptionColor(
                  'backgroundColor',
                  hasBackground ? undefined : { r: 0, g: 0, b: 0, a: 180 },
                )
              }
              disabled={isReadOnly}
              testId="caption-background-toggle"
            >
              <Square className="h-4 w-4" />
            </StyleToggle>
          </div>

          {captionStyle.backgroundColor && (
            <>
              <ColorField
                label="Background Color"
                color={captionStyle.backgroundColor}
                onChange={(color) => updateCaptionColor('backgroundColor', color)}
                disabled={isReadOnly}
                testId="caption-background-color"
              />
              <NumberField
                label="Padding"
                value={captionStyle.backgroundPadding ?? 10}
                min={0}
                max={500}
                unit="px"
                testId="caption-background-padding"
                onChange={(backgroundPadding) => commitCaptionStyle({ backgroundPadding })}
                disabled={isReadOnly}
              />
            </>
          )}
        </InspectorSection>

        <InspectorSection title="Outline" icon={<Square className="w-3 h-3" />}>
          <div className="flex items-center justify-between">
            <label className="text-xs text-editor-text-muted">Enabled</label>
            <StyleToggle
              title={hasOutline ? 'Remove outline' : 'Add outline'}
              active={hasOutline}
              onClick={() =>
                hasOutline
                  ? commitCaptionStyle({ outlineColor: undefined, outlineWidth: 0 })
                  : commitCaptionStyle({
                      outlineColor: { r: 0, g: 0, b: 0, a: 255 },
                      outlineWidth: 2,
                    })
              }
              disabled={isReadOnly}
              testId="caption-outline-toggle"
            >
              <Square className="h-4 w-4" />
            </StyleToggle>
          </div>

          {captionStyle.outlineColor && (
            <>
              <ColorField
                label="Outline Color"
                color={captionStyle.outlineColor}
                onChange={(color) => updateCaptionColor('outlineColor', color)}
                disabled={isReadOnly}
                testId="caption-outline-color"
              />
              <NumberField
                label="Width"
                value={captionStyle.outlineWidth}
                min={0}
                max={100}
                unit="px"
                testId="caption-outline-width"
                onChange={(outlineWidth) => commitCaptionStyle({ outlineWidth })}
                disabled={isReadOnly}
              />
            </>
          )}
        </InspectorSection>

        <InspectorSection title="Shadow" icon={<Square className="w-3 h-3" />}>
          <div className="flex items-center justify-between">
            <label className="text-xs text-editor-text-muted">Enabled</label>
            <StyleToggle
              title={hasShadow ? 'Remove shadow' : 'Add shadow'}
              active={hasShadow}
              onClick={() =>
                updateCaptionColor(
                  'shadowColor',
                  hasShadow ? undefined : { r: 0, g: 0, b: 0, a: 160 },
                )
              }
              disabled={isReadOnly}
              testId="caption-shadow-toggle"
            >
              <Square className="h-4 w-4" />
            </StyleToggle>
          </div>

          {captionStyle.shadowColor && (
            <>
              <ColorField
                label="Shadow Color"
                color={captionStyle.shadowColor}
                onChange={(color) => updateCaptionColor('shadowColor', color)}
                disabled={isReadOnly}
                testId="caption-shadow-color"
              />
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="X"
                  value={captionStyle.shadowOffsetX ?? captionStyle.shadowOffset}
                  min={-500}
                  max={500}
                  unit="px"
                  testId="caption-shadow-x"
                  onChange={(shadowOffsetX) => commitCaptionStyle({ shadowOffsetX })}
                  disabled={isReadOnly}
                />
                <NumberField
                  label="Y"
                  value={captionStyle.shadowOffsetY ?? captionStyle.shadowOffset}
                  min={-500}
                  max={500}
                  unit="px"
                  testId="caption-shadow-y"
                  onChange={(shadowOffsetY) => commitCaptionStyle({ shadowOffsetY })}
                  disabled={isReadOnly}
                />
              </div>
              <NumberField
                label="Blur"
                value={captionStyle.shadowBlur ?? 0}
                min={0}
                max={500}
                unit="px"
                testId="caption-shadow-blur"
                onChange={(shadowBlur) => commitCaptionStyle({ shadowBlur })}
                disabled={isReadOnly}
              />
            </>
          )}
        </InspectorSection>

        <InspectorSection title="Position" icon={<Maximize className="w-3 h-3" />}>
          <label className="text-xs font-medium text-editor-text-muted">Position</label>
          <select
            data-testid="caption-position-mode"
            value={captionPosition.type === 'custom' ? 'custom' : captionPosition.vertical}
            className="w-full bg-editor-input bg-opacity-50 border border-editor-border rounded p-2 text-sm text-editor-text focus:border-primary-500 focus:ring-1 focus:ring-primary-500 focus:outline-none"
            onChange={(event) => handlePositionModeChange(event.target.value)}
            disabled={isReadOnly}
          >
            <option value="top">Top</option>
            <option value="center">Center</option>
            <option value="bottom">Bottom</option>
            <option value="custom">Custom</option>
          </select>

          {captionPosition.type === 'preset' ? (
            <div className="space-y-1">
              <label className="text-[11px] text-editor-text-muted">Margin (%)</label>
              <input
                data-testid="caption-position-margin"
                type="range"
                min={0}
                max={50}
                step={1}
                value={captionPosition.marginPercent}
                onChange={(event) => {
                  commitCaptionPosition({
                    type: 'preset',
                    vertical: captionPosition.vertical,
                    marginPercent: Number(event.target.value),
                  });
                }}
                disabled={isReadOnly}
              />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-[11px] text-editor-text-muted">X (%)</label>
                <input
                  data-testid="caption-position-x"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={captionPosition.xPercent}
                  onChange={(event) => {
                    commitCaptionPosition({
                      type: 'custom',
                      xPercent: Number(event.target.value),
                      yPercent: captionPosition.yPercent,
                    });
                  }}
                  disabled={isReadOnly}
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] text-editor-text-muted">Y (%)</label>
                <input
                  data-testid="caption-position-y"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={captionPosition.yPercent}
                  onChange={(event) => {
                    commitCaptionPosition({
                      type: 'custom',
                      xPercent: captionPosition.xPercent,
                      yPercent: Number(event.target.value),
                    });
                  }}
                  disabled={isReadOnly}
                />
              </div>
            </div>
          )}
        </InspectorSection>
      </div>
    </div>
  );
}
