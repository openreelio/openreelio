/**
 * AgentCard
 *
 * Displays a single agent instance with status, last message,
 * and focus/stop controls.
 */

import { useCallback } from 'react';
import { Square, RotateCcw, Eye } from 'lucide-react';
import type { AgentInstance, AgentInstanceStatus } from '@/stores/agentManagerStore';

// =============================================================================
// Types
// =============================================================================

interface AgentCardProps {
  agent: AgentInstance;
  isActive: boolean;
  onFocus: (agentId: string) => void;
  onStop: (agentId: string) => void;
  onRestart: (agentId: string) => void;
  className?: string;
}

// =============================================================================
// Status Config
// =============================================================================

const STATUS_CONFIG: Record<
  AgentInstanceStatus,
  { label: string; color: string; icon: string }
> = {
  idle: { label: 'Idle', color: 'text-text-tertiary', icon: '\u23F8' },
  running: { label: 'Running', color: 'text-primary-400', icon: '\u25B6' },
  waiting_approval: { label: 'Waiting', color: 'text-yellow-400', icon: '\u26A0' },
  completed: { label: 'Complete', color: 'text-green-400', icon: '\u2705' },
  failed: { label: 'Failed', color: 'text-red-400', icon: '\u274C' },
  aborted: { label: 'Stopped', color: 'text-orange-400', icon: '\u23F9' },
};

// =============================================================================
// Component
// =============================================================================

export function AgentCard({
  agent,
  isActive,
  onFocus,
  onStop,
  onRestart,
  className = '',
}: AgentCardProps) {
  const config = STATUS_CONFIG[agent.status];

  const handleFocus = useCallback(() => onFocus(agent.id), [onFocus, agent.id]);
  const handleStop = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onStop(agent.id);
    },
    [onStop, agent.id],
  );
  const handleRestart = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onRestart(agent.id);
    },
    [onRestart, agent.id],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleFocus}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleFocus();
        }
      }}
      className={`
        p-3 rounded-lg border cursor-pointer transition-all
        ${isActive
          ? 'border-primary-500 bg-primary-500/10'
          : 'border-border-subtle bg-surface-elevated hover:bg-surface-active'
        }
        ${className}
      `}
      data-testid={`agent-card-${agent.id}`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-sm ${config.color}`}>{config.icon}</span>
        <span className="text-sm font-medium text-text-primary">
          {agent.definition.name}
        </span>
        {agent.status === 'running' && (
          <span className="w-2 h-2 bg-primary-500 rounded-full animate-pulse ml-auto" />
        )}
      </div>

      {/* Last message preview */}
      {agent.lastMessage && (
        <p className="text-xs text-text-tertiary truncate mb-2">
          {agent.lastMessage}
        </p>
      )}

      {/* Status & Controls */}
      <div className="flex items-center gap-2">
        <span className={`text-[10px] font-medium ${config.color}`}>
          {config.label}
        </span>
        <span className="flex-1" />

        {/* Focus button */}
        <button
          onClick={handleFocus}
          className="p-1 rounded hover:bg-surface-active transition-colors"
          aria-label="Focus on agent"
          title="Focus"
        >
          <Eye className="w-3 h-3 text-text-tertiary" />
        </button>

        {/* Stop (only when running or waiting) */}
        {(agent.status === 'running' || agent.status === 'waiting_approval') && (
          <button
            onClick={handleStop}
            className="p-1 rounded hover:bg-red-500/20 transition-colors"
            aria-label="Stop agent"
            title="Stop"
          >
            <Square className="w-3 h-3 text-red-400" />
          </button>
        )}

        {/* Restart (when completed, failed, or aborted) */}
        {(agent.status === 'completed' || agent.status === 'failed' || agent.status === 'aborted') && (
          <button
            onClick={handleRestart}
            className="p-1 rounded hover:bg-primary-500/20 transition-colors"
            aria-label="Restart agent"
            title="Restart"
          >
            <RotateCcw className="w-3 h-3 text-primary-400" />
          </button>
        )}
      </div>

      {/* Error display */}
      {agent.error && (
        <p className="text-[10px] text-red-400 mt-1 truncate">{agent.error}</p>
      )}
    </div>
  );
}
