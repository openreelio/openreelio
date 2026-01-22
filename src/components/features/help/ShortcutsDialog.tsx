/**
 * ShortcutsDialog Component
 *
 * Modal dialog displaying all keyboard shortcuts grouped by category.
 * Accessible via the "?" key.
 */

import { useEffect, useRef, useCallback } from 'react';
import { X, Keyboard } from 'lucide-react';
import { KEYBOARD_SHORTCUTS } from '@/hooks/useKeyboardShortcuts';

export interface ShortcutsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

// Additional shortcuts not in KEYBOARD_SHORTCUTS constant
const APPLICATION_SHORTCUTS = [
  { key: 'Ctrl+S', description: 'Save Project' },
  { key: 'Ctrl+K', description: 'Search' },
  { key: 'Ctrl+,', description: 'Settings' },
  { key: 'Ctrl+Shift+E', description: 'Export' },
  { key: '?', description: 'Show Shortcuts' },
];

const NAVIGATION_SHORTCUTS = [
  { key: 'Home', description: 'Jump to Start' },
  { key: 'End', description: 'Jump to End' },
  { key: 'Ctrl+=', description: 'Zoom In Timeline' },
  { key: 'Ctrl+-', description: 'Zoom Out Timeline' },
];

export function ShortcutsDialog({ isOpen, onClose }: ShortcutsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      dialogRef.current?.focus();
    }
  }, [isOpen]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        onClose();
      }
    },
    [onClose]
  );

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-labelledby="shortcuts-title"
        aria-modal="true"
        tabIndex={-1}
        className="bg-editor-panel border border-editor-border rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-editor-border shrink-0">
          <div className="flex items-center gap-3">
            <Keyboard className="w-5 h-5 text-primary-400" />
            <h2 id="shortcuts-title" className="text-lg font-semibold text-editor-text">
              Keyboard Shortcuts
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-editor-bg transition-colors text-editor-text-muted hover:text-editor-text"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="grid grid-cols-2 gap-8">
            {/* Left Column */}
            <div className="space-y-6">
              {/* Application */}
              <ShortcutGroup title="Application" shortcuts={APPLICATION_SHORTCUTS} />

              {/* Navigation */}
              <ShortcutGroup title="Navigation" shortcuts={NAVIGATION_SHORTCUTS} />
            </div>

            {/* Right Column */}
            <div className="space-y-6">
              {/* From KEYBOARD_SHORTCUTS constant */}
              {KEYBOARD_SHORTCUTS.map((group) => (
                <ShortcutGroup
                  key={group.category}
                  title={group.category}
                  shortcuts={group.shortcuts}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-center px-6 py-4 border-t border-editor-border bg-editor-sidebar/50 rounded-b-xl shrink-0">
          <p className="text-xs text-editor-text-muted">
            Press <kbd className="px-1.5 py-0.5 bg-editor-bg border border-editor-border rounded text-xs mx-1">?</kbd> or <kbd className="px-1.5 py-0.5 bg-editor-bg border border-editor-border rounded text-xs mx-1">Esc</kbd> to close
          </p>
        </div>
      </div>
    </div>
  );
}

interface ShortcutGroupProps {
  title: string;
  shortcuts: Array<{ key: string; description: string }>;
}

function ShortcutGroup({ title, shortcuts }: ShortcutGroupProps) {
  return (
    <div>
      <h3 className="text-sm font-medium text-editor-text mb-3">{title}</h3>
      <div className="space-y-2">
        {shortcuts.map((shortcut) => (
          <div
            key={shortcut.key}
            className="flex items-center justify-between py-1.5"
          >
            <span className="text-sm text-editor-text-muted">
              {shortcut.description}
            </span>
            <kbd className="px-2 py-1 bg-editor-bg border border-editor-border rounded text-xs text-editor-text font-mono">
              {formatShortcut(shortcut.key)}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatShortcut(key: string): string {
  return key
    .replace('Ctrl+', 'Ctrl + ')
    .replace('Shift+', 'Shift + ')
    .replace('Alt+', 'Alt + ');
}

export default ShortcutsDialog;
