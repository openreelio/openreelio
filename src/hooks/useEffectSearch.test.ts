/**
 * useEffectSearch Hook Tests
 *
 * BDD-style tests for effect search filtering and favorites management.
 * Uses real settingsStore (no mocking internal stores per Testing Trophy).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEffectSearch, type CategoryDefinition } from './useEffectSearch';
import { useSettingsStore } from '@/stores/settingsStore';

// =============================================================================
// Test Data
// =============================================================================

const TEST_CATEGORIES: CategoryDefinition[] = [
  {
    id: 'color',
    effects: [
      { type: 'brightness', label: 'Brightness' },
      { type: 'contrast', label: 'Contrast' },
      { type: 'saturation', label: 'Saturation' },
    ],
  },
  {
    id: 'blur_sharpen',
    effects: [
      { type: 'gaussian_blur', label: 'Gaussian Blur' },
      { type: 'sharpen', label: 'Sharpen' },
    ],
  },
  {
    id: 'stylize',
    effects: [
      { type: 'vignette', label: 'Vignette' },
      { type: 'glow', label: 'Glow' },
    ],
  },
];

// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
  // Reset settings store to defaults (clears favorites)
  const store = useSettingsStore.getState();
  if (typeof (store as unknown as Record<string, unknown>)._resetInternalState === 'function') {
    (store as unknown as Record<string, (() => void)>)._resetInternalState();
  }
  useSettingsStore.setState((state) => {
    state.settings.editor.favoriteEffects = [];
  });
});

// =============================================================================
// Search Filtering Tests
// =============================================================================

describe('useEffectSearch', () => {
  describe('search filtering', () => {
    it('should return all categories when search is empty', () => {
      const { result } = renderHook(() =>
        useEffectSearch({ categories: TEST_CATEGORIES }),
      );

      expect(result.current.filteredCategories).toHaveLength(3);
      expect(result.current.searchQuery).toBe('');
    });

    it('should filter effects matching search query', () => {
      const { result } = renderHook(() =>
        useEffectSearch({ categories: TEST_CATEGORIES }),
      );

      act(() => {
        result.current.setSearchQuery('blur');
      });

      expect(result.current.filteredCategories).toHaveLength(1);
      expect(result.current.filteredCategories[0].id).toBe('blur_sharpen');
      expect(result.current.filteredCategories[0].effects).toHaveLength(1);
      expect(result.current.filteredCategories[0].effects[0].label).toBe('Gaussian Blur');
    });

    it('should be case-insensitive when searching', () => {
      const { result } = renderHook(() =>
        useEffectSearch({ categories: TEST_CATEGORIES }),
      );

      act(() => {
        result.current.setSearchQuery('BRIGHT');
      });

      expect(result.current.filteredCategories).toHaveLength(1);
      expect(result.current.filteredCategories[0].effects[0].label).toBe('Brightness');
    });

    it('should report no results for unmatched query', () => {
      const { result } = renderHook(() =>
        useEffectSearch({ categories: TEST_CATEGORIES }),
      );

      act(() => {
        result.current.setSearchQuery('nonexistent');
      });

      expect(result.current.hasResults).toBe(false);
      expect(result.current.filteredCategories).toHaveLength(0);
    });

    it('should restore all effects when search is cleared', () => {
      const { result } = renderHook(() =>
        useEffectSearch({ categories: TEST_CATEGORIES }),
      );

      act(() => {
        result.current.setSearchQuery('blur');
      });
      expect(result.current.filteredCategories).toHaveLength(1);

      act(() => {
        result.current.setSearchQuery('');
      });
      expect(result.current.filteredCategories).toHaveLength(3);
    });
  });

  // ===========================================================================
  // Favorites Tests
  // ===========================================================================

  describe('favorites', () => {
    it('should have no favorites by default', () => {
      const { result } = renderHook(() =>
        useEffectSearch({ categories: TEST_CATEGORIES }),
      );

      expect(result.current.favoriteEffects).toEqual([]);
      expect(result.current.favoritesCategory).toBeNull();
    });

    it('should add effect to favorites when toggled on', () => {
      const { result } = renderHook(() =>
        useEffectSearch({ categories: TEST_CATEGORIES }),
      );

      act(() => {
        result.current.toggleFavorite('brightness');
      });

      expect(result.current.isFavorite('brightness')).toBe(true);
      expect(result.current.favoriteEffects).toContain('brightness');
    });

    it('should remove effect from favorites when toggled off', () => {
      const { result } = renderHook(() =>
        useEffectSearch({ categories: TEST_CATEGORIES }),
      );

      act(() => {
        result.current.toggleFavorite('brightness');
      });
      expect(result.current.isFavorite('brightness')).toBe(true);

      act(() => {
        result.current.toggleFavorite('brightness');
      });
      expect(result.current.isFavorite('brightness')).toBe(false);
    });

    it('should create favorites category when favorites exist', () => {
      const { result } = renderHook(() =>
        useEffectSearch({ categories: TEST_CATEGORIES }),
      );

      act(() => {
        result.current.toggleFavorite('brightness');
        result.current.toggleFavorite('gaussian_blur');
      });

      expect(result.current.favoritesCategory).not.toBeNull();
      expect(result.current.favoritesCategory!.id).toBe('favorites');
      expect(result.current.favoritesCategory!.effects).toHaveLength(2);
    });

    it('should filter favorites by search query', () => {
      const { result } = renderHook(() =>
        useEffectSearch({ categories: TEST_CATEGORIES }),
      );

      act(() => {
        result.current.toggleFavorite('brightness');
        result.current.toggleFavorite('gaussian_blur');
      });

      act(() => {
        result.current.setSearchQuery('bright');
      });

      expect(result.current.favoritesCategory).not.toBeNull();
      expect(result.current.favoritesCategory!.effects).toHaveLength(1);
      expect(result.current.favoritesCategory!.effects[0].label).toBe('Brightness');
    });

    it('should hide favorites category when no favorites match search', () => {
      const { result } = renderHook(() =>
        useEffectSearch({ categories: TEST_CATEGORIES }),
      );

      act(() => {
        result.current.toggleFavorite('brightness');
      });

      act(() => {
        result.current.setSearchQuery('vignette');
      });

      expect(result.current.favoritesCategory).toBeNull();
    });

    it('should persist favorites in settings store', () => {
      const { result } = renderHook(() =>
        useEffectSearch({ categories: TEST_CATEGORIES }),
      );

      act(() => {
        result.current.toggleFavorite('contrast');
      });

      const stored = useSettingsStore.getState().settings.editor.favoriteEffects;
      expect(stored).toContain('contrast');
    });
  });

  // ===========================================================================
  // Combined Search + Favorites Tests
  // ===========================================================================

  describe('search with favorites', () => {
    it('should have results when favorites match but categories do not', () => {
      const { result } = renderHook(() =>
        useEffectSearch({ categories: TEST_CATEGORIES }),
      );

      act(() => {
        result.current.toggleFavorite('glow');
      });

      act(() => {
        result.current.setSearchQuery('glow');
      });

      expect(result.current.hasResults).toBe(true);
    });

    it('should report isFavorite correctly for non-favorited effects', () => {
      const { result } = renderHook(() =>
        useEffectSearch({ categories: TEST_CATEGORIES }),
      );

      expect(result.current.isFavorite('brightness')).toBe(false);
      expect(result.current.isFavorite('nonexistent')).toBe(false);
    });
  });
});
