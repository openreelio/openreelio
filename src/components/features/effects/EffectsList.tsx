/**
 * EffectsList Component
 *
 * Displays a list of effects applied to a clip with controls for
 * enabling/disabling, reordering, and removing effects.
 */

import {
  Eye,
  EyeOff,
  Trash2,
  ChevronUp,
  ChevronDown,
  Plus,
  Music,
  Sparkles,
} from 'lucide-react';
import type { Effect, EffectId } from '@/types';
import { isAudioEffect, EFFECT_TYPE_LABELS } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface EffectsListProps {
  /** List of effects to display */
  effects: Effect[];
  /** Currently selected effect ID */
  selectedEffectId?: EffectId;
  /** Callback when an effect is selected */
  onSelectEffect?: (effectId: EffectId) => void;
  /** Callback when an effect is toggled on/off */
  onToggleEffect?: (effectId: EffectId, enabled: boolean) => void;
  /** Callback when an effect should be removed */
  onRemoveEffect?: (effectId: EffectId) => void;
  /** Callback when an effect should be reordered */
  onReorderEffect?: (effectId: EffectId, newOrder: number) => void;
  /** Callback when add effect button is clicked */
  onAddEffect?: () => void;
  /** Whether the list is read-only */
  readOnly?: boolean;
}

// =============================================================================
// Helper Functions
// =============================================================================

function getEffectLabel(effect: Effect): string {
  const effectType = effect.effectType;

  if (typeof effectType === 'object' && 'custom' in effectType) {
    return effectType.custom;
  }

  return EFFECT_TYPE_LABELS[effectType] ?? effectType;
}

// =============================================================================
// Component
// =============================================================================

export function EffectsList({
  effects,
  selectedEffectId,
  onSelectEffect,
  onToggleEffect,
  onRemoveEffect,
  onReorderEffect,
  onAddEffect,
  readOnly = false,
}: EffectsListProps): JSX.Element {
  // Sort effects by order
  const sortedEffects = [...effects].sort((a, b) => a.order - b.order);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-editor-border">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-editor-text-muted" />
          <span className="text-sm font-medium text-editor-text">Effects</span>
          {effects.length > 0 && (
            <span className="px-1.5 py-0.5 text-xs bg-editor-border rounded text-editor-text-muted">
              {effects.length}
            </span>
          )}
        </div>
        {onAddEffect && !readOnly && (
          <button
            data-testid="add-effect-button"
            className="p-1 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text"
            onClick={onAddEffect}
            title="Add effect"
          >
            <Plus className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Effects List */}
      <div className="flex-1 overflow-auto">
        {sortedEffects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-4 text-editor-text-muted text-sm">
            <Sparkles className="w-8 h-8 mb-2 opacity-50" />
            <p>No effects applied</p>
            {onAddEffect && !readOnly && (
              <button
                className="mt-2 text-primary-400 hover:text-primary-300"
                onClick={onAddEffect}
              >
                Add an effect
              </button>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-editor-border" role="list" aria-label="Applied effects">
            {sortedEffects.map((effect, index) => {
              const isSelected = effect.id === selectedEffectId;
              const isAudio = isAudioEffect(effect.effectType);
              const isFirst = index === 0;
              const isLast = index === sortedEffects.length - 1;

              return (
                <li
                  key={effect.id}
                  data-testid={`effect-item-${effect.id}`}
                  className={`
                    flex items-center gap-2 px-2 py-1.5 cursor-pointer transition-colors
                    hover:bg-editor-hover
                    ${isSelected ? 'ring-2 ring-inset ring-primary-400 bg-editor-hover' : ''}
                    ${!effect.enabled ? 'opacity-50' : ''}
                  `}
                  onClick={() => onSelectEffect?.(effect.id)}
                >
                  {/* Effect Icon */}
                  <div className="flex-shrink-0">
                    {isAudio ? (
                      <Music
                        data-testid="audio-icon"
                        className="w-4 h-4 text-green-400"
                      />
                    ) : (
                      <Sparkles className="w-4 h-4 text-purple-400" />
                    )}
                  </div>

                  {/* Effect Name */}
                  <span className="flex-1 text-sm text-editor-text truncate">
                    {getEffectLabel(effect)}
                  </span>

                  {/* Controls */}
                  {!readOnly && (
                    <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                      {/* Reorder buttons */}
                      {onReorderEffect && (
                        <>
                          <button
                            data-testid={`move-up-${effect.id}`}
                            className="p-0.5 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text disabled:opacity-30 disabled:cursor-not-allowed"
                            onClick={() => onReorderEffect(effect.id, effect.order - 1)}
                            disabled={isFirst}
                            title="Move up"
                          >
                            <ChevronUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            data-testid={`move-down-${effect.id}`}
                            className="p-0.5 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text disabled:opacity-30 disabled:cursor-not-allowed"
                            onClick={() => onReorderEffect(effect.id, effect.order + 1)}
                            disabled={isLast}
                            title="Move down"
                          >
                            <ChevronDown className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}

                      {/* Toggle button */}
                      {onToggleEffect && (
                        <button
                          data-testid={`toggle-effect-${effect.id}`}
                          className="p-0.5 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text"
                          onClick={() => onToggleEffect(effect.id, !effect.enabled)}
                          aria-pressed={effect.enabled}
                          title={effect.enabled ? 'Disable effect' : 'Enable effect'}
                        >
                          {effect.enabled ? (
                            <Eye className="w-3.5 h-3.5" />
                          ) : (
                            <EyeOff className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}

                      {/* Remove button */}
                      {onRemoveEffect && (
                        <button
                          data-testid={`remove-effect-${effect.id}`}
                          className="p-0.5 rounded hover:bg-red-500/20 text-editor-text-muted hover:text-red-400"
                          onClick={() => onRemoveEffect(effect.id)}
                          title="Remove effect"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
