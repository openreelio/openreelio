/**
 * SessionList
 *
 * Sidebar panel showing all AI sessions for the current project.
 * Supports creating, switching, and deleting sessions.
 */

import { useCallback } from 'react';
import { Plus, Trash2, Archive, MessageSquare } from 'lucide-react';
import { useConversationStore } from '@/stores/conversationStore';

// =============================================================================
// Types
// =============================================================================

interface SessionListProps {
  onNewSession?: () => void;
  className?: string;
}

// =============================================================================
// Helpers
// =============================================================================

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

// =============================================================================
// Component
// =============================================================================

export function SessionList({ onNewSession, className = '' }: SessionListProps) {
  const sessions = useConversationStore((s) => s.sessions);
  const activeSessionId = useConversationStore((s) => s.activeSessionId);
  const switchSession = useConversationStore((s) => s.switchSession);
  const deleteSession = useConversationStore((s) => s.deleteSession);
  const archiveSession = useConversationStore((s) => s.archiveSession);

  const handleSwitch = useCallback(
    (sessionId: string) => {
      if (sessionId !== activeSessionId) {
        void switchSession(sessionId);
      }
    },
    [activeSessionId, switchSession],
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      if (window.confirm('Are you sure you want to delete this session?')) {
        void deleteSession(sessionId);
      }
    },
    [deleteSession],
  );

  const handleArchive = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      void archiveSession(sessionId);
    },
    [archiveSession],
  );

  return (
    <div className={`flex flex-col ${className}`} data-testid="session-list">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
        <span className="text-xs font-medium text-text-secondary">Sessions</span>
        <button
          onClick={onNewSession}
          className="p-1 rounded hover:bg-surface-active transition-colors"
          aria-label="New session"
          title="New session"
          data-testid="new-session-btn"
        >
          <Plus className="w-3.5 h-3.5 text-text-tertiary" />
        </button>
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="px-3 py-4 text-center">
            <MessageSquare className="w-6 h-6 text-text-tertiary mx-auto mb-2" />
            <p className="text-xs text-text-tertiary">No sessions yet</p>
          </div>
        ) : (
          sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <div
                key={session.id}
                role="button"
                tabIndex={0}
                onClick={() => handleSwitch(session.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleSwitch(session.id);
                  }
                }}
                className={`w-full text-left px-3 py-2 border-b border-border-subtle/50 transition-colors group cursor-pointer ${
                  isActive
                    ? 'bg-primary-500/10 border-l-2 border-l-primary-500'
                    : 'hover:bg-surface-active border-l-2 border-l-transparent'
                }`}
                data-testid={`session-item-${session.id}`}
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-medium truncate ${
                      isActive ? 'text-primary-400' : 'text-text-primary'
                    }`}>
                      {session.title || 'Untitled Session'}
                    </p>
                    {session.lastMessagePreview && (
                      <p className="text-[10px] text-text-tertiary truncate mt-0.5">
                        {session.lastMessagePreview}
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-text-tertiary">
                        {formatRelativeTime(session.updatedAt)}
                      </span>
                      {session.messageCount > 0 && (
                        <span className="text-[10px] text-text-tertiary">
                          {session.messageCount} msgs
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions (visible on hover) */}
                  <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <button
                      onClick={(e) => handleArchive(e, session.id)}
                      className="p-1 rounded hover:bg-surface-elevated transition-colors"
                      aria-label="Archive session"
                      title="Archive"
                    >
                      <Archive className="w-3 h-3 text-text-tertiary" />
                    </button>
                    <button
                      onClick={(e) => handleDelete(e, session.id)}
                      className="p-1 rounded hover:bg-red-500/20 transition-colors"
                      aria-label="Delete session"
                      title="Delete"
                    >
                      <Trash2 className="w-3 h-3 text-text-tertiary hover:text-red-400" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
