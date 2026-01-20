/**
 * MemoryProfiler Component
 *
 * Developer panel for monitoring memory usage in real-time.
 * Shows pool stats, cache stats, and memory trends.
 * Only visible in development mode.
 *
 * @module components/features/dev/MemoryProfiler
 */

import { useState, useCallback, useMemo } from 'react';
import {
  Activity,
  Database,
  HardDrive,
  Trash2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  X,
} from 'lucide-react';
import {
  useMemoryMonitor,
  formatBytes,
  calculateTrend,
} from '@/hooks/useMemoryMonitor';

// =============================================================================
// Types
// =============================================================================

export interface MemoryProfilerProps {
  /** Whether the panel is visible */
  isOpen?: boolean;
  /** Callback when panel is closed */
  onClose?: () => void;
  /** Position of the panel */
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  /** Polling interval in milliseconds */
  intervalMs?: number;
}

// =============================================================================
// Constants
// =============================================================================

const MEMORY_WARNING_THRESHOLD_PERCENT = 80;
const CACHE_HIT_RATE_WARNING_THRESHOLD = 0.5;

// =============================================================================
// Sub-components
// =============================================================================

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  subValue?: string;
  trend?: 'up' | 'down' | 'stable';
  warning?: boolean;
}

function StatCard({ icon, label, value, subValue, trend, warning }: StatCardProps): JSX.Element {
  return (
    <div
      className={`
        flex items-center gap-2 p-2 rounded-md
        ${warning ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-editor-bg-tertiary'}
      `}
    >
      <div className={`${warning ? 'text-yellow-500' : 'text-editor-text-muted'}`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-editor-text-muted">{label}</div>
        <div className="text-sm font-medium text-editor-text flex items-center gap-1">
          {value}
          {trend === 'up' && <TrendingUp className="w-3 h-3 text-red-400" />}
          {trend === 'down' && <TrendingDown className="w-3 h-3 text-green-400" />}
          {trend === 'stable' && <Minus className="w-3 h-3 text-editor-text-muted" />}
        </div>
        {subValue && (
          <div className="text-xs text-editor-text-muted">{subValue}</div>
        )}
      </div>
    </div>
  );
}

interface ProgressBarProps {
  value: number;
  max: number;
  label: string;
  warningThreshold?: number;
}

function ProgressBar({ value, max, label, warningThreshold = 80 }: ProgressBarProps): JSX.Element {
  const percent = max > 0 ? (value / max) * 100 : 0;
  const isWarning = percent >= warningThreshold;

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-editor-text-muted">{label}</span>
        <span className={isWarning ? 'text-yellow-500' : 'text-editor-text'}>
          {percent.toFixed(1)}%
        </span>
      </div>
      <div className="h-1.5 bg-editor-bg-tertiary rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${
            isWarning ? 'bg-yellow-500' : 'bg-primary-500'
          }`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export function MemoryProfiler({
  isOpen = false,
  onClose,
  position = 'bottom-right',
  intervalMs = 5000,
}: MemoryProfilerProps): JSX.Element | null {
  // ===========================================================================
  // State
  // ===========================================================================

  const [isExpanded, setIsExpanded] = useState(true);
  const [isCleaningUp, setIsCleaningUp] = useState(false);

  // ===========================================================================
  // Hooks
  // ===========================================================================

  const {
    stats,
    isMonitoring,
    isLoading,
    error,
    start,
    stop,
    refresh,
    cleanup,
    history,
  } = useMemoryMonitor({
    intervalMs,
    autoStart: isOpen,
    includeJSHeap: true,
  });

  // ===========================================================================
  // Computed Values
  // ===========================================================================

  const trend = useMemo(() => calculateTrend(history), [history]);

  const hasMemoryWarning = useMemo(() => {
    if (!stats?.systemMemory) return false;
    return stats.systemMemory.usagePercent >= MEMORY_WARNING_THRESHOLD_PERCENT;
  }, [stats]);

  const hasCacheWarning = useMemo(() => {
    if (!stats?.cacheStats) return false;
    return stats.cacheStats.hitRate < CACHE_HIT_RATE_WARNING_THRESHOLD;
  }, [stats]);

  // ===========================================================================
  // Position Styles
  // ===========================================================================

  const positionStyles = useMemo(() => {
    switch (position) {
      case 'bottom-right':
        return 'bottom-4 right-4';
      case 'bottom-left':
        return 'bottom-4 left-4';
      case 'top-right':
        return 'top-4 right-4';
      case 'top-left':
        return 'top-4 left-4';
      default:
        return 'bottom-4 right-4';
    }
  }, [position]);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleToggleExpand = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const handleToggleMonitoring = useCallback(() => {
    if (isMonitoring) {
      stop();
    } else {
      start();
    }
  }, [isMonitoring, start, stop]);

  const handleCleanup = useCallback(async () => {
    setIsCleaningUp(true);
    try {
      const result = await cleanup();
      if (result) {
        console.info(
          `Memory cleanup: freed ${formatBytes(result.totalBytesFreed)}, ` +
          `evicted ${result.cacheEntriesEvicted} cache entries`
        );
      }
    } finally {
      setIsCleaningUp(false);
    }
  }, [cleanup]);

  // ===========================================================================
  // Early Return
  // ===========================================================================

  if (!isOpen) {
    return null;
  }

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div
      className={`
        fixed ${positionStyles} z-50
        bg-editor-bg-secondary border border-editor-border rounded-lg shadow-xl
        w-80 max-h-[80vh] overflow-hidden
        transition-all duration-200
      `}
      data-testid="memory-profiler"
    >
      {/* Header */}
      <div
        className="flex items-center justify-between p-3 border-b border-editor-border cursor-pointer"
        onClick={handleToggleExpand}
      >
        <div className="flex items-center gap-2">
          <Activity
            className={`w-4 h-4 ${
              hasMemoryWarning || hasCacheWarning ? 'text-yellow-500' : 'text-primary-500'
            }`}
          />
          <span className="text-sm font-semibold text-editor-text">Memory Profiler</span>
          {(hasMemoryWarning || hasCacheWarning) && (
            <AlertTriangle className="w-3 h-3 text-yellow-500" />
          )}
        </div>
        <div className="flex items-center gap-1">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-editor-text-muted" />
          ) : (
            <ChevronUp className="w-4 h-4 text-editor-text-muted" />
          )}
          {onClose && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="p-1 hover:bg-editor-bg-tertiary rounded"
              aria-label="Close memory profiler"
            >
              <X className="w-4 h-4 text-editor-text-muted" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      {isExpanded && (
        <div className="p-3 space-y-3 overflow-y-auto max-h-[calc(80vh-48px)]">
          {/* Error State */}
          {error && (
            <div className="p-2 bg-red-500/10 border border-red-500/30 rounded-md text-xs text-red-400">
              Error: {error}
            </div>
          )}

          {/* Loading State */}
          {isLoading && !stats && (
            <div className="flex items-center justify-center py-4">
              <RefreshCw className="w-5 h-5 animate-spin text-editor-text-muted" />
            </div>
          )}

          {/* Stats Display */}
          {stats && (
            <>
              {/* Backend Memory */}
              <div className="space-y-2">
                <div className="text-xs font-medium text-editor-text-muted uppercase tracking-wider">
                  Backend Memory
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <StatCard
                    icon={<HardDrive className="w-4 h-4" />}
                    label="Allocated"
                    value={formatBytes(stats.allocatedBytes)}
                    trend={trend === 'increasing' ? 'up' : trend === 'decreasing' ? 'down' : 'stable'}
                    warning={trend === 'increasing'}
                  />
                  <StatCard
                    icon={<Database className="w-4 h-4" />}
                    label="Pool Used"
                    value={formatBytes(stats.poolStats.usedSizeBytes)}
                    subValue={`${stats.poolStats.allocatedBlocks}/${stats.poolStats.totalBlocks} blocks`}
                  />
                </div>
              </div>

              {/* Pool Stats */}
              <div className="space-y-2">
                <div className="text-xs font-medium text-editor-text-muted uppercase tracking-wider">
                  Pool Performance
                </div>
                <ProgressBar
                  value={stats.poolStats.poolHits}
                  max={stats.poolStats.poolHits + stats.poolStats.poolMisses}
                  label="Pool Hit Rate"
                />
                <div className="flex justify-between text-xs text-editor-text-muted">
                  <span>Hits: {stats.poolStats.poolHits.toLocaleString()}</span>
                  <span>Misses: {stats.poolStats.poolMisses.toLocaleString()}</span>
                </div>
              </div>

              {/* Cache Stats */}
              <div className="space-y-2">
                <div className="text-xs font-medium text-editor-text-muted uppercase tracking-wider">
                  Cache Performance
                </div>
                <ProgressBar
                  value={stats.cacheStats.hitRate * 100}
                  max={100}
                  label="Cache Hit Rate"
                  warningThreshold={50}
                />
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="text-editor-text-muted">
                    Entries: {stats.cacheStats.entryCount.toLocaleString()}
                  </div>
                  <div className="text-editor-text-muted text-right">
                    Size: {formatBytes(stats.cacheStats.totalSizeBytes)}
                  </div>
                  <div className="text-editor-text-muted">
                    Evictions: {stats.cacheStats.evictions.toLocaleString()}
                  </div>
                  <div className="text-editor-text-muted text-right">
                    Hits: {stats.cacheStats.hits.toLocaleString()}
                  </div>
                </div>
              </div>

              {/* System Memory */}
              {stats.systemMemory && (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-editor-text-muted uppercase tracking-wider">
                    System Memory
                  </div>
                  <ProgressBar
                    value={stats.systemMemory.usedBytes}
                    max={stats.systemMemory.totalBytes}
                    label="System Usage"
                  />
                  <div className="flex justify-between text-xs text-editor-text-muted">
                    <span>Used: {formatBytes(stats.systemMemory.usedBytes)}</span>
                    <span>Total: {formatBytes(stats.systemMemory.totalBytes)}</span>
                  </div>
                </div>
              )}

              {/* JS Heap */}
              {stats.jsHeap && (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-editor-text-muted uppercase tracking-wider">
                    JS Heap
                  </div>
                  <ProgressBar
                    value={stats.jsHeap.usedJSHeapSize}
                    max={stats.jsHeap.jsHeapSizeLimit}
                    label="Heap Usage"
                  />
                  <div className="flex justify-between text-xs text-editor-text-muted">
                    <span>Used: {formatBytes(stats.jsHeap.usedJSHeapSize)}</span>
                    <span>Limit: {formatBytes(stats.jsHeap.jsHeapSizeLimit)}</span>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-2 border-t border-editor-border">
            <button
              onClick={handleToggleMonitoring}
              className={`
                flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
                ${isMonitoring
                  ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                  : 'bg-primary-500/20 text-primary-400 hover:bg-primary-500/30'
                }
                transition-colors
              `}
            >
              <Activity className="w-3 h-3" />
              {isMonitoring ? 'Stop' : 'Start'}
            </button>
            <button
              onClick={() => void refresh()}
              disabled={isLoading}
              className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
                bg-editor-bg-tertiary text-editor-text hover:bg-editor-border
                disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button
              onClick={() => void handleCleanup()}
              disabled={isCleaningUp}
              className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
                bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30
                disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Trash2 className={`w-3 h-3 ${isCleaningUp ? 'animate-pulse' : ''}`} />
              Cleanup
            </button>
          </div>

          {/* Footer Info */}
          <div className="text-xs text-editor-text-muted text-center">
            {history.length > 0 && (
              <span>Last updated: {new Date(history[history.length - 1].timestamp).toLocaleTimeString()}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default MemoryProfiler;
