import { useCallback, type ReactNode } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { SessionList } from './SessionList';
import {
  AgentDelegationStrip,
  type DelegatedChildItem,
  type DelegatedParentContext,
} from './AgentDelegationStrip';

export interface AgenticSidebarWorkspaceProps {
  className?: string;
  showSessionList: boolean;
  onToggleSessionList: () => void;
  onNewSession: (agentProfileId?: string) => void;
  onSwitchSession: (sessionId: string) => void;
  canCreateNewSession?: boolean;
  activeAgentName?: string;
  delegatedFrom?: DelegatedParentContext | null;
  delegatedChildren?: DelegatedChildItem[];
  runtimeState: 'disabled' | 'transitioning' | 'ready';
  runtimeDisabledTitle?: string;
  runtimeDisabledDescription?: string;
  sessionTransitionLabel: 'new' | 'switch' | 'delegate' | null;
  children: ReactNode;
}

function renderTransitionTitle(
  label: AgenticSidebarWorkspaceProps['sessionTransitionLabel'],
): string {
  if (label === 'switch') {
    return 'Opening session...';
  }
  if (label === 'delegate') {
    return 'Delegating to specialist...';
  }
  return 'Starting new session...';
}

export function AgenticSidebarWorkspace({
  className = '',
  showSessionList,
  onToggleSessionList,
  onNewSession,
  onSwitchSession,
  canCreateNewSession = true,
  activeAgentName,
  delegatedFrom = null,
  delegatedChildren = [],
  runtimeState,
  runtimeDisabledTitle = 'AI runtime is disabled',
  runtimeDisabledDescription = 'Enable `USE_AGENTIC_ENGINE` to restore the canonical TPAO runtime.',
  sessionTransitionLabel,
  children,
}: AgenticSidebarWorkspaceProps): JSX.Element {
  const handleNewSession = useCallback(
    (agentProfileId?: string) => {
      if (!canCreateNewSession) {
        return;
      }
      onNewSession(agentProfileId);
      if (showSessionList) {
        onToggleSessionList();
      }
    },
    [canCreateNewSession, onNewSession, onToggleSessionList, showSessionList],
  );

  const handleSwitchSession = useCallback(
    (sessionId: string) => {
      onSwitchSession(sessionId);
      if (showSessionList) {
        onToggleSessionList();
      }
    },
    [onSwitchSession, onToggleSessionList, showSessionList],
  );

  return (
    <div
      data-testid="agentic-sidebar-content"
      className={`relative flex min-h-0 min-w-0 flex-1 overflow-hidden ${className}`}
    >
      {showSessionList && (
        <div className="absolute inset-y-0 left-0 z-20 flex w-[82%] max-w-[240px] min-w-0 flex-col border-r border-border-subtle bg-surface-base shadow-xl">
          <div className="flex shrink-0 items-center justify-end border-b border-border-subtle px-2 py-1">
            <button
              type="button"
              onClick={onToggleSessionList}
              className="p-1 rounded hover:bg-surface-active transition-colors"
              aria-label="Hide sessions"
              title="Hide sessions"
              data-testid="close-sessions-overlay-btn"
            >
              <PanelLeftClose className="w-3.5 h-3.5 text-text-tertiary" />
            </button>
          </div>
          <SessionList
            className="min-h-0 flex-1"
            onNewSession={handleNewSession}
            onSwitchSession={handleSwitchSession}
            canCreateNewSession={canCreateNewSession}
          />
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center px-2 py-1 border-b border-border-subtle bg-surface-base">
          <button
            onClick={onToggleSessionList}
            className="p-1 rounded hover:bg-surface-active transition-colors"
            aria-label={showSessionList ? 'Hide sessions' : 'Show sessions'}
            title={showSessionList ? 'Hide sessions' : 'Show sessions'}
            data-testid="toggle-sessions-btn"
          >
            {showSessionList ? (
              <PanelLeftClose className="w-3.5 h-3.5 text-text-tertiary" />
            ) : (
              <PanelLeftOpen className="w-3.5 h-3.5 text-text-tertiary" />
            )}
          </button>
          <div className="flex-1 flex min-w-0 overflow-hidden items-center gap-2">
            <span className="text-xs text-text-tertiary">Agent Workspace</span>
            {activeAgentName && (
              <span className="rounded-full border border-border-subtle bg-surface-elevated px-1.5 py-0.5 text-[10px] font-medium text-text-secondary truncate">
                {activeAgentName}
              </span>
            )}
          </div>
        </div>

        <AgentDelegationStrip delegatedFrom={delegatedFrom} delegatedChildren={delegatedChildren} />

        {runtimeState === 'disabled' ? (
          <div
            data-testid="agent-runtime-disabled-state"
            className="flex flex-1 items-center justify-center px-6 py-8"
          >
            <div className="max-w-sm text-center">
              <p className="text-sm font-medium text-text-primary">{runtimeDisabledTitle}</p>
              <p className="mt-2 text-xs text-text-secondary">{runtimeDisabledDescription}</p>
            </div>
          </div>
        ) : runtimeState === 'transitioning' ? (
          <div
            data-testid="agent-session-transition-state"
            className="flex flex-1 items-center justify-center px-6 py-8"
          >
            <div className="max-w-sm text-center">
              <p className="text-sm font-medium text-text-primary">
                {renderTransitionTitle(sessionTransitionLabel)}
              </p>
              <p className="mt-2 text-xs text-text-secondary">
                Preparing a clean agent workspace before the next turn.
              </p>
            </div>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
