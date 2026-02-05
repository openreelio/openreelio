/**
 * ActionFeed Component
 *
 * Displays a live feed of agent events during execution.
 * Shows session start, phase changes, tool calls, and errors.
 */

import { useRef, useEffect, useMemo } from 'react';
import type { AgentEvent, Thought } from '@/agents/engine';

// =============================================================================
// Types
// =============================================================================

/**
 * Extended event types for backward compatibility
 * Includes both official types and simplified event format
 */
type ExtendedAgentEvent = AgentEvent | PhaseChangedEvent | ToolCallStartEvent | ToolCallCompleteEvent | ErrorEvent;

interface PhaseChangedEvent {
  type: 'phase_changed';
  phase: string;
  timestamp: number;
}

interface ToolCallStartEvent {
  type: 'tool_call_start';
  stepId: string;
  tool: string;
  args: Record<string, unknown>;
  timestamp: number;
}

interface ToolCallCompleteEvent {
  type: 'tool_call_complete';
  stepId: string;
  tool: string;
  result: { success: boolean; data?: unknown; error?: string };
  duration: number;
  timestamp: number;
}

interface ErrorEvent {
  type: 'error';
  error: Error;
  timestamp: number;
}

export interface ActionFeedProps {
  /** List of events to display */
  events: ExtendedAgentEvent[];
  /** Filter events by type */
  filter?: 'all' | 'tools' | 'phases';
  /** Enable auto-scroll to latest event */
  autoScroll?: boolean;
  /** Show in compact mode */
  compact?: boolean;
  /** Maximum events to display */
  maxEvents?: number;
  /** Optional className */
  className?: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function getEventIcon(event: ExtendedAgentEvent): string {
  switch (event.type) {
    case 'session_start':
      return '▶';
    case 'phase_changed':
    case 'thinking_start':
    case 'planning_start':
      return '◐';
    case 'thinking_complete':
      return '💭';
    case 'planning_complete':
      return '📋';
    case 'tool_call_start':
    case 'execution_start':
      return '⚡';
    case 'tool_call_complete':
    case 'execution_complete':
      return '✓';
    case 'error':
    case 'session_failed':
      return '✕';
    case 'session_complete':
      return '✓';
    case 'session_aborted':
      return '⏹';
    default:
      return '•';
  }
}

function getEventColor(event: ExtendedAgentEvent): string {
  switch (event.type) {
    case 'session_start':
      return 'text-blue-400';
    case 'phase_changed':
    case 'thinking_start':
    case 'planning_start':
      return 'text-purple-400';
    case 'thinking_complete':
    case 'planning_complete':
      return 'text-green-400';
    case 'tool_call_start':
    case 'execution_start':
      return 'text-yellow-400';
    case 'tool_call_complete':
    case 'execution_complete':
      return 'text-green-400';
    case 'error':
    case 'session_failed':
      return 'text-red-400';
    case 'session_complete':
      return 'text-green-400';
    case 'session_aborted':
      return 'text-orange-400';
    default:
      return 'text-text-secondary';
  }
}

function isToolEvent(event: ExtendedAgentEvent): boolean {
  return [
    'tool_call_start',
    'tool_call_complete',
    'execution_start',
    'execution_complete',
    'execution_progress',
  ].includes(event.type);
}

function isPhaseEvent(event: ExtendedAgentEvent): boolean {
  return [
    'phase_changed',
    'thinking_start',
    'thinking_complete',
    'planning_start',
    'planning_complete',
  ].includes(event.type);
}

// =============================================================================
// Event Renderers
// =============================================================================

interface EventItemProps {
  event: ExtendedAgentEvent;
  compact?: boolean;
}

function EventItem({ event, compact }: EventItemProps) {
  const icon = getEventIcon(event);
  const color = getEventColor(event);
  const time = formatTimestamp(event.timestamp);

  // Get event description
  const description = getEventDescription(event);
  const details = getEventDetails(event);
  const isError = event.type === 'error' || event.type === 'session_failed';

  if (compact) {
    return (
      <div className={`flex items-center gap-2 py-1 ${isError ? 'text-red-400' : ''}`}>
        <span className={`text-xs ${color}`}>{icon}</span>
        <span className="text-xs text-text-secondary truncate">{description}</span>
      </div>
    );
  }

  return (
    <div
      className={`
        p-2 rounded-lg
        ${isError
          ? 'bg-red-500/10 border border-red-500/20'
          : 'bg-surface-elevated border border-border-subtle'
        }
      `}
    >
      <div className="flex items-start gap-2">
        <span className={`text-sm ${color} mt-0.5`}>{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className={`text-sm ${isError ? 'text-red-400' : 'text-text-primary'}`}>
              {description}
            </span>
            <span className="text-xs text-text-tertiary">{time}</span>
          </div>
          {details && (
            <p className="text-xs text-text-secondary mt-1">{details}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function getEventDescription(event: ExtendedAgentEvent): string {
  switch (event.type) {
    case 'session_start':
      return event.input;
    case 'phase_changed':
      return `Phase: ${event.phase}`;
    case 'thinking_start':
      return 'Analyzing request...';
    case 'thinking_complete':
      return 'Analysis complete';
    case 'planning_start':
      return 'Creating plan...';
    case 'planning_complete':
      return 'Plan created';
    case 'tool_call_start':
      return `Running: ${event.tool}`;
    case 'tool_call_complete':
      return `${event.tool} ${event.result.success ? '✓' : '✕'}`;
    case 'execution_start':
      return `Running: ${event.step.tool}`;
    case 'execution_complete':
      return `${event.step.tool} ${event.result.success ? '✓' : '✕'}`;
    case 'error':
      return event.error.message;
    case 'session_failed':
      return event.error.message;
    case 'session_complete':
      return 'Session complete';
    case 'session_aborted':
      return `Aborted: ${event.reason}`;
    default:
      return event.type;
  }
}

function getEventDetails(event: ExtendedAgentEvent): string | null {
  switch (event.type) {
    case 'thinking_complete':
      return (event.thought as Thought).approach;
    case 'tool_call_start':
      return `Args: ${JSON.stringify(event.args)}`;
    case 'tool_call_complete':
      return event.duration ? `Duration: ${event.duration}ms` : null;
    case 'execution_start':
      return `Args: ${JSON.stringify(event.step.args)}`;
    case 'execution_complete':
      return `Duration: ${event.result.duration}ms`;
    default:
      return null;
  }
}

// =============================================================================
// Component
// =============================================================================

export function ActionFeed({
  events,
  filter = 'all',
  autoScroll = false,
  compact = false,
  maxEvents = 100,
  className = '',
}: ActionFeedProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // ===========================================================================
  // Filter Events
  // ===========================================================================

  const filteredEvents = useMemo(() => {
    let filtered = events;

    if (filter === 'tools') {
      filtered = events.filter(isToolEvent);
    } else if (filter === 'phases') {
      filtered = events.filter(isPhaseEvent);
    }

    // Limit number of events
    if (filtered.length > maxEvents) {
      filtered = filtered.slice(-maxEvents);
    }

    return filtered;
  }, [events, filter, maxEvents]);

  // ===========================================================================
  // Auto-scroll
  // ===========================================================================

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [filteredEvents, autoScroll]);

  // ===========================================================================
  // Empty State
  // ===========================================================================

  if (filteredEvents.length === 0) {
    return (
      <div
        data-testid="action-feed"
        className={`p-4 text-center text-text-tertiary ${className}`}
      >
        <p className="text-sm">No actions yet</p>
      </div>
    );
  }

  // ===========================================================================
  // Compact Mode
  // ===========================================================================

  if (compact) {
    return (
      <div
        ref={containerRef}
        data-testid="action-feed-compact"
        className={`overflow-y-auto ${className}`}
      >
        {filteredEvents.map((event, index) => (
          <EventItem key={`${event.type}-${event.timestamp}-${index}`} event={event} compact />
        ))}
      </div>
    );
  }

  // ===========================================================================
  // Full Mode
  // ===========================================================================

  return (
    <div
      ref={containerRef}
      data-testid="action-feed"
      className={`space-y-2 overflow-y-auto ${className}`}
    >
      {filteredEvents.map((event, index) => (
        <EventItem key={`${event.type}-${event.timestamp}-${index}`} event={event} />
      ))}
    </div>
  );
}
