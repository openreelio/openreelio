/**
 * SearchFilters Component
 *
 * Filter controls for search results.
 * Supports filtering by asset type, language, source, etc.
 */

import React, { useCallback, useMemo } from 'react';
import { X, Filter } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

export type AssetTypeFilter = 'all' | 'video' | 'audio' | 'image';
export type SourceFilter = 'all' | 'asset' | 'transcript';

export interface SearchFilterValues {
  /** Asset type filter */
  assetType?: AssetTypeFilter;
  /** Language code filter */
  language?: string;
  /** Source filter (asset name vs transcript) */
  source?: SourceFilter;
  /** Date range filter - start */
  dateFrom?: string;
  /** Date range filter - end */
  dateTo?: string;
  /** Speaker filter */
  speaker?: string;
}

export interface SearchFiltersProps {
  /** Current filter values */
  filters: SearchFilterValues;
  /** Callback when filters change */
  onChange: (filters: SearchFilterValues) => void;
  /** Show transcript-specific filters */
  showTranscriptFilters?: boolean;
  /** Show filter count badge */
  showFilterCount?: boolean;
  /** Compact display mode */
  compact?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const ASSET_TYPES: Array<{ value: AssetTypeFilter; label: string }> = [
  { value: 'all', label: 'All Types' },
  { value: 'video', label: 'Video' },
  { value: 'audio', label: 'Audio' },
  { value: 'image', label: 'Image' },
];

const LANGUAGES = [
  { code: 'all', name: 'All Languages' },
  { code: 'en', name: 'English' },
  { code: 'ko', name: 'Korean' },
  { code: 'ja', name: 'Japanese' },
  { code: 'zh', name: 'Chinese' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
];

const SOURCES: Array<{ value: SourceFilter; label: string }> = [
  { value: 'all', label: 'All Sources' },
  { value: 'asset', label: 'Asset Name' },
  { value: 'transcript', label: 'Transcript' },
];

// =============================================================================
// Component
// =============================================================================

export const SearchFilters: React.FC<SearchFiltersProps> = ({
  filters,
  onChange,
  showTranscriptFilters = false,
  showFilterCount = false,
  compact = false,
  className = '',
}) => {
  // Count active filters
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.assetType && filters.assetType !== 'all') count++;
    if (filters.language && filters.language !== 'all') count++;
    if (filters.source && filters.source !== 'all') count++;
    if (filters.speaker) count++;
    if (filters.dateFrom) count++;
    if (filters.dateTo) count++;
    return count;
  }, [filters]);

  // Handle filter change
  const handleChange = useCallback(
    (key: keyof SearchFilterValues, value: string) => {
      const newFilters = { ...filters };

      if (value === 'all' || value === '') {
        delete newFilters[key];
      } else {
        (newFilters as Record<string, string>)[key] = value;
      }

      onChange(newFilters);
    },
    [filters, onChange]
  );

  // Handle clear all filters
  const handleClear = useCallback(() => {
    onChange({});
  }, [onChange]);

  const gapClass = compact ? 'gap-1' : 'gap-2';
  const selectClass = compact
    ? 'px-2 py-1 text-xs'
    : 'px-3 py-1.5 text-sm';

  return (
    <div
      data-testid="search-filters"
      className={`flex items-center flex-wrap ${gapClass} ${className}`}
    >
      {/* Filter Icon */}
      <div className="flex items-center gap-1 text-gray-400">
        <Filter className="w-4 h-4" />
        {showFilterCount && activeFilterCount > 0 && (
          <span className="text-xs text-blue-400">
            {activeFilterCount} {activeFilterCount === 1 ? 'filter' : 'filters'}
          </span>
        )}
      </div>

      {/* Asset Type Filter */}
      <div>
        <label htmlFor="filter-type" className="sr-only">
          Asset Type
        </label>
        <select
          id="filter-type"
          value={filters.assetType ?? 'all'}
          onChange={(e) => handleChange('assetType', e.target.value)}
          className={`rounded bg-gray-800 border border-gray-600 text-white
            focus:outline-none focus:border-blue-500 ${selectClass}`}
        >
          {ASSET_TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
      </div>

      {/* Language Filter */}
      <div>
        <label htmlFor="filter-language" className="sr-only">
          Language
        </label>
        <select
          id="filter-language"
          value={filters.language ?? 'all'}
          onChange={(e) => handleChange('language', e.target.value)}
          className={`rounded bg-gray-800 border border-gray-600 text-white
            focus:outline-none focus:border-blue-500 ${selectClass}`}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.name}
            </option>
          ))}
        </select>
      </div>

      {/* Source Filter (Transcript-specific) */}
      {showTranscriptFilters && (
        <div>
          <label htmlFor="filter-source" className="sr-only">
            Source
          </label>
          <select
            id="filter-source"
            value={filters.source ?? 'all'}
            onChange={(e) => handleChange('source', e.target.value)}
            className={`rounded bg-gray-800 border border-gray-600 text-white
              focus:outline-none focus:border-blue-500 ${selectClass}`}
          >
            {SOURCES.map((source) => (
              <option key={source.value} value={source.value}>
                {source.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Clear Filters Button */}
      {activeFilterCount > 0 && (
        <button
          type="button"
          onClick={handleClear}
          className={`flex items-center gap-1 rounded bg-gray-700 text-gray-300
            hover:bg-gray-600 hover:text-white transition-colors ${selectClass}`}
          aria-label="Clear filters"
        >
          <X className="w-3 h-3" />
          <span>Clear</span>
        </button>
      )}
    </div>
  );
};

export default SearchFilters;
