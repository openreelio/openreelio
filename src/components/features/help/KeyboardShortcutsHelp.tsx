/**
 * Keyboard Shortcuts Help Component
 *
 * Displays a modal/panel with all available keyboard shortcuts.
 * Triggered by pressing '?' or from the help menu.
 *
 * @module components/features/help/KeyboardShortcutsHelp
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { X, Keyboard } from 'lucide-react';
import { ENHANCED_KEYBOARD_SHORTCUTS } from '@/hooks/useEnhancedKeyboardShortcuts';

// =============================================================================
// Types
// =============================================================================

export interface KeyboardShortcutsHelpProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback when dialog should close */
  onClose: () => void;
}

// =============================================================================
// Component
// =============================================================================

function KeyboardShortcutsHelpComponent({ isOpen, onClose }: KeyboardShortcutsHelpProps) {
  // Handle escape key to close
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Handle click outside to close
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-dialog-title"
    >
      <div className="w-full max-w-3xl max-h-[80vh] bg-editor-panel rounded-lg shadow-xl border border-editor-border overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-editor-border">
          <div className="flex items-center gap-3">
            <Keyboard className="w-5 h-5 text-primary-400" />
            <h2 id="shortcuts-dialog-title" className="text-lg font-medium text-editor-text">
              Keyboard Shortcuts
            </h2>
          </div>
          <button
            type="button"
            className="p-1.5 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text transition-colors"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(80vh-80px)]">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {ENHANCED_KEYBOARD_SHORTCUTS.map((category) => (
              <div key={category.category}>
                <h3 className="text-sm font-medium text-primary-400 mb-3">
                  {category.category}
                </h3>
                <div className="space-y-2">
                  {category.shortcuts.map((shortcut) => (
                    <div
                      key={shortcut.key}
                      className="flex items-center justify-between py-1.5"
                    >
                      <span className="text-sm text-editor-text-muted">
                        {shortcut.description}
                      </span>
                      <kbd className="px-2 py-1 text-xs font-mono bg-editor-sidebar rounded border border-editor-border text-editor-text">
                        {shortcut.key}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Additional Tips */}
          <div className="mt-8 pt-6 border-t border-editor-border">
            <h3 className="text-sm font-medium text-editor-text-muted mb-3">
              Tips
            </h3>
            <ul className="text-sm text-editor-text-muted space-y-2">
              <li>• Press <kbd className="px-1.5 py-0.5 text-xs font-mono bg-editor-sidebar rounded border border-editor-border">?</kbd> to toggle this help dialog</li>
              <li>• Hold <kbd className="px-1.5 py-0.5 text-xs font-mono bg-editor-sidebar rounded border border-editor-border">Shift</kbd> + <kbd className="px-1.5 py-0.5 text-xs font-mono bg-editor-sidebar rounded border border-editor-border">J</kbd>/<kbd className="px-1.5 py-0.5 text-xs font-mono bg-editor-sidebar rounded border border-editor-border">L</kbd> for faster shuttle speeds</li>
              <li>• Use <kbd className="px-1.5 py-0.5 text-xs font-mono bg-editor-sidebar rounded border border-editor-border">Ctrl</kbd> + click to multi-select clips</li>
              <li>• Drag from clip edges to trim in/out points</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

export const KeyboardShortcutsHelp = memo(KeyboardShortcutsHelpComponent);

// =============================================================================
// Hook for Keyboard Shortcut Help Trigger
// =============================================================================

/**
 * Hook that manages the keyboard shortcuts help dialog visibility.
 * Opens on '?' key press.
 */
export function useKeyboardShortcutsHelp() {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  // Listen for '?' key to toggle help
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check if '?' is pressed (Shift + /)
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        // Don't trigger when typing in input fields
        const target = e.target as HTMLElement;
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        toggle();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggle]);

  return {
    isOpen,
    open,
    close,
    toggle,
  };
}

export default KeyboardShortcutsHelp;
