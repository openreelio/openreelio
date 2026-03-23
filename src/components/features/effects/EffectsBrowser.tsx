/**
 * EffectsBrowser Component
 *
 * Browser panel for discovering and applying effects to clips.
 * Displays available effects organized by category with search and favorites.
 */

import { memo, type ReactNode } from 'react';
import { Wand2, Search, Star } from 'lucide-react';
import type { EffectCategory } from '@/types';
import { EFFECT_CATEGORY_LABELS } from '@/types';
import {
  useEffectSearch,
  getEffectTypeKey,
  type EffectEntry,
} from '@/hooks/useEffectSearch';
import {
  EFFECT_CATEGORIES,
  CATEGORY_ICONS,
  TOTAL_EFFECT_COUNT,
} from './effectCategoryData';

// =============================================================================
// Types
// =============================================================================

export interface EffectsBrowserProps {
  /** Additional CSS classes */
  className?: string;
  /** Callback when an effect is selected */
  onEffectSelect?: (effectType: string) => void;
}

// =============================================================================
// Helpers
// =============================================================================

/** Renders effect label with highlighted matching text */
function HighlightedLabel({ label, query }: { label: string; query: string }): ReactNode {
  if (!query.trim()) return label;

  const lower = label.toLowerCase();
  const idx = lower.indexOf(query.trim().toLowerCase());
  if (idx === -1) return label;

  const before = label.slice(0, idx);
  const match = label.slice(idx, idx + query.trim().length);
  const after = label.slice(idx + query.trim().length);

  return (
    <>
      {before}
      <span className="text-primary-400 font-semibold">{match}</span>
      {after}
    </>
  );
}

// =============================================================================
// Component
// =============================================================================

export const EffectsBrowser = memo(function EffectsBrowser({
  className = '',
  onEffectSelect,
}: EffectsBrowserProps) {
  const {
    searchQuery,
    setSearchQuery,
    filteredCategories,
    favoritesCategory,
    hasResults,
    toggleFavorite,
    isFavorite,
  } = useEffectSearch({ categories: EFFECT_CATEGORIES });

  const renderEffectButton = (effect: EffectEntry): ReactNode => {
    const key = getEffectTypeKey(effect.type);
    const favorited = isFavorite(key);

    return (
      <div key={key} className="flex items-center group">
        <button
          type="button"
          className="flex-1 text-left px-3 py-1.5 text-sm rounded transition-colors text-editor-text hover:bg-editor-hover focus-visible:ring-1 focus-visible:ring-primary-500 focus-visible:outline-none"
          onClick={() => onEffectSelect?.(key)}
        >
          <HighlightedLabel label={effect.label} query={searchQuery} />
        </button>
        <button
          type="button"
          aria-label={favorited ? `Remove ${effect.label} from favorites` : `Add ${effect.label} to favorites`}
          className={`p-1 mr-1 rounded transition-opacity focus-visible:ring-1 focus-visible:ring-primary-500 focus-visible:outline-none ${
            favorited
              ? 'opacity-100 text-yellow-400'
              : 'opacity-0 group-hover:opacity-60 text-editor-text-muted hover:text-yellow-400'
          }`}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite(key);
          }}
        >
          <Star className="w-3.5 h-3.5" fill={favorited ? 'currentColor' : 'none'} />
        </button>
      </div>
    );
  };

  return (
    <div className={`h-full overflow-auto ${className}`} data-testid="effects-browser">
      {/* Header */}
      <div className="p-3 border-b border-editor-border">
        <div className="flex items-center gap-2 text-editor-text">
          <Wand2 className="w-4 h-4 text-primary-500" />
          <span className="text-sm font-medium">Effects</span>
        </div>
        <p className="text-xs text-editor-text-muted mt-1">
          Drag effects to clips or double-click to apply
        </p>
      </div>

      {/* Search */}
      <div className="p-2 border-b border-editor-border" role="search">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-editor-text-muted" />
          <input
            type="text"
            placeholder="Search effects..."
            aria-label="Search effects"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-editor-input border border-editor-border rounded pl-8 pr-2 py-1.5 text-sm text-editor-text placeholder:text-editor-text-muted focus:border-primary-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Effect Categories */}
      <div className="p-2 space-y-4">
        {!hasResults ? (
          <div className="flex flex-col items-center justify-center py-8 text-editor-text-muted">
            <Search className="w-8 h-8 mb-2 opacity-50" />
            <p className="text-sm">No effects found</p>
            <p className="text-xs mt-1">Try a different search term</p>
          </div>
        ) : (
          <>
            {/* Favorites Category (at top when populated) */}
            {favoritesCategory && (
              <div data-testid="favorites-category">
                <div className="flex items-center gap-2 px-2 py-1.5 text-yellow-400">
                  <Star className="w-4 h-4" fill="currentColor" />
                  <span className="text-xs font-medium uppercase tracking-wider">Favorites</span>
                </div>
                <div className="space-y-0.5">
                  {favoritesCategory.effects.map(renderEffectButton)}
                </div>
              </div>
            )}

            {/* Regular Categories */}
            {filteredCategories.map((category) => {
              const catId = category.id as EffectCategory;
              return (
                <div key={category.id}>
                  <div className="flex items-center gap-2 px-2 py-1.5 text-editor-text-muted">
                    {CATEGORY_ICONS[catId] ?? <Wand2 className="w-4 h-4" />}
                    <span className="text-xs font-medium uppercase tracking-wider">
                      {EFFECT_CATEGORY_LABELS[catId] ?? category.id}
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    {category.effects.map(renderEffectButton)}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-editor-border mt-4">
        <p className="text-xs text-editor-text-muted text-center italic">
          {TOTAL_EFFECT_COUNT} effects available
        </p>
      </div>
    </div>
  );
});
