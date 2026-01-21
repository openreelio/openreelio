/**
 * SearchResults Component
 *
 * Displays search results from SQLite-based asset search.
 * Supports keyboard navigation, selection, and various display options.
 */

import { useCallback, type KeyboardEvent } from 'react';
import type { AssetSearchResultItem } from '@/hooks/useSearch';

// =============================================================================
// Types
// =============================================================================

export interface SearchResultsProps {
  /** Search results to display */
  results: AssetSearchResultItem[];
  /** Total number of results (may be more than displayed) */
  total?: number;
  /** Processing time in milliseconds */
  processingTimeMs?: number;
  /** ID of currently selected result */
  selectedId?: string;
  /** Whether search is in progress */
  isLoading?: boolean;
  /** Error message to display */
  error?: string | null;
  /** Custom empty state message */
  emptyMessage?: string;
  /** Additional CSS classes */
  className?: string;
  /** Whether to show thumbnails */
  showThumbnails?: boolean;
  /** Whether to show relevance score */
  showScore?: boolean;
  /** Whether to show match reasons */
  showReasons?: boolean;
  /** Whether to show source badge */
  showSource?: boolean;
  /** Whether to show metadata (count, time) */
  showMetadata?: boolean;
  /** Callback when a result is clicked */
  onResultClick?: (result: AssetSearchResultItem) => void;
  /** Callback when a result is double-clicked */
  onResultDoubleClick?: (result: AssetSearchResultItem) => void;
  /** Callback when selection changes (keyboard navigation) */
  onSelectionChange?: (assetId: string) => void;
}

// =============================================================================
// Helper Functions
// =============================================================================

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// =============================================================================
// Sub-Components
// =============================================================================

interface ResultItemProps {
  result: AssetSearchResultItem;
  isSelected: boolean;
  showThumbnails?: boolean;
  showScore?: boolean;
  showReasons?: boolean;
  showSource?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
}

