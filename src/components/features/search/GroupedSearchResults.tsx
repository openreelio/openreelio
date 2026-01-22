/**
 * GroupedSearchResults Component
 *
 * Displays search results grouped by asset, source, or other criteria.
 * Supports expand/collapse of groups and various sorting modes.
 */

import React, { useState, useCallback, useMemo } from 'react';
import { ChevronDown, ChevronRight, Film, Music, FileText } from 'lucide-react';
import type { AssetSearchResultItem } from '@/hooks/useSearch';

// =============================================================================
// Types
// =============================================================================

export type GroupByOption = 'asset' | 'source' | 'none';
export type SortGroupsOption = 'count' | 'name' | 'score';

export interface GroupedSearchResultsProps {
  /** Search results to display */
  results: AssetSearchResultItem[];
  /** Grouping mode */
  groupBy: GroupByOption;
  /** Callback when a result is clicked */
  onResultClick: (result: AssetSearchResultItem) => void;
  /** Callback when a result is double-clicked */
  onResultDoubleClick?: (result: AssetSearchResultItem) => void;
  /** Callback when a group is expanded/collapsed */
  onGroupToggle?: (groupId: string, isExpanded: boolean) => void;
  /** Groups that are initially collapsed */
  defaultCollapsed?: string[];
  /** Show match count in group header */
  showCount?: boolean;
  /** Show thumbnails */
  showThumbnails?: boolean;
  /** Sort groups by */
  sortGroups?: SortGroupsOption;
  /** Empty state message */
  emptyMessage?: string;
  /** Additional CSS classes */
  className?: string;
}

interface ResultGroup {
  id: string;
  name: string;
  results: AssetSearchResultItem[];
  totalScore: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getSourceIcon(source: string) {
  switch (source) {
    case 'asset':
      return <Film className="w-4 h-4" />;
    case 'transcript':
      return <FileText className="w-4 h-4" />;
    default:
      return <Music className="w-4 h-4" />;
  }
}

function groupResults(
  results: AssetSearchResultItem[],
  groupBy: GroupByOption
): ResultGroup[] {
  if (groupBy === 'none') {
    return [];
  }

  const groups = new Map<string, ResultGroup>();

  for (const result of results) {
    let groupId: string;
    let groupName: string;

    if (groupBy === 'asset') {
      groupId = result.assetId;
      groupName = result.assetName;
    } else {
      groupId = result.source;
      groupName = result.source === 'asset' ? 'Asset Names' : 'Transcripts';
    }

    if (!groups.has(groupId)) {
      groups.set(groupId, {
        id: groupId,
        name: groupName,
        results: [],
        totalScore: 0,
      });
    }

    const group = groups.get(groupId)!;
    group.results.push(result);
    group.totalScore += result.score;
  }

  return Array.from(groups.values());
}

function sortGroups(groups: ResultGroup[], sortBy: SortGroupsOption): ResultGroup[] {
  return [...groups].sort((a, b) => {
    switch (sortBy) {
      case 'count':
        return b.results.length - a.results.length;
      case 'name':
        return a.name.localeCompare(b.name);
      case 'score':
        return b.totalScore - a.totalScore;
      default:
        return 0;
    }
  });
}

// =============================================================================
// Sub-Components
// =============================================================================

interface GroupHeaderProps {
  group: ResultGroup;
  isExpanded: boolean;
  showCount: boolean;
  onToggle: () => void;
}

const GroupHeader: React.FC<GroupHeaderProps> = ({
  group,
  isExpanded,
  showCount,
  onToggle,
}) => {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={isExpanded}
      className="flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-700 cursor-pointer transition-colors"
      onClick={onToggle}
      onKeyDown={handleKeyDown}
    >
      {isExpanded ? (
        <ChevronDown className="w-4 h-4 text-gray-400" />
      ) : (
        <ChevronRight className="w-4 h-4 text-gray-400" />
      )}
      <span className="font-medium text-white truncate">{group.name}</span>
      {showCount && (
        <span className="text-xs text-gray-400 ml-auto">
          {group.results.length} {group.results.length === 1 ? 'match' : 'matches'}
        </span>
      )}
    </div>
  );
};

