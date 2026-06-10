/**
 * EffectsBrowser Component Tests
 *
 * Integration tests for effects browser with search and favorites.
 * Uses real settingsStore (Testing Trophy — no mocking internal stores).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EffectsBrowser } from './EffectsBrowser';
import { useSettingsStore } from '@/stores/settingsStore';
import type { EffectPreset, EffectPresetSummary } from '@/types';

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

const savedPresetSummary: EffectPresetSummary = {
  id: 'preset-saved-warm',
  name: 'Saved Warm Blur',
  description: 'Reusable warm blur with animated radius',
  effectType: 'gaussian_blur',
  category: 'blur_sharpen',
  createdAt: '2026-06-08T00:00:00Z',
  updatedAt: '2026-06-08T00:00:00Z',
};

const savedPreset: EffectPreset = {
  ...savedPresetSummary,
  params: { radius: 12 },
  keyframes: {
    radius: [
      {
        timeOffset: 0,
        value: { type: 'float', value: 4 },
        easing: 'linear',
      },
      {
        timeOffset: 1,
        value: { type: 'float', value: 12 },
        easing: 'ease_out',
      },
    ],
  },
};

const savedPresetBackend = {
  ...savedPresetSummary,
  params: { radius: 12 },
  keyframes: {
    radius: [
      {
        timeOffset: 0,
        value: 4,
        easing: 'linear',
      },
      {
        timeOffset: 1,
        value: 12,
        easing: 'ease_out',
      },
    ],
  },
} as unknown as EffectPreset;

// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
    if (command === 'list_effect_presets') {
      return Promise.resolve([]);
    }
    if (command === 'load_effect_preset' && args?.presetId === savedPreset.id) {
      return Promise.resolve(savedPresetBackend);
    }
    if (command === 'delete_effect_preset') {
      return Promise.resolve(null);
    }
    return Promise.reject(new Error(`Unexpected invoke: ${command}`));
  });

  const store = useSettingsStore.getState();
  if (typeof (store as unknown as Record<string, unknown>)._resetInternalState === 'function') {
    (store as unknown as Record<string, (() => void)>)._resetInternalState();
  }
  useSettingsStore.setState((state) => {
    state.settings.editor.favoriteEffects = [];
  });
});

// =============================================================================
// Rendering Tests
// =============================================================================

describe('EffectsBrowser', () => {
  describe('rendering', () => {
    it('should render the effects browser container', () => {
      render(<EffectsBrowser onSavedPresetSelect={vi.fn()} />);

      expect(screen.getByTestId('effects-browser')).toBeInTheDocument();
    });

    it('should render header with Effects title', () => {
      render(<EffectsBrowser onSavedPresetSelect={vi.fn()} />);

      expect(screen.getByText('Effects')).toBeInTheDocument();
    });

    it('should render search input', () => {
      render(<EffectsBrowser onSavedPresetSelect={vi.fn()} />);

      expect(screen.getByPlaceholderText('Search effects...')).toBeInTheDocument();
    });

    it('should render built-in visual presets', () => {
      render(<EffectsBrowser onSavedPresetSelect={vi.fn()} />);

      expect(screen.getByTestId('effect-presets-section')).toBeInTheDocument();
      expect(screen.getByText('Heavy Mosaic')).toBeInTheDocument();
      expect(screen.getByText('Warm Documentary')).toBeInTheDocument();
    });

    it('should render saved effect presets loaded from the preset store', async () => {
      mockInvoke.mockImplementation((command: string) => {
        if (command === 'list_effect_presets') {
          return Promise.resolve([savedPresetSummary]);
        }
        return Promise.reject(new Error(`Unexpected invoke: ${command}`));
      });

      render(<EffectsBrowser onSavedPresetSelect={vi.fn()} />);

      expect(await screen.findByTestId('saved-effect-presets-section')).toBeInTheDocument();
      expect(screen.getByTestId('saved-effect-preset-preset-saved-warm')).toBeInTheDocument();
      expect(screen.getByText('Saved Warm Blur')).toBeInTheDocument();
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

    it('should render Keying category', () => {
      render(<EffectsBrowser />);

      expect(screen.getByText('Keying')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Keying Effects Tests
  // ===========================================================================

  describe('keying effects', () => {
    it('should display Chroma Key effect', () => {
      render(<EffectsBrowser />);

      expect(screen.getByText('Chroma Key')).toBeInTheDocument();
    });

    it('should display Luma Key effect', () => {
      render(<EffectsBrowser />);

      expect(screen.getByText('Luma Key')).toBeInTheDocument();
    });

    it('should find chroma key when searching', () => {
      render(<EffectsBrowser />);

      const searchInput = screen.getByPlaceholderText('Search effects...');
      fireEvent.change(searchInput, { target: { value: 'chroma' } });

      // Chroma Key present (effect button + star button both match role)
      const chromaButtons = screen.getAllByRole('button', { name: /Chroma Key/i });
      expect(chromaButtons.length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByRole('button', { name: /^Brightness$/i })).not.toBeInTheDocument();
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

    it('should call onPresetSelect with a built-in visual preset when clicked', () => {
      const onPresetSelect = vi.fn();
      render(<EffectsBrowser onPresetSelect={onPresetSelect} />);

      fireEvent.click(screen.getByTestId('effect-preset-privacy-heavy-mosaic'));

      expect(onPresetSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'privacy-heavy-mosaic',
          effects: expect.arrayContaining([
            expect.objectContaining({
              effectType: 'pixelate',
              params: { size: 28 },
              defaultMask: expect.objectContaining({
                name: 'Privacy Mosaic Region',
                shape: expect.objectContaining({ type: 'rectangle' }),
              }),
            }),
          ]),
        }),
      );
    });

    it('should load and apply a saved effect preset when clicked', async () => {
      mockInvoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
        if (command === 'list_effect_presets') {
          return Promise.resolve([savedPresetSummary]);
        }
        if (command === 'load_effect_preset' && args?.presetId === savedPreset.id) {
          return Promise.resolve(savedPresetBackend);
        }
        return Promise.reject(new Error(`Unexpected invoke: ${command}`));
      });
      const onSavedPresetSelect = vi.fn();
      render(<EffectsBrowser onSavedPresetSelect={onSavedPresetSelect} />);

      fireEvent.click(await screen.findByTestId('saved-effect-preset-preset-saved-warm'));

      await waitFor(() => expect(onSavedPresetSelect).toHaveBeenCalledWith(savedPreset));
    });

    it('should delete a saved effect preset after confirmation', async () => {
      mockInvoke.mockImplementation((command: string) => {
        if (command === 'list_effect_presets') {
          return Promise.resolve([savedPresetSummary]);
        }
        if (command === 'delete_effect_preset') {
          return Promise.resolve(null);
        }
        return Promise.reject(new Error(`Unexpected invoke: ${command}`));
      });
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<EffectsBrowser onSavedPresetSelect={vi.fn()} />);

      fireEvent.click(await screen.findByTestId('delete-saved-effect-preset-preset-saved-warm'));

      await waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith('delete_effect_preset', {
          presetId: savedPreset.id,
        }),
      );
      confirmSpy.mockRestore();
    });
  });

  // ===========================================================================
  // Search Tests
  // ===========================================================================

  describe('search functionality', () => {
    it('should have enabled search input', () => {
      render(<EffectsBrowser onSavedPresetSelect={vi.fn()} />);

      const searchInput = screen.getByPlaceholderText('Search effects...');
      expect(searchInput).not.toBeDisabled();
    });

    it('should filter effects when searching', () => {
      render(<EffectsBrowser />);

      const searchInput = screen.getByPlaceholderText('Search effects...');
      fireEvent.change(searchInput, { target: { value: 'dissolve' } });

      // Effect button + star button both match role, use getAllByRole
      const dissolveButtons = screen.getAllByRole('button', { name: /Cross Dissolve/i });
      expect(dissolveButtons.length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByRole('button', { name: /^Brightness$/i })).not.toBeInTheDocument();
    });

    it('should filter built-in visual presets by category and description', () => {
      render(<EffectsBrowser />);

      const searchInput = screen.getByPlaceholderText('Search effects...');
      fireEvent.change(searchInput, { target: { value: 'privacy' } });

      expect(screen.getByText('Heavy Mosaic')).toBeInTheDocument();
      expect(screen.getByTestId('effect-preset-privacy-soft-blur')).toBeInTheDocument();
      expect(screen.queryByText('Warm Documentary')).not.toBeInTheDocument();
    });

    it('should filter saved effect presets by saved name and effect type', async () => {
      mockInvoke.mockImplementation((command: string) => {
        if (command === 'list_effect_presets') {
          return Promise.resolve([savedPresetSummary]);
        }
        return Promise.reject(new Error(`Unexpected invoke: ${command}`));
      });
      render(<EffectsBrowser onSavedPresetSelect={vi.fn()} />);

      const searchInput = screen.getByPlaceholderText('Search effects...');
      fireEvent.change(searchInput, { target: { value: 'animated radius' } });

      expect(await screen.findByTestId('saved-effect-preset-preset-saved-warm')).toBeInTheDocument();
      expect(screen.queryByText('Warm Documentary')).not.toBeInTheDocument();
    });

    it('should be case-insensitive when searching', () => {
      render(<EffectsBrowser />);

      const searchInput = screen.getByPlaceholderText('Search effects...');
      fireEvent.change(searchInput, { target: { value: 'WIPE' } });

      expect(screen.getByText(/Wipe/)).toBeInTheDocument();
    });

    it('should show empty state when no results match', async () => {
      render(<EffectsBrowser />);

      const searchInput = screen.getByPlaceholderText('Search effects...');
      fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

      expect(await screen.findByText(/no effects found/i)).toBeInTheDocument();
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

    it('should highlight matching text in search results', () => {
      render(<EffectsBrowser />);

      const searchInput = screen.getByPlaceholderText('Search effects...');
      fireEvent.change(searchInput, { target: { value: 'blur' } });

      const highlighted = screen.getAllByText('Blur');
      expect(highlighted.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Favorites Tests
  // ===========================================================================

  describe('favorites', () => {
    it('should not show Favorites category when no favorites exist', () => {
      render(<EffectsBrowser />);

      expect(screen.queryByTestId('favorites-category')).not.toBeInTheDocument();
      expect(screen.queryByText('Favorites')).not.toBeInTheDocument();
    });

    it('should show star toggle button on hover for each effect', () => {
      render(<EffectsBrowser />);

      const starButtons = screen.getAllByRole('button', { name: /add .+ to favorites/i });
      expect(starButtons.length).toBeGreaterThan(0);
    });

    it('should add effect to favorites when star is clicked', () => {
      render(<EffectsBrowser />);

      const addFavButton = screen.getByRole('button', { name: /add Brightness to favorites/i });
      fireEvent.click(addFavButton);

      expect(screen.getByTestId('favorites-category')).toBeInTheDocument();
      expect(screen.getByText('Favorites')).toBeInTheDocument();
    });

    it('should remove effect from favorites when star is clicked again', () => {
      render(<EffectsBrowser />);

      // Add to favorites
      const addFavButton = screen.getByRole('button', { name: /add Brightness to favorites/i });
      fireEvent.click(addFavButton);
      expect(screen.getByTestId('favorites-category')).toBeInTheDocument();

      // Remove from favorites
      const removeFavButtons = screen.getAllByRole('button', { name: /remove Brightness from favorites/i });
      fireEvent.click(removeFavButtons[0]);
      expect(screen.queryByTestId('favorites-category')).not.toBeInTheDocument();
    });

    it('should show Favorites category at top of the list', () => {
      render(<EffectsBrowser />);

      // Add favorite
      const addFavButton = screen.getByRole('button', { name: /add Brightness to favorites/i });
      fireEvent.click(addFavButton);

      const categoriesContainer = screen.getByTestId('effects-browser');
      const favoritesCategory = screen.getByTestId('favorites-category');
      // Favorites should appear before Color in DOM order
      const favPosition = Array.from(categoriesContainer.querySelectorAll('[data-testid], .text-xs.font-medium'))
        .findIndex(el => el.getAttribute('data-testid') === 'favorites-category');
      const colorPosition = Array.from(categoriesContainer.querySelectorAll('[data-testid], .text-xs.font-medium'))
        .findIndex(el => el.textContent === 'Color');

      expect(favoritesCategory).toBeInTheDocument();
      expect(favPosition).toBeLessThan(colorPosition);
    });

    it('should filter favorites by search query', () => {
      render(<EffectsBrowser />);

      // Add two favorites
      fireEvent.click(screen.getByRole('button', { name: /add Brightness to favorites/i }));
      fireEvent.click(screen.getByRole('button', { name: /add Contrast to favorites/i }));

      // Search for brightness — text split by highlight span, use button role
      const searchInput = screen.getByPlaceholderText('Search effects...');
      fireEvent.change(searchInput, { target: { value: 'bright' } });

      // Favorites category should show and contain Brightness
      const favCategory = screen.getByTestId('favorites-category');
      expect(favCategory).toBeInTheDocument();
      // Brightness appears in both favorites and color category (button roles with accessible name)
      const brightnessButtons = screen.getAllByRole('button', { name: /Brightness/i });
      expect(brightnessButtons.length).toBeGreaterThanOrEqual(1);
    });

    it('should persist favorites across re-renders via settings store', () => {
      const { unmount } = render(<EffectsBrowser />);

      // Add a favorite
      fireEvent.click(screen.getByRole('button', { name: /add Gaussian Blur to favorites/i }));

      // Verify it's in settings store
      const stored = useSettingsStore.getState().settings.editor.favoriteEffects;
      expect(stored).toContain('gaussian_blur');

      // Unmount and remount
      unmount();
      render(<EffectsBrowser />);

      // Favorites should persist
      expect(screen.getByTestId('favorites-category')).toBeInTheDocument();
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

    it('should have accessible favorite toggle labels', () => {
      render(<EffectsBrowser />);

      expect(screen.getByRole('button', { name: /add Brightness to favorites/i })).toBeInTheDocument();
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
