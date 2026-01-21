/**
 * SearchPanel Component Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SearchPanel } from './SearchPanel';

// =============================================================================
// Mocks
// =============================================================================

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { invoke } from '@tauri-apps/api/core';

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

// =============================================================================
// Test Data
// =============================================================================

const mockSearchResponse = {
  results: [
    {
      assetId: 'asset_001',
      assetName: 'Interview.mp4',
      startSec: 10.5,
      endSec: 15.0,
      score: 0.95,
      reasons: ['Transcript match: "hello"'],
      thumbnailUri: '/thumb.jpg',
      source: 'transcript',
    },
    {
      assetId: 'asset_002',
      assetName: 'B-roll.mp4',
      startSec: 0.0,
      endSec: 5.0,
      score: 0.75,
      reasons: ['Shot: outdoor'],
      thumbnailUri: null,
      source: 'shot',
    },
  ],
  total: 2,
  processingTimeMs: 12,
};

// =============================================================================
// Tests
// =============================================================================

describe('SearchPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render when isOpen is true', () => {
      render(<SearchPanel isOpen={true} onClose={vi.fn()} />);

      expect(screen.getByTestId('search-panel')).toBeInTheDocument();
    });

    it('should not render when isOpen is false', () => {
      render(<SearchPanel isOpen={false} onClose={vi.fn()} />);

      expect(screen.queryByTestId('search-panel')).not.toBeInTheDocument();
    });

    it('should render search bar', () => {
      render(<SearchPanel isOpen={true} onClose={vi.fn()} />);

      expect(screen.getByRole('searchbox')).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(<SearchPanel isOpen={true} onClose={vi.fn()} className="custom-class" />);

      expect(screen.getByTestId('search-panel')).toHaveClass('custom-class');
    });

    it('should render title', () => {
      render(<SearchPanel isOpen={true} onClose={vi.fn()} title="Search Assets" />);

      expect(screen.getByText('Search Assets')).toBeInTheDocument();
    });

    it('should render close button', () => {
      render(<SearchPanel isOpen={true} onClose={vi.fn()} />);

      expect(screen.getByTestId('search-panel-close')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Search Flow Tests
  // ===========================================================================

  describe('search flow', () => {
    it('should show empty state initially', () => {
      render(<SearchPanel isOpen={true} onClose={vi.fn()} />);

      expect(screen.getByText('Type to search assets and transcripts')).toBeInTheDocument();
    });

    it('should perform search when typing', async () => {
      mockInvoke.mockResolvedValueOnce(mockSearchResponse);

      render(<SearchPanel isOpen={true} onClose={vi.fn()} />);

      const input = screen.getByRole('searchbox');
      fireEvent.change(input, { target: { value: 'hello' } });

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('search_assets', expect.any(Object));
      });
    });

    it('should display search results', async () => {
      mockInvoke.mockResolvedValueOnce(mockSearchResponse);

      render(<SearchPanel isOpen={true} onClose={vi.fn()} />);

      const input = screen.getByRole('searchbox');
      fireEvent.change(input, { target: { value: 'hello' } });

      await waitFor(() => {
        expect(screen.getByText('Interview.mp4')).toBeInTheDocument();
        expect(screen.getByText('B-roll.mp4')).toBeInTheDocument();
      });
    });

    it('should show no results message when search returns empty', async () => {
      mockInvoke.mockResolvedValueOnce({
        results: [],
        total: 0,
        processingTimeMs: 5,
      });

      render(<SearchPanel isOpen={true} onClose={vi.fn()} />);

      const input = screen.getByRole('searchbox');
      fireEvent.change(input, { target: { value: 'nonexistent' } });

      await waitFor(() => {
        expect(screen.getByText('No results found')).toBeInTheDocument();
      });
    });

    it('should show error message on search failure', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Search failed'));

      render(<SearchPanel isOpen={true} onClose={vi.fn()} />);

      const input = screen.getByRole('searchbox');
      fireEvent.change(input, { target: { value: 'hello' } });

      await waitFor(() => {
        expect(screen.getByText('Search failed')).toBeInTheDocument();
      });
    });
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  describe('user interaction', () => {
    it('should call onClose when close button is clicked', () => {
      const onClose = vi.fn();
      render(<SearchPanel isOpen={true} onClose={onClose} />);

      fireEvent.click(screen.getByTestId('search-panel-close'));

      expect(onClose).toHaveBeenCalled();
    });

    it('should call onClose when Escape is pressed', () => {
      const onClose = vi.fn();
      render(<SearchPanel isOpen={true} onClose={onClose} />);

      fireEvent.keyDown(screen.getByTestId('search-panel'), { key: 'Escape' });

      expect(onClose).toHaveBeenCalled();
    });

    it('should call onResultSelect when a result is clicked', async () => {
      mockInvoke.mockResolvedValueOnce(mockSearchResponse);
      const onResultSelect = vi.fn();

      render(<SearchPanel isOpen={true} onClose={vi.fn()} onResultSelect={onResultSelect} />);

      const input = screen.getByRole('searchbox');
      fireEvent.change(input, { target: { value: 'hello' } });

      await waitFor(() => {
        expect(screen.getByText('Interview.mp4')).toBeInTheDocument();
      });

      const result = screen.getByText('Interview.mp4').closest('[data-testid="search-result-item"]');
      fireEvent.click(result!);

      expect(onResultSelect).toHaveBeenCalledWith(mockSearchResponse.results[0]);
    });

    it('should have focusable search input', () => {
      render(<SearchPanel isOpen={true} onClose={vi.fn()} />);

      const input = screen.getByRole('searchbox');

      // Verify input can receive focus (manual focus works)
      input.focus();
      expect(document.activeElement).toBe(input);
    });
  });

  // ===========================================================================
  // Backdrop Tests
  // ===========================================================================

  describe('backdrop', () => {
    it('should render backdrop when showBackdrop is true', () => {
      render(<SearchPanel isOpen={true} onClose={vi.fn()} showBackdrop />);

      expect(screen.getByTestId('search-panel-backdrop')).toBeInTheDocument();
    });

    it('should call onClose when backdrop is clicked', () => {
      const onClose = vi.fn();
      render(<SearchPanel isOpen={true} onClose={onClose} showBackdrop />);

      fireEvent.click(screen.getByTestId('search-panel-backdrop'));

      expect(onClose).toHaveBeenCalled();
    });
  });
});
