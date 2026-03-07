/**
 * DeveloperSettings Component
 *
 * Settings panel tab that displays agent execution traces for debugging
 * and observability. Shows a list of recent agent runs with expandable
 * detail views including phase timelines and tool call breakdowns.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ArrowLeft, RefreshCw, AlertTriangle } from 'lucide-react';
import type { AgentTrace, PhaseTrace } from '@/agents/engine/core/traceRecorder';
import type { AgentPhase } from '@/agents/engine/core/types';
import { commands, type TraceSummary } from '@/bindings';

type StatusFilter = 'all' | 'success' | 'failed';
type PathFilter = 'all' | 'fast_path' | 'full_tpao';

// =============================================================================
// Constants
// =============================================================================

const MAX_TRACES = 20;
const INPUT_TRUNCATE_LENGTH = 50;
const SLOW_RUN_THRESHOLD_MS = 10_000;

const PHASE_COLORS: Partial<Record<AgentPhase, string>> = {
  thinking: 'bg-blue-400',
  planning: 'bg-yellow-400',
  executing: 'bg-green-400',
  observing: 'bg-purple-400',
};

const PHASE_TEXT_COLORS: Partial<Record<AgentPhase, string>> = {
  thinking: 'text-blue-400',
  planning: 'text-yellow-400',
  executing: 'text-green-400',
  observing: 'text-purple-400',
};

// =============================================================================
// Helpers
// =============================================================================

function truncateInput(input: string): string {
  if (input.length <= INPUT_TRUNCATE_LENGTH) return input;
  return input.slice(0, INPUT_TRUNCATE_LENGTH) + '...';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatTokens(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

function countToolCalls(phases: PhaseTrace[]): number {
  return phases.reduce((sum, phase) => sum + phase.toolCalls.length, 0);
}

interface MetricsSummary {
  totalRuns: number;
  successRate: number;
  avgDurationMs: number;
  totalTokens: number;
  slowRunCount: number;
  topTools: Array<{ name: string; count: number; successRate: number }>;
}

function computeMetrics(traces: AgentTrace[]): MetricsSummary | null {
  if (traces.length === 0) return null;

  const successCount = traces.filter((t) => t.success).length;
  const totalDuration = traces.reduce((sum, t) => sum + t.totalDurationMs, 0);
  const totalTokens = traces.reduce((sum, t) => sum + t.tokenUsage.totalTokens, 0);
  const slowRunCount = traces.filter((t) => t.totalDurationMs > SLOW_RUN_THRESHOLD_MS).length;

  const toolStats = new Map<string, { total: number; success: number }>();
  for (const trace of traces) {
    for (const phase of trace.phases) {
      for (const call of phase.toolCalls) {
        const stat = toolStats.get(call.name) ?? { total: 0, success: 0 };
        stat.total++;
        if (call.success) stat.success++;
        toolStats.set(call.name, stat);
      }
    }
  }

  const topTools = Array.from(toolStats.entries())
    .map(([name, stat]) => ({
      name,
      count: stat.total,
      successRate: stat.total > 0 ? stat.success / stat.total : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    totalRuns: traces.length,
    successRate: successCount / traces.length,
    avgDurationMs: totalDuration / traces.length,
    totalTokens,
    slowRunCount,
    topTools,
  };
}

// =============================================================================
// Sub-Components
// =============================================================================

function StatusBadge({ success }: { success: boolean }): JSX.Element {
  return success ? (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-green-600/20 text-green-400">
      Success
    </span>
  ) : (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-red-600/20 text-red-400">
      Failed
    </span>
  );
}

function PhaseTimelineBar({
  phases,
  totalMs,
}: {
  phases: PhaseTrace[];
  totalMs: number;
}): JSX.Element {
  if (totalMs === 0 || phases.length === 0) {
    return <div className="h-3 rounded bg-editor-border" />;
  }

  return (
    <div className="flex h-3 rounded overflow-hidden bg-editor-border">
      {phases.map((phase, index) => {
        const widthPercent = Math.max((phase.durationMs / totalMs) * 100, 1);
        const colorClass = PHASE_COLORS[phase.phase] ?? 'bg-gray-500';
        return (
          <div
            key={`${phase.phase}-${index}`}
            className={`${colorClass} opacity-80`}
            style={{ width: `${widthPercent}%` }}
            title={`${phase.phase}: ${formatDuration(phase.durationMs)}`}
          />
        );
      })}
    </div>
  );
}

function PhaseTimlineLegend(): JSX.Element {
  const entries: Array<{ phase: AgentPhase; label: string }> = [
    { phase: 'thinking', label: 'Think' },
    { phase: 'planning', label: 'Plan' },
    { phase: 'executing', label: 'Execute' },
    { phase: 'observing', label: 'Observe' },
  ];

  return (
    <div className="flex gap-3 flex-wrap">
      {entries.map(({ phase, label }) => (
        <div key={phase} className="flex items-center gap-1.5">
          <div className={`w-2.5 h-2.5 rounded-sm ${PHASE_COLORS[phase] ?? ''} opacity-80`} />
          <span className="text-xs text-editor-text-muted">{label}</span>
        </div>
      ))}
    </div>
  );
}

function MetricsSummaryPanel({ metrics }: { metrics: MetricsSummary }): JSX.Element {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2">
        {[
          { label: 'Runs', value: String(metrics.totalRuns) },
          { label: 'Success', value: `${(metrics.successRate * 100).toFixed(0)}%` },
          { label: 'Avg Time', value: formatDuration(metrics.avgDurationMs) },
          { label: 'Tokens', value: formatTokens(metrics.totalTokens) },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="p-2 rounded-lg bg-editor-bg border border-editor-border text-center"
          >
            <div className="text-sm font-mono text-editor-text">{value}</div>
            <div className="text-xs text-editor-text-muted">{label}</div>
          </div>
        ))}
      </div>

      {metrics.slowRunCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-600/10 border border-yellow-600/20">
          <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />
          <span className="text-xs text-yellow-400">
            {metrics.slowRunCount} slow run{metrics.slowRunCount !== 1 ? 's' : ''} detected
            (&gt;10s)
          </span>
        </div>
      )}

      {metrics.topTools.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-editor-text-muted uppercase tracking-wide">
            Top Tools
          </h4>
          <div className="space-y-0.5">
            {metrics.topTools.map((tool) => (
              <div
                key={tool.name}
                className="flex items-center justify-between px-2 py-1 text-xs rounded bg-editor-bg border border-editor-border"
              >
                <span className="font-mono text-editor-text">{tool.name}</span>
                <div className="flex items-center gap-2 text-editor-text-muted">
                  <span>{tool.count}x</span>
                  <span className={tool.successRate < 0.8 ? 'text-yellow-400' : 'text-green-400'}>
                    {(tool.successRate * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TraceDetailView({
  trace,
  onBack,
}: {
  trace: AgentTrace;
  onBack: () => void;
}): JSX.Element {
  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-editor-text-muted hover:text-editor-text transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to list
      </button>

      {/* Header */}
      <div className="p-3 rounded-lg bg-editor-bg border border-editor-border space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-editor-text">{truncateInput(trace.input)}</span>
          <StatusBadge success={trace.success} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-editor-text-muted">
          <span>{formatTimestamp(trace.createdAt)}</span>
          <span>{formatDuration(trace.totalDurationMs)}</span>
          <span>{trace.model || 'Unknown model'}</span>
          <span>{trace.fastPath ? 'Fast Path' : 'Full TPAO'}</span>
          <span>
            {trace.iterations} iteration{trace.iterations !== 1 ? 's' : ''}
          </span>
        </div>
        {trace.error && <p className="text-xs text-red-400 mt-1">{trace.error}</p>}
      </div>

      {/* Phase Timeline */}
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-editor-text-muted uppercase tracking-wide">
          Phase Timeline
        </h4>
        <PhaseTimelineBar phases={trace.phases} totalMs={trace.totalDurationMs} />
        <PhaseTimlineLegend />
      </div>

      {/* Token Usage */}
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-editor-text-muted uppercase tracking-wide">
          Token Usage
        </h4>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Input', value: trace.tokenUsage.inputTokens },
            { label: 'Output', value: trace.tokenUsage.outputTokens },
            { label: 'Total', value: trace.tokenUsage.totalTokens },
          ].map(({ label, value }) => (
            <div
              key={label}
              className="p-2 rounded-lg bg-editor-bg border border-editor-border text-center"
            >
              <div className="text-sm font-mono text-editor-text">{formatTokens(value)}</div>
              <div className="text-xs text-editor-text-muted">{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tool Calls by Phase */}
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-editor-text-muted uppercase tracking-wide">
          Tool Calls
        </h4>
        {trace.phases.filter((p) => p.toolCalls.length > 0).length === 0 ? (
          <p className="text-xs text-editor-text-muted py-2">No tool calls recorded.</p>
        ) : (
          trace.phases
            .filter((p) => p.toolCalls.length > 0)
            .map((phase, phaseIdx) => (
              <div key={`${phase.phase}-${phaseIdx}`} className="space-y-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs font-medium capitalize ${PHASE_TEXT_COLORS[phase.phase] ?? 'text-editor-text-muted'}`}
                  >
                    {phase.phase}
                  </span>
                  <span className="text-xs text-editor-text-muted">
                    ({phase.toolCalls.length} call{phase.toolCalls.length !== 1 ? 's' : ''})
                  </span>
                </div>
                <div className="space-y-1 pl-3">
                  {phase.toolCalls.map((tool, toolIdx) => (
                    <div
                      key={`${tool.name}-${toolIdx}`}
                      className="flex items-center justify-between py-1 px-2 rounded bg-editor-bg border border-editor-border text-xs"
                    >
                      <span className="font-mono text-editor-text">{tool.name}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-editor-text-muted">
                          {formatDuration(tool.durationMs)}
                        </span>
                        {tool.success ? (
                          <span className="text-green-400">OK</span>
                        ) : (
                          <span className="text-red-400" title={tool.error ?? 'Failed'}>
                            ERR
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export function DeveloperSettings(): JSX.Element {
  const [traces, setTraces] = useState<AgentTrace[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedTrace, setSelectedTrace] = useState<AgentTrace | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [pathFilter, setPathFilter] = useState<PathFilter>('all');

  const loadTraces = useCallback(async () => {
    setLoading(true);
    try {
      const summariesResult = await commands.listAgentTraces(MAX_TRACES);
      if (summariesResult.status === 'error') {
        throw new Error(String(summariesResult.error));
      }

      const loaded = await Promise.all(
        summariesResult.data.map(async (summary: TraceSummary): Promise<AgentTrace | null> => {
          const traceResult = await commands.readAgentTrace(summary.traceId);
          if (traceResult.status === 'error') {
            return null;
          }

          try {
            return JSON.parse(traceResult.data) as AgentTrace;
          } catch {
            return null;
          }
        }),
      );

      setTraces(loaded.filter((trace): trace is AgentTrace => trace !== null));
    } catch {
      // IPC not available (non-Tauri dev environment) — use empty state
      setTraces([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTraces();
  }, [loadTraces]);

  const metrics = useMemo(() => computeMetrics(traces), [traces]);

  const filteredTraces = traces.filter((trace) => {
    if (statusFilter === 'success' && !trace.success) return false;
    if (statusFilter === 'failed' && trace.success) return false;
    if (pathFilter === 'fast_path' && !trace.fastPath) return false;
    if (pathFilter === 'full_tpao' && trace.fastPath) return false;
    return true;
  });

  if (selectedTrace) {
    return (
      <div className="space-y-6">
        <h3 className="text-sm font-medium text-editor-text">Agent Trace Detail</h3>
        <TraceDetailView trace={selectedTrace} onBack={() => setSelectedTrace(null)} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-medium text-editor-text">Agent Execution Traces</h3>

      {/* Metrics Summary */}
      {metrics && <MetricsSummaryPanel metrics={metrics} />}

      {/* Filter Bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="px-2 py-1.5 text-xs bg-editor-bg border border-editor-border rounded-lg text-editor-text focus:outline-none focus:ring-1 focus:ring-primary-500/50"
          aria-label="Status filter"
        >
          <option value="all">All Status</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
        </select>
        <select
          value={pathFilter}
          onChange={(e) => setPathFilter(e.target.value as PathFilter)}
          className="px-2 py-1.5 text-xs bg-editor-bg border border-editor-border rounded-lg text-editor-text focus:outline-none focus:ring-1 focus:ring-primary-500/50"
          aria-label="Path filter"
        >
          <option value="all">All Paths</option>
          <option value="fast_path">Fast Path</option>
          <option value="full_tpao">Full TPAO</option>
        </select>
        <button
          type="button"
          onClick={() => void loadTraces()}
          disabled={loading}
          className="ml-auto p-1.5 rounded-lg text-editor-text-muted hover:text-editor-text hover:bg-editor-bg transition-colors disabled:opacity-50"
          title="Refresh traces"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Trace List */}
      {loading && traces.length === 0 ? (
        <div className="text-center py-8 text-sm text-editor-text-muted">Loading traces...</div>
      ) : filteredTraces.length === 0 ? (
        <div className="text-center py-8 text-sm text-editor-text-muted">
          {traces.length === 0
            ? 'No agent traces recorded yet. Traces appear after running agent commands.'
            : 'No traces match the current filters.'}
        </div>
      ) : (
        <div className="space-y-1.5">
          {filteredTraces.map((trace) => (
            <button
              key={trace.traceId}
              type="button"
              onClick={() => setSelectedTrace(trace)}
              className="w-full text-left p-3 rounded-lg bg-editor-bg border border-editor-border hover:border-editor-text-muted transition-colors"
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-sm text-editor-text truncate max-w-[60%]">
                  {truncateInput(trace.input)}
                </span>
                <div className="flex items-center gap-2">
                  {trace.totalDurationMs > SLOW_RUN_THRESHOLD_MS && (
                    <span title="Slow run (>10s)">
                      <AlertTriangle className="w-3.5 h-3.5 text-yellow-400" />
                    </span>
                  )}
                  <StatusBadge success={trace.success} />
                </div>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-editor-text-muted">
                <span>{formatTimestamp(trace.createdAt)}</span>
                <span
                  className={trace.totalDurationMs > SLOW_RUN_THRESHOLD_MS ? 'text-yellow-400' : ''}
                >
                  {formatDuration(trace.totalDurationMs)}
                </span>
                <span>
                  {countToolCalls(trace.phases)} tool{countToolCalls(trace.phases) !== 1 ? 's' : ''}
                </span>
                <span>{formatTokens(trace.tokenUsage.totalTokens)} tokens</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
