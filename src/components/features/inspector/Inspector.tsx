/**
 * Inspector Component
 *
 * Property inspector panel for selected clips and assets.
 * Displays and allows editing of properties.
 * Supports text clips with the TextInspector sub-component.
 */

import { useMemo, useState, useCallback } from 'react';
import {
  Film,
  Music,
  Image as ImageIcon,
  FileText,
  Info,
  Clock,
  Maximize,
  Type,
} from 'lucide-react';
// Direct import instead of barrel to avoid bundling all utilities
import { formatDuration } from '@/utils/formatters';
import { EffectsList } from '../effects';
import { TextInspector } from './TextInspector';
import type { SelectedTextClip } from './TextInspector';
import type {
  Effect,
  EffectId,
  CaptionStyle,
  CaptionPosition,
  TextClipData,
  ClipId,
} from '@/types';

// =============================================================================
// Types
// =============================================================================

/** Clip selection data */
export interface SelectedClip {
  id: string;
  name: string;
  assetId: string;
  range: {
    sourceInSec: number;
    sourceOutSec: number;
  };
  place: {
    trackId: string;
    timelineInSec: number;
  };
  /** Effects applied to this clip */
  effects?: Effect[];
}

/** Asset selection data */
export interface SelectedAsset {
  id: string;
  name: string;
  kind: 'video' | 'audio' | 'image' | 'graphics';
  uri: string;
  durationSec?: number;
  resolution?: {
    width: number;
    height: number;
  };
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
  /** Callback when text clip data changes */
  onTextDataChange?: (clipId: ClipId, textData: TextClipData) => void;
  /** Callback when caption property changes */
  onCaptionChange?: (captionId: string, property: string, value: unknown) => void;
  /** Callback when an effect is toggled */
  onEffectToggle?: (clipId: string, effectId: EffectId, enabled: boolean) => void;
  /** Callback when an effect is removed */
  onEffectRemove?: (clipId: string, effectId: EffectId) => void;
  /** Callback when add effect is requested */
  onAddEffect?: (clipId: string) => void;
  /** Whether the inspector is read-only */
  readOnly?: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Get icon component for asset kind
 */
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

// =============================================================================
// Sub-components
// =============================================================================

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

// =============================================================================
// Component
// =============================================================================

export function Inspector({
  selectedClip,
  selectedTextClip,
  selectedAsset,
  selectedCaption,
  // onClipChange is reserved for future clip property editing
  onTextDataChange,
  onCaptionChange,
  onEffectToggle,
  onEffectRemove,
  onAddEffect,
  readOnly = false,
}: InspectorProps): JSX.Element {
  // ===========================================================================
  // State
  // ===========================================================================

  const [selectedEffectId, setSelectedEffectId] = useState<EffectId | undefined>();

  // ===========================================================================
  // Computed Values
  // ===========================================================================

  const clipDuration = useMemo(() => {
    if (!selectedClip) return null;
    return selectedClip.range.sourceOutSec - selectedClip.range.sourceInSec;
  }, [selectedClip]);

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

  // ===========================================================================
  // Render Empty State
  // ===========================================================================

  if (!selectedClip && !selectedTextClip && !selectedAsset && !selectedCaption) {
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

  // ===========================================================================
  // Render Text Clip Properties (Priority over regular clips)
  // ===========================================================================

  if (selectedTextClip) {
    return (
      <TextInspector
        selectedTextClip={selectedTextClip}
        onTextDataChange={onTextDataChange ?? (() => {})}
        readOnly={readOnly}
      />
    );
  }

  // ===========================================================================
  // Render Clip Properties
  // ===========================================================================

  if (selectedClip) {
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
            value={`${clipDuration?.toFixed(2)}s`}
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

        {/* Effects Section */}
        <div className="mt-6 pt-4 border-t border-editor-border">
          <EffectsList
            effects={selectedClip.effects ?? []}
            selectedEffectId={selectedEffectId}
            onSelectEffect={handleEffectSelect}
            onToggleEffect={onEffectToggle ? handleEffectToggle : undefined}
            onRemoveEffect={onEffectRemove ? handleEffectRemove : undefined}
            onAddEffect={onAddEffect ? handleAddEffect : undefined}
          />
        </div>
      </div>
    );
  }

  // ===========================================================================
  // Render Asset Properties
  // ===========================================================================

  if (selectedAsset) {
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

  // ===========================================================================
  // Render Caption Properties
  // ===========================================================================

  if (selectedCaption) {
    const captionPosition = normalizeCaptionPosition(selectedCaption.position);

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
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return <></>;
}
