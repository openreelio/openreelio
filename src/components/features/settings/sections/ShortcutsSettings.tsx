/**
 * ShortcutsSettings Component
 *
 * Keyboard shortcut customization section for Settings dialog.
 * Uses ShortcutEditor for full editing capabilities.
 */

import { ShortcutEditor } from '@/components/settings/ShortcutEditor';

interface ShortcutsSettingsProps {
  className?: string;
}

export function ShortcutsSettings({ className }: ShortcutsSettingsProps) {
  return (
    <div className={className}>
      <p className="text-sm text-editor-text-muted mb-4">
        Click on any shortcut to customize it. Press Escape to cancel editing.
      </p>
      <ShortcutEditor />
    </div>
  );
}
