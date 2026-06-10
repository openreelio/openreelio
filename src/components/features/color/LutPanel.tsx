/**
 * LUT panel for finishing-grade lookup table controls.
 */

import { memo, useCallback } from 'react';
import { Folder, RotateCcw, X } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import type { SimpleParamValue } from '@/types';

export type LutInterpolation = 'nearest' | 'trilinear' | 'tetrahedral';

export interface LutPanelProps {
  params: Record<string, SimpleParamValue>;
  onChange: (paramName: string, value: SimpleParamValue) => void;
  readOnly?: boolean;
}

const LUT_INTERPOLATION_OPTIONS: LutInterpolation[] = ['nearest', 'trilinear', 'tetrahedral'];
const LUT_FILE_EXTENSIONS = ['cube', '3dl', 'lut'];

function getLutFile(params: Record<string, SimpleParamValue>): string {
  return typeof params.file === 'string' ? params.file : '';
}

function getInterpolation(params: Record<string, SimpleParamValue>): LutInterpolation {
  return LUT_INTERPOLATION_OPTIONS.includes(params.interp as LutInterpolation)
    ? (params.interp as LutInterpolation)
    : 'tetrahedral';
}

function getIntensity(params: Record<string, SimpleParamValue>): number {
  const value = typeof params.intensity === 'number' ? params.intensity : 1;
  return Math.max(0, Math.min(1, value));
}

function formatIntensity(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export const LutPanel = memo(function LutPanel({
  params,
  onChange,
  readOnly = false,
}: LutPanelProps) {
  const file = getLutFile(params);
  const interpolation = getInterpolation(params);
  const intensity = getIntensity(params);
  const isActive = file.trim().length > 0;

  const handleBrowse = useCallback(async () => {
    if (readOnly) return;

    const selected = await open({
      multiple: false,
      filters: [{ name: 'LUT', extensions: LUT_FILE_EXTENSIONS }],
    });

    if (typeof selected === 'string') {
      onChange('file', selected);
    }
  }, [onChange, readOnly]);

  const handleClear = useCallback(() => {
    onChange('file', '');
  }, [onChange]);

  const handleReset = useCallback(() => {
    onChange('file', '');
    onChange('interp', 'tetrahedral');
    onChange('intensity', 1);
  }, [onChange]);

  return (
    <div className="space-y-3" data-testid="lut-panel">
      <div className="flex items-center justify-between">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] ${
            isActive ? 'bg-green-500/10 text-green-400' : 'bg-editor-border text-editor-text-muted'
          }`}
          data-testid="lut-status"
        >
          {isActive ? 'Active' : 'Inactive'}
        </span>
        <button
          type="button"
          onClick={handleReset}
          disabled={readOnly || (!isActive && interpolation === 'tetrahedral' && intensity === 1)}
          className="p-1 rounded text-editor-text-muted hover:text-editor-text hover:bg-editor-border disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Reset LUT"
          title="Reset LUT"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="lut-file" className="text-xs font-medium text-editor-text">
          LUT File
        </label>
        <div className="flex items-center gap-2">
          <input
            id="lut-file"
            type="text"
            value={file}
            readOnly
            disabled={readOnly}
            placeholder="No file selected"
            className="min-w-0 flex-1 rounded border border-editor-border bg-editor-bg px-2 py-1 text-xs text-editor-text disabled:opacity-50"
          />
          {isActive && !readOnly && (
            <button
              type="button"
              onClick={handleClear}
              className="rounded border border-editor-border bg-editor-surface p-1 text-editor-text-muted hover:text-editor-text"
              aria-label="Clear LUT file"
              title="Clear LUT file"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={handleBrowse}
            disabled={readOnly}
            className="flex items-center gap-1 rounded border border-editor-border bg-editor-surface px-2 py-1 text-xs text-editor-text hover:bg-editor-border disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Browse LUT file"
          >
            <Folder className="w-3.5 h-3.5" />
            Browse
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-editor-text">Interpolation</span>
          <select
            value={interpolation}
            onChange={(event) => onChange('interp', event.target.value)}
            disabled={readOnly}
            className="w-full rounded border border-editor-border bg-editor-bg px-2 py-1 text-xs text-editor-text disabled:opacity-50"
            aria-label="LUT interpolation"
          >
            {LUT_INTERPOLATION_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1.5">
          <span className="flex items-center justify-between gap-2 text-xs font-medium text-editor-text">
            Intensity
            <span className="tabular-nums text-editor-text-muted">
              {formatIntensity(intensity)}
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={intensity}
            onChange={(event) => onChange('intensity', Number(event.target.value))}
            disabled={readOnly}
            className="w-full accent-primary-500 disabled:opacity-50"
            aria-label="LUT intensity"
          />
        </label>
      </div>
    </div>
  );
});

export default LutPanel;
