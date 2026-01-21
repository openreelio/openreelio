/**
 * SearchResults Component Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchResults } from './SearchResults';
import type { AssetSearchResultItem } from '@/hooks/useSearch';

// =============================================================================
// Test Data
// =============================================================================

const mockResults: AssetSearchResultItem[] = [
  {
    assetId: 'asset_001',
    assetName: 'Interview.mp4',
    startSec: 10.5,
    endSec: 15.0,
    score: 0.95,
    reasons: ['Transcript match: "hello world"'],
    thumbnailUri: '/path/to/thumb1.jpg',
    source: 'transcript',
  },
  {
    assetId: 'asset_002',
    assetName: 'B-roll.mp4',
    startSec: 0.0,
    endSec: 5.0,
    score: 0.75,
    reasons: ['Shot label: "outdoor scene"'],
    thumbnailUri: null,
    source: 'shot',
  },
  {
    assetId: 'asset_003',
    assetName: 'Music.wav',
    startSec: 30.0,
    endSec: 45.0,
    score: 0.5,
    reasons: ['Audio peak detected'],
    thumbnailUri: null,
    source: 'audio',
  },
];

// =============================================================================
// Tests
// =============================================================================

describe('SearchResults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render results list', () => {
      render(<SearchResults results={mockResults} />);

      const resultsList = screen.getByTestId('search-results');
      expect(resultsList).toBeInTheDocument();
    });

    it('should render each result item', () => {
      render(<SearchResults results={mockResults} />);

      expect(screen.getByText('Interview.mp4')).toBeInTheDocument();
      expect(screen.getByText('B-roll.mp4')).toBeInTheDocument();
      expect(screen.getByText('Music.wav')).toBeInTheDocument();
    });

    it('should display empty state when no results', () => {
      render(<SearchResults results={[]} />);

      const emptyState = screen.getByTestId('search-results-empty');
      expect(emptyState).toBeInTheDocument();
    });

    it('should display custom empty message', () => {
      render(<SearchResults results={[]} emptyMessage="No matching assets found" />);

      expect(screen.getByText('No matching assets found')).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(<SearchResults results={mockResults} className="custom-class" />);

      const container = screen.getByTestId('search-results');
      expect(container).toHaveClass('custom-class');
    });
  });

  // ===========================================================================
  // Result Item Details Tests
  // ===========================================================================

  describe('result item details', () => {
    it('should display time range in formatted time', () => {
      render(<SearchResults results={mockResults} />);

      // 10.5 -> 0:10, 15.0 -> 0:15
      expect(screen.getByText('0:10 - 0:15')).toBeInTheDocument();
    });

    it('should display relevance score as percentage', () => {
      render(<SearchResults results={mockResults} showScore />);

      expect(screen.getByText('95%')).toBeInTheDocument();
      expect(screen.getByText('75%')).toBeInTheDocument();
    });

    it('should display match reasons', () => {
      render(<SearchResults results={mockResults} showReasons />);

      expect(screen.getByText('Transcript match: "hello world"')).toBeInTheDocument();
      expect(screen.getByText('Shot label: "outdoor scene"')).toBeInTheDocument();
    });

    it('should display source badge', () => {
      render(<SearchResults results={mockResults} showSource />);

      expect(screen.getByText('transcript')).toBeInTheDocument();
      expect(screen.getByText('shot')).toBeInTheDocument();
      expect(screen.getByText('audio')).toBeInTheDocument();
    });

    it('should render thumbnail when available', () => {
      render(<SearchResults results={mockResults} showThumbnails />);

      const thumbnail = screen.getByAltText('Interview.mp4');
      expect(thumbnail).toHaveAttribute('src', '/path/to/thumb1.jpg');
    });

    it('should render placeholder when thumbnail is not available', () => {
      render(<SearchResults results={mockResults} showThumbnails />);

      // B-roll.mp4 has no thumbnail
      const placeholders = screen.getAllByTestId('thumbnail-placeholder');
      expect(placeholders.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  describe('user interaction', () => {
    it('should call onResultClick when result is clicked', () => {
      const onResultClick = vi.fn();
      render(<SearchResults results={mockResults} onResultClick={onResultClick} />);

      const firstResult = screen.getByText('Interview.mp4').closest('[data-testid="search-result-item"]');
      fireEvent.click(firstResult!);

      expect(onResultClick).toHaveBeenCalledWith(mockResults[0]);
    });

    it('should call onResultDoubleClick when result is double-clicked', () => {
      const onResultDoubleClick = vi.fn();
      render(<SearchResults results={mockResults} onResultDoubleClick={onResultDoubleClick} />);

      const firstResult = screen.getByText('Interview.mp4').closest('[data-testid="search-result-item"]');
      fireEvent.doubleClick(firstResult!);

      expect(onResultDoubleClick).toHaveBeenCalledWith(mockResults[0]);
    });

    it('should highlight selected result', () => {
      render(<SearchResults results={mockResults} selectedId="asset_002" />);

      const selectedResult = screen.getByText('B-roll.mp4').closest('[data-testid="search-result-item"]');
      expect(selectedResult).toHaveAttribute('data-selected', 'true');
    });

    it('should support keyboard navigation with ArrowDown', () => {
      const onSelectionChange = vi.fn();
      render(
        <SearchResults
          results={mockResults}
          selectedId="asset_001"
          onSelectionChange={onSelectionChange}
        />
      );

      const container = screen.getByTestId('search-results');
      fireEvent.keyDown(container, { key: 'ArrowDown' });

      expect(onSelectionChange).toHaveBeenCalledWith('asset_002');
    });

    it('should support keyboard navigation with ArrowUp', () => {
      const onSelectionChange = vi.fn();
      render(
        <SearchResults
          results={mockResults}
          selectedId="asset_002"
          onSelectionChange={onSelectionChange}
        />
      );

      const container = screen.getByTestId('search-results');
      fireEvent.keyDown(container, { key: 'ArrowUp' });

      expect(onSelectionChange).toHaveBeenCalledWith('asset_001');
    });

    it('should trigger onResultClick on Enter key', () => {
      const onResultClick = vi.fn();
      render(
        <SearchResults
          results={mockResults}
          selectedId="asset_001"
          onResultClick={onResultClick}
        />
      );

      const container = screen.getByTestId('search-results');
      fireEvent.keyDown(container, { key: 'Enter' });

      expect(onResultClick).toHaveBeenCalledWith(mockResults[0]);
    });
  });

  // ===========================================================================
  // Loading State Tests
  // ===========================================================================

  describe('loading state', () => {
    it('should show loading skeleton when isLoading is true', () => {
      render(<SearchResults results={[]} isLoading />);

      const skeletons = screen.getAllByTestId('search-result-skeleton');
      expect(skeletons.length).toBeGreaterThan(0);
    });

    it('should not show results when loading', () => {
      render(<SearchResults results={mockResults} isLoading />);

      expect(screen.queryByText('Interview.mp4')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Error State Tests
  // ===========================================================================

  describe('error state', () => {
    it('should show error message when error is provided', () => {
      render(<SearchResults results={[]} error="Search failed" />);

      expect(screen.getByText('Search failed')).toBeInTheDocument();
    });

    it('should show error icon when error is provided', () => {
      render(<SearchResults results={[]} error="Search failed" />);

      const errorIcon = screen.getByTestId('search-error-icon');
      expect(errorIcon).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Metadata Tests
  // ===========================================================================

  describe('metadata display', () => {
    it('should show total results count', () => {
      render(<SearchResults results={mockResults} total={100} showMetadata />);

      expect(screen.getByText('100 results')).toBeInTheDocument();
    });

    it('should show processing time', () => {
      render(<SearchResults results={mockResults} processingTimeMs={15} showMetadata />);

      expect(screen.getByText('15ms')).toBeInTheDocument();
    });

    it('should show singular "result" for single result', () => {
      render(<SearchResults results={[mockResults[0]]} total={1} showMetadata />);

      expect(screen.getByText('1 result')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('accessibility', () => {
    it('should have proper ARIA role', () => {
      render(<SearchResults results={mockResults} />);

      const list = screen.getByRole('listbox');
      expect(list).toBeInTheDocument();
    });

    it('should have option role for each result', () => {
      render(<SearchResults results={mockResults} />);

      const options = screen.getAllByRole('option');
      expect(options).toHaveLength(3);
    });

    it('should mark selected option with aria-selected', () => {
      render(<SearchResults results={mockResults} selectedId="asset_001" />);

      const selectedOption = screen.getByText('Interview.mp4').closest('[role="option"]');
      expect(selectedOption).toHaveAttribute('aria-selected', 'true');
    });
  });
});
