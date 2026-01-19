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
} from 'lucide-react';
import type { ExportPreset, ExportStatus, ExportPresetIcon } from './types';

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
    return (
      <div className="py-8 text-center" data-testid="export-progress">
        <Loader2 className="w-12 h-12 mx-auto text-primary-500 animate-spin mb-4" />
        <p className="text-editor-text font-medium mb-2">Exporting...</p>
        <p className="text-sm text-editor-text-muted mb-4">{status.message}</p>
        <div className="w-full bg-editor-bg rounded-full h-2 mb-2">
          <div
            className="bg-primary-500 h-2 rounded-full transition-all duration-300"
            style={{ width: `${status.progress}%` }}
            data-testid="export-progress-bar"
          />
        </div>
        <p className="text-xs text-editor-text-muted">{Math.round(status.progress)}%</p>
      </div>
    );
  }

  if (status.type === 'completed') {
    return (
      <div className="py-8 text-center" data-testid="export-completed">
        <CheckCircle className="w-12 h-12 mx-auto text-green-500 mb-4" />
        <p className="text-editor-text font-medium mb-2">Export Completed!</p>
        <p className="text-sm text-editor-text-muted mb-4">
          Saved to: <span className="text-editor-text">{status.outputPath}</span>
        </p>
        <p className="text-xs text-editor-text-muted">
          Duration: {status.duration.toFixed(1)}s
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
