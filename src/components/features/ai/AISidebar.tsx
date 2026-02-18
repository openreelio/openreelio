/**
 * AISidebar Component
 *
 * Main AI assistant sidebar container with chat interface.
 * Includes toggle, resize, keyboard shortcuts, and provider status.
 */

import { useEffect, useCallback, useRef, useState } from 'react';
import { Bot, Settings, ChevronRight, ChevronLeft, Plus, Zap } from 'lucide-react';
import { useAIStore } from '@/stores/aiStore';
import { useUIStore } from '@/stores';
import { AIErrorBoundary } from '@/components/shared/FeatureErrorBoundaries';
import { AgenticSidebarContent } from '@/components/features/agent';
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

  // New Chat handler, registered by AgenticSidebarContent
  const [newChatHandler, setNewChatHandler] = useState<{
    handler: () => void;
    canCreate: boolean;
  }>({ handler: () => {}, canCreate: false });

  const onRegisterNewChat = useCallback(
    (handler: () => void, canCreate: boolean) => {
      setNewChatHandler({ handler, canCreate });
    },
    [],
  );

  // Global settings dialog
  const openSettings = useUIStore((state) => state.openSettings);

  // Get provider status from store
  const providerStatus = useAIStore((state) => state.providerStatus);
  const syncFromSettings = useAIStore((state) => state.syncFromSettings);

  // Sync provider from global settings on mount
  useEffect(() => {
    syncFromSettings().catch((error) => {
      logger.warn('Failed to sync AI provider from global settings', { error });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        collapsed ? 'w-0' : ''
      }`}
      style={collapsed ? { overflow: 'visible' } : { width: `${width}px` }}
    >
      {/* Expand button - visible when collapsed */}
      {collapsed && (
        <button
          type="button"
          onClick={onToggle}
          className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-0 flex items-center gap-1.5 px-2 py-3 bg-editor-surface border border-editor-border border-r-0 rounded-l-lg hover:bg-primary-500/10 hover:border-primary-500/50 transition-all group shadow-lg z-30"
          style={{ transform: 'translateY(-50%) translateX(-100%)' }}
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
          <span
            data-testid="agentic-mode-indicator"
            className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-purple-500/20 text-purple-300 rounded"
            title="Agentic Engine Mode (Think-Plan-Act-Observe)"
          >
            <Zap className="w-2.5 h-2.5" />
            Agent
          </span>
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
          <button
            type="button"
            data-testid="new-chat-btn"
            onClick={newChatHandler.handler}
            disabled={!newChatHandler.canCreate}
            className="p-1.5 rounded-md hover:bg-editor-surface transition-colors text-editor-text-muted hover:text-editor-text disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="New conversation"
            title="New conversation"
          >
            <Plus className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => openSettings('ai')}
            className="p-1.5 rounded-md hover:bg-editor-surface transition-colors text-editor-text-muted hover:text-editor-text"
            aria-label="AI settings"
            title="AI Settings"
          >
            <Settings className="w-4 h-4" />
          </button>

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
          <AgenticSidebarContent
            className="flex-1"
            onRegisterNewChat={onRegisterNewChat}
          />
        </AIErrorBoundary>
      )}

    </aside>
  );
}
