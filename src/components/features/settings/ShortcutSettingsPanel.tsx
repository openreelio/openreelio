/**
 * ShortcutSettingsPanel Component
 *
 * A comprehensive keyboard shortcuts customization panel for the settings dialog.
 * Provides full control over keyboard shortcuts including rebinding, presets,
 * conflict detection, and import/export functionality.
 *
 * Features:
 * - Display all shortcuts grouped by category
 * - Click-to-record shortcut rebinding
 * - Real-time conflict detection with warnings
 * - Preset selector (Default, Premiere Pro, DaVinci)
 * - Reset to defaults functionality
 * - Import/Export shortcuts as JSON
 *
 * @module components/features/settings/ShortcutSettingsPanel
 */

import { memo, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  Search,
  RotateCcw,
  AlertTriangle,
  Download,
  Upload,
  ChevronDown,
  Check,
  X,
  Keyboard,
} from 'lucide-react';
import {
  useShortcutStore,
  formatShortcut,
  SHORTCUT_PRESETS,
  type ShortcutBinding,
  type ShortcutConflict,
} from '@/stores/shortcutStore';
import type { ShortcutCategory, ModifierKey } from '@/constants/editing';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

// =============================================================================
// Types
// =============================================================================

/**
 * Props for the ShortcutSettingsPanel component
 */
export interface ShortcutSettingsPanelProps {
  /** Additional CSS classes */
  className?: string;
}

/**
 * Props for individual shortcut row
 */
interface ShortcutRowProps {
  /** The shortcut binding to display */
  binding: ShortcutBinding;
  /** Whether this row is currently being edited */
  isEditing: boolean;
  /** Callback when edit mode is started */
  onStartEdit: () => void;
  /** Callback when edit is cancelled */
  onCancelEdit: () => void;
  /** Callback when a new shortcut is captured */
  onShortcutCaptured: (key: string, modifiers: ModifierKey[]) => void;
  /** Callback to reset this binding to default */
  onReset: () => void;
  /** Current conflict information, if any */
  conflict: ShortcutConflict | null;
}

/**
 * Props for the preset selector dropdown
 */
interface PresetSelectorProps {
  /** Currently active preset ID */
  activePreset: string | null;
  /** Callback when a preset is selected */
  onSelectPreset: (presetId: string) => void;
  /** Whether the selector is disabled */
  disabled?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** Category display names and order */
const CATEGORY_CONFIG: Record<ShortcutCategory, { label: string; order: number }> = {
  playback: { label: 'Playback', order: 1 },
  navigation: { label: 'Navigation', order: 2 },
  tools: { label: 'Tools', order: 3 },
  editing: { label: 'Editing', order: 4 },
  selection: { label: 'Selection', order: 5 },
  view: { label: 'View', order: 6 },
  file: { label: 'File', order: 7 },
};

/** All categories in display order */
const CATEGORY_ORDER: ShortcutCategory[] = [
  'playback',
  'navigation',
  'tools',
  'editing',
  'selection',
  'view',
  'file',
];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Convert a keyboard event to key code and modifiers
 *
 * @param event - The keyboard event
 * @returns Object containing key and modifiers, or null if only modifiers pressed
 */
function keyEventToBinding(event: KeyboardEvent): { key: string; modifiers: ModifierKey[] } | null {
  // Ignore modifier-only key presses
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
    return null;
  }

  const modifiers: ModifierKey[] = [];
  if (event.ctrlKey) modifiers.push('ctrl');
  if (event.shiftKey) modifiers.push('shift');
  if (event.altKey) modifiers.push('alt');
  if (event.metaKey) modifiers.push('meta');

  return {
    key: event.code,
    modifiers,
  };
}

// =============================================================================
// PresetSelector Component
// =============================================================================

/**
 * Dropdown selector for shortcut presets
 */
