/**
 * BlendModePicker Component
 *
 * A dropdown selector for video blend modes.
 * Features:
 * - Dropdown with all blend mode options
 * - Optional category grouping
 * - Keyboard navigation
 * - Descriptions for each mode
 *
 * @module components/features/effects/BlendModePicker
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import type { BlendMode } from '@/types';
import {
  ALL_BLEND_MODES,
  getBlendModeLabel,
  getBlendModeDescription,
  getBlendModeCategory,
  BLEND_MODE_CATEGORY_LABELS,
  getUsedCategories,
} from '@/utils/blendModes';

// =============================================================================
// Types
// =============================================================================

export interface BlendModePickerProps {
  /** Current blend mode value */
  value: BlendMode;
  /** Called when a new blend mode is selected */
  onChange: (mode: BlendMode) => void;
  /** Whether the picker is disabled */
  disabled?: boolean;
  /** Show in compact mode (smaller size) */
  compact?: boolean;
  /** Optional label to display above the picker */
  label?: string;
  /** Show descriptions as tooltips */
  showDescriptions?: boolean;
  /** Group options by category */
  grouped?: boolean;
  /** Additional CSS class */
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

export function BlendModePicker({
  value,
  onChange,
  disabled = false,
  compact = false,
  label,
  showDescriptions = false,
  grouped = false,
  className = '',
}: BlendModePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Handle option selection
  const handleSelect = useCallback(
    (mode: BlendMode) => {
      if (mode !== value) {
        onChange(mode);
      }
      setIsOpen(false);
    },
    [value, onChange]
  );

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      } else if (event.key === 'Enter' || event.key === ' ') {
        if (!isOpen) {
          event.preventDefault();
          setIsOpen(true);
        }
      }
    },
    [isOpen]
  );

  // Handle button click
  const handleButtonClick = useCallback(() => {
    if (!disabled) {
      setIsOpen((prev) => !prev);
    }
  }, [disabled]);

  // Render options grouped by category
  const renderGroupedOptions = () => {
    const categories = getUsedCategories();

    return categories.map((category) => {
      const modesInCategory = ALL_BLEND_MODES.filter(
        (mode) => getBlendModeCategory(mode) === category
      );

      if (modesInCategory.length === 0) return null;

      return (
        <div key={category} className="py-1">
          <div className="px-2 py-1 text-xs font-medium text-zinc-500 uppercase tracking-wider">
            {BLEND_MODE_CATEGORY_LABELS[category]}
          </div>
          {modesInCategory.map((mode) => renderOption(mode))}
        </div>
      );
    });
  };

  // Render a single option
  const renderOption = (mode: BlendMode) => {
    const isSelected = mode === value;
    const label = getBlendModeLabel(mode);
    const description = showDescriptions ? getBlendModeDescription(mode) : undefined;

    return (
      <div
        key={mode}
        role="option"
        aria-selected={isSelected}
        title={description}
        className={`
          px-3 py-1.5 cursor-pointer text-sm
          ${isSelected ? 'bg-blue-600 text-white' : 'text-zinc-200 hover:bg-zinc-700'}
          transition-colors
        `}
        onClick={() => handleSelect(mode)}
      >
        {label}
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      data-testid="blend-mode-picker"
      className={`relative ${compact ? 'compact' : ''} ${className}`}
    >
      {/* Label */}
      {label && (
        <label className="block text-xs text-zinc-400 mb-1">{label}</label>
      )}

      {/* Button */}
      <button
        type="button"
        onClick={handleButtonClick}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className={`
          flex items-center justify-between gap-2
          ${compact ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm'}
          w-full min-w-[100px]
          bg-zinc-800 border border-zinc-600 rounded
          text-zinc-200
          hover:bg-zinc-700 hover:border-zinc-500
          disabled:opacity-50 disabled:cursor-not-allowed
          transition-colors
        `}
      >
        <span>{getBlendModeLabel(value)}</span>
        <ChevronDown
          size={compact ? 12 : 14}
          className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div
          ref={listboxRef}
          role="listbox"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setIsOpen(false);
            }
          }}
          className={`
            absolute z-50 mt-1
            min-w-full w-max
            bg-zinc-800 border border-zinc-600 rounded shadow-lg
            py-1 max-h-60 overflow-y-auto
          `}
        >
          {grouped
            ? renderGroupedOptions()
            : ALL_BLEND_MODES.map((mode) => renderOption(mode))}
        </div>
      )}
    </div>
  );
}

export default BlendModePicker;
