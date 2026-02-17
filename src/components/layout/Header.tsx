/**
 * Header Component
 *
 * Application header with branding, project info, menu bar, and toolbar.
 */

import { X, Save, FolderOpen, Download, Search, Settings, Loader2 } from 'lucide-react';
import { UndoRedoButtons } from '@/components/ui';
import { SearchPanel } from '@/components/features/search';
import { SettingsDialog } from '@/components/features/settings';
import { ShortcutsDialog } from '@/components/features/help';
import { useProjectStore, useUIStore } from '@/stores';
import { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { createLogger } from '@/services/logger';
import { SaveStatusBadge, type SaveStatus } from './SaveStatusBadge';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';
import type { AssetSearchResultItem } from '@/hooks/useSearch';

const logger = createLogger('Header');

// =============================================================================
// Types
// =============================================================================

interface HeaderProps {
  /** Application title */
  title?: string;
  /** Version string */
  version?: string;
  /** Whether to show toolbar (undo/redo buttons) */
  showToolbar?: boolean;
  /** Export button click handler */
  onExport?: () => void;
  /** Callback when a search result is selected */
  onSearchResultSelect?: (result: AssetSearchResultItem) => void;
}

// =============================================================================
// Component
// =============================================================================

export function Header({
  title = 'OpenReelio',
  version = '0.1.0',
  showToolbar = true,
  onExport,
  onSearchResultSelect,
}: HeaderProps) {
  const { meta, isDirty, closeProject, saveProject } = useProjectStore();
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Derived state for backward compatibility
  const isSaving = saveStatus === 'saving';
  const [showSearch, setShowSearch] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);

  const isMacLikePlatform = useMemo(
    () => typeof navigator !== 'undefined' && /(Mac|iPhone|iPad|iPod)/i.test(navigator.platform),
    [],
  );
  const searchShortcutLabel = isMacLikePlatform ? '⌘K' : 'Ctrl+K';
  const settingsShortcutLabel = isMacLikePlatform ? '⌘,' : 'Ctrl+,';
  const saveShortcutLabel = isMacLikePlatform ? '⌘S' : 'Ctrl+S';

  // Global settings dialog state
  const isSettingsOpen = useUIStore((state) => state.isSettingsOpen);
  const openSettings = useUIStore((state) => state.openSettings);
  const closeSettings = useUIStore((state) => state.closeSettings);

  // Keyboard shortcuts (Ctrl/Cmd + K for search, Ctrl/Cmd + , for settings, ? for shortcuts)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip all shortcuts if in input element to avoid disrupting user input
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if (isInput) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setShowSearch(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        openSettings();
      }
      // "?" key for shortcuts (Shift + /)
      if (e.key === '?') {
        e.preventDefault();
        setShowShortcuts(true);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [openSettings]);

  const handleSearchClose = useCallback(() => {
    setShowSearch(false);
  }, []);

  const handleSearchResultSelect = useCallback(
    (result: AssetSearchResultItem) => {
      onSearchResultSelect?.(result);
      setShowSearch(false);
    },
    [onSearchResultSelect],
  );

  const handleSave = useCallback(async () => {
    // Clear any existing "saved" timeout
    if (savedTimeoutRef.current) {
      clearTimeout(savedTimeoutRef.current);
      savedTimeoutRef.current = null;
    }

    setSaveStatus('saving');
    try {
      await saveProject();
      setSaveStatus('saved');
      // Show "saved" for 3 seconds then return to idle
      savedTimeoutRef.current = setTimeout(() => {
        setSaveStatus('idle');
      }, 3000);
    } catch (error) {
      logger.error('Failed to save project', { error });
      setSaveStatus('error');
      // Show error for 5 seconds then return to idle
      savedTimeoutRef.current = setTimeout(() => {
        setSaveStatus('idle');
      }, 5000);
    }
  }, [saveProject]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (savedTimeoutRef.current) {
        clearTimeout(savedTimeoutRef.current);
      }
    };
  }, []);

  // Handle close button click - show confirmation if unsaved changes
  const handleCloseClick = useCallback(() => {
    if (isDirty) {
      setShowCloseConfirm(true);
    } else {
      void closeProject();
    }
  }, [isDirty, closeProject]);

  // Save and close project
  const handleSaveAndClose = useCallback(async () => {
    setSaveStatus('saving');
    try {
      await saveProject();
      setShowCloseConfirm(false);
      await closeProject();
    } catch (error) {
      logger.error('Failed to save project', { error });
      setSaveStatus('error');
      // Keep dialog open on error so user can retry or discard
    }
  }, [saveProject, closeProject]);

  // Discard changes and close project
  const handleDiscardAndClose = useCallback(() => {
    setShowCloseConfirm(false);
    void closeProject();
  }, [closeProject]);

  // Cancel close action
  const handleCancelClose = useCallback(() => {
    setShowCloseConfirm(false);
  }, []);

  return (
    <div className="border-b border-editor-border bg-editor-sidebar px-2 py-2 sm:px-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/* Branding */}
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="shrink-0 text-sm font-semibold text-primary-400">{title}</h1>
          <span className="text-xs text-editor-text-muted">v{version}</span>
        </div>

        {/* Project Info */}
        {meta && (
          <div className="hidden min-w-0 items-center gap-2 lg:flex">
            <div className="h-4 w-px bg-editor-border" />
            <div className="flex min-w-0 items-center gap-2">
              <FolderOpen className="h-4 w-4 shrink-0 text-editor-text-muted" />
              <span className="max-w-[220px] truncate text-sm text-editor-text" title={meta.name}>
                {meta.name}
              </span>

              {/* Save Status Indicator */}
              <div className="ml-1 flex items-center gap-1.5">
                <SaveStatusBadge status={saveStatus} isDirty={isDirty} />
              </div>
            </div>
          </div>
        )}

        <div className="ml-auto flex min-w-0 items-center gap-2">
          {/* Search Button */}
          <button
            onClick={() => setShowSearch(true)}
            className="flex items-center gap-2 rounded-lg border border-border-default bg-surface-panel px-2 py-1.5 text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary sm:px-3"
            title={`Search (${searchShortcutLabel})`}
          >
            <Search className="h-4 w-4" />
            <span className="hidden text-sm sm:inline">Search</span>
            <kbd className="hidden rounded bg-surface-active px-1.5 py-0.5 text-xs md:inline-block">
              {searchShortcutLabel}
            </kbd>
          </button>

          {/* Toolbar */}
          {showToolbar && (
            <div className="flex items-center gap-1 sm:gap-2">
              <div className="hidden sm:flex">
                <UndoRedoButtons />
              </div>

              {/* Save Button */}
              <button
                onClick={() => void handleSave()}
                disabled={!isDirty || isSaving}
                className={`rounded p-1.5 transition-colors disabled:cursor-not-allowed ${
                  isSaving
                    ? 'text-blue-400'
                    : isDirty
                      ? 'text-yellow-500 hover:text-yellow-400 hover:bg-editor-bg'
                      : 'text-editor-text-muted hover:text-editor-text disabled:opacity-50'
                }`}
                title={
                  isSaving
                    ? 'Saving...'
                    : isDirty
                      ? `Save project (${saveShortcutLabel})`
                      : 'No changes to save'
                }
              >
                {isSaving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
              </button>

              {/* Export Button */}
              {onExport && (
                <button
                  onClick={onExport}
                  className="rounded p-1.5 text-editor-text-muted transition-colors hover:bg-editor-bg hover:text-primary-400"
                  title="Export video"
                >
                  <Download className="h-4 w-4" />
                </button>
              )}

              <div className="h-4 w-px bg-editor-border" />

              {/* Settings Button */}
              <button
                onClick={() => openSettings()}
                className="rounded p-1.5 text-editor-text-muted transition-colors hover:bg-editor-bg hover:text-editor-text"
                title={`Settings (${settingsShortcutLabel})`}
              >
                <Settings className="h-4 w-4" />
              </button>

              {/* Close Project Button */}
              <button
                onClick={handleCloseClick}
                className="rounded p-1.5 text-editor-text-muted transition-colors hover:bg-editor-bg hover:text-red-400"
                title="Close project"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      <UnsavedChangesDialog
        isOpen={showCloseConfirm}
        isSaving={isSaving}
        onCancel={handleCancelClose}
        onDiscard={handleDiscardAndClose}
        onSave={() => void handleSaveAndClose()}
      />

      {/* Search Panel */}
      <SearchPanel
        isOpen={showSearch}
        onClose={handleSearchClose}
        onResultSelect={handleSearchResultSelect}
        showBackdrop
        className="fixed top-1/4 left-1/2 -translate-x-1/2 w-full max-w-2xl"
      />

      {/* Settings Dialog */}
      <SettingsDialog isOpen={isSettingsOpen} onClose={closeSettings} />

      {/* Shortcuts Dialog */}
      <ShortcutsDialog isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />
    </div>
  );
}
