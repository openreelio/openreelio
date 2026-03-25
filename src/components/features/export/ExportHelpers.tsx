/**
 * Export Helper Components
 *
 * Reusable sub-components for the ExportDialog.
 */

import {
  Monitor,
  Smartphone,
  Film,
  Globe,
  CheckCircle,
  XCircle,
  Loader2,
  X,
} from 'lucide-react';
import type { ExportPreset, ExportStatus, ExportPresetIcon, RenderQueueItem } from './types';

// =============================================================================
// Icon Map
// =============================================================================

const PRESET_ICONS: Record<ExportPresetIcon, typeof Monitor> = {
  monitor: Monitor,
  smartphone: Smartphone,
  film: Film,
  globe: Globe,
};

// =============================================================================
// PresetOption Component
// =============================================================================

export interface PresetOptionProps {
  /** Preset to display */
  preset: ExportPreset;
  /** Whether this preset is currently selected */
  isSelected: boolean;
  /** Callback when preset is selected */
  onSelect: () => void;
  /** Whether interaction is disabled */
  disabled: boolean;
}

/**
 * Individual export preset option button.
 */
export function PresetOption({
  preset,
  isSelected,
  onSelect,
  disabled,
}: PresetOptionProps): JSX.Element {
  const Icon = PRESET_ICONS[preset.icon];

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      data-testid={`preset-option-${preset.id}`}
      className={`
        flex items-center gap-3 p-3 rounded-lg border transition-colors text-left w-full
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
        ${
          isSelected
            ? 'border-primary-500 bg-primary-500/10'
            : 'border-editor-border hover:border-editor-text-muted'
        }
      `}
    >
      <div
        className={`p-2 rounded ${
          isSelected ? 'bg-primary-500 text-white' : 'bg-editor-bg text-editor-text-muted'
        }`}
      >
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p
          className={`font-medium text-sm truncate ${
            isSelected ? 'text-primary-400' : 'text-editor-text'
          }`}
        >
          {preset.name}
        </p>
        <p className="text-xs text-editor-text-muted truncate">{preset.description}</p>
      </div>
    </button>
  );
}

// =============================================================================
// ProgressDisplay Component
// =============================================================================

export interface ProgressDisplayProps {
  /** Current export status */
  status: ExportStatus;
  /** Callback when close is clicked */
  onClose: () => void;
  /** Callback when retry is clicked */
  onRetry: () => void;
}

/**
 * Display export progress, completion, or error state.
 */
