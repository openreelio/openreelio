/**
 * ShortcutEditor Component
 *
 * UI for viewing and customizing keyboard shortcuts.
 * Displays shortcuts organized by category with editing support.
 *
 * Features:
 * - View all shortcuts by category
 * - Click to edit shortcut
 * - Conflict detection
 * - Reset individual or all shortcuts
 * - Search/filter shortcuts
 */

import { memo, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Search, RotateCcw, AlertTriangle } from 'lucide-react';
import { useShortcutSettings } from '@/hooks/useShortcutSettings';
import { keyEventToSignature, signatureToDisplayString } from '@/utils/shortcutUtils';
import { getShortcutAction, type ShortcutCategory, type ShortcutEntry } from '@/utils/shortcutActions';

// =============================================================================
// Types
// =============================================================================

export interface ShortcutEditorProps {
  /** Additional CSS classes */
  className?: string;
}

interface ShortcutRowProps {
  entry: ShortcutEntry;
  isEditing: boolean;
  isCustomized: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSetShortcut: (shortcut: string) => void;
  onReset: () => void;
  conflictActionId: string | null;
}

// =============================================================================
// Category Display Names
// =============================================================================

const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  playback: 'Playback',
  timeline: 'Timeline',
  project: 'Project',
  navigation: 'Navigation',
  view: 'View',
  tools: 'Tools',
};

// Category order for display
const CATEGORY_ORDER: ShortcutCategory[] = [
  'playback',
  'timeline',
  'project',
  'navigation',
  'view',
  'tools',
];

// =============================================================================
// ShortcutRow Component
// =============================================================================

