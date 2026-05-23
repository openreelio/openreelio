import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Clock,
  FileText,
  Film,
  Gauge,
  Image as ImageIcon,
  Info,
  Italic,
  Maximize,
  Music,
  Palette,
  Square,
  Type,
  Underline,
} from 'lucide-react';
import { formatDuration } from '@/utils/formatters';
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
  TextAlignment,
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

interface PropertyRowProps {
  label: string;
  value: string;
  testId?: string;
  icon?: JSX.Element;
}

function PropertyRow({ label, value, testId, icon }: PropertyRowProps): JSX.Element {
  return (
    <div className="flex items-center justify-between py-2 border-b border-editor-border last:border-b-0">
      <span className="text-editor-text-muted text-sm flex items-center gap-2">
        {icon}
        {label}
      </span>
      <span data-testid={testId} className="text-editor-text text-sm font-medium">
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
  canEditEffects: boolean;
  selectedEffectId?: EffectId;
  selectedEffect?: Effect;
  selectedEffectParamDefs: ParamDef[];
  presetSaveTarget: Effect | null;
  presetSaveError: string | null;
  isSavingPreset: boolean;
  onBlendModeChange: (mode: BlendMode) => void;
  onClipSpeedChange?: (clipId: string, trackId: string, speed: number, reverse: boolean) => void;
  onClipReverseToggle?: (clipId: string, trackId: string) => void;
  onFreezeFrame?: (clipId: string, trackId: string) => void;
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
  canEditEffects,
  selectedEffectId,
  selectedEffect,
  selectedEffectParamDefs,
  presetSaveTarget,
  presetSaveError,
  isSavingPreset,
  onBlendModeChange,
  onClipSpeedChange,
  onClipReverseToggle,
  onFreezeFrame,
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
}

export function AssetInspectorPanel({ selectedAsset }: AssetInspectorPanelProps): JSX.Element {
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

      <div className="mt-4 pt-4 border-t border-editor-border">
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
