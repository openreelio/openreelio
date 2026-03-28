/**
 * GpuDeviceSelector — GPU device detection and selection sub-component.
 *
 * Extracted from PerformanceSettings to keep each component under 200 lines.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { commands, type GpuAccelerationStatus } from '@/bindings';
import { isDesktopRuntimeAvailable } from '@/services/runtimeEnvironment';

interface GpuDeviceSelectorProps {
  /** Currently selected GPU device ID (null = auto) */
  gpuDeviceId: string | null;
  /** Whether hardware acceleration is enabled */
  hardwareAcceleration: boolean;
  /** Called when the user picks a different device */
  onDeviceChange: (deviceId: string | null) => void;
  disabled?: boolean;
}

const AUTO_DEVICE_VALUE = '__auto__';

/** Returns a human-readable capability summary for the device dropdown. */
function describeDevice(device: GpuAccelerationStatus['devices'][number]): string {
  const capabilities = [];

  if (device.hasDecode) capabilities.push('decode');
  if (device.hasEncode) capabilities.push('encode');
  if (device.isPrimary) capabilities.push('primary');

  return capabilities.length > 0 ? `${device.vendor} · ${capabilities.join(' / ')}` : device.vendor;
}

export function GpuDeviceSelector({
  gpuDeviceId,
  hardwareAcceleration,
  onDeviceChange,
  disabled = false,
}: GpuDeviceSelectorProps): React.JSX.Element {
  const [gpuStatus, setGpuStatus] = useState<GpuAccelerationStatus | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [gpuError, setGpuError] = useState<string | null>(null);

  const tauriRuntime = isDesktopRuntimeAvailable();

  const refreshGpuStatus = useCallback(async () => {
    if (!tauriRuntime) {
      setGpuStatus(null);
      setGpuError(null);
      return;
    }

    setIsDetecting(true);
    setGpuError(null);

    try {
      const result = await commands.detectGpuDevices();
      if (result.status === 'error') {
        setGpuError(String(result.error));
        setGpuStatus(null);
        return;
      }

      setGpuStatus(result.data);
    } catch (error) {
      setGpuError(error instanceof Error ? error.message : String(error));
      setGpuStatus(null);
    } finally {
      setIsDetecting(false);
    }
  }, [tauriRuntime]);

  useEffect(() => {
    void refreshGpuStatus();
  }, [refreshGpuStatus]);

  const detectedDevices = useMemo(() => gpuStatus?.devices ?? [], [gpuStatus]);
  const selectedDeviceMissing = Boolean(
    gpuDeviceId &&
    detectedDevices.length > 0 &&
    !detectedDevices.some((device) => device.id === gpuDeviceId),
  );

  const selectedDeviceValue = useMemo(() => {
    if (!gpuDeviceId) return AUTO_DEVICE_VALUE;
    return detectedDevices.some((device) => device.id === gpuDeviceId)
      ? gpuDeviceId
      : AUTO_DEVICE_VALUE;
  }, [detectedDevices, gpuDeviceId]);

  const handleDeviceChange = useCallback(
    (value: string) => {
      onDeviceChange(value === AUTO_DEVICE_VALUE ? null : value);
    },
    [onDeviceChange],
  );

  return (
    <div className="rounded-lg border border-editor-border bg-editor-sidebar/40 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-editor-text">GPU device</h3>
          <p className="text-xs text-editor-text-muted">
            The selected device is used for hardware export when acceleration is enabled
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshGpuStatus()}
          disabled={disabled || isDetecting || !tauriRuntime}
          className="inline-flex items-center gap-2 rounded-lg border border-editor-border px-3 py-1.5 text-xs text-editor-text hover:bg-editor-bg disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isDetecting ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {!tauriRuntime && (
        <p className="text-xs text-editor-text-muted">
          GPU detection is only available inside the desktop app runtime.
        </p>
      )}

      {gpuError && (
        <p className="text-xs text-red-400">Failed to detect GPU devices: {gpuError}</p>
      )}

      {tauriRuntime && !gpuError && detectedDevices.length === 0 && !isDetecting && (
        <p className="text-xs text-editor-text-muted">
          No hardware encoders or decoders were detected. Exports will use CPU mode.
        </p>
      )}

      <div>
        <label htmlFor="gpuDeviceId" className="block text-sm font-medium text-editor-text mb-2">
          Preferred GPU
        </label>
        <select
          id="gpuDeviceId"
          value={selectedDeviceValue}
          onChange={(e) => handleDeviceChange(e.target.value)}
          disabled={disabled || !hardwareAcceleration || detectedDevices.length === 0}
          className="w-full px-3 py-2 bg-editor-bg border border-editor-border rounded-lg text-editor-text focus:outline-none focus:ring-2 focus:ring-primary-500/50 disabled:opacity-50"
        >
          <option value={AUTO_DEVICE_VALUE}>Auto-select best available GPU</option>
          {detectedDevices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.name} ({describeDevice(device)})
            </option>
          ))}
        </select>
        {selectedDeviceMissing && (
          <p className="mt-1 text-xs text-amber-400">
            The previously selected GPU is no longer available. Auto-select will be used.
          </p>
        )}
        {gpuStatus && (
          <p className="mt-1 text-xs text-editor-text-muted">
            Detected {gpuStatus.devices.length} device(s),{' '}
            {gpuStatus.availableEncoders.hardware.length} encoder backend(s),{' '}
            {gpuStatus.availableDecoders.hardware.length} decoder backend(s)
          </p>
        )}
      </div>
    </div>
  );
}
