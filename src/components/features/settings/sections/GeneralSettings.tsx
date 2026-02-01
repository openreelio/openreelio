/**
 * GeneralSettings Component
 *
 * General application settings including language, welcome screen, and updates.
 */

import { useState, useEffect } from 'react';
import { FolderOpen, RefreshCw, CheckCircle, ArrowUpCircle, AlertCircle } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import type { GeneralSettings as GeneralSettingsType } from '@/stores/settingsStore';
import { useUpdate } from '@/hooks/useUpdate';
import { updateService } from '@/services/updateService';

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
  const [currentVersion, setCurrentVersion] = useState<string>('...');
  const {
    updateInfo,
    isChecking,
    isInstalling,
    error,
    updateAvailable,
    needsRestart,
    checkForUpdates,
    installUpdate,
    relaunch,
    clearError,
  } = useUpdate({ checkOnMount: false });

  // Load current version on mount
  useEffect(() => {
    updateService.getCurrentVersion().then(setCurrentVersion);
  }, []);

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

  const handleCheckForUpdates = async () => {
    clearError();
    try {
      await checkForUpdates();
    } catch {
      // Error is already handled by the hook
    }
  };

  const handleInstallUpdate = async () => {
    try {
      await installUpdate();
    } catch {
      // Error is already handled by the hook
    }
  };

  const handleRelaunch = async () => {
    await relaunch();
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

      {/* Startup Behavior */}
      <div>
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

      {/* Updates Section */}
      <div className="border-t border-editor-border pt-6">
        <h3 className="text-sm font-medium text-editor-text mb-4">Updates</h3>

        {/* Current Version */}
        <div className="flex items-center justify-between mb-4 px-3 py-2 bg-editor-bg rounded-lg border border-editor-border">
          <span className="text-sm text-editor-text-muted">Current version</span>
          <span className="text-sm font-mono text-editor-text">v{currentVersion}</span>
        </div>

        {/* Auto-check Setting */}
        <label className="flex items-center gap-3 cursor-pointer mb-4">
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

        {/* Manual Check Button & Status */}
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => void handleCheckForUpdates()}
            disabled={disabled || isChecking || isInstalling}
            className="w-full px-4 py-2 bg-editor-sidebar border border-editor-border rounded-lg text-editor-text hover:bg-editor-bg transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isChecking ? 'animate-spin' : ''}`} />
            {isChecking ? 'Checking...' : 'Check for Updates'}
          </button>

          {/* Update Status */}
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-red-400">{error}</p>
                <button
                  type="button"
                  onClick={clearError}
                  className="text-xs text-red-400/70 hover:text-red-400 underline mt-1"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {needsRestart && (
            <div className="flex items-center justify-between px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-lg">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-green-400" />
                <span className="text-sm text-green-400">Update installed successfully</span>
              </div>
              <button
                type="button"
                onClick={() => void handleRelaunch()}
                className="px-3 py-1 bg-green-500 text-white text-sm rounded hover:bg-green-600 transition-colors"
              >
                Restart Now
              </button>
            </div>
          )}

          {updateAvailable && !needsRestart && updateInfo && (
            <div className="flex items-center justify-between px-3 py-2 bg-primary-500/10 border border-primary-500/30 rounded-lg">
              <div className="flex items-center gap-2">
                <ArrowUpCircle className="w-4 h-4 text-primary-400" />
                <span className="text-sm text-primary-400">
                  Update available: v{updateInfo.latestVersion}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleInstallUpdate()}
                disabled={isInstalling}
                className="px-3 py-1 bg-primary-500 text-white text-sm rounded hover:bg-primary-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
              >
                {isInstalling ? (
                  <>
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    Installing...
                  </>
                ) : (
                  'Update Now'
                )}
              </button>
            </div>
          )}

          {!error && !needsRestart && !updateAvailable && updateInfo && (
            <div className="flex items-center gap-2 px-3 py-2 bg-editor-bg rounded-lg border border-editor-border">
              <CheckCircle className="w-4 h-4 text-green-400" />
              <span className="text-sm text-editor-text-muted">You're up to date</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
