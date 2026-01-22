/**
 * AppearanceSettings Component
 *
 * Appearance settings including theme, accent color, and UI scale.
 */

import { Sun, Moon, Monitor } from 'lucide-react';
import type { AppearanceSettings as AppearanceSettingsType } from '@/stores/settingsStore';

interface AppearanceSettingsProps {
  settings: AppearanceSettingsType;
  onUpdate: (values: Partial<AppearanceSettingsType>) => void;
  disabled?: boolean;
}

const ACCENT_COLORS = [
  { id: '#3b82f6', name: 'Blue' },
  { id: '#8b5cf6', name: 'Purple' },
  { id: '#ec4899', name: 'Pink' },
  { id: '#f97316', name: 'Orange' },
  { id: '#22c55e', name: 'Green' },
  { id: '#14b8a6', name: 'Teal' },
];

export function AppearanceSettings({
  settings,
  onUpdate,
  disabled = false,
}: AppearanceSettingsProps) {
  return (
    <div className="space-y-6">
      {/* Theme */}
      <div>
        <label className="block text-sm font-medium text-editor-text mb-3">
          Theme
        </label>
        <div className="flex gap-3">
          <ThemeOption
            icon={<Sun className="w-5 h-5" />}
            label="Light"
            isSelected={settings.theme === 'light'}
            onSelect={() => onUpdate({ theme: 'light' })}
            disabled={disabled}
          />
          <ThemeOption
            icon={<Moon className="w-5 h-5" />}
            label="Dark"
            isSelected={settings.theme === 'dark'}
            onSelect={() => onUpdate({ theme: 'dark' })}
            disabled={disabled}
          />
          <ThemeOption
            icon={<Monitor className="w-5 h-5" />}
            label="System"
            isSelected={settings.theme === 'system'}
            onSelect={() => onUpdate({ theme: 'system' })}
            disabled={disabled}
          />
        </div>
        <p className="mt-2 text-xs text-editor-text-muted">
          Note: Only dark theme is currently implemented
        </p>
      </div>

      {/* Accent Color */}
      <div>
        <label className="block text-sm font-medium text-editor-text mb-3">
          Accent Color
        </label>
        <div className="flex gap-3 flex-wrap">
          {ACCENT_COLORS.map((color) => (
            <button
              key={color.id}
              type="button"
              onClick={() => onUpdate({ accentColor: color.id })}
              disabled={disabled}
              title={color.name}
              className={`
                w-8 h-8 rounded-full border-2 transition-all
                ${settings.accentColor === color.id
                  ? 'border-white scale-110'
                  : 'border-transparent hover:scale-105'
                }
                disabled:opacity-50 disabled:cursor-not-allowed
              `}
              style={{ backgroundColor: color.id }}
            />
          ))}
        </div>
      </div>

      {/* UI Scale */}
      <div>
        <label
          htmlFor="uiScale"
          className="block text-sm font-medium text-editor-text mb-2"
        >
          UI Scale: {Math.round(settings.uiScale * 100)}%
        </label>
        <input
          id="uiScale"
          type="range"
          min="0.8"
          max="1.5"
          step="0.1"
          value={settings.uiScale}
          onChange={(e) => onUpdate({ uiScale: Number(e.target.value) })}
          disabled={disabled}
          className="w-full h-2 bg-editor-bg rounded-lg appearance-none cursor-pointer accent-primary-500 disabled:opacity-50"
        />
        <div className="flex justify-between text-xs text-editor-text-muted mt-1">
          <span>80%</span>
          <span>100%</span>
          <span>150%</span>
        </div>
        <p className="mt-2 text-xs text-editor-text-muted">
          Note: UI scale is not yet implemented
        </p>
      </div>

      {/* Additional Options */}
      <div className="space-y-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.showStatusBar}
            onChange={(e) => onUpdate({ showStatusBar: e.target.checked })}
            disabled={disabled}
            className="w-4 h-4 rounded border-editor-border bg-editor-bg text-primary-500 focus:ring-primary-500/50 focus:ring-offset-0"
          />
          <div>
            <span className="text-sm text-editor-text">Show status bar</span>
            <p className="text-xs text-editor-text-muted">
              Display status information at the bottom of the window
            </p>
          </div>
        </label>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.compactMode}
            onChange={(e) => onUpdate({ compactMode: e.target.checked })}
            disabled={disabled}
            className="w-4 h-4 rounded border-editor-border bg-editor-bg text-primary-500 focus:ring-primary-500/50 focus:ring-offset-0"
          />
          <div>
            <span className="text-sm text-editor-text">Compact mode</span>
            <p className="text-xs text-editor-text-muted">
              Reduce padding and spacing for more screen real estate
            </p>
          </div>
        </label>
      </div>
    </div>
  );
}

interface ThemeOptionProps {
  icon: React.ReactNode;
  label: string;
  isSelected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}

function ThemeOption({ icon, label, isSelected, onSelect, disabled }: ThemeOptionProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`
        flex-1 flex flex-col items-center gap-2 p-4 rounded-lg border transition-all
        ${isSelected
          ? 'border-primary-500 bg-primary-500/10'
          : 'border-editor-border hover:border-editor-text-muted'
        }
        disabled:opacity-50 disabled:cursor-not-allowed
      `}
    >
      <div className={isSelected ? 'text-primary-400' : 'text-editor-text-muted'}>
        {icon}
      </div>
      <span className={`text-sm ${isSelected ? 'text-primary-400' : 'text-editor-text'}`}>
        {label}
      </span>
    </button>
  );
}
