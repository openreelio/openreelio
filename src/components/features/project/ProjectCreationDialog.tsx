/**
 * ProjectCreationDialog Component
 *
 * Modal dialog for creating a new project with name, location, and format settings.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, X, Film, Monitor, Smartphone } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

/** Format preset option */
export interface FormatPreset {
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  fps: number;
  icon: 'monitor' | 'smartphone' | 'film';
}

/** Project creation data */
export interface ProjectCreateData {
  name: string;
  path: string;
  format: string;
}

/** Dialog props */
export interface ProjectCreationDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback when dialog is cancelled */
  onCancel: () => void;
  /** Callback when project is created */
  onCreate: (data: ProjectCreateData) => void;
  /** Default location path */
  defaultLocation?: string;
  /** Whether creation is in progress */
  isCreating?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const FORMAT_PRESETS: FormatPreset[] = [
  {
    id: 'youtube-1080p',
    name: 'YouTube 1080p',
    description: '1920x1080, 30fps',
    width: 1920,
    height: 1080,
    fps: 30,
    icon: 'monitor',
  },
  {
    id: 'youtube-4k',
    name: 'YouTube 4K',
    description: '3840x2160, 30fps',
    width: 3840,
    height: 2160,
    fps: 30,
    icon: 'monitor',
  },
  {
    id: 'shorts-vertical',
    name: 'Shorts/Reels',
    description: '1080x1920, 30fps',
    width: 1080,
    height: 1920,
    fps: 30,
    icon: 'smartphone',
  },
  {
    id: 'cinema-24fps',
    name: 'Cinema 24fps',
    description: '1920x1080, 24fps',
    width: 1920,
    height: 1080,
    fps: 24,
    icon: 'film',
  },
];

// =============================================================================
// Helper Components
// =============================================================================

interface FormatOptionProps {
  preset: FormatPreset;
  isSelected: boolean;
  onSelect: () => void;
}

