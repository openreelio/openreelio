/**
 * EffectsBrowser Component
 *
 * Browser panel for discovering and applying effects to clips.
 * Displays available effects organized by category with search and favorites.
 */

import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { Trash2, Wand2, Search, Star, Sparkles } from 'lucide-react';
import type { EffectCategory, EffectPreset, EffectPresetSummary } from '@/types';
import { EFFECT_CATEGORY_LABELS } from '@/types';
import { useEffectSearch, getEffectTypeKey, type EffectEntry } from '@/hooks/useEffectSearch';
import { useEffectCapabilityRegistry } from '@/hooks/useEffectCapabilities';
import { useEffectPresets } from '@/hooks/useEffectPresets';
import { getEffectCapabilityBadge } from '@/utils/effectCapabilities';
import { EFFECT_CATEGORIES, CATEGORY_ICONS, totalEffectCount } from './effectCategoryData';
import {
  BUILT_IN_VISUAL_EFFECT_PRESETS,
  VISUAL_EFFECT_PRESET_CATEGORY_LABELS,
  filterSavedEffectPresets,
  filterVisualEffectPresets,
  getEffectPresetTypeLabel,
  type VisualEffectPreset,
} from './effectPresetLibrary';

// =============================================================================
// Types
// =============================================================================

export interface EffectsBrowserProps {
  /** Additional CSS classes */
  className?: string;
  /** Callback when an effect is selected */
  onEffectSelect?: (effectType: string) => void | Promise<void>;
  /** Callback when a built-in visual preset is selected */
  onPresetSelect?: (preset: VisualEffectPreset) => void | Promise<void>;
  /** Callback when a saved effect preset is selected */
  onSavedPresetSelect?: (preset: EffectPreset) => void | Promise<void>;
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
  onPresetSelect,
  onSavedPresetSelect,
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
  const capabilityRegistry = useEffectCapabilityRegistry();
  const {
    presets: savedPresets,
    loading: savedPresetsLoading,
    error: savedPresetsError,
    loadPreset,
    deletePreset,
  } = useEffectPresets({ autoLoad: Boolean(onSavedPresetSelect) });
  const [busySavedPresetId, setBusySavedPresetId] = useState<string | null>(null);
  const filteredPresets = filterVisualEffectPresets(BUILT_IN_VISUAL_EFFECT_PRESETS, searchQuery);
  const filteredSavedPresets = useMemo(
    () => filterSavedEffectPresets(savedPresets, searchQuery),
    [savedPresets, searchQuery],
  );
  const hasPresetResults = filteredPresets.length > 0;
  const hasSavedPresetResults = filteredSavedPresets.length > 0;
  const canUseSavedPresets = Boolean(onSavedPresetSelect);
  const hasAnyResults =
    hasResults ||
    hasPresetResults ||
    (canUseSavedPresets && (hasSavedPresetResults || savedPresetsLoading));

  const handleSavedPresetSelect = useCallback(
    async (presetId: string) => {
      if (!onSavedPresetSelect) return;

      try {
        setBusySavedPresetId(presetId);
        const preset = await loadPreset(presetId);
        await onSavedPresetSelect(preset);
      } finally {
        setBusySavedPresetId((current) => (current === presetId ? null : current));
      }
    },
    [loadPreset, onSavedPresetSelect],
  );

  const handleSavedPresetDelete = useCallback(
    async (presetId: string, presetName: string) => {
      const confirmed = window.confirm(`Delete saved preset "${presetName}"?`);
      if (!confirmed) return;

      try {
        setBusySavedPresetId(presetId);
        await deletePreset(presetId);
      } finally {
        setBusySavedPresetId((current) => (current === presetId ? null : current));
      }
    },
    [deletePreset],
  );

