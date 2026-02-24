/**
 * AgentManager
 *
 * Mission Control view for orchestrating multiple AI agents.
 * Shows active agent sessions, inbox notifications, and controls
 * for launching/stopping agents.
 *
 * Inspired by Google Antigravity's agent management pattern.
 */

import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { Plus } from 'lucide-react';
import { useAgentManagerStore } from '@/stores/agentManagerStore';
import { getAllAgentDefinitions, type AgentDefinition } from '@/agents/engine/core/agentDefinitions';
import { AgentCard } from './AgentCard';
import { InboxPanel } from './InboxPanel';

// =============================================================================
// Types
// =============================================================================

interface AgentManagerProps {
  onAgentFocus?: (agentId: string) => void;
  onAgentLaunch?: (definition: AgentDefinition) => void;
  onAgentStop?: (agentId: string) => void;
  onAgentRestart?: (agentId: string) => void;
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

export function AgentManager({
  onAgentFocus,
  onAgentLaunch,
  onAgentStop,
  onAgentRestart,
  className = '',
}: AgentManagerProps) {
  const activeAgents = useAgentManagerStore((s) => s.activeAgents);
  const focusedAgentId = useAgentManagerStore((s) => s.focusedAgentId);
  const setFocusedAgent = useAgentManagerStore((s) => s.setFocusedAgent);

  const agents = useMemo(
    () => Array.from(activeAgents.values()),
    [activeAgents],
  );

  const availableDefinitions = useMemo(() => getAllAgentDefinitions(), []);

  const handleFocus = useCallback(
    (agentId: string) => {
      setFocusedAgent(agentId);
      onAgentFocus?.(agentId);
    },
    [setFocusedAgent, onAgentFocus],
  );

  const handleStop = useCallback(
    (agentId: string) => {
      onAgentStop?.(agentId);
    },
    [onAgentStop],
  );

  const handleRestart = useCallback(
    (agentId: string) => {
      onAgentRestart?.(agentId);
    },
    [onAgentRestart],
  );

  const handleLaunch = useCallback(
    (definition: AgentDefinition) => {
      onAgentLaunch?.(definition);
      setDropdownOpen(false);
    },
    [onAgentLaunch],
  );

  // Dropdown state for "New Agent" menu
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on Escape or click outside
  useEffect(() => {
    if (!dropdownOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setDropdownOpen(false);
      }
    };
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('mousedown', handleClickOutside);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('mousedown', handleClickOutside);
    };
  }, [dropdownOpen]);

  // Group agents by status
  const runningAgents = agents.filter(
    (a) => a.status === 'running' || a.status === 'waiting_approval',
  );
  const otherAgents = agents.filter(
    (a) => a.status !== 'running' && a.status !== 'waiting_approval',
  );

  return (
    <div
      className={`flex flex-col h-full bg-surface-base ${className}`}
      data-testid="agent-manager"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <h2 className="text-sm font-semibold text-text-primary">Agent Manager</h2>
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen((prev) => !prev)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setDropdownOpen((prev) => !prev);
              }
            }}
            aria-expanded={dropdownOpen}
            aria-haspopup="true"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-primary-600 hover:bg-primary-500 text-white text-xs transition-colors"
            data-testid="launch-agent-btn"
          >
            <Plus className="w-3 h-3" />
            New Agent
          </button>

          {/* Agent type dropdown */}
          {dropdownOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-1 w-48 rounded-lg border border-border-subtle bg-surface-elevated shadow-xl z-50"
            >
              {availableDefinitions.map((def) => (
                <button
                  key={def.id}
                  role="menuitem"
                  onClick={() => handleLaunch(def)}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-surface-active transition-colors first:rounded-t-lg last:rounded-b-lg"
                >
                  <span className="font-medium text-text-primary">{def.name}</span>
                  <p className="text-text-tertiary mt-0.5">{def.description}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Active Sessions */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2 border-r border-border-subtle">
          <h3 className="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">
            Active Sessions
          </h3>

          {agents.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-xs text-text-tertiary">No active agents</p>
              <p className="text-[10px] text-text-tertiary mt-1">
                Launch an agent to get started
              </p>
            </div>
          ) : (
            <>
              {/* Running agents first */}
              {runningAgents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  isActive={agent.id === focusedAgentId}
                  onFocus={handleFocus}
                  onStop={handleStop}
                  onRestart={handleRestart}
                />
              ))}

              {/* Then completed/failed/idle */}
              {otherAgents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  isActive={agent.id === focusedAgentId}
                  onFocus={handleFocus}
                  onStop={handleStop}
                  onRestart={handleRestart}
                />
              ))}
            </>
          )}
        </div>

        {/* Inbox */}
        <div className="w-56 flex-shrink-0">
          <InboxPanel onAgentFocus={handleFocus} className="h-full" />
        </div>
      </div>
    </div>
  );
}
