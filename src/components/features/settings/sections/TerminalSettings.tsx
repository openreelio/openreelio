import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isDesktopRuntimeAvailable } from '@/services/runtimeEnvironment';
import type { TerminalSettings as TerminalSettingsType } from '@/stores/settingsStore';

interface TerminalSettingsProps {
  settings: TerminalSettingsType;
  onUpdate: (values: Partial<TerminalSettingsType>) => void;
  disabled?: boolean;
}

interface DetectedTerminalProfile {
  id: string;
  label: string;
  commandLine: string;
  source: string;
  isDefault: boolean;
}

const SYSTEM_DEFAULT_ID = '__system__';

function getTerminalExamples(): { defaultLabel: string; examples: string } {
  if (typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('win')) {
    return {
      defaultLabel: 'Windows default shell',
      examples: 'Examples: PowerShell, PowerShell 7, WSL, Git Bash',
    };
  }

  if (typeof navigator !== 'undefined' && /(mac|iphone|ipad|ipod)/i.test(navigator.platform)) {
    return {
      defaultLabel: 'your login shell',
      examples: 'Examples: /bin/zsh, /bin/bash, /opt/homebrew/bin/fish',
    };
  }

  return { defaultLabel: 'your login shell', examples: 'Examples: /bin/bash, /bin/zsh, fish' };
}

function profileSourceLabel(source: string): string {
  if (source === 'windows-terminal') return 'Windows Terminal';
  if (source === 'wsl') return 'WSL';
  if (source === 'default') return 'Default';
  return 'Detected';
}

export function TerminalSettings({
  settings,
  onUpdate,
  disabled = false,
}: TerminalSettingsProps): JSX.Element {
  const { defaultLabel, examples } = getTerminalExamples();
  const [profiles, setProfiles] = useState<DetectedTerminalProfile[]>([]);
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const selectedProfileId = useMemo(() => {
    if (settings.defaultShellCommand == null) {
      return SYSTEM_DEFAULT_ID;
    }

    return (
      profiles.find((profile) => profile.commandLine === settings.defaultShellCommand)?.id ?? ''
    );
  }, [profiles, settings.defaultShellCommand]);

  useEffect(() => {
    if (!isDesktopRuntimeAvailable()) {
      setProfiles([]);
      setProfileError(null);
      return;
    }

    setIsLoadingProfiles(true);
    setProfileError(null);

    invoke<DetectedTerminalProfile[]>('list_terminal_profiles')
      .then((detectedProfiles) => {
        setProfiles(detectedProfiles);
      })
      .catch((error) => {
        setProfileError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setIsLoadingProfiles(false);
      });
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <label
          htmlFor="terminalProfile"
          className="mb-2 block text-sm font-medium text-editor-text"
        >
          Detected Terminal Profiles
        </label>
        <select
          id="terminalProfile"
          value={selectedProfileId}
          disabled={disabled || isLoadingProfiles}
          onChange={(event) => {
            const value = event.target.value;
            if (value === SYSTEM_DEFAULT_ID) {
              onUpdate({ defaultShellCommand: null });
              return;
            }

            const selectedProfile = profiles.find((profile) => profile.id === value);
            if (selectedProfile) {
              onUpdate({ defaultShellCommand: selectedProfile.commandLine });
            }
          }}
          className="w-full rounded-lg border border-editor-border bg-editor-bg px-3 py-2 text-editor-text focus:outline-none focus:ring-2 focus:ring-primary-500/50 disabled:opacity-50"
        >
          <option value={SYSTEM_DEFAULT_ID}>System default ({defaultLabel})</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.label} · {profileSourceLabel(profile.source)}
            </option>
          ))}
          {settings.defaultShellCommand && selectedProfileId === '' && !isLoadingProfiles && (
            <option value="">Unavailable saved profile</option>
          )}
        </select>
        <p className="mt-2 text-xs text-editor-text-muted">
          {isLoadingProfiles
            ? 'Scanning installed terminal profiles...'
            : 'Pick a detected profile. Custom command lines are not launched from settings.'}
        </p>
        {profileError && <p className="mt-2 text-xs text-rose-400">{profileError}</p>}
      </div>

      <div>
        <label
          htmlFor="defaultShellCommand"
          className="mb-2 block text-sm font-medium text-editor-text"
        >
          Saved Terminal Command Line
        </label>
        <input
          id="defaultShellCommand"
          type="text"
          value={settings.defaultShellCommand ?? ''}
          readOnly
          disabled={disabled}
          placeholder={`Leave blank to use ${defaultLabel}`}
          className="w-full rounded-lg border border-editor-border bg-editor-bg px-3 py-2 text-editor-text opacity-80 focus:outline-none focus:ring-2 focus:ring-primary-500/50 disabled:opacity-50"
        />
        <p className="mt-2 text-xs text-editor-text-muted">
          The backend resolves this value against detected profiles before launch. {examples}
        </p>
      </div>

      <div className="rounded-xl border border-editor-border bg-editor-bg px-4 py-3">
        <h3 className="text-sm font-medium text-editor-text">Integrated Terminal Behavior</h3>
        <p className="mt-2 text-xs leading-5 text-editor-text-muted">
          The terminal opens in the active project folder, appears in the bottom panel, and closing
          the panel ends every open terminal pane immediately. Use <code>Ctrl+`</code> to toggle the
          entire terminal area.
        </p>
      </div>
    </div>
  );
}
