/**
 * InboxPanel
 *
 * Aggregated notifications from all active agents.
 * Shows approval requests, completions, errors, and info.
 */

import { useCallback } from 'react';
import { Bell, Check, AlertTriangle, Info, CheckCircle, X } from 'lucide-react';
import { useAgentManagerStore, type InboxItem, type InboxItemType } from '@/stores/agentManagerStore';

// =============================================================================
// Types
// =============================================================================

interface InboxPanelProps {
  onAgentFocus?: (agentId: string) => void;
  className?: string;
}

// =============================================================================
// Item Config
// =============================================================================

const TYPE_CONFIG: Record<
  InboxItemType,
  { icon: typeof Bell; color: string; bgColor: string }
> = {
  approval_request: {
    icon: AlertTriangle,
    color: 'text-yellow-400',
    bgColor: 'bg-yellow-500/10',
  },
  completion: {
    icon: CheckCircle,
    color: 'text-green-400',
    bgColor: 'bg-green-500/10',
  },
  error: {
    icon: X,
    color: 'text-red-400',
    bgColor: 'bg-red-500/10',
  },
  info: {
    icon: Info,
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/10',
  },
};

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// =============================================================================
// Component
// =============================================================================

export function InboxPanel({ onAgentFocus, className = '' }: InboxPanelProps) {
  const inbox = useAgentManagerStore((s) => s.inbox);
  const markInboxRead = useAgentManagerStore((s) => s.markInboxRead);
  const markAllInboxRead = useAgentManagerStore((s) => s.markAllInboxRead);
  const clearInbox = useAgentManagerStore((s) => s.clearInbox);

  const unreadCount = inbox.filter((i) => !i.read).length;

  const handleItemClick = useCallback(
    (item: InboxItem) => {
      markInboxRead(item.id);
      onAgentFocus?.(item.agentId);
    },
    [markInboxRead, onAgentFocus],
  );

  return (
    <div className={`flex flex-col ${className}`} data-testid="inbox-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <Bell className="w-3.5 h-3.5 text-text-tertiary" />
          <span className="text-xs font-medium text-text-secondary">Inbox</span>
          {unreadCount > 0 && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-primary-500 text-white rounded-full">
              {unreadCount}
            </span>
          )}
        </div>
        <div className="flex gap-1">
          {unreadCount > 0 && (
            <button
              onClick={markAllInboxRead}
              className="p-1 rounded hover:bg-surface-active transition-colors"
              aria-label="Mark all as read"
              title="Mark all read"
            >
              <Check className="w-3 h-3 text-text-tertiary" />
            </button>
          )}
          {inbox.length > 0 && (
            <button
              onClick={clearInbox}
              className="p-1 rounded hover:bg-surface-active transition-colors"
              aria-label="Clear inbox"
              title="Clear all"
            >
              <X className="w-3 h-3 text-text-tertiary" />
            </button>
          )}
        </div>
      </div>

      {/* Items */}
      <div className="flex-1 overflow-y-auto">
        {inbox.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <Bell className="w-6 h-6 text-text-tertiary mx-auto mb-2 opacity-50" />
            <p className="text-xs text-text-tertiary">No notifications</p>
          </div>
        ) : (
          inbox.map((item) => {
            const config = TYPE_CONFIG[item.type];
            const Icon = config.icon;

            return (
              <button
                key={item.id}
                onClick={() => handleItemClick(item)}
                className={`w-full text-left px-3 py-2 border-b border-border-subtle/50 transition-colors hover:bg-surface-active ${
                  !item.read ? 'bg-surface-base' : ''
                }`}
                data-testid={`inbox-item-${item.id}`}
              >
                <div className="flex items-start gap-2">
                  <div className={`p-1 rounded ${config.bgColor} flex-shrink-0 mt-0.5`}>
                    <Icon className={`w-3 h-3 ${config.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                      <span className="text-xs font-medium text-text-primary">
                        {item.agentName}
                      </span>
                      {!item.read && (
                        <span className="w-1.5 h-1.5 bg-primary-500 rounded-full flex-shrink-0" />
                      )}
                    </div>
                    <p className="text-[10px] text-text-tertiary truncate">
                      {item.message}
                    </p>
                    <span className="text-[10px] text-text-tertiary/60">
                      {formatTime(item.timestamp)}
                    </span>
                  </div>
                  {item.actionRequired && (
                    <span className="text-[10px] text-yellow-400 font-medium flex-shrink-0">
                      Action
                    </span>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
