/**
 * BlendModePicker Tests
 *
 * Tests for the blend mode picker component.
 * Following TDD methodology.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BlendModePicker } from './BlendModePicker';
import type { BlendMode } from '@/types';

describe('BlendModePicker', () => {
  const defaultProps = {
    value: 'normal' as BlendMode,
    onChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render the current blend mode', () => {
      render(<BlendModePicker {...defaultProps} />);

      expect(screen.getByText('Normal')).toBeInTheDocument();
    });

    it('should render with different blend modes', () => {
      render(<BlendModePicker {...defaultProps} value="multiply" />);

      expect(screen.getByText('Multiply')).toBeInTheDocument();
    });

    it('should render a dropdown button', () => {
      render(<BlendModePicker {...defaultProps} />);

      const button = screen.getByRole('button');
      expect(button).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(<BlendModePicker {...defaultProps} className="custom-class" />);

      const container = screen.getByTestId('blend-mode-picker');
      expect(container).toHaveClass('custom-class');
    });
  });

  describe('dropdown interaction', () => {
    it('should open dropdown when clicked', async () => {
      render(<BlendModePicker {...defaultProps} />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    it('should show all blend mode options when open', async () => {
      render(<BlendModePicker {...defaultProps} />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      const listbox = screen.getByRole('listbox');
      expect(within(listbox).getByText('Normal')).toBeInTheDocument();
      expect(within(listbox).getByText('Multiply')).toBeInTheDocument();
      expect(within(listbox).getByText('Screen')).toBeInTheDocument();
      expect(within(listbox).getByText('Overlay')).toBeInTheDocument();
      expect(within(listbox).getByText('Add')).toBeInTheDocument();
    });

    it('should close dropdown when option is selected', async () => {
      render(<BlendModePicker {...defaultProps} />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      const multiplyOption = screen.getByRole('option', { name: /multiply/i });
      await userEvent.click(multiplyOption);

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('should close dropdown when clicking outside', async () => {
      render(
        <div>
          <BlendModePicker {...defaultProps} />
          <div data-testid="outside">Outside</div>
        </div>
      );

      const button = screen.getByRole('button');
      await userEvent.click(button);

      expect(screen.getByRole('listbox')).toBeInTheDocument();

      await userEvent.click(screen.getByTestId('outside'));

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('should close dropdown on Escape key', async () => {
      render(<BlendModePicker {...defaultProps} />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      expect(screen.getByRole('listbox')).toBeInTheDocument();

      fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  });

  describe('selection', () => {
    it('should call onChange when option is selected', async () => {
      const onChange = vi.fn();
      render(<BlendModePicker {...defaultProps} onChange={onChange} />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      const screenOption = screen.getByRole('option', { name: /screen/i });
      await userEvent.click(screenOption);

      expect(onChange).toHaveBeenCalledWith('screen');
    });

    it('should highlight the currently selected option', async () => {
      render(<BlendModePicker {...defaultProps} value="overlay" />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      const overlayOption = screen.getByRole('option', { name: /overlay/i });
      expect(overlayOption).toHaveAttribute('aria-selected', 'true');
    });

    it('should not call onChange when same option is selected', async () => {
      const onChange = vi.fn();
      render(<BlendModePicker {...defaultProps} onChange={onChange} />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      const normalOption = screen.getByRole('option', { name: /normal/i });
      await userEvent.click(normalOption);

      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('disabled state', () => {
    it('should not open dropdown when disabled', async () => {
      render(<BlendModePicker {...defaultProps} disabled />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('should show disabled styling', () => {
      render(<BlendModePicker {...defaultProps} disabled />);

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });
  });

  describe('compact mode', () => {
    it('should render in compact mode when specified', () => {
      render(<BlendModePicker {...defaultProps} compact />);

      const container = screen.getByTestId('blend-mode-picker');
      expect(container).toHaveClass('compact');
    });
  });

  describe('labels', () => {
    it('should show label when provided', () => {
      render(<BlendModePicker {...defaultProps} label="Track Blend" />);

      expect(screen.getByText('Track Blend')).toBeInTheDocument();
    });

    it('should not show label when not provided', () => {
      render(<BlendModePicker {...defaultProps} />);

      expect(screen.queryByText('Track Blend')).not.toBeInTheDocument();
    });
  });

  describe('tooltips', () => {
    it('should show description on option hover', async () => {
      render(<BlendModePicker {...defaultProps} showDescriptions />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      const multiplyOption = screen.getByRole('option', { name: /multiply/i });
      expect(multiplyOption).toHaveAttribute('title');
    });
  });

  describe('accessibility', () => {
    it('should have proper ARIA attributes on button', () => {
      render(<BlendModePicker {...defaultProps} />);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-haspopup', 'listbox');
    });

    it('should have proper ARIA attributes when open', async () => {
      render(<BlendModePicker {...defaultProps} />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      expect(button).toHaveAttribute('aria-expanded', 'true');
    });

    it('should support keyboard navigation', async () => {
      render(<BlendModePicker {...defaultProps} />);

      const button = screen.getByRole('button');
      button.focus();

      // Open with Enter
      fireEvent.keyDown(button, { key: 'Enter' });
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });
  });

  describe('grouped display', () => {
    it('should show category headers when grouped', async () => {
      render(<BlendModePicker {...defaultProps} grouped />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      expect(screen.getByTestId('blend-category-basic')).toBeInTheDocument();
      expect(screen.getByTestId('blend-category-darken')).toBeInTheDocument();
      expect(screen.getByTestId('blend-category-lighten')).toBeInTheDocument();
      expect(screen.getByTestId('blend-category-contrast')).toBeInTheDocument();
    });

    it('should show all 19 blend modes in grouped view', async () => {
      render(<BlendModePicker {...defaultProps} grouped />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      const listbox = screen.getByRole('listbox');
      const options = within(listbox).getAllByRole('option');
      expect(options.length).toBe(19);
    });

    it('should collapse a category when header is clicked', async () => {
      render(<BlendModePicker {...defaultProps} grouped />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      // Darken category should have modes visible
      expect(screen.getByTestId('blend-option-multiply')).toBeInTheDocument();

      // Click darken category header to collapse
      await userEvent.click(screen.getByTestId('blend-category-darken'));

      // Multiply is in the darken category - should be hidden
      expect(screen.queryByTestId('blend-option-multiply')).not.toBeInTheDocument();
    });

    it('should expand a collapsed category when header is clicked again', async () => {
      render(<BlendModePicker {...defaultProps} grouped />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      // Collapse then expand
      await userEvent.click(screen.getByTestId('blend-category-darken'));
      expect(screen.queryByTestId('blend-option-multiply')).not.toBeInTheDocument();

      await userEvent.click(screen.getByTestId('blend-category-darken'));
      expect(screen.getByTestId('blend-option-multiply')).toBeInTheDocument();
    });
  });

  describe('search filter', () => {
    it('should show search input when grouped', async () => {
      render(<BlendModePicker {...defaultProps} grouped />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      expect(screen.getByTestId('blend-mode-search')).toBeInTheDocument();
    });

    it('should not show search input when not grouped', async () => {
      render(<BlendModePicker {...defaultProps} />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      expect(screen.queryByTestId('blend-mode-search')).not.toBeInTheDocument();
    });

    it('should filter modes by search query', async () => {
      render(<BlendModePicker {...defaultProps} grouped />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      const searchInput = screen.getByTestId('blend-mode-search');
      await userEvent.type(searchInput, 'burn');

      // Should show Color Burn and Linear Burn
      expect(screen.getByTestId('blend-option-color_burn')).toBeInTheDocument();
      expect(screen.getByTestId('blend-option-linear_burn')).toBeInTheDocument();

      // Should not show unrelated modes
      expect(screen.queryByTestId('blend-option-screen')).not.toBeInTheDocument();
    });

    it('should show empty state when no modes match search', async () => {
      render(<BlendModePicker {...defaultProps} grouped />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      const searchInput = screen.getByTestId('blend-mode-search');
      await userEvent.type(searchInput, 'nonexistent');

      expect(screen.getByText('No matching blend modes')).toBeInTheDocument();
    });

    it('should clear search when dropdown closes', async () => {
      render(<BlendModePicker {...defaultProps} grouped />);

      const button = screen.getByRole('button');
      await userEvent.click(button);

      const searchInput = screen.getByTestId('blend-mode-search');
      await userEvent.type(searchInput, 'burn');

      // Close dropdown
      fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });

      // Reopen
      await userEvent.click(button);

      // Search should be cleared
      const newSearchInput = screen.getByTestId('blend-mode-search') as HTMLInputElement;
      expect(newSearchInput.value).toBe('');
    });
  });
});
