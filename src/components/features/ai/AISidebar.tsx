/**
 * AISidebar Component
 *
 * Main AI assistant sidebar container with chat interface.
 * Includes toggle, resize, keyboard shortcuts, and provider status.
 */

import { useEffect, useCallback, useRef, useState } from 'react';
import { useAIStore } from '@/stores/aiStore';
import { useProjectStore } from '@/stores';
import { ChatHistory } from './ChatHistory';
import { ChatInput } from './ChatInput';
import { ContextPanel } from './ContextPanel';
import { QuickActionsBar } from './QuickActionsBar';
import { AISettingsPanel } from '../settings/AISettingsPanel';

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
      className={`flex flex-col bg-editor-bg border-l border-editor-border transition-all duration-200 ease-in-out ${
        collapsed ? 'w-0 overflow-hidden' : ''
      }`}
      style={collapsed ? undefined : { width: `${width}px` }}
    >
      {/* Resize handle */}
      {!collapsed && (
        <div
          ref={resizeHandleRef}
          data-testid="resize-handle"
          onMouseDown={handleResizeStart}
          className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-500/50 transition-colors z-10"
        />
      )}

      {/* Header */}
      <header className="flex items-center justify-between px-3 py-2 border-b border-editor-border">
        <div className="flex items-center gap-2">
          <AIIcon />
          <h2 className="text-sm font-medium text-editor-text">AI Assistant</h2>
          {/* Provider status indicator */}
          <div
            data-testid="provider-status"
            className={`w-2 h-2 rounded-full ${getProviderStatusColor()}`}
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
        <div className="flex items-center gap-1">
          {/* Settings button */}
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className="p-1 rounded hover:bg-editor-surface transition-colors"
            aria-label="AI settings"
          >
            <SettingsIcon />
          </button>

          {/* Toggle button */}
          <button
            type="button"
            onClick={onToggle}
            className="p-1 rounded hover:bg-editor-surface transition-colors"
            aria-label="Toggle AI sidebar"
            aria-expanded={!collapsed}
          >
            <CollapseIcon collapsed={collapsed} />
          </button>
        </div>
      </header>

      {/* Content - only render when not collapsed */}
      {!collapsed && (
        <>
          {/* Chat history - takes remaining space */}
          <ChatHistory />

          {/* Context panel */}
          <ContextPanel />

          {/* Quick actions */}
          <QuickActionsBar />

          {/* Chat input */}
          <ChatInput />
        </>
      )}

      {/* Settings Dialog */}
      {showSettings && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
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
                  className="p-1 rounded hover:bg-editor-surface transition-colors"
                  aria-label="Close settings"
                >
                  <svg className="w-5 h-5 text-editor-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
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

// =============================================================================
// Icons
// =============================================================================

function AIIcon() {
  return (
    <svg
      className="w-5 h-5 text-purple-400"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
      />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      className="w-4 h-4 text-editor-text-secondary"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
      />
    </svg>
  );
}

function CollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      className={`w-4 h-4 text-editor-text-secondary transition-transform ${
        collapsed ? 'rotate-180' : ''
      }`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M13 5l7 7-7 7M5 5l7 7-7 7"
      />
    </svg>
  );
}