  const renderEffectButton = (effect: EffectEntry): ReactNode => {
    const key = getEffectTypeKey(effect.type);
    const favorited = isFavorite(key);
    const badge = getEffectCapabilityBadge(effect.type, capabilityRegistry);
    const badgeClass =
      badge.tone === 'success'
        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
        : badge.tone === 'warning'
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
          : 'border-editor-border bg-editor-input text-editor-text-muted';

    return (
      <div key={key} className="flex items-center group">
        <button
          type="button"
          className="flex-1 min-w-0 px-3 py-1.5 text-sm rounded transition-colors text-editor-text hover:bg-editor-hover focus-visible:ring-1 focus-visible:ring-primary-500 focus-visible:outline-none"
          onClick={() => onEffectSelect?.(key)}
          title={badge.title}
        >
          <span className="flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 truncate text-left">
              <HighlightedLabel label={effect.label} query={searchQuery} />
            </span>
            <span
              className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] leading-none ${badgeClass}`}
            >
              {badge.label}
            </span>
          </span>
        </button>
        <button
          type="button"
          aria-label={
            favorited ? `Remove ${effect.label} from favorites` : `Add ${effect.label} to favorites`
          }
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

  const renderPresetButton = (preset: VisualEffectPreset): ReactNode => {
    const category = VISUAL_EFFECT_PRESET_CATEGORY_LABELS[preset.category];

    return (
      <button
        key={preset.id}
        type="button"
        data-testid={`effect-preset-${preset.id}`}
        className="w-full rounded border border-editor-border bg-editor-input bg-opacity-40 px-3 py-2 text-left transition-colors hover:bg-editor-hover focus-visible:ring-1 focus-visible:ring-primary-500 focus-visible:outline-none"
        onClick={() => onPresetSelect?.(preset)}
        title={preset.description}
      >
        <span className="flex items-start justify-between gap-2">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-editor-text">
              <HighlightedLabel label={preset.name} query={searchQuery} />
            </span>
            <span className="mt-0.5 block line-clamp-2 text-xs text-editor-text-muted">
              {preset.description}
            </span>
          </span>
          <span className="shrink-0 rounded border border-primary-500/40 bg-primary-500/10 px-1.5 py-0.5 text-[10px] leading-none text-primary-300">
            {category}
          </span>
        </span>
      </button>
    );
  };

  const renderSavedPresetButton = (preset: EffectPresetSummary): ReactNode => {
    const effectLabel = getEffectPresetTypeLabel(preset.effectType);
    const isBusy = busySavedPresetId === preset.id;

    return (
      <div
        key={preset.id}
        className="group flex items-stretch rounded border border-editor-border bg-editor-input bg-opacity-40 transition-colors hover:bg-editor-hover"
      >
        <button
          type="button"
          data-testid={`saved-effect-preset-${preset.id}`}
          className="min-w-0 flex-1 px-3 py-2 text-left focus-visible:ring-1 focus-visible:ring-primary-500 focus-visible:outline-none disabled:opacity-60"
          onClick={() => {
            void handleSavedPresetSelect(preset.id);
          }}
          disabled={isBusy || !onSavedPresetSelect}
          title={preset.description ?? effectLabel}
        >
          <span className="flex items-start justify-between gap-2">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-editor-text">
                <HighlightedLabel label={preset.name} query={searchQuery} />
              </span>
              <span className="mt-0.5 block truncate text-xs text-editor-text-muted">
                {preset.description ?? effectLabel}
              </span>
            </span>
            <span className="shrink-0 rounded border border-editor-border bg-editor-bg px-1.5 py-0.5 text-[10px] leading-none text-editor-text-muted">
              {effectLabel}
            </span>
          </span>
        </button>
        <button
          type="button"
          aria-label={`Delete ${preset.name}`}
          data-testid={`delete-saved-effect-preset-${preset.id}`}
          className="shrink-0 px-2 text-editor-text-muted opacity-70 transition-colors hover:text-red-300 group-hover:opacity-100 focus-visible:ring-1 focus-visible:ring-red-400 focus-visible:outline-none disabled:opacity-40"
          onClick={(event) => {
            event.stopPropagation();
            void handleSavedPresetDelete(preset.id, preset.name);
          }}
          disabled={isBusy}
          title={`Delete ${preset.name}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
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
        {!hasAnyResults ? (
          <div className="flex flex-col items-center justify-center py-8 text-editor-text-muted">
            <Search className="w-8 h-8 mb-2 opacity-50" />
            <p className="text-sm">No effects found</p>
            <p className="text-xs mt-1">Try a different search term</p>
          </div>
        ) : (
          <>
            {hasPresetResults && (
              <div data-testid="effect-presets-section">
                <div className="flex items-center gap-2 px-2 py-1.5 text-primary-300">
                  <Sparkles className="w-4 h-4" />
                  <span className="text-xs font-medium uppercase tracking-wider">Presets</span>
                </div>
                <div className="grid gap-2">{filteredPresets.map(renderPresetButton)}</div>
              </div>
            )}

            {canUseSavedPresets &&
              (savedPresetsLoading || savedPresetsError || hasSavedPresetResults) && (
                <div data-testid="saved-effect-presets-section">
                  <div className="flex items-center gap-2 px-2 py-1.5 text-editor-text-muted">
                    <Star className="w-4 h-4" />
                    <span className="text-xs font-medium uppercase tracking-wider">
                      Saved Presets
                    </span>
                  </div>
                  {savedPresetsLoading ? (
                    <p className="px-2 py-2 text-xs text-editor-text-muted">
                      Loading saved presets...
                    </p>
                  ) : savedPresetsError ? (
                    <p className="px-2 py-2 text-xs text-red-300">Saved presets unavailable</p>
                  ) : (
                    <div className="grid gap-2">
                      {filteredSavedPresets.map(renderSavedPresetButton)}
                    </div>
                  )}
                </div>
              )}

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
                  <div className="space-y-0.5">{category.effects.map(renderEffectButton)}</div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-editor-border mt-4">
        <p className="text-xs text-editor-text-muted text-center italic">
          {totalEffectCount} effects, {BUILT_IN_VISUAL_EFFECT_PRESETS.length} built-in presets, and{' '}
          {savedPresets.length} saved presets available
        </p>
      </div>
    </div>
  );
});
