/**
 * WorkspacePresetSelector
 *
 * Dropdown menu for selecting built-in or custom workspace presets,
 * saving the current layout as a preset, and managing custom presets.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { LayoutGrid, Check, Plus, Trash2 } from 'lucide-react';
import { HeaderPopoverAction } from './HeaderPopoverAction';
import {
  useWorkspaceLayoutStore,
  WORKSPACE_PRESETS,
  selectActivePresetId,
  selectCustomPresets,
} from '@/stores/workspaceLayoutStore';
import type { WorkspacePreset } from '@/stores/workspaceLayoutStore';

/** Preset list item with active indicator and optional delete */
function PresetItem({
  preset,
  isActive,
  onSelect,
  onDelete,
}: {
  preset: WorkspacePreset;
  isActive: boolean;
  onSelect: () => void;
  onDelete?: () => void;
}): React.JSX.Element {
  return (
    <div
      className={`group flex items-center gap-1 rounded ${
        isActive
          ? 'bg-primary-600/20 text-primary-400'
          : 'text-editor-text hover:bg-editor-bg'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-sm"
        title={preset.description}
      >
        <span className="w-4 shrink-0">
          {isActive && <Check className="h-3.5 w-3.5" />}
        </span>
        <span className="flex-1 truncate">{preset.name}</span>
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="mr-1 shrink-0 rounded p-0.5 text-editor-text-muted opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
          aria-label={`Delete ${preset.name}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export function WorkspacePresetSelector(): React.JSX.Element {
  const activePresetId = useWorkspaceLayoutStore(selectActivePresetId);
  const customPresets = useWorkspaceLayoutStore(selectCustomPresets);
  const applyPreset = useWorkspaceLayoutStore((s) => s.applyPreset);
  const saveCustomPreset = useWorkspaceLayoutStore((s) => s.saveCustomPreset);
  const deleteCustomPreset = useWorkspaceLayoutStore((s) => s.deleteCustomPreset);

  const [isSaving, setIsSaving] = useState(false);
  const [saveName, setSaveName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isSaving && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isSaving]);

  const handleSave = useCallback(() => {
    const trimmed = saveName.trim();
    if (!trimmed) return;
    saveCustomPreset(trimmed);
    setSaveName('');
    setIsSaving(false);
  }, [saveName, saveCustomPreset]);

  const handleSaveKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSave();
      } else if (e.key === 'Escape') {
        setIsSaving(false);
        setSaveName('');
      }
    },
    [handleSave],
  );

  return (
    <HeaderPopoverAction
      label="Workspace"
      icon={<LayoutGrid className="h-4 w-4" />}
      panelClassName="w-[220px] p-1"
    >
      <div className="flex flex-col gap-0.5">
        {/* Built-in presets */}
        <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-editor-text-muted">
          Presets
        </div>
        {WORKSPACE_PRESETS.map((preset) => (
          <PresetItem
            key={preset.id}
            preset={preset}
            isActive={activePresetId === preset.id}
            onSelect={() => applyPreset(preset.id)}
          />
        ))}

        {/* Custom presets section */}
        {customPresets.length > 0 && (
          <>
            <div className="mx-2 my-1 h-px bg-editor-border" />
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-editor-text-muted">
              Custom
            </div>
            {customPresets.map((preset) => (
              <PresetItem
                key={preset.id}
                preset={preset}
                isActive={activePresetId === preset.id}
                onSelect={() => applyPreset(preset.id)}
                onDelete={() => deleteCustomPreset(preset.id)}
              />
            ))}
          </>
        )}

        {/* Divider + Save action */}
        <div className="mx-2 my-1 h-px bg-editor-border" />

        {isSaving ? (
          <div className="flex items-center gap-1 px-2 py-1">
            <input
              ref={inputRef}
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={handleSaveKeyDown}
              onBlur={() => {
                if (!saveName.trim()) {
                  setIsSaving(false);
                }
              }}
              placeholder="Preset name..."
              className="flex-1 rounded border border-editor-border bg-editor-bg px-2 py-1 text-sm text-editor-text placeholder:text-editor-text-muted focus:border-primary-500 focus:outline-none"
              maxLength={50}
            />
            <button
              type="button"
              onClick={handleSave}
              disabled={!saveName.trim()}
              className="rounded bg-primary-600 px-2 py-1 text-xs text-white hover:bg-primary-500 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setIsSaving(true)}
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm text-editor-text hover:bg-editor-bg"
          >
            <Plus className="h-3.5 w-3.5 text-editor-text-muted" />
            Save Current Layout
          </button>
        )}
      </div>
    </HeaderPopoverAction>
  );
}
