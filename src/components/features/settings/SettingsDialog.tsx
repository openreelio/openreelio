/**
 * SettingsDialog Component
 *
 * Modal dialog for application settings with tabbed navigation.
 */

import { useEffect, useRef, useCallback } from 'react';
import { X, Settings2, Palette, Keyboard, RotateCcw, Bot } from 'lucide-react';
import { useSettings } from '@/hooks/useSettings';
import { useUIStore } from '@/stores';
import { GeneralSettings } from './sections/GeneralSettings';
import { AppearanceSettings } from './sections/AppearanceSettings';
import { ShortcutsSettings } from './sections/ShortcutsSettings';
import { AISettingsSection } from './sections/AISettingsSection';

// =============================================================================
// Types
// =============================================================================

export interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabId = 'general' | 'appearance' | 'shortcuts' | 'ai';

interface Tab {
  id: TabId;
  label: string;
  icon: React.ReactNode;
}

// =============================================================================
// Constants
// =============================================================================

const TABS: Tab[] = [
  { id: 'general', label: 'General', icon: <Settings2 className="w-4 h-4" /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette className="w-4 h-4" /> },
  { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard className="w-4 h-4" /> },
  { id: 'ai', label: 'AI', icon: <Bot className="w-4 h-4" /> },
];

// =============================================================================
// Component
// =============================================================================

export function SettingsDialog({ isOpen, onClose }: SettingsDialogProps) {
  const activeTab = useUIStore((state) => state.settingsActiveTab);
  const setActiveTab = useUIStore((state) => state.setSettingsTab);
  const dialogRef = useRef<HTMLDivElement>(null);

  const {
    general,
    appearance,
    ai,
    updateGeneral,
    updateAppearance,
    updateAI,
    resetSettings,
    isSaving,
    error,
    clearError,
  } = useSettings();

  // Focus trap and keyboard handling
  useEffect(() => {
    if (isOpen) {
      dialogRef.current?.focus();
    }
  }, [isOpen]);

  // Clear error when dialog opens (tab is already set by openSettings)
  useEffect(() => {
    if (isOpen) {
      clearError();
    }
  }, [isOpen, clearError]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    },
    [onClose]
  );

  const handleReset = useCallback(async () => {
    if (window.confirm('Are you sure you want to reset all settings to defaults?')) {
      await resetSettings();
    }
  }, [resetSettings]);

  const handleGeneralUpdate = useCallback(
    (values: Parameters<typeof updateGeneral>[0]) => {
      void updateGeneral(values);
    },
    [updateGeneral]
  );

  const handleAppearanceUpdate = useCallback(
    (values: Parameters<typeof updateAppearance>[0]) => {
      void updateAppearance(values);
    },
    [updateAppearance]
  );

  const handleAIUpdate = useCallback(
    (values: Parameters<typeof updateAI>[0]) => {
      void updateAI(values);
    },
    [updateAI]
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
        aria-labelledby="settings-title"
        aria-modal="true"
        tabIndex={-1}
        className="bg-editor-panel border border-editor-border rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-editor-border shrink-0">
          <h2 id="settings-title" className="text-lg font-semibold text-editor-text">
            Settings
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-editor-bg transition-colors text-editor-text-muted hover:text-editor-text"
            aria-label="Close settings"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* Tab Navigation */}
          <nav className="w-44 border-r border-editor-border p-2 shrink-0">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`
                  w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors
                  ${activeTab === tab.id
                    ? 'bg-primary-500/10 text-primary-400'
                    : 'text-editor-text-muted hover:bg-editor-bg hover:text-editor-text'
                  }
                `}
              >
                {tab.icon}
                <span className="text-sm">{tab.label}</span>
              </button>
            ))}
          </nav>

          {/* Tab Content */}
          <div className="flex-1 p-6 overflow-y-auto">
            {/* Error Display */}
            {error && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            {/* Saving Indicator */}
            {isSaving && (
              <div className="mb-4 p-3 bg-primary-500/10 border border-primary-500/20 rounded-lg">
                <p className="text-sm text-primary-400">Saving settings...</p>
              </div>
            )}

            {activeTab === 'general' && (
              <GeneralSettings
                settings={general}
                onUpdate={handleGeneralUpdate}
                disabled={isSaving}
              />
            )}

            {activeTab === 'appearance' && (
              <AppearanceSettings
                settings={appearance}
                onUpdate={handleAppearanceUpdate}
                disabled={isSaving}
              />
            )}

            {activeTab === 'shortcuts' && <ShortcutsSettings />}

            {activeTab === 'ai' && (
              <AISettingsSection
                settings={ai}
                onUpdate={handleAIUpdate}
                disabled={isSaving}
              />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center px-6 py-4 border-t border-editor-border bg-editor-sidebar/50 rounded-b-xl shrink-0">
          <button
            type="button"
            onClick={() => void handleReset()}
            disabled={isSaving}
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-editor-text-muted hover:text-editor-text transition-colors disabled:opacity-50"
          >
            <RotateCcw className="w-4 h-4" />
            Reset to Defaults
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

export default SettingsDialog;
