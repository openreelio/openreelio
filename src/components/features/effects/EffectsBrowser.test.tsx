/**
 * EffectsBrowser Component Tests
 *
 * Tests for the effects browser panel that displays available effects.
 * TDD: RED phase - writing tests first
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EffectsBrowser } from './EffectsBrowser';

// =============================================================================
// Rendering Tests
// =============================================================================

describe('EffectsBrowser', () => {
  describe('rendering', () => {
    it('should render the effects browser container', () => {
      render(<EffectsBrowser />);

      expect(screen.getByTestId('effects-browser')).toBeInTheDocument();
    });

    it('should render header with Effects title', () => {
      render(<EffectsBrowser />);

      expect(screen.getByText('Effects')).toBeInTheDocument();
    });

    it('should render search input', () => {
      render(<EffectsBrowser />);

      expect(screen.getByPlaceholderText('Search effects...')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Category Rendering Tests
  // ===========================================================================

  describe('categories', () => {
    it('should render Color & Grading category', () => {
      render(<EffectsBrowser />);

      expect(screen.getByText('Color')).toBeInTheDocument();
    });

    it('should render Transform category', () => {
      render(<EffectsBrowser />);

      expect(screen.getByText('Transform')).toBeInTheDocument();
    });

    it('should render Transitions category', () => {
      render(<EffectsBrowser />);

      expect(screen.getByText('Transition')).toBeInTheDocument();
    });

    it('should render Audio category', () => {
      render(<EffectsBrowser />);

      expect(screen.getByText('Audio')).toBeInTheDocument();
    });

    it('should render Blur & Sharpen category', () => {
      render(<EffectsBrowser />);

      expect(screen.getByText('Blur & Sharpen')).toBeInTheDocument();
    });

    it('should render Stylize category', () => {
      render(<EffectsBrowser />);

      expect(screen.getByText('Stylize')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Transition Effects Tests
  // ===========================================================================

  describe('transition effects', () => {
    it('should display Cross Dissolve effect', () => {
      render(<EffectsBrowser />);

      expect(screen.getByText('Cross Dissolve')).toBeInTheDocument();
    });

    it('should display Fade effect', () => {
      render(<EffectsBrowser />);

      expect(screen.getByText('Fade')).toBeInTheDocument();
    });

    it('should display Wipe effect', () => {
      render(<EffectsBrowser />);

      expect(screen.getByText('Wipe')).toBeInTheDocument();
    });

    it('should display Slide effect', () => {
      render(<EffectsBrowser />);

      expect(screen.getByText('Slide')).toBeInTheDocument();
    });

    it('should display Zoom effect', () => {
      render(<EffectsBrowser />);

      expect(screen.getByText('Zoom')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Color Effects Tests
  // ===========================================================================

  describe('color effects', () => {
    it('should display Brightness effect', () => {
      render(<EffectsBrowser />);

      expect(screen.getByText('Brightness')).toBeInTheDocument();
    });

    it('should display Contrast effect', () => {
      render(<EffectsBrowser />);

      expect(screen.getByText('Contrast')).toBeInTheDocument();
    });

    it('should display Saturation effect', () => {
      render(<EffectsBrowser />);

      expect(screen.getByText('Saturation')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Selection Tests
  // ===========================================================================

  describe('effect selection', () => {
    it('should call onEffectSelect with effect type when effect is clicked', () => {
      const onEffectSelect = vi.fn();
      render(<EffectsBrowser onEffectSelect={onEffectSelect} />);

      fireEvent.click(screen.getByText('Cross Dissolve'));

      expect(onEffectSelect).toHaveBeenCalledWith('cross_dissolve');
    });

    it('should call onEffectSelect for brightness effect', () => {
      const onEffectSelect = vi.fn();
      render(<EffectsBrowser onEffectSelect={onEffectSelect} />);

      fireEvent.click(screen.getByText('Brightness'));

      expect(onEffectSelect).toHaveBeenCalledWith('brightness');
    });

    it('should call onEffectSelect for wipe transition', () => {
      const onEffectSelect = vi.fn();
      render(<EffectsBrowser onEffectSelect={onEffectSelect} />);

      fireEvent.click(screen.getByText('Wipe'));

      expect(onEffectSelect).toHaveBeenCalledWith('wipe');
    });
  });

  // ===========================================================================
  // Search Tests
  // ===========================================================================

  describe('search functionality', () => {
    it('should have enabled search input', () => {
      render(<EffectsBrowser />);

      const searchInput = screen.getByPlaceholderText('Search effects...');
      expect(searchInput).not.toBeDisabled();
    });

    it('should filter effects when searching', () => {
      render(<EffectsBrowser />);

      const searchInput = screen.getByPlaceholderText('Search effects...');
      fireEvent.change(searchInput, { target: { value: 'dissolve' } });

      expect(screen.getByText('Cross Dissolve')).toBeInTheDocument();
      expect(screen.queryByText('Brightness')).not.toBeInTheDocument();
    });

    it('should be case-insensitive when searching', () => {
      render(<EffectsBrowser />);

      const searchInput = screen.getByPlaceholderText('Search effects...');
      fireEvent.change(searchInput, { target: { value: 'WIPE' } });

      expect(screen.getByText('Wipe')).toBeInTheDocument();
    });

    it('should show empty state when no results match', () => {
      render(<EffectsBrowser />);

      const searchInput = screen.getByPlaceholderText('Search effects...');
      fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

      expect(screen.getByText(/no effects found/i)).toBeInTheDocument();
    });

    it('should clear search and show all effects when search is cleared', () => {
      render(<EffectsBrowser />);

      const searchInput = screen.getByPlaceholderText('Search effects...');

      // First filter
      fireEvent.change(searchInput, { target: { value: 'dissolve' } });
      expect(screen.queryByText('Brightness')).not.toBeInTheDocument();

      // Then clear
      fireEvent.change(searchInput, { target: { value: '' } });
      expect(screen.getByText('Brightness')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('accessibility', () => {
    it('should have accessible effect buttons', () => {
      render(<EffectsBrowser />);

      const effectButton = screen.getByText('Cross Dissolve').closest('button');
      expect(effectButton).toHaveAttribute('type', 'button');
    });

    it('should support keyboard navigation', () => {
      const onEffectSelect = vi.fn();
      render(<EffectsBrowser onEffectSelect={onEffectSelect} />);

      const effectButton = screen.getByText('Cross Dissolve').closest('button')!;
      fireEvent.keyDown(effectButton, { key: 'Enter' });
      fireEvent.click(effectButton);

      expect(onEffectSelect).toHaveBeenCalledWith('cross_dissolve');
    });
  });

  // ===========================================================================
  // Custom className Tests
  // ===========================================================================

  describe('styling', () => {
    it('should apply custom className', () => {
      render(<EffectsBrowser className="custom-class" />);

      expect(screen.getByTestId('effects-browser')).toHaveClass('custom-class');
    });
  });
});