const PresetSelector = memo(function PresetSelector({
  activePreset,
  onSelectPreset,
  disabled = false,
}: PresetSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const activePresetData = SHORTCUT_PRESETS.find(p => p.id === activePreset);
  const displayName = activePresetData?.name ?? 'Custom';

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className={`
          flex items-center gap-2 px-3 py-2 text-sm rounded-lg border transition-colors
          ${isOpen
            ? 'border-primary-500 bg-primary-500/10'
            : 'border-editor-border bg-editor-bg hover:border-editor-text-muted'
          }
          disabled:opacity-50 disabled:cursor-not-allowed
        `}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <Keyboard className="w-4 h-4 text-editor-text-muted" />
        <span className="text-editor-text">{displayName}</span>
        <ChevronDown className={`w-4 h-4 text-editor-text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div
          className="absolute top-full left-0 mt-1 w-64 bg-editor-panel border border-editor-border rounded-lg shadow-xl z-50 py-1"
          role="listbox"
        >
          {SHORTCUT_PRESETS.map(preset => (
            <button
              key={preset.id}
              type="button"
              onClick={() => {
                onSelectPreset(preset.id);
                setIsOpen(false);
              }}
              className={`
                w-full flex items-center gap-3 px-3 py-2 text-left transition-colors
                ${activePreset === preset.id
                  ? 'bg-primary-500/10 text-primary-400'
                  : 'text-editor-text hover:bg-editor-bg'
                }
              `}
              role="option"
              aria-selected={activePreset === preset.id}
            >
              <div className="w-4 h-4 flex items-center justify-center">
                {activePreset === preset.id && <Check className="w-4 h-4" />}
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium">{preset.name}</div>
                <div className="text-xs text-editor-text-muted">{preset.description}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

// =============================================================================
// ShortcutRow Component
// =============================================================================

/**
 * Individual row for a single shortcut binding
 */
const ShortcutRow = memo(function ShortcutRow({
  binding,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onShortcutCaptured,
  onReset,
  conflict,
}: ShortcutRowProps) {
  const inputRef = useRef<HTMLDivElement>(null);

  // Handle key capture when editing
  useEffect(() => {
    if (!isEditing) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Escape cancels editing
      if (e.key === 'Escape') {
        onCancelEdit();
        return;
      }

      const result = keyEventToBinding(e);
      if (result) {
        onShortcutCaptured(result.key, result.modifiers);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isEditing, onCancelEdit, onShortcutCaptured]);

  // Focus when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  return (
    <div
      className={`
        flex items-center justify-between px-3 py-2.5 rounded-lg transition-colors
        ${binding.customized ? 'bg-primary-500/5' : ''}
        ${!binding.enabled ? 'opacity-50' : ''}
        hover:bg-editor-bg
      `}
      data-testid={`shortcut-row-${binding.id}`}
    >
      {/* Action Label and Description */}
      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-editor-text truncate">{binding.label}</span>
          {binding.customized && (
            <span className="text-xs text-primary-400 bg-primary-500/10 px-1.5 py-0.5 rounded">
              Modified
            </span>
          )}
        </div>
        <span className="text-xs text-editor-text-muted truncate">{binding.description}</span>
      </div>

      {/* Conflict Warning */}
      {conflict && (
        <div className="flex items-center gap-1 text-yellow-500 mr-3" title={`Conflicts with: ${conflict.existingBinding.label}`}>
          <AlertTriangle className="w-4 h-4" />
          <span className="text-xs max-w-[120px] truncate">
            Conflicts with {conflict.existingBinding.label}
          </span>
        </div>
      )}

      {/* Shortcut Display / Editor */}
      <div className="flex items-center gap-2">
        {isEditing ? (
          <div className="flex items-center gap-2">
            <div
              ref={inputRef}
              tabIndex={0}
              className="px-4 py-1.5 text-sm bg-primary-500/20 border border-primary-500 rounded-lg text-primary-400 animate-pulse min-w-[120px] text-center"
              role="textbox"
              aria-label="Press a key combination"
            >
              Press a key...
            </div>
            <button
              type="button"
              onClick={onCancelEdit}
              className="p-1.5 rounded hover:bg-editor-bg text-editor-text-muted hover:text-editor-text"
              aria-label="Cancel editing"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onStartEdit}
            disabled={!binding.enabled}
            className={`
              px-4 py-1.5 text-sm rounded-lg border transition-colors min-w-[100px]
              ${binding.customized
                ? 'bg-primary-500/10 border-primary-500/30 text-primary-400'
                : 'bg-editor-bg border-editor-border text-editor-text hover:border-primary-500/50'
              }
              disabled:opacity-50 disabled:cursor-not-allowed
            `}
            aria-label={`Edit shortcut for ${binding.label}`}
          >
            {formatShortcut(binding)}
          </button>
        )}

        {/* Reset Button */}
        {binding.customized && !isEditing && (
          <button
            type="button"
            onClick={onReset}
            className="p-1.5 rounded hover:bg-editor-bg text-editor-text-muted hover:text-editor-text"
            aria-label={`Reset ${binding.label} to default`}
            title="Reset to default"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        )}

        {/* Enable/Disable Toggle */}
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={binding.enabled}
            onChange={() => {
              // This will be handled by the parent via store
            }}
            className="sr-only"
            aria-label={`${binding.enabled ? 'Disable' : 'Enable'} ${binding.label}`}
          />
        </label>
      </div>
    </div>
  );
});

// =============================================================================
// ShortcutSettingsPanel Component
// =============================================================================

/**
 * Main panel for keyboard shortcuts customization
 *
 * Provides a comprehensive interface for viewing, searching, editing,
 * and managing keyboard shortcuts. Supports preset profiles, conflict
 * detection, and import/export functionality.
 *
 * @example
 * ```tsx
 * <ShortcutSettingsPanel className="p-4" />
 * ```
 */
export const ShortcutSettingsPanel = memo(function ShortcutSettingsPanel({
  className = '',
}: ShortcutSettingsPanelProps) {
  // Store hooks
  const activePreset = useShortcutStore(state => state.activePreset);
  const updateBinding = useShortcutStore(state => state.updateBinding);
  const resetBinding = useShortcutStore(state => state.resetBinding);
  const resetAllBindings = useShortcutStore(state => state.resetAllBindings);
  const applyPreset = useShortcutStore(state => state.applyPreset);
  const checkConflict = useShortcutStore(state => state.checkConflict);
  const exportBindings = useShortcutStore(state => state.exportBindings);
  const importBindings = useShortcutStore(state => state.importBindings);
  const getBindingsByCategory = useShortcutStore(state => state.getBindingsByCategory);

  // Local state
  const [searchQuery, setSearchQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingConflict, setPendingConflict] = useState<ShortcutConflict | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Clear messages after timeout
  useEffect(() => {
    if (successMessage) {
      const timer = setTimeout(() => setSuccessMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [successMessage]);

  useEffect(() => {
    if (importError) {
      const timer = setTimeout(() => setImportError(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [importError]);

  // Group bindings by category
  const groupedBindings = useMemo(() => {
    const groups: Record<ShortcutCategory, ShortcutBinding[]> = {
      playback: [],
      navigation: [],
      tools: [],
      editing: [],
      selection: [],
      view: [],
      file: [],
    };

    for (const category of CATEGORY_ORDER) {
      groups[category] = getBindingsByCategory(category);
    }

    return groups;
  }, [getBindingsByCategory]);

  // Filter bindings by search query
  const filteredGroups = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return groupedBindings;

    const filtered: Record<ShortcutCategory, ShortcutBinding[]> = {
      playback: [],
      navigation: [],
      tools: [],
      editing: [],
      selection: [],
      view: [],
      file: [],
    };

    for (const category of CATEGORY_ORDER) {
      filtered[category] = groupedBindings[category].filter(binding =>
        binding.label.toLowerCase().includes(query) ||
        binding.description.toLowerCase().includes(query) ||
        binding.action.toLowerCase().includes(query) ||
        formatShortcut(binding).toLowerCase().includes(query)
      );
    }

    return filtered;
  }, [searchQuery, groupedBindings]);

  // Check if any results exist
  const hasResults = useMemo(() => {
    return CATEGORY_ORDER.some(category => filteredGroups[category].length > 0);
  }, [filteredGroups]);

  // Handlers
  const handleStartEdit = useCallback((id: string) => {
    setEditingId(id);
    setPendingConflict(null);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setPendingConflict(null);
  }, []);

  const handleShortcutCaptured = useCallback((id: string, key: string, modifiers: ModifierKey[]) => {
    // Check for conflicts
    const conflict = checkConflict(id, key, modifiers);

    if (conflict) {
      // Show conflict warning but still allow the change
      setPendingConflict(conflict);
      // Apply the binding anyway (it will override)
      updateBinding(id, { key, modifiers });
      // Clear editing state after a delay to show conflict
      setTimeout(() => {
        setEditingId(null);
        setPendingConflict(null);
      }, 1500);
    } else {
      // No conflict, apply immediately
      updateBinding(id, { key, modifiers });
      setEditingId(null);
      setPendingConflict(null);
    }
  }, [checkConflict, updateBinding]);

  const handleResetBinding = useCallback((id: string) => {
    resetBinding(id);
  }, [resetBinding]);

  const handleResetAll = useCallback(() => {
    resetAllBindings();
    setShowResetConfirm(false);
    setSuccessMessage('All shortcuts reset to defaults');
  }, [resetAllBindings]);

  const handlePresetSelect = useCallback((presetId: string) => {
    applyPreset(presetId);
    setSuccessMessage(`Applied "${SHORTCUT_PRESETS.find(p => p.id === presetId)?.name}" preset`);
  }, [applyPreset]);

  const handleExport = useCallback(() => {
    try {
      const json = exportBindings();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'openreelio-shortcuts.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setSuccessMessage('Shortcuts exported successfully');
    } catch {
      setImportError('Failed to export shortcuts');
    }
  }, [exportBindings]);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const success = importBindings(content);
        if (success) {
          setSuccessMessage('Shortcuts imported successfully');
          setImportError(null);
        } else {
          setImportError('Invalid shortcuts file format');
        }
      } catch {
        setImportError('Failed to read shortcuts file');
      }
    };
    reader.onerror = () => {
      setImportError('Failed to read file');
    };
    reader.readAsText(file);

    // Reset input so same file can be selected again
    event.target.value = '';
  }, [importBindings]);

  return (
    <div className={`flex flex-col gap-4 ${className}`} data-testid="shortcut-settings-panel">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h3 className="text-lg font-semibold text-editor-text">Keyboard Shortcuts</h3>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Preset Selector */}
          <PresetSelector
            activePreset={activePreset}
            onSelectPreset={handlePresetSelect}
          />

          {/* Import/Export */}
          <button
            type="button"
            onClick={handleExport}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-editor-border bg-editor-bg hover:border-editor-text-muted text-editor-text-muted hover:text-editor-text transition-colors"
            title="Export shortcuts"
          >
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">Export</span>
          </button>

          <button
            type="button"
            onClick={handleImportClick}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-editor-border bg-editor-bg hover:border-editor-text-muted text-editor-text-muted hover:text-editor-text transition-colors"
            title="Import shortcuts"
          >
            <Upload className="w-4 h-4" />
            <span className="hidden sm:inline">Import</span>
          </button>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImportFile}
            className="hidden"
            aria-label="Import shortcuts file"
          />

          {/* Reset All */}
          <button
            type="button"
            onClick={() => setShowResetConfirm(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-editor-border bg-editor-bg hover:border-red-500/50 text-editor-text-muted hover:text-red-400 transition-colors"
            title="Reset all shortcuts to defaults"
          >
            <RotateCcw className="w-4 h-4" />
            <span className="hidden sm:inline">Reset All</span>
          </button>
        </div>
      </div>

      {/* Messages */}
      {successMessage && (
        <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-sm flex items-center justify-between">
          <span>{successMessage}</span>
          <button
            type="button"
            onClick={() => setSuccessMessage(null)}
            className="p-1 hover:bg-green-500/20 rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {importError && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center justify-between">
          <span>{importError}</span>
          <button
            type="button"
            onClick={() => setImportError(null)}
            className="p-1 hover:bg-red-500/20 rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-editor-text-muted" />
        <input
          type="text"
          placeholder="Search shortcuts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-9 pr-4 py-2.5 text-sm bg-editor-bg border border-editor-border rounded-lg text-editor-text placeholder-editor-text-muted focus:outline-none focus:border-primary-500 transition-colors"
          aria-label="Search shortcuts"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 hover:bg-editor-sidebar rounded"
            aria-label="Clear search"
          >
            <X className="w-4 h-4 text-editor-text-muted" />
          </button>
        )}
      </div>

      {/* Instructions */}
      <p className="text-xs text-editor-text-muted">
        Click on any shortcut to customize it. Press Escape to cancel editing.
      </p>

      {/* Shortcuts List */}
      <div className="flex flex-col gap-6 max-h-[60vh] overflow-y-auto pr-1">
        {CATEGORY_ORDER.map(category => {
          const categoryBindings = filteredGroups[category];
          if (categoryBindings.length === 0) return null;

          return (
            <div key={category} className="flex flex-col gap-2">
              <h4 className="text-sm font-medium text-editor-text-muted px-1 sticky top-0 bg-editor-panel py-1">
                {CATEGORY_CONFIG[category].label}
                <span className="ml-2 text-xs text-editor-text-muted/50">
                  ({categoryBindings.length})
                </span>
              </h4>
              <div className="flex flex-col gap-1">
                {categoryBindings.map(binding => (
                  <ShortcutRow
                    key={binding.id}
                    binding={binding}
                    isEditing={editingId === binding.id}
                    onStartEdit={() => handleStartEdit(binding.id)}
                    onCancelEdit={handleCancelEdit}
                    onShortcutCaptured={(key, modifiers) =>
                      handleShortcutCaptured(binding.id, key, modifiers)
                    }
                    onReset={() => handleResetBinding(binding.id)}
                    conflict={editingId === binding.id ? pendingConflict : null}
                  />
                ))}
              </div>
            </div>
          );
        })}

        {/* Empty State */}
        {!hasResults && searchQuery && (
          <div className="flex flex-col items-center justify-center py-12 text-editor-text-muted">
            <Search className="w-12 h-12 mb-4 opacity-30" />
            <p className="text-sm">No shortcuts found for "{searchQuery}"</p>
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="mt-2 text-sm text-primary-400 hover:underline"
            >
              Clear search
            </button>
          </div>
        )}
      </div>

      {/* Reset Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showResetConfirm}
        title="Reset All Shortcuts"
        message="Are you sure you want to reset all keyboard shortcuts to their default values? This action cannot be undone."
        confirmLabel="Reset All"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleResetAll}
        onCancel={() => setShowResetConfirm(false)}
      />
    </div>
  );
});

export default ShortcutSettingsPanel;
