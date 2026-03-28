/**
 * PerformancePanel
 *
 * Real-time performance monitoring panel displaying CPU, RAM, GPU,
 * disk I/O, FPS, and dropped frame metrics. Designed as a bottom
 * panel tab in the editor layout.
 *
 * @module components/features/dev/PerformancePanel
 */

import React, { memo } from 'react';
import { Cpu, HardDrive, MemoryStick, MonitorDot, Gauge, AlertTriangle } from 'lucide-react';
import { usePerformancePanel } from '@/hooks/usePerformancePanel';

// =============================================================================
// Helpers
// =============================================================================

/** Formats bytes into a human-readable string (KB, MB, GB) */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Returns a Tailwind color class based on a percentage value */
function usageColor(percent: number): string {
  if (percent >= 90) return 'bg-red-500';
  if (percent >= 70) return 'bg-yellow-500';
  return 'bg-emerald-500';
}

/** Returns a text color for FPS display */
function fpsColor(fps: number): string {
  if (fps >= 55) return 'text-emerald-400';
  if (fps >= 30) return 'text-yellow-400';
  return 'text-red-400';
}

// =============================================================================
// Sub-components
// =============================================================================

interface BarProps {
  label: string;
  value: string;
  percent: number;
  icon: React.ReactNode;
}

/** Compact progress bar with label, icon, and percentage */
const MetricBar = memo(function MetricBar({ label, value, percent, icon }: BarProps) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="flex items-center gap-2 min-w-0" role="meter" aria-label={label} aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
      <span className="text-neutral-400 shrink-0">{icon}</span>
      <span className="text-xs text-neutral-300 w-12 shrink-0 truncate">{label}</span>
      <div className="flex-1 h-3 bg-neutral-700 rounded-sm overflow-hidden" aria-hidden="true">
        <div
          className={`h-full transition-all duration-300 ${usageColor(clamped)}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="text-xs text-neutral-300 w-20 text-right shrink-0 tabular-nums">{value}</span>
    </div>
  );
});

interface StatProps {
  label: string;
  value: string;
  icon: React.ReactNode;
  valueClass?: string;
}

/** Inline stat with icon */
const MetricStat = memo(function MetricStat({ label, value, icon, valueClass = 'text-neutral-200' }: StatProps) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-neutral-400">{icon}</span>
      <span className="text-xs text-neutral-400">{label}</span>
      <span className={`text-xs font-mono font-medium ${valueClass}`}>{value}</span>
    </div>
  );
});

// =============================================================================
// Main Component
// =============================================================================

export interface PerformancePanelProps {
  /** Whether the panel is visible (controls polling) */
  isVisible?: boolean;
}

/** Real-time performance monitoring panel for the bottom panel tab. */
export const PerformancePanel = memo(function PerformancePanel({
  isVisible = true,
}: PerformancePanelProps) {
  const { system, fpsMetrics, gpuName, isSupported, isLoading, error, refresh } =
    usePerformancePanel(isVisible);

  if (!isSupported) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-400 text-sm">
        Performance monitoring is only available in the desktop app runtime.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-400 text-sm">
        Loading metrics...
      </div>
    );
  }

  if (error && !system) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-red-400 text-sm">
        <AlertTriangle className="w-4 h-4" />
        <span>Failed to load metrics: {error}</span>
        <button onClick={refresh} className="ml-2 underline text-neutral-300 hover:text-neutral-100">
          Retry
        </button>
      </div>
    );
  }

  const ramPercent = system ? (system.ramUsedBytes / system.ramTotalBytes) * 100 : 0;
  const diskPercent = system && system.diskTotalBytes > 0
    ? ((system.diskTotalBytes - system.diskAvailableBytes) / system.diskTotalBytes) * 100
    : 0;

  return (
    <div className="flex flex-col gap-2 p-3 h-full overflow-y-auto text-sm" data-testid="performance-panel">
      {/* Row 1: Bars — CPU, RAM, Disk */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <MetricBar
          label="CPU"
          icon={<Cpu className="w-3.5 h-3.5" />}
          percent={system?.cpuUsagePercent ?? 0}
          value={`${(system?.cpuUsagePercent ?? 0).toFixed(1)}% (${system?.cpuCoreCount ?? 0} cores)`}
        />
        <MetricBar
          label="RAM"
          icon={<MemoryStick className="w-3.5 h-3.5" />}
          percent={ramPercent}
          value={`${formatBytes(system?.ramUsedBytes ?? 0)} / ${formatBytes(system?.ramTotalBytes ?? 0)}`}
        />
        <MetricBar
          label="Disk"
          icon={<HardDrive className="w-3.5 h-3.5" />}
          percent={diskPercent}
          value={`${formatBytes(system?.diskAvailableBytes ?? 0)} free`}
        />
      </div>

      {/* Row 2: Inline stats — FPS, Dropped, GPU, Process, Disk I/O */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-neutral-700 pt-2">
        <MetricStat
          label="FPS"
          icon={<Gauge className="w-3.5 h-3.5" />}
          value={`${fpsMetrics.fps}`}
          valueClass={fpsColor(fpsMetrics.fps)}
        />
        <MetricStat
          label="Dropped"
          icon={<AlertTriangle className="w-3.5 h-3.5" />}
          value={`${fpsMetrics.droppedFrames}`}
          valueClass={fpsMetrics.droppedFrames > 0 ? 'text-yellow-400' : 'text-neutral-200'}
        />
        {gpuName && (
          <MetricStat
            label="GPU"
            icon={<MonitorDot className="w-3.5 h-3.5" />}
            value={gpuName}
          />
        )}
        <MetricStat
          label="Process"
          icon={<Cpu className="w-3.5 h-3.5" />}
          value={formatBytes(system?.processMemoryBytes ?? 0)}
        />
        <MetricStat
          label="Disk R/W"
          icon={<HardDrive className="w-3.5 h-3.5" />}
          value={`${formatBytes(system?.diskReadBytes ?? 0)} / ${formatBytes(system?.diskWriteBytes ?? 0)}`}
        />
      </div>
    </div>
  );
});
