/**
 * SearchFilters Component Tests
 *
 * Tests for search filter controls.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchFilters } from './SearchFilters';

// =============================================================================
// Mocks
// =============================================================================

const mockOnChange = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// Tests
// =============================================================================

describe('SearchFilters', () => {
  describe('Rendering', () => {
    it('renders filter controls', () => {
      render(<SearchFilters filters={{}} onChange={mockOnChange} />);

      expect(screen.getByTestId('search-filters')).toBeInTheDocument();
    });

    it('shows asset type filter', () => {
      render(<SearchFilters filters={{}} onChange={mockOnChange} />);

      expect(screen.getByLabelText(/type/i)).toBeInTheDocument();
    });

    it('shows language filter', () => {
      render(<SearchFilters filters={{}} onChange={mockOnChange} />);

      expect(screen.getByLabelText(/language/i)).toBeInTheDocument();
    });

    it('shows source filter for transcript search', () => {
      render(
        <SearchFilters
          filters={{}}
          onChange={mockOnChange}
          showTranscriptFilters={true}
        />
      );

      expect(screen.getByLabelText(/source/i)).toBeInTheDocument();
    });
  });

  describe('Asset Type Filter', () => {
    it('includes all type option', () => {
      render(<SearchFilters filters={{}} onChange={mockOnChange} />);

      const typeSelect = screen.getByLabelText(/type/i);
      const options = Array.from((typeSelect as HTMLSelectElement).options);

      expect(options.some((o) => o.value === 'all')).toBe(true);
    });

    it('includes video, audio, image types', () => {
      render(<SearchFilters filters={{}} onChange={mockOnChange} />);

      const typeSelect = screen.getByLabelText(/type/i);
      const options = Array.from((typeSelect as HTMLSelectElement).options);

      expect(options.map((o) => o.value)).toContain('video');
      expect(options.map((o) => o.value)).toContain('audio');
      expect(options.map((o) => o.value)).toContain('image');
    });

    it('calls onChange when type changes', async () => {
      const user = userEvent.setup();
      render(<SearchFilters filters={{}} onChange={mockOnChange} />);

      await user.selectOptions(screen.getByLabelText(/type/i), 'video');

      expect(mockOnChange).toHaveBeenCalledWith(
        expect.objectContaining({ assetType: 'video' })
      );
    });

    it('shows current filter value', () => {
      render(
        <SearchFilters filters={{ assetType: 'audio' }} onChange={mockOnChange} />
      );

      expect(screen.getByLabelText(/type/i)).toHaveValue('audio');
    });
  });

  describe('Language Filter', () => {
    it('includes common languages', () => {
      render(<SearchFilters filters={{}} onChange={mockOnChange} />);

      const langSelect = screen.getByLabelText(/language/i);
      const options = Array.from((langSelect as HTMLSelectElement).options);
      const values = options.map((o) => o.value);

      expect(values).toContain('en');
      expect(values).toContain('ko');
      expect(values).toContain('ja');
    });

    it('calls onChange when language changes', async () => {
      const user = userEvent.setup();
      render(<SearchFilters filters={{}} onChange={mockOnChange} />);

      await user.selectOptions(screen.getByLabelText(/language/i), 'ko');

      expect(mockOnChange).toHaveBeenCalledWith(
        expect.objectContaining({ language: 'ko' })
      );
    });
  });

  describe('Source Filter', () => {
    it('shows transcript and asset sources', () => {
      render(
        <SearchFilters
          filters={{}}
          onChange={mockOnChange}
          showTranscriptFilters={true}
        />
      );

      const sourceSelect = screen.getByLabelText(/source/i);
      const options = Array.from((sourceSelect as HTMLSelectElement).options);
      const values = options.map((o) => o.value);

      expect(values).toContain('transcript');
      expect(values).toContain('asset');
    });

    it('calls onChange when source changes', async () => {
      const user = userEvent.setup();
      render(
        <SearchFilters
          filters={{}}
          onChange={mockOnChange}
          showTranscriptFilters={true}
        />
      );

      await user.selectOptions(screen.getByLabelText(/source/i), 'transcript');

      expect(mockOnChange).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'transcript' })
      );
    });
  });

  describe('Clear Filters', () => {
    it('shows clear button when filters are active', () => {
      render(
        <SearchFilters
          filters={{ assetType: 'video', language: 'en' }}
          onChange={mockOnChange}
        />
      );

      expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument();
    });

    it('does not show clear button when no filters are active', () => {
      render(<SearchFilters filters={{}} onChange={mockOnChange} />);

      expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();
    });

    it('calls onChange with empty object when clear is clicked', async () => {
      const user = userEvent.setup();
      render(
        <SearchFilters
          filters={{ assetType: 'video' }}
          onChange={mockOnChange}
        />
      );

      await user.click(screen.getByRole('button', { name: /clear/i }));

      expect(mockOnChange).toHaveBeenCalledWith({});
    });
  });

  describe('Compact Mode', () => {
    it('renders in compact mode when specified', () => {
      render(
        <SearchFilters filters={{}} onChange={mockOnChange} compact={true} />
      );

      const container = screen.getByTestId('search-filters');
      expect(container.className).toContain('gap-1');
    });
  });

  describe('Active Filter Count', () => {
    it('shows count of active filters', () => {
      render(
        <SearchFilters
          filters={{ assetType: 'video', language: 'en' }}
          onChange={mockOnChange}
          showFilterCount={true}
        />
      );

      expect(screen.getByText(/2 filters/i)).toBeInTheDocument();
    });

    it('shows singular form for one filter', () => {
      render(
        <SearchFilters
          filters={{ assetType: 'video' }}
          onChange={mockOnChange}
          showFilterCount={true}
        />
      );

      expect(screen.getByText(/1 filter/i)).toBeInTheDocument();
    });
  });
});