export function ProgressDisplay({
  status,
  onClose,
  onRetry,
}: ProgressDisplayProps): JSX.Element {
  if (status.type === 'exporting') {
    // Validate and clamp progress value to 0-100 range
    const progress = Math.max(0, Math.min(100, Number(status.progress) || 0));

    return (
      <div className="py-8 text-center" data-testid="export-progress">
        <Loader2 className="w-12 h-12 mx-auto text-primary-500 animate-spin mb-4" />
        <p className="text-editor-text font-medium mb-2">Exporting...</p>
        <p className="text-sm text-editor-text-muted mb-4">{status.message}</p>
        <div className="w-full bg-editor-bg rounded-full h-2 mb-2">
          <div
            className="bg-primary-500 h-2 rounded-full transition-all duration-300"
            style={{ width: `${progress}%` }}
            data-testid="export-progress-bar"
          />
        </div>
        <p className="text-xs text-editor-text-muted">{Math.round(progress)}%</p>
      </div>
    );
  }

  if (status.type === 'completed') {
    // Safely format duration value
    const duration = typeof status.duration === 'number' && !isNaN(status.duration)
      ? status.duration.toFixed(1)
      : '0.0';

    return (
      <div className="py-8 text-center" data-testid="export-completed">
        <CheckCircle className="w-12 h-12 mx-auto text-green-500 mb-4" />
        <p className="text-editor-text font-medium mb-2">Export Completed!</p>
        <p className="text-sm text-editor-text-muted mb-4">
          Saved to: <span className="text-editor-text">{status.outputPath}</span>
        </p>
        <p className="text-xs text-editor-text-muted">
          Duration: {duration}s
        </p>
        <button
          onClick={onClose}
          className="mt-6 px-6 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
        >
          Done
        </button>
      </div>
    );
  }

  if (status.type === 'failed') {
    return (
      <div className="py-8 text-center" data-testid="export-failed">
        <XCircle className="w-12 h-12 mx-auto text-red-500 mb-4" />
        <p className="text-editor-text font-medium mb-2">Export Failed</p>
        <p className="text-sm text-red-400 mb-6">{status.error}</p>
        <div className="flex justify-center gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-editor-text hover:bg-editor-bg rounded-lg transition-colors"
          >
            Close
          </button>
          <button
            onClick={onRetry}
            className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return <></>;
}

// =============================================================================
// RenderQueuePanel Component
// =============================================================================

export interface RenderQueuePanelProps {
  /** Items in the render queue */
  queue: RenderQueueItem[];
  /** Whether the batch is currently rendering */
  isBatchRendering: boolean;
  /** Overall batch progress (0-100) */
  batchProgress: number;
  /** Cancel a specific job */
  onCancelJob: (jobId: string) => void;
  /** Remove a pending item */
  onRemoveItem: (jobId: string) => void;
}

const STATUS_LABELS: Record<RenderQueueItem['status'], string> = {
  pending: 'Pending',
  rendering: 'Rendering',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_COLORS: Record<RenderQueueItem['status'], string> = {
  pending: 'text-editor-text-muted',
  rendering: 'text-primary-400',
  completed: 'text-green-400',
  failed: 'text-red-400',
  cancelled: 'text-yellow-400',
};

// =============================================================================
// OutputLocationField Component
// =============================================================================

export interface OutputLocationFieldProps {
  outputPath: string;
  onBrowse: () => void;
  disabled: boolean;
}

/** File output path display with Browse button. */
export function OutputLocationField({ outputPath, onBrowse, disabled }: OutputLocationFieldProps): JSX.Element {
  return (
    <div>
      <label className="block text-sm font-medium text-editor-text mb-2">Output File</label>
      <div className="flex gap-2">
        <input
          type="text" value={outputPath} readOnly
          className="flex-1 px-3 py-2 bg-editor-bg border border-editor-border rounded-lg text-editor-text text-sm truncate"
          placeholder="Select output location"
        />
        <button
          type="button" onClick={onBrowse} disabled={disabled}
          className="px-4 py-2 bg-editor-sidebar border border-editor-border rounded-lg text-editor-text hover:bg-editor-bg transition-colors disabled:opacity-50"
        >
          Browse
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// RangeControls Component
// =============================================================================

export interface RangeControlsProps {
  useRange: boolean;
  onUseRangeChange: (value: boolean) => void;
  inPoint: number;
  onInPointChange: (value: number) => void;
  outPoint: number;
  onOutPointChange: (value: number) => void;
  disabled: boolean;
}

/** Range export toggle and In/Out point inputs. */
export function RangeControls({
  useRange, onUseRangeChange, inPoint, onInPointChange,
  outPoint, onOutPointChange, disabled,
}: RangeControlsProps): JSX.Element {
  return (
    <>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={useRange}
          onChange={(e) => onUseRangeChange(e.target.checked)}
          disabled={disabled}
          className="rounded border-editor-border bg-editor-bg text-primary-500 focus:ring-primary-500"
          data-testid="range-export-checkbox"
        />
        <span className="text-sm text-editor-text">Render In/Out Range</span>
      </label>
      {useRange && (
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-xs text-editor-text-muted mb-1">In (sec)</label>
            <input
              type="number" min={0} step={0.1} value={inPoint}
              onChange={(e) => onInPointChange(Number(e.target.value))}
              className="w-full px-2 py-1 bg-editor-bg border border-editor-border rounded text-editor-text text-sm"
              data-testid="range-in-point"
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-editor-text-muted mb-1">Out (sec)</label>
            <input
              type="number" min={0} step={0.1} value={outPoint}
              onChange={(e) => onOutPointChange(Number(e.target.value))}
              className="w-full px-2 py-1 bg-editor-bg border border-editor-border rounded text-editor-text text-sm"
              data-testid="range-out-point"
            />
          </div>
        </div>
      )}
    </>
  );
}

// =============================================================================
// RenderQueuePanel Component
// =============================================================================

/** Render queue panel showing all items with status and progress. */
export function RenderQueuePanel({
  queue,
  isBatchRendering,
  batchProgress,
  onCancelJob,
  onRemoveItem,
}: RenderQueuePanelProps): JSX.Element | null {
  if (queue.length === 0) return null;

  return (
    <div className="space-y-3" data-testid="render-queue-panel">
      {/* Overall progress */}
      {isBatchRendering && (
        <div className="p-3 bg-editor-bg rounded-lg">
          <div className="flex justify-between text-xs text-editor-text-muted mb-1">
            <span>Batch Progress</span>
            <span>{Math.round(batchProgress)}%</span>
          </div>
          <div className="w-full bg-editor-panel rounded-full h-1.5">
            <div
              className="bg-primary-500 h-1.5 rounded-full transition-all duration-300"
              style={{ width: `${Math.min(100, batchProgress)}%` }}
            />
          </div>
        </div>
      )}

      {/* Queue items */}
      <div className="space-y-1.5 max-h-48 overflow-y-auto">
        {queue.map((item) => (
          <div
            key={item.jobId}
            className="flex items-center gap-2 p-2 bg-editor-bg rounded-lg text-sm"
            data-testid={`queue-item-${item.jobId}`}
          >
            {/* Status indicator */}
            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{
              backgroundColor:
                item.status === 'rendering' ? '#3b82f6' :
                item.status === 'completed' ? '#22c55e' :
                item.status === 'failed' ? '#ef4444' :
                item.status === 'cancelled' ? '#eab308' : '#6b7280',
            }} />

            {/* Info */}
            <div className="flex-1 min-w-0">
              <p className="text-xs text-editor-text truncate">{item.presetName}</p>
              <p className="text-xs text-editor-text-muted truncate">{item.outputPath}</p>
              {item.inPoint !== undefined && item.outPoint !== undefined && (
                <p className="text-xs text-editor-text-muted">
                  Range: {item.inPoint.toFixed(1)}s - {item.outPoint.toFixed(1)}s
                </p>
              )}
            </div>

            {/* Progress or status */}
            <div className="flex items-center gap-2 flex-shrink-0">
              {item.status === 'rendering' && (
                <span className="text-xs text-primary-400">{Math.round(item.progress)}%</span>
              )}
              <span className={`text-xs ${STATUS_COLORS[item.status]}`}>
                {STATUS_LABELS[item.status]}
              </span>

              {/* Cancel button (rendering) */}
              {item.status === 'rendering' && (
                <button
                  onClick={() => onCancelJob(item.jobId)}
                  className="p-0.5 rounded hover:bg-editor-panel text-editor-text-muted hover:text-red-400"
                  aria-label="Cancel render"
                >
                  <X className="w-3 h-3" />
                </button>
              )}

              {/* Remove button (pending) */}
              {item.status === 'pending' && !isBatchRendering && (
                <button
                  onClick={() => onRemoveItem(item.jobId)}
                  className="p-0.5 rounded hover:bg-editor-panel text-editor-text-muted hover:text-red-400"
                  aria-label="Remove from queue"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