function ResultItem({
  result,
  isSelected,
  showThumbnails,
  showScore,
  showReasons,
  showSource,
  onClick,
  onDoubleClick,
}: ResultItemProps) {
  return (
    <div
      data-testid="search-result-item"
      data-selected={isSelected ? 'true' : undefined}
      role="option"
      aria-selected={isSelected}
      className={`
        flex items-start gap-3 p-3 cursor-pointer
        border-b border-gray-700 last:border-b-0
        transition-colors duration-150
        ${isSelected ? 'bg-blue-900/50' : 'hover:bg-gray-800'}
      `}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {/* Thumbnail */}
      {showThumbnails && (
        <div className="flex-shrink-0 w-16 h-12 bg-gray-800 rounded overflow-hidden">
          {result.thumbnailUri ? (
            <img
              src={result.thumbnailUri}
              alt={result.assetName}
              className="w-full h-full object-cover"
            />
          ) : (
            <div
              data-testid="thumbnail-placeholder"
              className="w-full h-full flex items-center justify-center text-gray-600"
            >
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4"
                />
              </svg>
            </div>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2">
          <span className="font-medium text-white truncate">
            {result.assetName}
          </span>
          {showSource && (
            <span className="px-1.5 py-0.5 text-xs bg-gray-700 text-gray-300 rounded">
              {result.source}
            </span>
          )}
          {showScore && (
            <span className="text-xs text-gray-400">
              {Math.round(result.score * 100)}%
            </span>
          )}
        </div>

        {/* Time Range */}
        <div className="text-sm text-gray-400 mt-1">
          {formatTime(result.startSec)} - {formatTime(result.endSec)}
        </div>

        {/* Reasons */}
        {showReasons && result.reasons.length > 0 && (
          <div className="text-xs text-gray-500 mt-1 truncate">
            {result.reasons.join(', ')}
          </div>
        )}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div data-testid="search-result-skeleton" className="flex items-start gap-3 p-3">
      <div className="flex-shrink-0 w-16 h-12 bg-gray-700 rounded animate-pulse" />
      <div className="flex-1">
        <div className="h-4 bg-gray-700 rounded w-3/4 animate-pulse" />
        <div className="h-3 bg-gray-700 rounded w-1/2 mt-2 animate-pulse" />
      </div>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export function SearchResults({
  results,
  total,
  processingTimeMs,
  selectedId,
  isLoading = false,
  error,
  emptyMessage = 'No results found',
  className = '',
  showThumbnails = false,
  showScore = false,
  showReasons = false,
  showSource = false,
  showMetadata = false,
  onResultClick,
  onResultDoubleClick,
  onSelectionChange,
}: SearchResultsProps) {
  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!results.length) return;

      const currentIndex = results.findIndex((r) => r.assetId === selectedId);

      if (e.key === 'ArrowDown' && onSelectionChange) {
        e.preventDefault();
        const nextIndex = currentIndex < results.length - 1 ? currentIndex + 1 : currentIndex;
        onSelectionChange(results[nextIndex].assetId);
      } else if (e.key === 'ArrowUp' && onSelectionChange) {
        e.preventDefault();
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : 0;
        onSelectionChange(results[prevIndex].assetId);
      } else if (e.key === 'Enter' && onResultClick && selectedId) {
        e.preventDefault();
        const selected = results.find((r) => r.assetId === selectedId);
        if (selected) {
          onResultClick(selected);
        }
      }
    },
    [results, selectedId, onSelectionChange, onResultClick]
  );

  // ===========================================================================
  // Render Loading State
  // ===========================================================================

  if (isLoading) {
    return (
      <div
        data-testid="search-results"
        className={`bg-gray-900 rounded-lg overflow-hidden ${className}`}
      >
        <LoadingSkeleton />
        <LoadingSkeleton />
        <LoadingSkeleton />
      </div>
    );
  }

  // ===========================================================================
  // Render Error State
  // ===========================================================================

  if (error) {
    return (
      <div
        data-testid="search-results"
        className={`bg-gray-900 rounded-lg p-4 ${className}`}
      >
        <div className="flex items-center gap-2 text-red-400">
          <svg
            data-testid="search-error-icon"
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <span>{error}</span>
        </div>
      </div>
    );
  }

  // ===========================================================================
  // Render Empty State
  // ===========================================================================

  if (results.length === 0) {
    return (
      <div
        data-testid="search-results"
        className={`bg-gray-900 rounded-lg ${className}`}
      >
        <div
          data-testid="search-results-empty"
          className="p-8 text-center text-gray-500"
        >
          <svg
            className="w-12 h-12 mx-auto mb-3"
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
          <p>{emptyMessage}</p>
        </div>
      </div>
    );
  }

  // ===========================================================================
  // Render Results
  // ===========================================================================

  const displayTotal = total ?? results.length;

  return (
    <div
      data-testid="search-results"
      role="listbox"
      tabIndex={0}
      className={`bg-gray-900 rounded-lg overflow-hidden focus:outline-none ${className}`}
      onKeyDown={handleKeyDown}
    >
      {/* Metadata Header */}
      {showMetadata && (
        <div className="px-3 py-2 bg-gray-800 border-b border-gray-700 text-xs text-gray-400 flex items-center justify-between">
          <span>
            {displayTotal} {displayTotal === 1 ? 'result' : 'results'}
          </span>
          {processingTimeMs !== undefined && (
            <span>{processingTimeMs}ms</span>
          )}
        </div>
      )}

      {/* Results List */}
      <div className="max-h-96 overflow-y-auto">
        {results.map((result) => (
          <ResultItem
            key={`${result.assetId}-${result.startSec}`}
            result={result}
            isSelected={result.assetId === selectedId}
            showThumbnails={showThumbnails}
            showScore={showScore}
            showReasons={showReasons}
            showSource={showSource}
            onClick={() => onResultClick?.(result)}
            onDoubleClick={() => onResultDoubleClick?.(result)}
          />
        ))}
      </div>
    </div>
  );
}
