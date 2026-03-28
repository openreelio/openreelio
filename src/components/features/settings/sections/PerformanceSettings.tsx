/**
 * PerformanceSettings Component
 *
 * Performance and GPU acceleration settings for rendering and proxy workflows.
 */

import { useCallback } from 'react';
import type { PerformanceSettings as PerformanceSettingsType } from '@/stores/settingsStore';
import { GpuDeviceSelector } from './GpuDeviceSelector';

interface PerformanceSettingsProps {
  settings: PerformanceSettingsType;
  onUpdate: (values: Partial<PerformanceSettingsType>) => void;
  disabled?: boolean;
}

export function PerformanceSettings({
  settings,
  onUpdate,
  disabled = false,
}: PerformanceSettingsProps) {
  const handleHardwareAccelerationChange = useCallback(
    (enabled: boolean) => {
      onUpdate({ hardwareAcceleration: enabled });
    },
    [onUpdate],
  );

  const handleGpuDeviceChange = useCallback(
    (deviceId: string | null) => {
      onUpdate({ gpuDeviceId: deviceId });
    },
    [onUpdate],
  );

  return (
    <div className="space-y-6">
      <div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.hardwareAcceleration}
            onChange={(e) => handleHardwareAccelerationChange(e.target.checked)}
            disabled={disabled}
            className="w-4 h-4 rounded border-editor-border bg-editor-bg text-primary-500 focus:ring-primary-500/50 focus:ring-offset-0"
          />
          <div>
            <span className="text-sm text-editor-text">Hardware acceleration</span>
            <p className="text-xs text-editor-text-muted">
              Uses detected GPU encoders for export when available
            </p>
          </div>
        </label>
      </div>

      <GpuDeviceSelector
        gpuDeviceId={settings.gpuDeviceId}
        hardwareAcceleration={settings.hardwareAcceleration}
        onDeviceChange={handleGpuDeviceChange}
        disabled={disabled}
      />

      <div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.proxyGeneration}
            onChange={(e) => onUpdate({ proxyGeneration: e.target.checked })}
            disabled={disabled}
            className="w-4 h-4 rounded border-editor-border bg-editor-bg text-primary-500 focus:ring-primary-500/50 focus:ring-offset-0"
          />
          <div>
            <span className="text-sm text-editor-text">Proxy generation</span>
            <p className="text-xs text-editor-text-muted">
              Automatically create lighter playback media for large video assets
            </p>
          </div>
        </label>
      </div>

      <div>
        <label
          htmlFor="proxyResolution"
          className="block text-sm font-medium text-editor-text mb-2"
        >
          Proxy resolution
        </label>
        <select
          id="proxyResolution"
          value={settings.proxyResolution}
          onChange={(e) =>
            onUpdate({
              proxyResolution: e.target.value as PerformanceSettingsType['proxyResolution'],
            })
          }
          disabled={disabled}
          className="w-full px-3 py-2 bg-editor-bg border border-editor-border rounded-lg text-editor-text focus:outline-none focus:ring-2 focus:ring-primary-500/50 disabled:opacity-50"
        >
          <option value="720p">720p</option>
          <option value="480p">480p</option>
          <option value="360p">360p</option>
        </select>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label
            htmlFor="maxConcurrentJobs"
            className="block text-sm font-medium text-editor-text mb-2"
          >
            Max concurrent jobs
          </label>
          <input
            id="maxConcurrentJobs"
            type="number"
            min={1}
            max={32}
            value={settings.maxConcurrentJobs}
            onChange={(e) =>
              onUpdate({
                maxConcurrentJobs: Math.max(1, Number.parseInt(e.target.value, 10) || 1),
              })
            }
            disabled={disabled}
            className="w-full px-3 py-2 bg-editor-bg border border-editor-border rounded-lg text-editor-text focus:outline-none focus:ring-2 focus:ring-primary-500/50 disabled:opacity-50"
          />
        </div>

        <div>
          <label
            htmlFor="memoryLimitMb"
            className="block text-sm font-medium text-editor-text mb-2"
          >
            Memory limit (MB)
          </label>
          <input
            id="memoryLimitMb"
            type="number"
            min={0}
            value={settings.memoryLimitMb}
            onChange={(e) => {
              const value = Number.parseInt(e.target.value || '0', 10);
              onUpdate({ memoryLimitMb: Number.isNaN(value) ? 0 : Math.max(0, value) });
            }}
            disabled={disabled}
            className="w-full px-3 py-2 bg-editor-bg border border-editor-border rounded-lg text-editor-text focus:outline-none focus:ring-2 focus:ring-primary-500/50 disabled:opacity-50"
          />
          <p className="mt-1 text-xs text-editor-text-muted">Use 0 for automatic memory sizing</p>
        </div>

        <div>
          <label htmlFor="cacheSizeMb" className="block text-sm font-medium text-editor-text mb-2">
            Cache size (MB)
          </label>
          <input
            id="cacheSizeMb"
            type="number"
            min={128}
            value={settings.cacheSizeMb}
            onChange={(e) => {
              const value = Number.parseInt(e.target.value, 10);
              onUpdate({ cacheSizeMb: Number.isNaN(value) ? 128 : Math.max(128, value) });
            }}
            disabled={disabled}
            className="w-full px-3 py-2 bg-editor-bg border border-editor-border rounded-lg text-editor-text focus:outline-none focus:ring-2 focus:ring-primary-500/50 disabled:opacity-50"
          />
        </div>
      </div>
    </div>
  );
}
