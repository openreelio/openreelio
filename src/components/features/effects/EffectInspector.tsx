/**
 * EffectInspector Component
 *
 * Displays and edits parameters for a selected effect.
 * Provides controls for enabling/disabling, deleting, and resetting effects.
 * Supports keyframe animation editing for animatable parameters.
 *
 * Performance: Uses debouncing for rapid parameter changes to prevent render thrashing.
 * Security: Validates all parameter inputs before propagating changes.
 */

import { memo, useCallback, useRef, useEffect, useState } from 'react';
import { Sparkles, Trash2, RotateCcw, Music, Key } from 'lucide-react';
import type { Effect, EffectId, ParamDef, SimpleParamValue, Keyframe } from '@/types';
import { EFFECT_TYPE_LABELS, isAudioEffect } from '@/types';
import { ParameterEditor } from './ParameterEditor';
import { KeyframeEditor } from './KeyframeEditor';
import { ColorWheelsPanel, type ColorWheelsValues, type ColorWheelsParamName } from './ColorWheelsPanel';
import { ChromaKeyControl } from './ChromaKeyControl';
import type { ChromaKeyParams } from '@/hooks/useChromaKey';

// =============================================================================
// Constants
// =============================================================================

/** Debounce delay for parameter changes (ms) */
const PARAM_CHANGE_DEBOUNCE_MS = 16; // ~1 frame at 60fps

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validates a parameter value is within acceptable bounds based on param definition.
 */
function validateParamValue(value: SimpleParamValue, paramDef: ParamDef): SimpleParamValue {
  if (typeof value === 'number') {
    // Validate numeric values
    if (!Number.isFinite(value)) {
      return getDefaultValue(paramDef);
    }
    // Clamp to min/max if defined
    let result = value;
    if (paramDef.min !== undefined && result < paramDef.min) {
      result = paramDef.min;
    }
    if (paramDef.max !== undefined && result > paramDef.max) {
      result = paramDef.max;
    }
    return result;
  }
  return value;
}

// =============================================================================
// Types
// =============================================================================

