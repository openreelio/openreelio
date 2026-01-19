/**
 * Inspector Component
 *
 * Property inspector panel for selected clips and assets.
 * Displays and allows editing of properties.
 */

import { useMemo, useState, useCallback } from 'react';
import { Film, Music, Image as ImageIcon, FileText, Info, Clock, Maximize } from 'lucide-react';
import { formatDuration } from '@/utils';
import { EffectsList } from '../effects';
import type { Effect, EffectId } from '@/types';

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

/** Inspector component props */
export interface InspectorProps {
  /** Currently selected clip */
  selectedClip?: SelectedClip;
  /** Currently selected asset */
  selectedAsset?: SelectedAsset;
  /** Callback when clip property changes */
  onClipChange?: (clipId: string, property: string, value: unknown) => void;
  /** Callback when an effect is toggled */
  onEffectToggle?: (clipId: string, effectId: EffectId, enabled: boolean) => void;
  /** Callback when an effect is removed */
  onEffectRemove?: (clipId: string, effectId: EffectId) => void;
  /** Callback when add effect is requested */
  onAddEffect?: (clipId: string) => void;
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
      <span
        data-testid={testId}
        className="text-editor-text text-sm font-medium"
      >
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
  selectedAsset,
  onEffectToggle,
  onEffectRemove,
  onAddEffect,
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
    [selectedClip, onEffectToggle]
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
    [selectedClip, onEffectRemove, selectedEffectId]
  );

  const handleAddEffect = useCallback(() => {
    if (selectedClip && onAddEffect) {
      onAddEffect(selectedClip.id);
    }
  }, [selectedClip, onAddEffect]);

  // ===========================================================================
  // Render Empty State
  // ===========================================================================

  if (!selectedClip && !selectedAsset) {
    return (
      <div
        data-testid="inspector"
        role="complementary"
        aria-label="Properties inspector"
        className="flex flex-col items-center justify-center h-full p-4 text-center"
      >
        <Info className="w-12 h-12 text-editor-text-muted opacity-50 mb-3" />
        <p className="text-editor-text-muted text-sm">
          No selection
        </p>
        <p className="text-editor-text-muted text-xs mt-1">
          Select a clip or asset to view properties
        </p>
      </div>
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
          <PropertyRow
            label="Name"
            value={selectedClip.name}
            testId="clip-name"
          />
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
          <PropertyRow
            label="Name"
            value={selectedAsset.name}
            testId="asset-name"
          />
          <PropertyRow
            label="Type"
            value={selectedAsset.kind}
            testId="asset-type"
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

        <div className="mt-4 pt-4 border-t border-editor-border">
          <p className="text-xs text-editor-text-muted truncate" title={selectedAsset.uri}>
            {selectedAsset.uri}
          </p>
        </div>
      </div>
    );
  }

  return <></>;
}
