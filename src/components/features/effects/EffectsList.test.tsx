/**
 * EffectsList Component Tests
 *
 * Tests for the effects list component that displays effects applied to a clip.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EffectsList } from './EffectsList';
import type { Effect } from '@/types';

// =============================================================================
// Test Data
// =============================================================================

const mockEffects: Effect[] = [
  {
    id: 'effect_001',
    effectType: 'brightness',
    enabled: true,
    params: { value: 0.2 },
    keyframes: {},
    order: 0,
  },
  {
    id: 'effect_002',
    effectType: 'gaussian_blur',
    enabled: false,
    params: { radius: 10 },
    keyframes: {},
    order: 1,
  },
  {
    id: 'effect_003',
    effectType: 'volume',
    enabled: true,
    params: { level: 0.8 },
    keyframes: {},
    order: 2,
  },
];

// =============================================================================
// Tests
// =============================================================================

describe('EffectsList', () => {
  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render empty state when no effects', () => {
      render(<EffectsList effects={[]} />);

      expect(screen.getByText(/no effects applied/i)).toBeInTheDocument();
    });

    it('should render list of effects', () => {
      render(<EffectsList effects={mockEffects} />);

      expect(screen.getByText('Brightness')).toBeInTheDocument();
      expect(screen.getByText('Gaussian Blur')).toBeInTheDocument();
      expect(screen.getByText('Volume')).toBeInTheDocument();
    });

    it('should show effect count in header', () => {
      render(<EffectsList effects={mockEffects} />);

      expect(screen.getByText(/effects/i)).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('should show disabled indicator for disabled effects', () => {
      render(<EffectsList effects={mockEffects} />);

      // Gaussian Blur is disabled
      const blurItem = screen.getByTestId('effect-item-effect_002');
      expect(blurItem).toHaveClass('opacity-50');
    });

    it('should show audio icon for audio effects', () => {
      render(<EffectsList effects={mockEffects} />);

      const volumeItem = screen.getByTestId('effect-item-effect_003');
      expect(volumeItem.querySelector('[data-testid="audio-icon"]')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Selection Tests
  // ===========================================================================

  describe('selection', () => {
    it('should highlight selected effect', () => {
      render(<EffectsList effects={mockEffects} selectedEffectId="effect_001" />);

      const selectedItem = screen.getByTestId('effect-item-effect_001');
      expect(selectedItem).toHaveClass('ring-2');
    });

    it('should call onSelectEffect when effect is clicked', () => {
      const onSelectEffect = vi.fn();
      render(<EffectsList effects={mockEffects} onSelectEffect={onSelectEffect} />);

      fireEvent.click(screen.getByTestId('effect-item-effect_002'));
      expect(onSelectEffect).toHaveBeenCalledWith('effect_002');
    });
  });

  // ===========================================================================
  // Toggle Tests
  // ===========================================================================

  describe('enable/disable', () => {
    it('should call onToggleEffect when toggle button is clicked', () => {
      const onToggleEffect = vi.fn();
      render(<EffectsList effects={mockEffects} onToggleEffect={onToggleEffect} />);

      const toggleBtn = screen.getByTestId('toggle-effect-effect_001');
      fireEvent.click(toggleBtn);

      expect(onToggleEffect).toHaveBeenCalledWith('effect_001', false);
    });

    it('should show correct toggle state for enabled effect', () => {
      render(<EffectsList effects={mockEffects} onToggleEffect={vi.fn()} />);

      const toggleBtn = screen.getByTestId('toggle-effect-effect_001');
      expect(toggleBtn).toHaveAttribute('aria-pressed', 'true');
    });

    it('should show correct toggle state for disabled effect', () => {
      render(<EffectsList effects={mockEffects} onToggleEffect={vi.fn()} />);

      const toggleBtn = screen.getByTestId('toggle-effect-effect_002');
      expect(toggleBtn).toHaveAttribute('aria-pressed', 'false');
    });
  });

  // ===========================================================================
  // Delete Tests
  // ===========================================================================

  describe('delete', () => {
    it('should call onRemoveEffect when delete button is clicked', () => {
      const onRemoveEffect = vi.fn();
      render(<EffectsList effects={mockEffects} onRemoveEffect={onRemoveEffect} />);

      const deleteBtn = screen.getByTestId('remove-effect-effect_001');
      fireEvent.click(deleteBtn);

      expect(onRemoveEffect).toHaveBeenCalledWith('effect_001');
    });
  });

  // ===========================================================================
  // Reorder Tests
  // ===========================================================================

  describe('reorder', () => {
    it('should show move up/down buttons', () => {
      render(<EffectsList effects={mockEffects} onReorderEffect={vi.fn()} />);

      expect(screen.getByTestId('move-up-effect_002')).toBeInTheDocument();
      expect(screen.getByTestId('move-down-effect_002')).toBeInTheDocument();
    });

    it('should disable move up for first effect', () => {
      render(<EffectsList effects={mockEffects} onReorderEffect={vi.fn()} />);

      const moveUpBtn = screen.getByTestId('move-up-effect_001');
      expect(moveUpBtn).toBeDisabled();
    });

    it('should disable move down for last effect', () => {
      render(<EffectsList effects={mockEffects} onReorderEffect={vi.fn()} />);

      const moveDownBtn = screen.getByTestId('move-down-effect_003');
      expect(moveDownBtn).toBeDisabled();
    });

    it('should call onReorderEffect when move button is clicked', () => {
      const onReorderEffect = vi.fn();
      render(<EffectsList effects={mockEffects} onReorderEffect={onReorderEffect} />);

      const moveDownBtn = screen.getByTestId('move-down-effect_001');
      fireEvent.click(moveDownBtn);

      expect(onReorderEffect).toHaveBeenCalledWith('effect_001', 1);
    });
  });

  // ===========================================================================
  // Add Effect Tests
  // ===========================================================================

  describe('add effect', () => {
    it('should show add button when onAddEffect is provided', () => {
      render(<EffectsList effects={[]} onAddEffect={vi.fn()} />);

      expect(screen.getByTestId('add-effect-button')).toBeInTheDocument();
    });

    it('should call onAddEffect when add button is clicked', () => {
      const onAddEffect = vi.fn();
      render(<EffectsList effects={[]} onAddEffect={onAddEffect} />);

      fireEvent.click(screen.getByTestId('add-effect-button'));
      expect(onAddEffect).toHaveBeenCalled();
    });
  });
});
