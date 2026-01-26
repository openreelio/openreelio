/**
 * SearchResults Component
 *
 * Displays search results from SQLite-based asset search.
 * Supports keyboard navigation, selection, and various display options.
 */

import { useCallback, useMemo, type KeyboardEvent } from 'react';
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
// Constants
// =============================================================================

/** Maximum number of results to display to prevent UI performance issues */
const MAX_DISPLAY_RESULTS = 100;

/** Maximum length for displayed text fields */
const MAX_TEXT_LENGTH = 200;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Safely formats a time in seconds to MM:SS format.
 *
 * @param seconds - Time in seconds (must be non-negative)
 * @returns Formatted time string or "0:00" for invalid input
 */
function formatTime(seconds: number): string {
  // Defensive: Handle invalid input
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }

  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Truncates text to a maximum length with ellipsis.
 *
 * @param text - Text to truncate
 * @param maxLength - Maximum allowed length
 * @returns Truncated text with ellipsis if needed
 */
function truncateText(text: string, maxLength: number = MAX_TEXT_LENGTH): string {
  if (typeof text !== 'string') return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

/**
 * Validates that a result item has the required fields.
 *
 * @param result - Result item to validate
 * @returns True if the result is valid
 */
function isValidResult(result: unknown): result is AssetSearchResultItem {
  if (!result || typeof result !== 'object') return false;

  const r = result as Record<string, unknown>;

  // Required fields
  if (typeof r.assetId !== 'string' || r.assetId.length === 0) return false;
  if (typeof r.assetName !== 'string') return false;
  if (typeof r.startSec !== 'number' || !Number.isFinite(r.startSec)) return false;
  if (typeof r.endSec !== 'number' || !Number.isFinite(r.endSec)) return false;
  if (typeof r.score !== 'number' || !Number.isFinite(r.score)) return false;
  if (!Array.isArray(r.reasons)) return false;
  if (typeof r.source !== 'string') return false;

  return true;
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
  // Defensive: Safely access and truncate text fields
  const assetName = truncateText(result.assetName || 'Untitled', 100);
  const source = truncateText(result.source || 'unknown', 30);

  // Defensive: Clamp score to valid percentage range
  const scorePercent = Math.max(0, Math.min(100, Math.round((result.score || 0) * 100)));

  // Defensive: Filter and truncate reasons
  const reasons = Array.isArray(result.reasons)
    ? result.reasons
        .filter((r): r is string => typeof r === 'string' && r.length > 0)
        .slice(0, 5) // Limit number of reasons
        .map((r) => truncateText(r, 50))
    : [];

  // Defensive: Validate thumbnail URL - allow safe protocols and relative paths
  const thumbnailUri = result.thumbnailUri &&
    typeof result.thumbnailUri === 'string' &&
    (result.thumbnailUri.startsWith('asset://') ||
      result.thumbnailUri.startsWith('file://') ||
      result.thumbnailUri.startsWith('http://') ||
      result.thumbnailUri.startsWith('https://') ||
      result.thumbnailUri.startsWith('data:image/') ||
      result.thumbnailUri.startsWith('/') || // Absolute path
      result.thumbnailUri.startsWith('./') || // Relative path
      result.thumbnailUri.startsWith('../')) // Parent relative path
    ? result.thumbnailUri
    : null;

  return (
    <div
      data-testid="search-result-item"
      data-selected={isSelected ? 'true' : undefined}
      data-asset-id={result.assetId}
      role="option"
      aria-selected={isSelected}
      className={`
        flex items-start gap-3 p-3 cursor-pointer
        border-b border-border-subtle last:border-b-0
        transition-colors duration-150
        ${isSelected ? 'bg-primary-500/20' : 'hover:bg-surface-active'}
      `}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {/* Thumbnail */}
      {showThumbnails && (
        <div className="flex-shrink-0 w-16 h-12 bg-surface-active rounded overflow-hidden">
          {thumbnailUri ? (
            <img
              src={thumbnailUri}
              alt={assetName}
              className="w-full h-full object-cover"
              loading="lazy"
              onError={(e) => {
                // Hide broken image and show placeholder
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : (
            <div
              data-testid="thumbnail-placeholder"
              className="w-full h-full flex items-center justify-center text-text-muted"
              aria-hidden="true"
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
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-text-primary truncate" title={result.assetName}>
            {assetName}
          </span>
          {showSource && (
            <span className="px-1.5 py-0.5 text-xs bg-surface-active text-text-secondary rounded">
              {source}
            </span>
          )}
          {showScore && (
            <span className="text-xs text-text-secondary" aria-label={`Relevance: ${scorePercent}%`}>
              {scorePercent}%
            </span>
          )}
        </div>

        {/* Time Range */}
        <div className="text-sm text-text-secondary mt-1">
          <time>{formatTime(result.startSec)}</time>
          {' - '}
          <time>{formatTime(result.endSec)}</time>
        </div>

        {/* Reasons */}
        {showReasons && reasons.length > 0 && (
          <div className="text-xs text-text-muted mt-1 truncate" title={reasons.join(', ')}>
            {reasons.join(', ')}
          </div>
        )}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div data-testid="search-result-skeleton" className="flex items-start gap-3 p-3">
      <div className="flex-shrink-0 w-16 h-12 bg-surface-active rounded animate-pulse" />
      <div className="flex-1">
        <div className="h-4 bg-surface-active rounded w-3/4 animate-pulse" />
        <div className="h-3 bg-surface-active rounded w-1/2 mt-2 animate-pulse" />
      </div>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export function SearchResults({
  results: rawResults,
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
  // Data Validation & Transformation
  // ===========================================================================

  // Defensive: Ensure results is a valid array and filter invalid items
  // Memoized to prevent unnecessary re-renders and stable reference for useCallback
  const results = useMemo(
    () =>
      Array.isArray(rawResults)
        ? rawResults
            .filter(isValidResult)
            .slice(0, MAX_DISPLAY_RESULTS) // Limit display count for performance
        : [],
    [rawResults]
  );

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
        // Defensive: Ensure we have a valid result before accessing assetId
        const nextResult = results[nextIndex];
        if (nextResult) {
          onSelectionChange(nextResult.assetId);
        }
      } else if (e.key === 'ArrowUp' && onSelectionChange) {
        e.preventDefault();
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : 0;
        // Defensive: Ensure we have a valid result before accessing assetId
        const prevResult = results[prevIndex];
        if (prevResult) {
          onSelectionChange(prevResult.assetId);
        }
      } else if (e.key === 'Enter' && onResultClick && selectedId) {
        e.preventDefault();
        const selected = results.find((r) => r.assetId === selectedId);
        if (selected) {
          try {
            onResultClick(selected);
          } catch (err) {
            // Defensive: Log but don't crash if callback fails
            console.error('Result click callback failed:', err);
          }
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
        className={`bg-surface-panel rounded-lg overflow-hidden ${className}`}
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
    // Defensive: Sanitize and truncate error message
    const safeError = typeof error === 'string'
      ? truncateText(error, MAX_TEXT_LENGTH)
      : 'An error occurred';

    return (
      <div
        data-testid="search-results"
        role="alert"
        aria-live="polite"
        className={`bg-surface-panel rounded-lg p-4 ${className}`}
      >
        <div className="flex items-center gap-2 text-status-error">
          <svg
            data-testid="search-error-icon"
            className="w-5 h-5 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <span className="break-words">{safeError}</span>
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
        className={`bg-surface-panel rounded-lg ${className}`}
      >
        <div
          data-testid="search-results-empty"
          className="p-8 text-center text-text-muted"
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
      className={`bg-surface-panel rounded-lg overflow-hidden focus:outline-none ${className}`}
      onKeyDown={handleKeyDown}
    >
      {/* Metadata Header */}
      {showMetadata && (
        <div className="px-3 py-2 bg-surface-elevated border-b border-border-subtle text-xs text-text-secondary flex items-center justify-between">
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
            onClick={() => {
              try {
                onResultClick?.(result);
              } catch (err) {
                console.error('Result click handler failed:', err);
              }
            }}
            onDoubleClick={() => {
              try {
                onResultDoubleClick?.(result);
              } catch (err) {
                console.error('Result double-click handler failed:', err);
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}