const ShortcutRow = memo(function ShortcutRow({
  entry,
  isEditing,
  isCustomized,
  onStartEdit,
  onCancelEdit,
  onSetShortcut,
  onReset,
  conflictActionId,
}: ShortcutRowProps) {
  const inputRef = useRef<HTMLDivElement>(null);

  // Handle key capture when editing
  useEffect(() => {
    if (!isEditing) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Escape cancels editing
      if (e.key === 'Escape') {
        onCancelEdit();
        return;
      }

      // Ignore modifier-only presses
      const signature = keyEventToSignature(e);
      if (!signature) return;

      onSetShortcut(signature);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isEditing, onCancelEdit, onSetShortcut]);

  // Focus when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  const conflictAction = conflictActionId ? getShortcutAction(conflictActionId) : null;

  return (
    <div
      className={`
        flex items-center justify-between px-3 py-2 rounded-md
        ${isCustomized ? 'bg-primary-500/10' : 'hover:bg-surface-active'}
      `}
    >
      {/* Action Label */}
      <div className="flex flex-col gap-0.5">
        <span className="text-sm text-editor-text">{entry.label}</span>
        {entry.description && (
          <span className="text-xs text-editor-text-muted">{entry.description}</span>
        )}
      </div>

      {/* Shortcut Key */}
      <div className="flex items-center gap-2">
        {/* Conflict Warning */}
        {conflictActionId && (
          <div className="flex items-center gap-1 text-warning-500">
            <AlertTriangle className="w-4 h-4" />
            <span className="text-xs">
              Conflict with {conflictAction?.label ?? conflictActionId}
            </span>
          </div>
        )}

        {/* Shortcut Display / Editor */}
        {isEditing ? (
          <div
            ref={inputRef}
            tabIndex={0}
            className="px-3 py-1.5 text-sm bg-surface-highest border border-primary-500 rounded animate-pulse"
          >
            Press a key...
          </div>
        ) : (
          <button
            className={`
              px-3 py-1.5 text-sm rounded border transition-colors
              ${isCustomized
                ? 'bg-primary-500/20 border-primary-500/50 text-primary-400'
                : 'bg-surface-highest border-editor-border text-editor-text hover:border-primary-500/50'
              }
            `}
            onClick={onStartEdit}
          >
            {entry.shortcut ? signatureToDisplayString(entry.shortcut) : 'Not set'}
          </button>
        )}

        {/* Reset Button */}
        {isCustomized && !isEditing && (
          <button
            className="p-1.5 rounded hover:bg-surface-active text-editor-text-muted hover:text-editor-text"
            onClick={onReset}
            aria-label="Reset shortcut"
            title="Reset to default"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
});

// =============================================================================
// ShortcutEditor Component
// =============================================================================

export const ShortcutEditor = memo(function ShortcutEditor({
  className = '',
}: ShortcutEditorProps) {
  const {
    getShortcutsByCategory,
    setShortcut,
    resetShortcut,
    resetAllShortcuts,
    isCustomized,
    hasConflict,
  } = useShortcutSettings();

  const [searchQuery, setSearchQuery] = useState('');
  const [editingActionId, setEditingActionId] = useState<string | null>(null);
  const [pendingShortcut, setPendingShortcut] = useState<string | null>(null);
  const conflictTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shortcutsByCategory = getShortcutsByCategory();

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (conflictTimeoutRef.current) {
        clearTimeout(conflictTimeoutRef.current);
      }
    };
  }, []);

  // Filter shortcuts by search query
  const filtered = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return shortcutsByCategory;

    const result: Record<ShortcutCategory, ShortcutEntry[]> = {
      playback: [],
      timeline: [],
      project: [],
      navigation: [],
      view: [],
      tools: [],
    };

    for (const category of CATEGORY_ORDER) {
      const filteredEntries = shortcutsByCategory[category].filter((entry) =>
        entry.label.toLowerCase().includes(query) ||
        entry.actionId.toLowerCase().includes(query) ||
        entry.shortcut?.toLowerCase().includes(query)
      );
      result[category] = filteredEntries;
    }

    return result;
  }, [searchQuery, shortcutsByCategory]);

  // Handle starting edit
  const handleStartEdit = useCallback((actionId: string) => {
    setEditingActionId(actionId);
    setPendingShortcut(null);
  }, []);

  // Handle cancel edit
  const handleCancelEdit = useCallback(() => {
    setEditingActionId(null);
    setPendingShortcut(null);
  }, []);

  // Handle setting shortcut
  const handleSetShortcut = useCallback(
    (actionId: string, shortcut: string) => {
      // Clear any existing timeout
      if (conflictTimeoutRef.current) {
        clearTimeout(conflictTimeoutRef.current);
        conflictTimeoutRef.current = null;
      }

      // Check for conflict
      const conflict = hasConflict(shortcut, actionId);
      if (conflict) {
        // Show conflict warning but still set the shortcut
        setPendingShortcut(shortcut);
        setShortcut(actionId, shortcut);
        // Keep editing state briefly to show conflict warning
        // Then clear after a short delay
        conflictTimeoutRef.current = setTimeout(() => {
          setEditingActionId(null);
          setPendingShortcut(null);
          conflictTimeoutRef.current = null;
        }, 2000);
      } else {
        setShortcut(actionId, shortcut);
        setEditingActionId(null);
        setPendingShortcut(null);
      }
    },
    [hasConflict, setShortcut]
  );

  // Handle reset
  const handleReset = useCallback(
    (actionId: string) => {
      resetShortcut(actionId);
    },
    [resetShortcut]
  );

  // Handle reset all
  const handleResetAll = useCallback(() => {
    resetAllShortcuts();
  }, [resetAllShortcuts]);

  return (
    <div data-testid="shortcut-editor" className={`flex flex-col gap-4 ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-editor-text">Keyboard Shortcuts</h3>
        <button
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-surface-highest hover:bg-surface-active text-editor-text-muted hover:text-editor-text"
          onClick={handleResetAll}
        >
          <RotateCcw className="w-4 h-4" />
          Reset All
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-editor-text-muted" />
        <input
          type="text"
          placeholder="Search shortcuts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-9 pr-4 py-2 text-sm bg-surface-highest border border-editor-border rounded focus:outline-none focus:border-primary-500"
        />
      </div>

      {/* Categories */}
      <div className="flex flex-col gap-6">
        {CATEGORY_ORDER.map((category) => {
          const entries = filtered[category];
          if (entries.length === 0) return null;

          return (
            <div key={category} className="flex flex-col gap-2">
              <h4 className="text-sm font-medium text-editor-text-muted px-1">
                {CATEGORY_LABELS[category]}
              </h4>
              <div className="flex flex-col gap-1">
                {entries.map((entry) => (
                  <ShortcutRow
                    key={entry.actionId}
                    entry={entry}
                    isEditing={editingActionId === entry.actionId}
                    isCustomized={isCustomized(entry.actionId)}
                    onStartEdit={() => handleStartEdit(entry.actionId)}
                    onCancelEdit={handleCancelEdit}
                    onSetShortcut={(shortcut) => handleSetShortcut(entry.actionId, shortcut)}
                    onReset={() => handleReset(entry.actionId)}
                    conflictActionId={
                      editingActionId === entry.actionId && pendingShortcut
                        ? hasConflict(pendingShortcut, entry.actionId)
                        : null
                    }
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Empty State */}
      {CATEGORY_ORDER.every((cat) => filtered[cat].length === 0) && (
        <div className="text-center py-8 text-editor-text-muted">
          No shortcuts found matching "{searchQuery}"
        </div>
      )}
    </div>
  );
});

export default ShortcutEditor;
