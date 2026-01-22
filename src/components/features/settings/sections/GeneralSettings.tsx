/**
 * GeneralSettings Component
 *
 * General application settings including language, welcome screen, and updates.
 */

import { FolderOpen } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import type { GeneralSettings as GeneralSettingsType } from '@/stores/settingsStore';

interface GeneralSettingsProps {
  settings: GeneralSettingsType;
  onUpdate: (values: Partial<GeneralSettingsType>) => void;
  disabled?: boolean;
}

export function GeneralSettings({
  settings,
  onUpdate,
  disabled = false,
}: GeneralSettingsProps) {
  const handleBrowseLocation = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Select Default Project Location',
    });

    if (selected && typeof selected === 'string') {
      onUpdate({ defaultProjectLocation: selected });
    }
  };

  return (
    <div className="space-y-6">
      {/* Language */}
      <div>
        <label
          htmlFor="language"
          className="block text-sm font-medium text-editor-text mb-2"
        >
          Language
        </label>
        <select
          id="language"
          value={settings.language}
          onChange={(e) => onUpdate({ language: e.target.value })}
          disabled={disabled}
          className="w-full px-3 py-2 bg-editor-bg border border-editor-border rounded-lg text-editor-text focus:outline-none focus:ring-2 focus:ring-primary-500/50 disabled:opacity-50"
        >
          <option value="en">English</option>
        </select>
        <p className="mt-1 text-xs text-editor-text-muted">
          More languages coming soon
        </p>
      </div>

      {/* Default Project Location */}
      <div>
        <label className="block text-sm font-medium text-editor-text mb-2">
          Default Project Location
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={settings.defaultProjectLocation || ''}
            readOnly
            className="flex-1 px-3 py-2 bg-editor-bg border border-editor-border rounded-lg text-editor-text text-sm truncate"
            placeholder="Not set (uses system default)"
          />
          <button
            type="button"
            onClick={() => void handleBrowseLocation()}
            disabled={disabled}
            className="px-4 py-2 bg-editor-sidebar border border-editor-border rounded-lg text-editor-text hover:bg-editor-bg transition-colors flex items-center gap-2 disabled:opacity-50"
          >
            <FolderOpen className="w-4 h-4" />
            Browse
          </button>
        </div>
      </div>

      {/* Checkboxes */}
      <div className="space-y-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.showWelcomeOnStartup}
            onChange={(e) => onUpdate({ showWelcomeOnStartup: e.target.checked })}
            disabled={disabled}
            className="w-4 h-4 rounded border-editor-border bg-editor-bg text-primary-500 focus:ring-primary-500/50 focus:ring-offset-0"
          />
          <div>
            <span className="text-sm text-editor-text">
              Show welcome screen on startup
            </span>
            <p className="text-xs text-editor-text-muted">
              Display the welcome screen with recent projects when opening the app
            </p>
          </div>
        </label>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.checkUpdatesOnStartup}
            onChange={(e) => onUpdate({ checkUpdatesOnStartup: e.target.checked })}
            disabled={disabled}
            className="w-4 h-4 rounded border-editor-border bg-editor-bg text-primary-500 focus:ring-primary-500/50 focus:ring-offset-0"
          />
          <div>
            <span className="text-sm text-editor-text">
              Check for updates on startup
            </span>
            <p className="text-xs text-editor-text-muted">
              Automatically check for new versions when the app starts
            </p>
          </div>
        </label>
      </div>

      {/* Recent Projects Limit */}
      <div>
        <label
          htmlFor="recentProjectsLimit"
          className="block text-sm font-medium text-editor-text mb-2"
        >
          Recent Projects Limit
        </label>
        <select
          id="recentProjectsLimit"
          value={settings.recentProjectsLimit}
          onChange={(e) => onUpdate({ recentProjectsLimit: Number(e.target.value) })}
          disabled={disabled}
          className="w-full px-3 py-2 bg-editor-bg border border-editor-border rounded-lg text-editor-text focus:outline-none focus:ring-2 focus:ring-primary-500/50 disabled:opacity-50"
        >
          <option value={5}>5 projects</option>
          <option value={10}>10 projects</option>
          <option value={15}>15 projects</option>
          <option value={20}>20 projects</option>
        </select>
        <p className="mt-1 text-xs text-editor-text-muted">
          Maximum number of recent projects to display
        </p>
      </div>
    </div>
  );
}
