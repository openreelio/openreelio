/**
 * ShortcutsSettings Component
 *
 * Read-only display of keyboard shortcuts grouped by category.
 */

import { KEYBOARD_SHORTCUTS } from '@/hooks/useKeyboardShortcuts';

interface ShortcutsSettingsProps {
  className?: string;
}

export function ShortcutsSettings({ className }: ShortcutsSettingsProps) {
  return (
    <div className={className}>
      <p className="text-sm text-editor-text-muted mb-4">
        Keyboard shortcuts for common actions. Custom shortcuts will be available in a future update.
      </p>

      <div className="space-y-6">
        {KEYBOARD_SHORTCUTS.map((group) => (
          <div key={group.category}>
            <h4 className="text-sm font-medium text-editor-text mb-3">
              {group.category}
            </h4>
            <div className="space-y-2">
              {group.shortcuts.map((shortcut) => (
                <div
                  key={shortcut.key}
                  className="flex items-center justify-between py-2 px-3 bg-editor-bg rounded-lg"
                >
                  <span className="text-sm text-editor-text">
                    {shortcut.description}
                  </span>
                  <kbd className="px-2 py-1 bg-editor-sidebar border border-editor-border rounded text-xs text-editor-text-muted font-mono">
                    {formatShortcut(shortcut.key)}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* Additional shortcuts not in the KEYBOARD_SHORTCUTS constant */}
        <div>
          <h4 className="text-sm font-medium text-editor-text mb-3">
            Application
          </h4>
          <div className="space-y-2">
            <ShortcutRow description="Save Project" shortcut="Ctrl+S" />
            <ShortcutRow description="Search" shortcut="Ctrl+K" />
            <ShortcutRow description="Settings" shortcut="Ctrl+," />
            <ShortcutRow description="Export" shortcut="Ctrl+Shift+E" />
            <ShortcutRow description="Jump to Start" shortcut="Home" />
            <ShortcutRow description="Jump to End" shortcut="End" />
            <ShortcutRow description="Zoom In Timeline" shortcut="Ctrl+=" />
            <ShortcutRow description="Zoom Out Timeline" shortcut="Ctrl+-" />
          </div>
        </div>
      </div>
    </div>
  );
}

interface ShortcutRowProps {
  description: string;
  shortcut: string;
}

function ShortcutRow({ description, shortcut }: ShortcutRowProps) {
  return (
    <div className="flex items-center justify-between py-2 px-3 bg-editor-bg rounded-lg">
      <span className="text-sm text-editor-text">{description}</span>
      <kbd className="px-2 py-1 bg-editor-sidebar border border-editor-border rounded text-xs text-editor-text-muted font-mono">
        {formatShortcut(shortcut)}
      </kbd>
    </div>
  );
}

function formatShortcut(key: string): string {
  // Convert generic key names to platform-specific symbols if on Mac
  // For now, just return as-is (Windows-style)
  return key
    .replace('Ctrl+', 'Ctrl + ')
    .replace('Shift+', 'Shift + ')
    .replace('Alt+', 'Alt + ');
}
