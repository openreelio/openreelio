/**
 * BlendModePicker Component
 *
 * A dropdown selector for video blend modes.
 * Features:
 * - Dropdown with all blend mode options
 * - Category grouping with collapsible sections
 * - Inline search/filter
 * - Keyboard navigation
 * - Descriptions for each mode
 *
 * @module components/features/effects/BlendModePicker
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import type { BlendMode } from '@/types';
import type { BlendModeCategory } from '@/utils/blendModes';
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
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<BlendModeCategory>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen && grouped) {
      // Small delay to ensure DOM is rendered
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
    }
    if (!isOpen) {
      setSearchQuery('');
    }
  }, [isOpen, grouped]);

  // Filter modes by search query
  const filteredModes = useMemo(() => {
    if (!searchQuery.trim()) return ALL_BLEND_MODES;
    const query = searchQuery.toLowerCase();
    return ALL_BLEND_MODES.filter((mode) => {
      const label = getBlendModeLabel(mode).toLowerCase();
      const category = BLEND_MODE_CATEGORY_LABELS[getBlendModeCategory(mode)].toLowerCase();
      return label.includes(query) || category.includes(query);
    });
  }, [searchQuery]);

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

  // Toggle category collapse
  const toggleCategory = useCallback((category: BlendModeCategory) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }, []);

  // Render options grouped by category
  const renderGroupedOptions = () => {
    const categories = getUsedCategories();

    return categories.map((category) => {
      const modesInCategory = filteredModes.filter(
        (mode) => getBlendModeCategory(mode) === category
      );

      if (modesInCategory.length === 0) return null;

      const isCollapsed = collapsedCategories.has(category);

      return (
        <div key={category} className="py-0.5">
          <button
            type="button"
            data-testid={`blend-category-${category}`}
            onClick={() => toggleCategory(category)}
            className="flex items-center gap-1 w-full px-2 py-1 text-xs font-medium text-zinc-400 uppercase tracking-wider hover:text-zinc-200 transition-colors"
          >
            {isCollapsed ? (
              <ChevronRight size={10} />
            ) : (
              <ChevronDown size={10} />
            )}
            {BLEND_MODE_CATEGORY_LABELS[category]}
            <span className="text-zinc-600 ml-auto normal-case tracking-normal font-normal">
              {modesInCategory.length}
            </span>
          </button>
          {!isCollapsed && modesInCategory.map((mode) => renderOption(mode))}
        </div>
      );
    });
  };

  // Render a single option
  const renderOption = (mode: BlendMode) => {
    const isSelected = mode === value;
    const modeLabel = getBlendModeLabel(mode);
    const description = showDescriptions ? getBlendModeDescription(mode) : undefined;

    return (
      <div
        key={mode}
        role="option"
        data-testid={`blend-option-${mode}`}
        aria-selected={isSelected}
        title={description}
        className={`
          px-3 py-1.5 cursor-pointer text-sm
          ${isSelected ? 'bg-blue-600 text-white' : 'text-zinc-200 hover:bg-zinc-700'}
          transition-colors
        `}
        onClick={() => handleSelect(mode)}
      >
        {modeLabel}
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
        data-testid="blend-mode-trigger"
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
          data-testid="blend-mode-listbox"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setIsOpen(false);
            }
          }}
          className={`
            absolute z-50 mt-1
            min-w-full w-max
            bg-zinc-800 border border-zinc-600 rounded shadow-lg
            max-h-72 overflow-y-auto
          `}
        >
          {/* Search filter (only in grouped mode) */}
          {grouped && (
            <div className="sticky top-0 bg-zinc-800 border-b border-zinc-700 p-1.5">
              <div className="relative">
                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  ref={searchInputRef}
                  type="text"
                  data-testid="blend-mode-search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter modes..."
                  className="w-full pl-6 pr-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-500 focus:border-zinc-500 focus:outline-none"
                />
              </div>
            </div>
          )}

          <div className="py-1">
            {grouped
              ? renderGroupedOptions()
              : (searchQuery ? filteredModes : ALL_BLEND_MODES).map((mode) => renderOption(mode))}
          </div>

          {/* Empty state */}
          {grouped && filteredModes.length === 0 && (
            <div className="px-3 py-2 text-xs text-zinc-500 text-center">
              No matching blend modes
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default BlendModePicker;
