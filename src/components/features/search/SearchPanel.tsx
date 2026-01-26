/**
 * SearchPanel Component
 *
 * A complete search panel that combines SearchBar, SearchResults, and useSearch hook.
 * Can be used as a modal/popover or embedded in the layout.
 */

import { useState, useCallback, useEffect, useRef, type KeyboardEvent } from 'react';
import { SearchBar } from './SearchBar';
import { SearchResults } from './SearchResults';
import { useSearch, type AssetSearchResultItem } from '@/hooks/useSearch';

// =============================================================================
// Types
// =============================================================================

export interface SearchPanelProps {
  /** Whether the panel is open */
  isOpen: boolean;
  /** Callback to close the panel */
  onClose: () => void;
  /** Callback when a search result is selected */
  onResultSelect?: (result: AssetSearchResultItem) => void;
  /** Callback when a search result is double-clicked */
  onResultDoubleClick?: (result: AssetSearchResultItem) => void;
  /** Panel title */
  title?: string;
  /** Additional CSS classes */
  className?: string;
  /** Whether to show backdrop */
  showBackdrop?: boolean;
  /** Placeholder text for search input */
  placeholder?: string;
}

// =============================================================================
// Component
// =============================================================================

export function SearchPanel({
  isOpen,
  onClose,
  onResultSelect,
  onResultDoubleClick,
  title = 'Search',
  className = '',
  showBackdrop = false,
  placeholder = 'Search assets and transcripts...',
}: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const {
    searchAssets,
    state: { isSearching, error },
  } = useSearch({ debounceMs: 300 });

  const [results, setResults] = useState<AssetSearchResultItem[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [processingTimeMs, setProcessingTimeMs] = useState<number | undefined>();
  const [hasSearched, setHasSearched] = useState(false);

  // ===========================================================================
  // Search Handler
  // ===========================================================================

  const handleSearch = useCallback(
    async (searchQuery: string) => {
      setQuery(searchQuery);

      if (!searchQuery.trim()) {
        setResults([]);
        setTotal(0);
        setProcessingTimeMs(undefined);
        setHasSearched(false);
        setSelectedId(undefined);
        return;
      }

      // Mark as searched even before response to show loading/error states
      setHasSearched(true);

      const response = await searchAssets(searchQuery);
      if (response) {
        setResults(response.results);
        setTotal(response.total);
        setProcessingTimeMs(response.processingTimeMs);

        // Select first result if available
        if (response.results.length > 0) {
          setSelectedId(response.results[0].assetId);
        } else {
          setSelectedId(undefined);
        }
      } else {
        // searchAssets returns null on error - results stay empty
        setResults([]);
        setTotal(0);
        setProcessingTimeMs(undefined);
        setSelectedId(undefined);
      }
    },
    [searchAssets]
  );

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  const handleClear = useCallback(() => {
    setQuery('');
    setResults([]);
    setTotal(0);
    setProcessingTimeMs(undefined);
    setHasSearched(false);
    setSelectedId(undefined);
  }, []);

  const handleResultClick = useCallback(
    (result: AssetSearchResultItem) => {
      setSelectedId(result.assetId);
      onResultSelect?.(result);
    },
    [onResultSelect]
  );

  const handleSelectionChange = useCallback((assetId: string) => {
    setSelectedId(assetId);
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    },
    [onClose]
  );

  // ===========================================================================
  // Effects
  // ===========================================================================

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) {
      // Use requestAnimationFrame for more reliable focus timing
      const rafId = requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, [isOpen]);

  // Reset state when panel closes
  useEffect(() => {
    if (!isOpen) {
      // Delay reset to allow animation
      const timer = setTimeout(() => {
        handleClear();
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [isOpen, handleClear]);

  // ===========================================================================
  // Render
  // ===========================================================================

  if (!isOpen) {
    return null;
  }

  return (
    <>
      {/* Backdrop */}
      {showBackdrop && (
        <div
          data-testid="search-panel-backdrop"
          className="fixed inset-0 bg-surface-overlay backdrop-blur-sm z-40"
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div
        ref={panelRef}
        data-testid="search-panel"
        className={`bg-surface-panel border border-border-default rounded-lg shadow-2xl overflow-hidden z-50 ${className}`}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
          <h2 className="text-sm font-medium text-text-primary">{title}</h2>
          <button
            data-testid="search-panel-close"
            onClick={onClose}
            className="p-1 text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Close search"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Search Bar */}
        <div className="p-3 border-b border-border-default">
          <SearchBar
            value={query}
            onChange={setQuery}
            onSearch={handleSearch}
            onClear={handleClear}
            placeholder={placeholder}
            isLoading={isSearching}
          />
        </div>

        {/* Results */}
        <div className="max-h-96 overflow-y-auto">
          {!hasSearched ? (
            // Initial state
            <div className="p-8 text-center text-text-muted">
              <svg
                className="w-12 h-12 mx-auto mb-3 opacity-50"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <p>Type to search assets and transcripts</p>
            </div>
          ) : (
            <SearchResults
              results={results}
              total={total}
              processingTimeMs={processingTimeMs}
              selectedId={selectedId}
              isLoading={isSearching}
              error={error}
              emptyMessage="No results found"
              showThumbnails
              showSource
              showScore
              showMetadata
              onResultClick={handleResultClick}
              onResultDoubleClick={onResultDoubleClick}
              onSelectionChange={handleSelectionChange}
            />
          )}
        </div>

        {/* Keyboard hints */}
        <div className="px-3 py-2 border-t border-border-default text-xs text-text-muted flex flex-wrap items-center gap-3 sm:gap-4">
          <span>
            <kbd className="px-1.5 py-0.5 bg-surface-active rounded">↑↓</kbd> Navigate
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-surface-active rounded">Enter</kbd> Select
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-surface-active rounded">Esc</kbd> Close
          </span>
        </div>
      </div>
    </>
  );
}
