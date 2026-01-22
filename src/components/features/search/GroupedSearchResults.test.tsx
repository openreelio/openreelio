/**
 * GroupedSearchResults Component Tests
 *
 * Tests for grouped search results display.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GroupedSearchResults } from './GroupedSearchResults';
import type { AssetSearchResultItem } from '@/hooks/useSearch';

// =============================================================================
// Test Data
// =============================================================================

const createTestResult = (overrides?: Partial<AssetSearchResultItem>): AssetSearchResultItem => ({
  assetId: 'asset_001',
  assetName: 'test-video.mp4',
  source: 'transcript',
  startSec: 10,
  endSec: 15,
  score: 0.85,
  reasons: ['Text match'],
  thumbnailUri: null,
  ...overrides,
});

const mockResults: AssetSearchResultItem[] = [
  createTestResult({ assetId: 'a1', assetName: 'video1.mp4', startSec: 10, endSec: 15 }),
  createTestResult({ assetId: 'a1', assetName: 'video1.mp4', startSec: 30, endSec: 35 }),
  createTestResult({ assetId: 'a2', assetName: 'video2.mp4', startSec: 5, endSec: 10 }),
  createTestResult({ assetId: 'a3', assetName: 'audio1.mp3', startSec: 0, endSec: 5 }),
];

// =============================================================================
// Mocks
// =============================================================================

const mockOnResultClick = vi.fn();
const mockOnGroupToggle = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// Tests
// =============================================================================

describe('GroupedSearchResults', () => {
  describe('Rendering', () => {
    it('renders the grouped results container', () => {
      render(
        <GroupedSearchResults
          results={mockResults}
          groupBy="asset"
          onResultClick={mockOnResultClick}
        />,
      );

      expect(screen.getByTestId('grouped-search-results')).toBeInTheDocument();
    });

    it('groups results by asset', () => {
      render(
        <GroupedSearchResults
          results={mockResults}
          groupBy="asset"
          onResultClick={mockOnResultClick}
        />,
      );

      // Should have 3 groups (a1, a2, a3)
      const groups = screen.getAllByTestId('result-group');
      expect(groups).toHaveLength(3);
    });

    it('shows asset name as group header', () => {
      render(
        <GroupedSearchResults
          results={mockResults}
          groupBy="asset"
          onResultClick={mockOnResultClick}
        />,
      );

      expect(screen.getByText('video1.mp4')).toBeInTheDocument();
      expect(screen.getByText('video2.mp4')).toBeInTheDocument();
      expect(screen.getByText('audio1.mp3')).toBeInTheDocument();
    });

    it('shows result count in group header', () => {
      render(
        <GroupedSearchResults
          results={mockResults}
          groupBy="asset"
          onResultClick={mockOnResultClick}
          showCount={true}
        />,
      );

      // video1.mp4 has 2 results
      expect(screen.getByText(/2 matches/i)).toBeInTheDocument();
    });
  });

  describe('Grouping Modes', () => {
    it('supports grouping by source', () => {
      const mixedResults: AssetSearchResultItem[] = [
        createTestResult({ assetId: 'a1', source: 'asset' }),
        createTestResult({ assetId: 'a2', source: 'transcript' }),
        createTestResult({ assetId: 'a3', source: 'transcript' }),
      ];

      render(
        <GroupedSearchResults
          results={mixedResults}
          groupBy="source"
          onResultClick={mockOnResultClick}
        />,
      );

      // Should have 2 groups (asset, transcript)
      const groups = screen.getAllByTestId('result-group');
      expect(groups).toHaveLength(2);
    });

    it('supports flat (ungrouped) mode', () => {
      render(
        <GroupedSearchResults
          results={mockResults}
          groupBy="none"
          onResultClick={mockOnResultClick}
        />,
      );

      // No group headers
      expect(screen.queryAllByTestId('result-group')).toHaveLength(0);
      // All results shown individually
      expect(screen.getAllByTestId('search-result-item')).toHaveLength(4);
    });
  });

  describe('Expand/Collapse', () => {
    it('groups are expanded by default', () => {
      render(
        <GroupedSearchResults
          results={mockResults}
          groupBy="asset"
          onResultClick={mockOnResultClick}
        />,
      );

      // All results should be visible
      expect(screen.getAllByTestId('search-result-item')).toHaveLength(4);
    });

    it('can collapse a group', async () => {
      const user = userEvent.setup();
      render(
        <GroupedSearchResults
          results={mockResults}
          groupBy="asset"
          onResultClick={mockOnResultClick}
        />,
      );

      // Click first group header to collapse
      const firstHeader = screen.getByText('video1.mp4');
      await user.click(firstHeader);

      // video1.mp4 results should be hidden (2 results)
      expect(screen.getAllByTestId('search-result-item')).toHaveLength(2);
    });

    it('can expand a collapsed group', async () => {
      const user = userEvent.setup();
      render(
        <GroupedSearchResults
          results={mockResults}
          groupBy="asset"
          defaultCollapsed={['a1']}
          onResultClick={mockOnResultClick}
        />,
      );

      // Initially video1.mp4 results hidden
      expect(screen.getAllByTestId('search-result-item')).toHaveLength(2);

      // Click to expand
      const firstHeader = screen.getByText('video1.mp4');
      await user.click(firstHeader);

      // All results should be visible
      expect(screen.getAllByTestId('search-result-item')).toHaveLength(4);
    });

    it('calls onGroupToggle when expanding/collapsing', async () => {
      const user = userEvent.setup();
      render(
        <GroupedSearchResults
          results={mockResults}
          groupBy="asset"
          onResultClick={mockOnResultClick}
          onGroupToggle={mockOnGroupToggle}
        />,
      );

      const firstHeader = screen.getByText('video1.mp4');
      await user.click(firstHeader);

      expect(mockOnGroupToggle).toHaveBeenCalledWith('a1', false);
    });
  });

  describe('Result Clicks', () => {
    it('calls onResultClick when a result is clicked', async () => {
      const user = userEvent.setup();
      render(
        <GroupedSearchResults
          results={mockResults}
          groupBy="asset"
          onResultClick={mockOnResultClick}
        />,
      );

      const results = screen.getAllByTestId('search-result-item');
      await user.click(results[0]);

      expect(mockOnResultClick).toHaveBeenCalledWith(expect.objectContaining({ assetId: 'a1' }));
    });
  });

  describe('Empty State', () => {
    it('shows empty message when no results', () => {
      render(
        <GroupedSearchResults
          results={[]}
          groupBy="asset"
          onResultClick={mockOnResultClick}
          emptyMessage="No matches found"
        />,
      );

      expect(screen.getByText('No matches found')).toBeInTheDocument();
    });
  });

  describe('Sorting', () => {
    it('sorts groups by match count when specified', () => {
      render(
        <GroupedSearchResults
          results={mockResults}
          groupBy="asset"
          sortGroups="count"
          onResultClick={mockOnResultClick}
        />,
      );

      // video1.mp4 has most matches, should be first
      const groups = screen.getAllByTestId('result-group');
      expect(groups[0]).toHaveTextContent('video1.mp4');
    });

    it('sorts groups alphabetically when specified', () => {
      render(
        <GroupedSearchResults
          results={mockResults}
          groupBy="asset"
          sortGroups="name"
          onResultClick={mockOnResultClick}
        />,
      );

      const groups = screen.getAllByTestId('result-group');
      expect(groups[0]).toHaveTextContent('audio1.mp3');
    });
  });

  describe('Accessibility', () => {
    it('group headers are keyboard accessible', async () => {
      const user = userEvent.setup();
      render(
        <GroupedSearchResults
          results={mockResults}
          groupBy="asset"
          onResultClick={mockOnResultClick}
        />,
      );

      const firstHeader = screen.getByRole('button', { name: 'video1.mp4' });
      firstHeader.focus();
      await user.keyboard('{Enter}');

      // Should be collapsed
      expect(screen.getAllByTestId('search-result-item')).toHaveLength(2);
    });

    it('has proper ARIA attributes', () => {
      render(
        <GroupedSearchResults
          results={mockResults}
          groupBy="asset"
          onResultClick={mockOnResultClick}
        />,
      );

      const groups = screen.getAllByTestId('result-group');
      groups.forEach((group) => {
        expect(group.querySelector('[aria-expanded]')).toBeInTheDocument();
      });
    });
  });
});