export interface EffectInspectorProps {
  /** The effect to inspect (null if none selected) */
  effect: Effect | null;
  /** Parameter definitions for the effect type */
  paramDefs: ParamDef[];
  /** Callback when parameter values change */
  onChange: (effectId: EffectId, params: Record<string, SimpleParamValue>) => void;
  /** Callback when effect enabled state changes */
  onToggle?: (effectId: EffectId, enabled: boolean) => void;
  /** Callback when effect should be deleted */
  onDelete?: (effectId: EffectId) => void;
  /** Callback when keyframes change */
  onKeyframesChange?: (effectId: EffectId, paramName: string, keyframes: Keyframe[]) => void;
  /** Whether to show keyframe editing UI */
  showKeyframes?: boolean;
  /** Current playhead time in seconds (for keyframe positioning) */
  currentTime?: number;
  /** Total effect duration in seconds */
  duration?: number;
  /** Whether the inspector is read-only */
  readOnly?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

function getEffectLabel(effectType: Effect['effectType']): string {
  if (typeof effectType === 'object' && 'custom' in effectType) {
    return effectType.custom;
  }
  return EFFECT_TYPE_LABELS[effectType] ?? effectType;
}

function getDefaultValue(paramDef: ParamDef): SimpleParamValue {
  // Use explicit default if available
  if (paramDef?.default && 'value' in paramDef.default) {
    return paramDef.default.value;
  }

  // Infer type from default.type if available
  const paramType = paramDef?.default && 'type' in paramDef.default
    ? paramDef.default.type
    : undefined;

  // Return type-appropriate defaults based on paramDef.default.type
  switch (paramType) {
    case 'float':
    case 'int':
      // Numeric param with bounds - use midpoint if available
      if (paramDef.min !== undefined && paramDef.max !== undefined) {
        return (paramDef.min + paramDef.max) / 2;
      }
      return 0;
    case 'bool':
      return false;
    case 'string':
      return '';
    case 'color':
      return [1, 1, 1, 1]; // Default white RGBA
    default:
      // Fallback: check if numeric bounds exist
      if (paramDef?.min !== undefined && paramDef?.max !== undefined) {
        return (paramDef.min + paramDef.max) / 2;
      }
      // Check for options (enum-like)
      if (paramDef?.options && paramDef.options.length > 0) {
        return paramDef.options[0];
      }
      return 0;
  }
}

// =============================================================================
// ColorWheels Helpers
// =============================================================================

/** Default ColorWheels values (all neutral) */
const DEFAULT_COLOR_WHEELS: ColorWheelsValues = {
  lift_r: 0,
  lift_g: 0,
  lift_b: 0,
  gamma_r: 0,
  gamma_g: 0,
  gamma_b: 0,
  gain_r: 0,
  gain_g: 0,
  gain_b: 0,
};

/**
 * Converts effect params to ColorWheelsValues.
 * Falls back to defaults for missing values.
 */
function paramsToColorWheelsValues(
  params: Record<string, SimpleParamValue> | undefined
): ColorWheelsValues {
  if (!params) return DEFAULT_COLOR_WHEELS;

  return {
    lift_r: typeof params.lift_r === 'number' ? params.lift_r : 0,
    lift_g: typeof params.lift_g === 'number' ? params.lift_g : 0,
    lift_b: typeof params.lift_b === 'number' ? params.lift_b : 0,
    gamma_r: typeof params.gamma_r === 'number' ? params.gamma_r : 0,
    gamma_g: typeof params.gamma_g === 'number' ? params.gamma_g : 0,
    gamma_b: typeof params.gamma_b === 'number' ? params.gamma_b : 0,
    gain_r: typeof params.gain_r === 'number' ? params.gain_r : 0,
    gain_g: typeof params.gain_g === 'number' ? params.gain_g : 0,
    gain_b: typeof params.gain_b === 'number' ? params.gain_b : 0,
  };
}

/**
 * Check if an effect is a ColorWheels effect.
 */
function isColorWheelsEffect(effectType: Effect['effectType']): boolean {
  return effectType === 'color_wheels';
}

// =============================================================================
// ChromaKey Helpers
// =============================================================================

/**
 * Check if an effect is a ChromaKey effect.
 */
function isChromaKeyEffect(effectType: Effect['effectType']): boolean {
  return effectType === 'chroma_key';
}

/**
 * Converts effect params to ChromaKeyParams for the ChromaKeyControl.
 * Maps backend param names (key_color, similarity, blend) to frontend names.
 */
function paramsToChromaKeyParams(
  params: Record<string, SimpleParamValue> | undefined
): Partial<ChromaKeyParams> {
  if (!params) return {};

  return {
    keyColor: typeof params.key_color === 'string' ? params.key_color : '#00FF00',
    similarity: typeof params.similarity === 'number' ? params.similarity : 0.3,
    softness: typeof params.blend === 'number' ? params.blend : 0.1,
    spillSuppression: typeof params.spill_suppression === 'number' ? params.spill_suppression : 0,
    edgeFeather: typeof params.edge_feather === 'number' ? params.edge_feather : 0,
  };
}

// =============================================================================
// Component
// =============================================================================

export const EffectInspector = memo(function EffectInspector({
  effect,
  paramDefs,
  onChange,
  onToggle,
  onDelete,
  onKeyframesChange,
  showKeyframes = false,
  currentTime = 0,
  duration = 10,
  readOnly = false,
  className = '',
}: EffectInspectorProps) {
  // Track which parameters have expanded keyframe editors
  const [expandedKeyframes, setExpandedKeyframes] = useState<Set<string>>(new Set());

  // Stable references to effect properties for callbacks
  const effectId = effect?.id;
  const effectParams = effect?.params;
  const effectKeyframes = effect?.keyframes;

  // Refs for debouncing and preventing stale closures
  const pendingChangesRef = useRef<Record<string, SimpleParamValue>>({});
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestParamsRef = useRef<Record<string, SimpleParamValue> | undefined>(effectParams);

  // Keep latestParamsRef in sync
  useEffect(() => {
    latestParamsRef.current = effectParams;
  }, [effectParams]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Get current param value or default
  const getParamValue = useCallback(
    (paramDef: ParamDef): SimpleParamValue => {
      if (!effectParams) return getDefaultValue(paramDef);
      const value = effectParams[paramDef.name];
      return value !== undefined ? value : getDefaultValue(paramDef);
    },
    [effectParams]
  );

  // Handle parameter change with debouncing and validation
  const handleParamChange = useCallback(
    (paramName: string, value: SimpleParamValue) => {
      if (!effectId) return;

      // Find param definition for validation
      const paramDef = paramDefs.find(p => p.name === paramName);
      const validatedValue = paramDef ? validateParamValue(value, paramDef) : value;

      // Accumulate pending changes
      pendingChangesRef.current[paramName] = validatedValue;

      // Clear existing timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      // Debounce the actual change propagation
      debounceTimerRef.current = setTimeout(() => {
        const currentParams = latestParamsRef.current ?? {};
        const newParams = { ...currentParams, ...pendingChangesRef.current };
        pendingChangesRef.current = {};
        onChange(effectId, newParams);
      }, PARAM_CHANGE_DEBOUNCE_MS);
    },
    [effectId, paramDefs, onChange]
  );

  // Stable reference to effect enabled state
  const effectEnabled = effect?.enabled;

  // Handle toggle with validation
  const handleToggle = useCallback(() => {
    if (!effectId || !onToggle || effectEnabled === undefined) return;
    onToggle(effectId, !effectEnabled);
  }, [effectId, effectEnabled, onToggle]);

  // Handle delete with confirmation guard
  const handleDelete = useCallback(() => {
    if (!effectId || !onDelete) return;
    onDelete(effectId);
  }, [effectId, onDelete]);

  // Handle reset to defaults
  const handleReset = useCallback(() => {
    if (!effectId) return;
    // Clear any pending debounced changes
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    pendingChangesRef.current = {};

    const defaultParams: Record<string, SimpleParamValue> = {};
    paramDefs.forEach((paramDef) => {
      defaultParams[paramDef.name] = getDefaultValue(paramDef);
    });
    onChange(effectId, defaultParams);
  }, [effectId, paramDefs, onChange]);

  // Toggle keyframe editor expansion for a parameter
  const handleToggleKeyframeEditor = useCallback((paramName: string) => {
    setExpandedKeyframes((prev) => {
      const next = new Set(prev);
      if (next.has(paramName)) {
        next.delete(paramName);
      } else {
        next.add(paramName);
      }
      return next;
    });
  }, []);

  // Handle keyframe changes for a parameter
  const handleKeyframesChange = useCallback(
    (paramName: string, keyframes: Keyframe[]) => {
      if (!effectId || !onKeyframesChange) return;
      onKeyframesChange(effectId, paramName, keyframes);
    },
    [effectId, onKeyframesChange]
  );

  // Check if a parameter has keyframes
  const hasKeyframes = useCallback(
    (paramName: string): boolean => {
      if (!effectKeyframes) return false;
      const kf = effectKeyframes[paramName];
      return kf !== undefined && kf.length > 0;
    },
    [effectKeyframes]
  );

  // Check if keyframe editor should be shown for a parameter
  const shouldShowKeyframeEditor = useCallback(
    (paramName: string): boolean => {
      return hasKeyframes(paramName) || expandedKeyframes.has(paramName);
    },
    [hasKeyframes, expandedKeyframes]
  );

  // Empty state
  if (!effect) {
    return (
      <div className={`flex flex-col h-full ${className}`} data-testid="effect-inspector">
        <div className="flex-1 flex flex-col items-center justify-center text-editor-text-muted p-4">
          <Sparkles className="w-8 h-8 mb-2 opacity-50" />
          <p className="text-sm">No effect selected</p>
          <p className="text-xs mt-1">Select an effect to view its parameters</p>
        </div>
      </div>
    );
  }

  const isAudio = isAudioEffect(effect.effectType);
  const effectLabel = getEffectLabel(effect.effectType);

  return (
    <div className={`flex flex-col h-full ${className}`} data-testid="effect-inspector">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-editor-border">
        <div className="flex items-center gap-2">
          {isAudio ? (
            <Music className="w-4 h-4 text-green-400" />
          ) : (
            <Sparkles className="w-4 h-4 text-purple-400" />
          )}
          <span className="text-sm font-medium text-editor-text">{effectLabel}</span>
        </div>

        {/* Enable Toggle */}
        <label className="flex items-center gap-2 cursor-pointer">
          <span className="text-xs text-editor-text-muted">Enabled</span>
          <input
            type="checkbox"
            checked={effect.enabled}
            onChange={handleToggle}
            disabled={readOnly}
            aria-label="Enabled"
            className="w-4 h-4 accent-primary-500 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          />
        </label>
      </div>

      {/* Parameters */}
      <div className="flex-1 overflow-auto p-3 space-y-2">
        {/* Special UI for ColorWheels effect */}
        {isColorWheelsEffect(effect.effectType) ? (
          <ColorWheelsPanel
            values={paramsToColorWheelsValues(effectParams)}
            onChange={(paramName: ColorWheelsParamName, value: number) => {
              handleParamChange(paramName, value);
            }}
            onReset={handleReset}
            readOnly={readOnly}
          />
        ) : isChromaKeyEffect(effect.effectType) ? (
          <ChromaKeyControl
            initialParams={paramsToChromaKeyParams(effectParams)}
            onChange={(chromaParams: ChromaKeyParams) => {
              // Route through handleParamChange for consistent debouncing
              handleParamChange('key_color', chromaParams.keyColor);
              handleParamChange('similarity', chromaParams.similarity);
              handleParamChange('blend', chromaParams.softness);
              handleParamChange('spill_suppression', chromaParams.spillSuppression);
              handleParamChange('edge_feather', chromaParams.edgeFeather);
            }}
            disabled={readOnly}
          />
        ) : paramDefs.length === 0 ? (
          <p className="text-sm text-editor-text-muted text-center py-4">
            No configurable parameters
          </p>
        ) : (
          paramDefs.map((paramDef) => (
            <div key={paramDef.name} className="space-y-1">
              <div className="flex items-center gap-1">
                <div className="flex-1">
                  <ParameterEditor
                    paramDef={paramDef}
                    value={getParamValue(paramDef)}
                    onChange={handleParamChange}
                    readOnly={readOnly}
                  />
                </div>
                {/* Keyframe toggle button */}
                {showKeyframes && (
                  <button
                    type="button"
                    onClick={() => handleToggleKeyframeEditor(paramDef.name)}
                    aria-label="Toggle keyframe editor"
                    className={`p-1 rounded transition-colors ${
                      hasKeyframes(paramDef.name)
                        ? 'text-yellow-400 hover:text-yellow-300'
                        : 'text-editor-text-muted hover:text-editor-text'
                    }`}
                  >
                    <Key className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {/* Keyframe Editor */}
              {showKeyframes && shouldShowKeyframeEditor(paramDef.name) && (
                <KeyframeEditor
                  paramDef={paramDef}
                  keyframes={effectKeyframes?.[paramDef.name] ?? []}
                  currentTime={currentTime}
                  duration={duration}
                  currentValue={getParamValue(paramDef) as number}
                  onChange={(keyframes) => handleKeyframesChange(paramDef.name, keyframes)}
                  readOnly={readOnly}
                />
              )}
            </div>
          ))
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between p-3 border-t border-editor-border">
        <button
          type="button"
          onClick={handleReset}
          disabled={readOnly}
          aria-label="Reset to defaults"
          className="flex items-center gap-1 px-2 py-1 text-xs text-editor-text-muted hover:text-editor-text rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset
        </button>

        {onDelete && !readOnly && (
          <button
            type="button"
            onClick={handleDelete}
            aria-label="Delete effect"
            className="flex items-center gap-1 px-2 py-1 text-xs text-red-400 hover:text-red-300 rounded transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </button>
        )}
      </div>
    </div>
  );
});
