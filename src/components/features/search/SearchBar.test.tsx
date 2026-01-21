/**
 * SearchBar Component Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchBar } from './SearchBar';

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

// =============================================================================
// Tests
// =============================================================================

describe('SearchBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render search input', () => {
      render(<SearchBar />);

      const input = screen.getByRole('searchbox');
      expect(input).toBeInTheDocument();
    });

    it('should render with placeholder text', () => {
      render(<SearchBar placeholder="Search assets..." />);

      const input = screen.getByPlaceholderText('Search assets...');
      expect(input).toBeInTheDocument();
    });

    it('should render search icon', () => {
      render(<SearchBar />);

      const icon = screen.getByTestId('search-icon');
      expect(icon).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(<SearchBar className="custom-class" />);

      const container = screen.getByTestId('search-bar');
      expect(container).toHaveClass('custom-class');
    });

    it('should render with default placeholder when not provided', () => {
      render(<SearchBar />);

      const input = screen.getByPlaceholderText('Search...');
      expect(input).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  describe('user interaction', () => {
    it('should update input value on typing', async () => {
      const user = userEvent.setup();
      render(<SearchBar />);

      const input = screen.getByRole('searchbox');
      await user.type(input, 'test query');

      expect(input).toHaveValue('test query');
    });

    it('should call onSearch when input changes', async () => {
      vi.useFakeTimers();
      const onSearch = vi.fn();

      render(<SearchBar onSearch={onSearch} debounceMs={300} />);

      const input = screen.getByRole('searchbox');
      fireEvent.change(input, { target: { value: 'test' } });

      // Should not have been called yet (waiting for debounce)
      expect(onSearch).not.toHaveBeenCalled();

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(350);

      expect(onSearch).toHaveBeenCalledWith('test');

      vi.useRealTimers();
    });

    it('should debounce search calls', async () => {
      vi.useFakeTimers();
      const onSearch = vi.fn();

      render(<SearchBar onSearch={onSearch} debounceMs={300} />);

      const input = screen.getByRole('searchbox');

      // Type multiple characters quickly
      fireEvent.change(input, { target: { value: 'a' } });
      fireEvent.change(input, { target: { value: 'ab' } });
      fireEvent.change(input, { target: { value: 'abc' } });

      // Should not have been called yet
      expect(onSearch).not.toHaveBeenCalled();

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(350);

      // Should only be called once with final value
      expect(onSearch).toHaveBeenCalledTimes(1);
      expect(onSearch).toHaveBeenCalledWith('abc');

      vi.useRealTimers();
    });

    it('should clear input when clear button is clicked', () => {
      const onClear = vi.fn();

      render(<SearchBar onClear={onClear} />);

      const input = screen.getByRole('searchbox');
      fireEvent.change(input, { target: { value: 'test' } });

      expect(input).toHaveValue('test');

      const clearButton = screen.getByTestId('search-clear-button');
      fireEvent.click(clearButton);

      expect(input).toHaveValue('');
      expect(onClear).toHaveBeenCalled();
    });

    it('should not show clear button when input is empty', () => {
      render(<SearchBar />);

      const clearButton = screen.queryByTestId('search-clear-button');
      expect(clearButton).not.toBeInTheDocument();
    });

    it('should show clear button when input has value', () => {
      render(<SearchBar />);

      const input = screen.getByRole('searchbox');
      fireEvent.change(input, { target: { value: 'test' } });

      const clearButton = screen.getByTestId('search-clear-button');
      expect(clearButton).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Focus/Blur Tests
  // ===========================================================================

  describe('focus behavior', () => {
    it('should call onFocus when input is focused', async () => {
      const onFocus = vi.fn();
      render(<SearchBar onFocus={onFocus} />);

      const input = screen.getByRole('searchbox');
      fireEvent.focus(input);

      expect(onFocus).toHaveBeenCalled();
    });

    it('should call onBlur when input loses focus', async () => {
      const onBlur = vi.fn();
      render(<SearchBar onBlur={onBlur} />);

      const input = screen.getByRole('searchbox');
      fireEvent.focus(input);
      fireEvent.blur(input);

      expect(onBlur).toHaveBeenCalled();
    });

    it('should apply focused styles when focused', async () => {
      render(<SearchBar />);

      const container = screen.getByTestId('search-bar');
      const input = screen.getByRole('searchbox');

      expect(container).not.toHaveAttribute('data-focused', 'true');

      fireEvent.focus(input);

      expect(container).toHaveAttribute('data-focused', 'true');
    });
  });

  // ===========================================================================
  // Keyboard Shortcuts Tests
  // ===========================================================================

  describe('keyboard shortcuts', () => {
    it('should submit search on Enter key', () => {
      const onSubmit = vi.fn();

      render(<SearchBar onSubmit={onSubmit} />);

      const input = screen.getByRole('searchbox');
      fireEvent.change(input, { target: { value: 'test' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onSubmit).toHaveBeenCalledWith('test');
    });

    it('should clear input on Escape key', () => {
      const onClear = vi.fn();

      render(<SearchBar onClear={onClear} />);

      const input = screen.getByRole('searchbox');
      fireEvent.change(input, { target: { value: 'test' } });
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(input).toHaveValue('');
      expect(onClear).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Loading State Tests
  // ===========================================================================

  describe('loading state', () => {
    it('should show loading indicator when isLoading is true', () => {
      render(<SearchBar isLoading={true} />);

      const loadingIndicator = screen.getByTestId('search-loading');
      expect(loadingIndicator).toBeInTheDocument();
    });

    it('should not show loading indicator when isLoading is false', () => {
      render(<SearchBar isLoading={false} />);

      const loadingIndicator = screen.queryByTestId('search-loading');
      expect(loadingIndicator).not.toBeInTheDocument();
    });

    it('should disable input when disabled prop is true', () => {
      render(<SearchBar disabled={true} />);

      const input = screen.getByRole('searchbox');
      expect(input).toBeDisabled();
    });
  });

  // ===========================================================================
  // Controlled Value Tests
  // ===========================================================================

  describe('controlled value', () => {
    it('should use controlled value when provided', () => {
      render(<SearchBar value="controlled value" />);

      const input = screen.getByRole('searchbox');
      expect(input).toHaveValue('controlled value');
    });

    it('should call onChange when controlled value changes', () => {
      const onChange = vi.fn();

      render(<SearchBar value="" onChange={onChange} />);

      const input = screen.getByRole('searchbox');
      fireEvent.change(input, { target: { value: 'a' } });

      expect(onChange).toHaveBeenCalledWith('a');
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('accessibility', () => {
    it('should have proper ARIA attributes', () => {
      render(<SearchBar aria-label="Search assets" />);

      const input = screen.getByRole('searchbox');
      expect(input).toHaveAttribute('aria-label', 'Search assets');
    });

    it('should have search role', () => {
      render(<SearchBar />);

      const input = screen.getByRole('searchbox');
      expect(input).toBeInTheDocument();
    });

    it('should associate label with input when provided', () => {
      render(<SearchBar id="search-input" label="Search" />);

      const input = screen.getByLabelText('Search');
      expect(input).toBeInTheDocument();
    });
  });
});
