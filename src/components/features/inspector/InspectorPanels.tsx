import { useCallback, useEffect, useState } from 'react';
import {
  Clock,
  FileText,
  Film,
  Gauge,
  Image as ImageIcon,
  Info,
  Maximize,
  Music,
  Type,
} from 'lucide-react';
import { formatDuration } from '@/utils/formatters';
import { EffectsList, SaveEffectPresetDialog } from '../effects';
import { BlendModePicker } from '../effects/BlendModePicker';
import { EffectInspector } from '../effects/EffectInspector';
import type {
  BlendMode,
  CaptionPosition,
  Effect,
  EffectId,
  ParamDef,
  SimpleParamValue,
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

function normalizeCaptionPosition(position: CaptionPosition | undefined): CaptionPosition {
  if (!position) {
    return {
      type: 'preset',
      vertical: 'bottom',
      marginPercent: 5,
    };
  }

  if (position.type === 'custom') {
    const xPercent = Number.isFinite(position.xPercent) ? position.xPercent : 50;
    const yPercent = Number.isFinite(position.yPercent) ? position.yPercent : 90;
    return {
      type: 'custom',
      xPercent: Math.max(0, Math.min(100, xPercent)),
      yPercent: Math.max(0, Math.min(100, yPercent)),
    };
  }

  const marginPercent = Number.isFinite(position.marginPercent) ? position.marginPercent : 5;
  return {
    type: 'preset',
    vertical: position.vertical,
    marginPercent: Math.max(0, Math.min(50, marginPercent)),
  };
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
  const isReadOnly = readOnly || !onCaptionChange;

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

      <div className="space-y-4">
        <div className="space-y-2">
          <label className="text-xs font-medium text-editor-text-muted">Content</label>
          <textarea
            className="w-full h-24 bg-editor-input bg-opacity-50 border border-editor-border rounded p-2 text-sm text-editor-text focus:border-primary-500 focus:ring-1 focus:ring-primary-500 focus:outline-none resize-none"
            value={selectedCaption.text}
            onChange={(e) => onCaptionChange?.(selectedCaption.id, 'text', e.target.value)}
            placeholder="Enter caption text..."
            disabled={isReadOnly}
          />
        </div>

        <div className="space-y-1">
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
        </div>

        <div className="space-y-2">
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
        </div>
      </div>
    </div>
  );
}
