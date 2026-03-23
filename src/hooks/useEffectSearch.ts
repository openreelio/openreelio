/**
 * useEffectSearch Hook
 *
 * Combines effect search filtering with favorites management.
 * Favorites are persisted in settingsStore (editor.favoriteEffects).
 */

import { useState, useMemo, useCallback } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import type { EffectType } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface EffectEntry {
  type: EffectType;
  label: string;
}

export interface CategoryDefinition {
  id: string;
  effects: EffectEntry[];
}

export type FilteredCategory = CategoryDefinition;

export interface UseEffectSearchOptions {
  categories: CategoryDefinition[];
}

export interface UseEffectSearchReturn {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  filteredCategories: FilteredCategory[];
  favoritesCategory: FilteredCategory | null;
  hasResults: boolean;
  favoriteEffects: string[];
  toggleFavorite: (effectType: string) => void;
  isFavorite: (effectType: string) => boolean;
}

// =============================================================================
// Helpers
// =============================================================================

/** Extracts a string key from an EffectType (string literal or { custom: string }) */
export function getEffectTypeKey(effectType: EffectType): string {
  return typeof effectType === 'string' ? effectType : effectType.custom;
}

function filterEffectsByQuery(effects: EffectEntry[], query: string): EffectEntry[] {
  const trimmed = query.trim();
  if (!trimmed) return effects;
  const lower = trimmed.toLowerCase();
  return effects.filter((effect) => effect.label.toLowerCase().includes(lower));
}

// =============================================================================
// Hook
// =============================================================================

export function useEffectSearch({ categories }: UseEffectSearchOptions): UseEffectSearchReturn {
  const [searchQuery, setSearchQuery] = useState('');
  const favoriteEffects = useSettingsStore((s) => s.settings.editor.favoriteEffects);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const toggleFavorite = useCallback(
    (effectType: string) => {
      const current = useSettingsStore.getState().settings.editor.favoriteEffects;
      const next = current.includes(effectType)
        ? current.filter((id) => id !== effectType)
        : [...current, effectType];
      updateSettings('editor', { favoriteEffects: next });
    },
    [updateSettings],
  );

  const isFavorite = useCallback(
    (effectType: string): boolean => {
      return favoriteEffects.includes(effectType);
    },
    [favoriteEffects],
  );

  const favoritesCategory = useMemo((): FilteredCategory | null => {
    if (favoriteEffects.length === 0) return null;

    const effectMap = new Map(
      categories.flatMap((cat) => cat.effects).map((e) => [getEffectTypeKey(e.type), e]),
    );
    const favEffects = favoriteEffects
      .map((favId) => effectMap.get(favId))
      .filter((e): e is EffectEntry => e !== undefined);

    if (favEffects.length === 0) return null;

    const filtered = filterEffectsByQuery(favEffects, searchQuery);
    if (filtered.length === 0 && searchQuery.trim()) return null;

    return { id: 'favorites', effects: filtered };
  }, [categories, favoriteEffects, searchQuery]);

  const filteredCategories = useMemo((): FilteredCategory[] => {
    if (!searchQuery.trim()) return categories;

    return categories
      .map((category) => ({
        ...category,
        effects: filterEffectsByQuery(category.effects, searchQuery),
      }))
      .filter((category) => category.effects.length > 0);
  }, [categories, searchQuery]);

  const hasResults = useMemo(() => {
    const catHasResults = filteredCategories.some((cat) => cat.effects.length > 0);
    const favHasResults = favoritesCategory !== null && favoritesCategory.effects.length > 0;
    return catHasResults || favHasResults;
  }, [filteredCategories, favoritesCategory]);

  return {
    searchQuery,
    setSearchQuery,
    filteredCategories,
    favoritesCategory,
    hasResults,
    favoriteEffects,
    toggleFavorite,
    isFavorite,
  };
}