interface ResultItemProps {
  result: AssetSearchResultItem;
  showThumbnails: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
}

const ResultItem: React.FC<ResultItemProps> = ({
  result,
  showThumbnails,
  onClick,
  onDoubleClick,
}) => {
  return (
    <div
      data-testid="search-result-item"
      className="flex items-center gap-3 px-4 py-2 hover:bg-gray-800 cursor-pointer transition-colors"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {/* Thumbnail */}
      {showThumbnails && (
        <div className="flex-shrink-0 w-12 h-8 bg-gray-700 rounded overflow-hidden">
          {result.thumbnailUri ? (
            <img
              src={result.thumbnailUri}
              alt=""
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-500">
              {getSourceIcon(result.source)}
            </div>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-300">
            {formatTime(result.startSec)} - {formatTime(result.endSec)}
          </span>
          <span className="text-xs text-gray-500">
            {Math.round(result.score * 100)}%
          </span>
        </div>
        {result.reasons.length > 0 && (
          <div className="text-xs text-gray-500 truncate mt-0.5">
            {result.reasons.join(', ')}
          </div>
        )}
      </div>
    </div>
  );
};

// =============================================================================
// Main Component
// =============================================================================

export const GroupedSearchResults: React.FC<GroupedSearchResultsProps> = ({
  results,
  groupBy,
  onResultClick,
  onResultDoubleClick,
  onGroupToggle,
  defaultCollapsed = [],
  showCount = false,
  showThumbnails = false,
  sortGroups: sortGroupsBy = 'count',
  emptyMessage = 'No results found',
  className = '',
}) => {
  // Track collapsed groups
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(defaultCollapsed)
  );

  // Group and sort results
  const groups = useMemo(() => {
    const grouped = groupResults(results, groupBy);
    return sortGroups(grouped, sortGroupsBy);
  }, [results, groupBy, sortGroupsBy]);

  // Handle group toggle
  const handleGroupToggle = useCallback(
    (groupId: string) => {
      setCollapsedGroups((prev) => {
        const next = new Set(prev);
        const isNowExpanded = next.has(groupId);

        if (isNowExpanded) {
          next.delete(groupId);
        } else {
          next.add(groupId);
        }

        onGroupToggle?.(groupId, isNowExpanded);
        return next;
      });
    },
    [onGroupToggle]
  );

  // Empty state
  if (results.length === 0) {
    return (
      <div
        data-testid="grouped-search-results"
        className={`p-8 text-center text-gray-500 ${className}`}
      >
        {emptyMessage}
      </div>
    );
  }

  // Flat (ungrouped) mode
  if (groupBy === 'none') {
    return (
      <div
        data-testid="grouped-search-results"
        className={`divide-y divide-gray-700 ${className}`}
      >
        {results.map((result, index) => (
          <ResultItem
            key={`${result.assetId}-${result.startSec}-${index}`}
            result={result}
            showThumbnails={showThumbnails}
            onClick={() => onResultClick(result)}
            onDoubleClick={() => onResultDoubleClick?.(result)}
          />
        ))}
      </div>
    );
  }

  // Grouped mode
  return (
    <div
      data-testid="grouped-search-results"
      className={className}
    >
      {groups.map((group) => {
        const isExpanded = !collapsedGroups.has(group.id);

        return (
          <div key={group.id} data-testid="result-group" className="border-b border-gray-700 last:border-b-0">
            <GroupHeader
              group={group}
              isExpanded={isExpanded}
              showCount={showCount}
              onToggle={() => handleGroupToggle(group.id)}
            />

            {isExpanded && (
              <div className="divide-y divide-gray-800">
                {group.results.map((result, index) => (
                  <ResultItem
                    key={`${result.assetId}-${result.startSec}-${index}`}
                    result={result}
                    showThumbnails={showThumbnails}
                    onClick={() => onResultClick(result)}
                    onDoubleClick={() => onResultDoubleClick?.(result)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default GroupedSearchResults;