function FormatOption({ preset, isSelected, onSelect }: FormatOptionProps): JSX.Element {
  const Icon = preset.icon === 'monitor' ? Monitor : preset.icon === 'smartphone' ? Smartphone : Film;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`
        flex items-center gap-3 p-3 rounded-lg border transition-colors text-left w-full
        ${isSelected
          ? 'border-primary-500 bg-primary-500/10'
          : 'border-editor-border hover:border-editor-text-muted'
        }
      `}
    >
      <div className={`p-2 rounded ${isSelected ? 'bg-primary-500 text-white' : 'bg-editor-bg text-editor-text-muted'}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div>
        <p className={`font-medium text-sm ${isSelected ? 'text-primary-400' : 'text-editor-text'}`}>
          {preset.name}
        </p>
        <p className="text-xs text-editor-text-muted">{preset.description}</p>
      </div>
    </button>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export function ProjectCreationDialog({
  isOpen,
  onCancel,
  onCreate,
  defaultLocation = '',
  isCreating = false,
}: ProjectCreationDialogProps): JSX.Element | null {
  // State
  const [name, setName] = useState('Untitled Project');
  const [location, setLocation] = useState(defaultLocation);
  const [selectedFormat, setSelectedFormat] = useState(FORMAT_PRESETS[0].id);
  const [nameError, setNameError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  // Refs
  const nameInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus name input when dialog opens
  useEffect(() => {
    if (isOpen && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [isOpen]);

  // Reset form when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setName('Untitled Project');
      setLocation(defaultLocation);
      setSelectedFormat(FORMAT_PRESETS[0].id);
      setNameError(null);
      setTouched(false);
    }
  }, [isOpen, defaultLocation]);

  // Validation
  const validateName = useCallback((value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) {
      return 'Project name is required';
    }
    if (trimmed.length < 2) {
      return 'Project name must be at least 2 characters';
    }
    if (!/^[a-zA-Z0-9\s\-_]+$/.test(trimmed)) {
      return 'Project name can only contain letters, numbers, spaces, hyphens, and underscores';
    }
    return null;
  }, []);

  const isValid = !validateName(name) && location.trim().length > 0;

  // Handlers
  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setName(value);
    if (touched) {
      setNameError(validateName(value));
    }
  }, [touched, validateName]);

  const handleNameBlur = useCallback(() => {
    setTouched(true);
    setNameError(validateName(name));
  }, [name, validateName]);

  const handleBrowse = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Select Project Location',
    });

    if (selected && typeof selected === 'string') {
      setLocation(selected);
    }
  }, []);

  const handleCreate = useCallback(() => {
    if (!isValid) return;

    onCreate({
      name: name.trim(),
      path: location,
      format: selectedFormat,
    });
  }, [isValid, name, location, selectedFormat, onCreate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel();
    } else if (e.key === 'Enter' && isValid && !isCreating) {
      handleCreate();
    }
  }, [onCancel, isValid, isCreating, handleCreate]);

  // Don't render if closed
  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        ref={dialogRef}
        data-testid="project-creation-dialog"
        role="dialog"
        aria-labelledby="dialog-title"
        aria-modal="true"
        className="bg-editor-panel border border-editor-border rounded-xl shadow-2xl w-full max-w-lg mx-4"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-editor-border">
          <h2 id="dialog-title" className="text-lg font-semibold text-editor-text">
            Create New Project
          </h2>
          <button
            onClick={onCancel}
            className="p-1 rounded hover:bg-editor-bg transition-colors text-editor-text-muted hover:text-editor-text"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-5">
          {/* Project Name */}
          <div>
            <label
              htmlFor="project-name"
              className="block text-sm font-medium text-editor-text mb-2"
            >
              Project Name
            </label>
            <input
              ref={nameInputRef}
              id="project-name"
              data-testid="project-name-input"
              type="text"
              value={name}
              onChange={handleNameChange}
              onBlur={handleNameBlur}
              className={`
                w-full px-3 py-2 bg-editor-bg border rounded-lg text-editor-text
                focus:outline-none focus:ring-2 focus:ring-primary-500/50
                ${nameError ? 'border-red-500' : 'border-editor-border'}
              `}
              placeholder="Enter project name"
            />
            {nameError && (
              <p className="mt-1 text-xs text-red-400">{nameError}</p>
            )}
          </div>

          {/* Location */}
          <div data-testid="location-picker">
            <label className="block text-sm font-medium text-editor-text mb-2">
              Location
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={location}
                readOnly
                className="flex-1 px-3 py-2 bg-editor-bg border border-editor-border rounded-lg text-editor-text text-sm truncate"
                placeholder="Select a location"
              />
              <button
                type="button"
                onClick={() => void handleBrowse()}
                className="px-4 py-2 bg-editor-sidebar border border-editor-border rounded-lg text-editor-text hover:bg-editor-bg transition-colors flex items-center gap-2"
              >
                <FolderOpen className="w-4 h-4" />
                Browse
              </button>
            </div>
          </div>

          {/* Format Preset */}
          <div data-testid="format-preset-selector">
            <label className="block text-sm font-medium text-editor-text mb-2">
              Format Preset
            </label>
            <div className="grid grid-cols-2 gap-2">
              {FORMAT_PRESETS.map((preset) => (
                <FormatOption
                  key={preset.id}
                  preset={preset}
                  isSelected={selectedFormat === preset.id}
                  onSelect={() => setSelectedFormat(preset.id)}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-editor-border bg-editor-sidebar/50 rounded-b-xl">
          <button
            data-testid="cancel-button"
            type="button"
            onClick={onCancel}
            disabled={isCreating}
            className="px-4 py-2 text-sm text-editor-text hover:bg-editor-bg rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            data-testid="create-button"
            type="button"
            onClick={handleCreate}
            disabled={!isValid || isCreating}
            className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCreating ? 'Creating...' : 'Create Project'}
          </button>
        </div>
      </div>
    </div>
  );
}
