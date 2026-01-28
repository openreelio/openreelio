/**
 * AISidebar Component
 *
 * Main AI assistant sidebar container with chat interface.
 * Includes toggle, resize, keyboard shortcuts, and provider status.
 */

import { useEffect, useCallback, useRef, useState } from 'react';
import { Bot, Settings, ChevronRight, ChevronLeft, X } from 'lucide-react';
import { useAIStore } from '@/stores/aiStore';
import { useProjectStore } from '@/stores';
import { AIErrorBoundary } from '@/components/shared/FeatureErrorBoundaries';
import { ChatHistory } from './ChatHistory';
import { ChatInput } from './ChatInput';
import { ContextPanel } from './ContextPanel';
import { QuickActionsBar } from './QuickActionsBar';
import { AISettingsPanel } from '../settings/AISettingsPanel';
import { createLogger } from '@/services/logger';

const logger = createLogger('AISidebar');

// =============================================================================
// Constants
// =============================================================================

const MIN_WIDTH = 280;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 320;

// =============================================================================
// Types
// =============================================================================

export interface AISidebarProps {
  /** Whether the sidebar is collapsed */
  collapsed: boolean;
  /** Callback when toggle is requested */
  onToggle: () => void;
  /** Current width in pixels */
  width?: number;
  /** Callback when width changes */
  onWidthChange?: (width: number) => void;
}

// =============================================================================
// Component
// =============================================================================

export function AISidebar({
  collapsed,
  onToggle,
  width = DEFAULT_WIDTH,
  onWidthChange,
}: AISidebarProps) {
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const isResizingRef = useRef(false);

  // Settings dialog state
  const [showSettings, setShowSettings] = useState(false);

  // Get provider status from store
  const providerStatus = useAIStore((state) => state.providerStatus);
  const loadChatHistoryForProject = useAIStore((state) => state.loadChatHistoryForProject);
  const currentProjectId = useAIStore((state) => state.currentProjectId);

  // Get active sequence ID to use as project identifier for chat persistence
  const activeSequenceId = useProjectStore((state) => state.activeSequenceId);

  // Load chat history when project changes
  useEffect(() => {
    if (activeSequenceId && activeSequenceId !== currentProjectId) {
      loadChatHistoryForProject(activeSequenceId);
    }
  }, [activeSequenceId, currentProjectId, loadChatHistoryForProject]);

  // Handle keyboard shortcut (Ctrl+/ or Cmd+/)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        onToggle();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onToggle]);

  // Handle resize
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizingRef.current = true;

      const startX = e.clientX;
      const startWidth = width;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isResizingRef.current) return;

        // Calculate new width (sidebar is on right, so subtract movement)
        const deltaX = startX - moveEvent.clientX;
        const newWidth = Math.min(
          Math.max(startWidth + deltaX, MIN_WIDTH),
          MAX_WIDTH
        );

        onWidthChange?.(newWidth);
      };

      const handleMouseUp = () => {
        isResizingRef.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width, onWidthChange]
  );

  // Handle Escape key to close settings dialog
  useEffect(() => {
    if (!showSettings) return;

    const handleEscapeKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSettings(false);
      }
    };

    document.addEventListener('keydown', handleEscapeKey);
    return () => document.removeEventListener('keydown', handleEscapeKey);
  }, [showSettings]);

  // Determine provider status indicator color
  const getProviderStatusColor = () => {
    if (!providerStatus.isConfigured) return 'bg-gray-500';
    if (!providerStatus.isAvailable) return 'bg-yellow-500';
    return 'bg-green-500';
  };

  return (
    <aside
      data-testid="ai-sidebar"
      aria-label="AI Assistant Sidebar"
      className={`flex flex-col bg-editor-bg border-l border-editor-border transition-all duration-200 ease-in-out relative ${
        collapsed ? 'w-0 overflow-hidden' : ''
      }`}
      style={collapsed ? undefined : { width: `${width}px` }}
    >
      {/* Expand button - visible when collapsed */}
      {collapsed && (
        <button
          type="button"
          onClick={onToggle}
          className="absolute right-full top-1/2 -translate-y-1/2 flex items-center gap-1.5 px-2 py-3 bg-editor-surface border border-editor-border border-r-0 rounded-l-lg hover:bg-primary-500/10 hover:border-primary-500/50 transition-all group shadow-lg z-10"
          aria-label="Open AI Assistant"
          title="Open AI Assistant (Ctrl+/)"
        >
          <Bot className="w-4 h-4 text-purple-400 group-hover:text-purple-300 transition-colors" />
          <ChevronLeft className="w-3 h-3 text-editor-text-muted group-hover:text-editor-text transition-colors" />
        </button>
      )}
      {/* Resize handle */}
      {!collapsed && (
        <div
          ref={resizeHandleRef}
          data-testid="resize-handle"
          onMouseDown={handleResizeStart}
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary-500/50 active:bg-primary-500/70 transition-colors z-20"
        />
      )}

      {/* Header */}
      <header className="flex items-center justify-between px-3 py-2.5 border-b border-editor-border bg-editor-sidebar/50">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-purple-400" />
          <h2 className="text-sm font-medium text-editor-text">AI Assistant</h2>
          {/* Provider status indicator */}
          <div
            data-testid="provider-status"
            className={`w-2 h-2 rounded-full ${getProviderStatusColor()} ring-2 ring-offset-1 ring-offset-editor-sidebar/50 ring-transparent`}
            title={
              providerStatus.isConfigured
                ? providerStatus.isAvailable
                  ? `Connected: ${providerStatus.currentModel}`
                  : 'Provider unavailable'
                : 'Not configured'
            }
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-0.5">
          {/* Settings button */}
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className="p-1.5 rounded-md hover:bg-editor-surface transition-colors text-editor-text-muted hover:text-editor-text"
            aria-label="AI settings"
            title="AI Settings"
          >
            <Settings className="w-4 h-4" />
          </button>

          {/* Collapse button */}
          <button
            type="button"
            onClick={onToggle}
            className="p-1.5 rounded-md hover:bg-editor-surface transition-colors text-editor-text-muted hover:text-editor-text"
            aria-label="Collapse AI sidebar"
            aria-expanded={!collapsed}
            title="Collapse (Ctrl+/)"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Content - only render when not collapsed */}
      {!collapsed && (
        <AIErrorBoundary
          onError={(error) => {
            logger.error('AI Sidebar error caught by boundary', { error });
          }}
        >
          {/* Chat history - takes remaining space */}
          <ChatHistory />

          {/* Context panel */}
          <ContextPanel />

          {/* Quick actions */}
          <QuickActionsBar />

          {/* Chat input */}
          <ChatInput />
        </AIErrorBoundary>
      )}

      {/* Settings Dialog - z-[60] to be above toast level */}
      {showSettings && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={(e) => {
            // Close on backdrop click
            if (e.target === e.currentTarget) {
              setShowSettings(false);
            }
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-dialog-title"
        >
          <div className="w-full max-w-lg mx-4">
            <div className="bg-editor-bg rounded-lg border border-editor-border shadow-xl">
              {/* Dialog header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-editor-border">
                <h2 id="settings-dialog-title" className="text-lg font-semibold text-editor-text">
                  AI Settings
                </h2>
                <button
                  type="button"
                  onClick={() => setShowSettings(false)}
                  className="p-1.5 rounded-md hover:bg-editor-surface transition-colors text-editor-text-muted hover:text-editor-text"
                  aria-label="Close settings"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Dialog content */}
              <div className="p-4">
                <AISettingsPanel
                  onSaved={() => setShowSettings(false)}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

