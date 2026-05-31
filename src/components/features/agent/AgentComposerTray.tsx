import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { AgentDefinition } from '@/agents/engine/core/agentDefinitions';
import type { RiskLevel } from '@/agents/engine/core/types';

export interface AgentRuntimeSummary {
  startedTools: number;
  completedTools: number;
  latestIteration: number;
  currentActivity?: string | null;
  runStartedAt?: number | null;
  lastActivityAt?: number | null;
}

export interface AgentRuntimePermissionRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  description: string;
  riskLevel: RiskLevel;
}

interface AgentComposerTrayProps {
  currentAgentName: string;
  currentAgentDescription?: string;
  isExperimentalSession: boolean;
  isRunning: boolean;
  stopState: 'idle' | 'stopping';
  phase: string;
  queueSize: number;
  runtimeSummary: AgentRuntimeSummary;
  pendingClarificationQuestion?: string | null;
  pendingToolPermissionRequest?: AgentRuntimePermissionRequest | null;
  specialistDefinitions: Array<Pick<AgentDefinition, 'id' | 'name' | 'description'>>;
  onStartSession?: (agentProfileId?: string) => void;
}

function getPhaseLabel(phase: string): string {
  switch (phase) {
    case 'idle':
      return 'Ready';
    case 'starting':
      return 'Starting Codex';
    case 'running':
      return 'Working';
    case 'thinking':
      return 'Thinking';
    case 'planning':
      return 'Planning';
    case 'awaiting_approval':
      return 'Awaiting approval';
    case 'executing':
      return 'Executing';
    case 'observing':
      return 'Observing';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'aborted':
      return 'Stopped';
    default:
      return 'Ready';
  }
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function trimActivityLabel(label: string): string {
  return label.length > 64 ? `${label.slice(0, 61).trimEnd()}...` : label;
}

function getRuntimeTone(input: {
  isRunning: boolean;
  stopState: 'idle' | 'stopping';
  phase: string;
  queueSize: number;
  pendingClarificationQuestion?: string | null;
  pendingToolPermissionRequest?: AgentRuntimePermissionRequest | null;
}): string {
  if (input.stopState === 'stopping') {
    return 'border-orange-500/20 bg-orange-500/10 text-orange-300';
  }
  if (input.pendingToolPermissionRequest) {
    return 'border-yellow-500/20 bg-yellow-500/10 text-yellow-300';
  }
  if (input.pendingClarificationQuestion) {
    return 'border-yellow-500/20 bg-yellow-500/10 text-yellow-300';
  }
  if (input.phase === 'failed') {
    return 'border-red-500/20 bg-red-500/10 text-red-300';
  }
  if (input.phase === 'completed') {
    return 'border-green-500/20 bg-green-500/10 text-green-300';
  }
  if (input.isRunning || input.queueSize > 0) {
    return 'border-primary-500/20 bg-primary-500/10 text-primary-300';
  }
  return 'border-border-subtle bg-surface-base text-text-tertiary';
}

export function AgentComposerTray({
  currentAgentName,
  currentAgentDescription,
  isExperimentalSession,
  isRunning,
  stopState,
  phase,
  queueSize,
  runtimeSummary,
  pendingClarificationQuestion,
  pendingToolPermissionRequest,
  specialistDefinitions,
  onStartSession,
}: AgentComposerTrayProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const trayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!trayRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!isRunning && !pendingToolPermissionRequest) {
      return undefined;
    }

    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [isRunning, pendingToolPermissionRequest]);

  const startedTools = runtimeSummary.startedTools;
  const completedTools = runtimeSummary.completedTools;

  const runtimeLabel = useMemo(() => {
    if (stopState === 'stopping') {
      return 'Stopping';
    }
    if (pendingToolPermissionRequest) {
      return `Waiting for approval: ${pendingToolPermissionRequest.tool}`;
    }
    if (pendingClarificationQuestion) {
      return 'Waiting for clarification';
    }
    if (queueSize > 0 && !isRunning) {
      return `${queueSize} queued`;
    }
    if (isRunning && runtimeSummary.currentActivity) {
      return trimActivityLabel(runtimeSummary.currentActivity);
    }
    return getPhaseLabel(phase);
  }, [
    isRunning,
    pendingClarificationQuestion,
    pendingToolPermissionRequest,
    phase,
    queueSize,
    runtimeSummary.currentActivity,
    stopState,
  ]);

  const activityAgeLabel = useMemo(() => {
    if (!isRunning || !runtimeSummary.lastActivityAt) {
      return null;
    }

    const elapsedMs = now - runtimeSummary.lastActivityAt;
    if (elapsedMs < 5000) {
      return null;
    }

    const prefix = elapsedMs >= 30000 ? 'No update' : 'Updated';
    return `${prefix} ${formatElapsed(elapsedMs)} ago`;
  }, [isRunning, now, runtimeSummary.lastActivityAt]);

  const runAgeLabel = useMemo(() => {
    if (!isRunning || !runtimeSummary.runStartedAt || activityAgeLabel) {
      return null;
    }

    const elapsedMs = now - runtimeSummary.runStartedAt;
    return elapsedMs >= 10000 ? `Running ${formatElapsed(elapsedMs)}` : null;
  }, [activityAgeLabel, isRunning, now, runtimeSummary.runStartedAt]);

  const showRuntime =
    isRunning ||
    queueSize > 0 ||
    phase === 'completed' ||
    phase === 'failed' ||
    !!pendingClarificationQuestion ||
    !!pendingToolPermissionRequest;
  const runtimeTone = getRuntimeTone({
    isRunning,
    stopState,
    phase,
    queueSize,
    pendingClarificationQuestion,
    pendingToolPermissionRequest,
  });

  return (
    <div
      ref={trayRef}
      className="relative flex min-h-[37px] min-w-0 items-center gap-2 border-b border-border-subtle px-3 py-1.5"
      data-testid="agent-composer-tray"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <span className="min-w-0 max-w-full truncate rounded border border-border-subtle bg-surface-base px-2 py-0.5 text-xs font-medium text-text-secondary">
          {currentAgentName}
        </span>
        {isExperimentalSession && (
          <span className="shrink-0 rounded-full border border-yellow-500/20 bg-yellow-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-yellow-300">
            Experimental
          </span>
        )}
        {currentAgentDescription && <span className="sr-only">{currentAgentDescription}</span>}
      </div>

      <div className="ml-auto flex min-w-0 max-w-[58%] shrink items-center justify-end gap-1.5 overflow-visible">
        {showRuntime && (
          <div
            className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] ${runtimeTone}`}
            data-testid="agent-runtime-pill"
          >
            <span className="truncate">{runtimeLabel}</span>
            {(activityAgeLabel || runAgeLabel) && (
              <span className="hidden shrink-0 text-text-tertiary sm:inline">
                {activityAgeLabel ?? runAgeLabel}
              </span>
            )}
            {startedTools > 0 && (
              <span className="flex-shrink-0 text-text-tertiary">
                {completedTools}/{startedTools}
              </span>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => onStartSession?.()}
          className="flex-shrink-0 p-1 rounded hover:bg-surface-active transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!onStartSession}
          data-testid="agent-new-editor-session-btn"
        >
          <span className="sr-only">New Editor Session</span>
          <Plus className="w-3.5 h-3.5 text-text-secondary" aria-hidden="true" />
        </button>

        {specialistDefinitions.length > 0 && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((prev) => !prev)}
              className="rounded-md border border-border-subtle bg-surface-base px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-active disabled:cursor-not-allowed disabled:opacity-50"
              aria-expanded={menuOpen}
              disabled={!onStartSession || isExperimentalSession}
              data-testid="agent-specialists-btn"
            >
              Delegate
            </button>

            {menuOpen && (
              <div
                className="absolute right-0 top-full z-20 mt-2 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border-subtle bg-surface-elevated shadow-xl"
                data-testid="agent-specialists-menu"
              >
                <div className="border-b border-border-subtle px-3 py-2">
                  <p className="text-xs font-medium text-text-primary">Delegate To Specialist</p>
                  <p className="mt-1 text-[11px] text-text-tertiary">
                    Open a child specialist session for the current task and keep the parent session
                    available.
                  </p>
                </div>
                <div className="p-2">
                  {specialistDefinitions.map((definition) => (
                    <button
                      key={definition.id}
                      type="button"
                      onClick={() => {
                        onStartSession?.(definition.id);
                        setMenuOpen(false);
                      }}
                      className="flex w-full flex-col rounded-md px-3 py-2 text-left transition-colors hover:bg-surface-active"
                      data-testid={`agent-specialist-option-${definition.id}`}
                    >
                      <span className="max-w-full truncate text-sm font-medium text-text-primary">
                        {definition.name}
                      </span>
                      <span className="mt-0.5 break-words text-xs text-text-tertiary">
                        {definition.description}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
