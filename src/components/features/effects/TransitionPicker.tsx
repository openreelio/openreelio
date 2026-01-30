/**
 * TransitionPicker Component
 *
 * A specialized picker for selecting and configuring transitions between clips.
 * Supports various transition types with configurable duration, direction, and zoom type.
 *
 * State Management: Uses controlled component pattern with proper synchronization
 * to prevent race conditions between internal and external state.
 *
 * Security: All user inputs are validated and sanitized before use.
 */

import { memo, useState, useCallback, useRef, useEffect, type KeyboardEvent } from 'react';
import { Layers } from 'lucide-react';
import { EFFECT_TYPE_LABELS } from '@/types';

// =============================================================================
// Types
// =============================================================================

/** Transition types supported by this picker */
export type TransitionType = 'cross_dissolve' | 'fade' | 'wipe' | 'slide' | 'zoom';

/** Direction for wipe and slide transitions */
export type TransitionDirection = 'left' | 'right' | 'up' | 'down';

/** Zoom type for zoom transitions */
export type ZoomType = 'in' | 'out';

/** Configuration for a transition */
export interface TransitionConfig {
  type: TransitionType;
  duration: number;
  direction?: TransitionDirection;
  zoomType?: ZoomType;
}

export interface TransitionPickerProps {
  /** Additional CSS classes */
  className?: string;
  /** Currently selected transition type */
  selectedType?: TransitionType;
  /** Initial configuration */
  initialConfig?: TransitionConfig;
  /** Callback when a transition is selected */
  onSelect: (config: TransitionConfig) => void;
  /** Callback when picker is cancelled */
  onCancel?: () => void;
}

// =============================================================================
// Constants
// =============================================================================

const TRANSITION_TYPES: TransitionType[] = ['cross_dissolve', 'fade', 'wipe', 'slide', 'zoom'];

const TRANSITION_DESCRIPTIONS: Record<TransitionType, string> = {
  cross_dissolve: 'Smooth blend between clips',
  fade: 'Fade to/from black',
  wipe: 'Reveal with a moving edge',
  slide: 'Slide in from a direction',
  zoom: 'Zoom in or out transition',
};

const DIRECTIONS: TransitionDirection[] = ['left', 'right', 'up', 'down'];

const MIN_DURATION = 0.1;
const MAX_DURATION = 10;
const DEFAULT_DURATION = 1;

// =============================================================================
// Helper Functions
// =============================================================================

function needsDirection(type: TransitionType): boolean {
  return type === 'wipe' || type === 'slide';
}

function needsZoomType(type: TransitionType): boolean {
  return type === 'zoom';
}

function clampDuration(value: number): number {
  return Math.max(MIN_DURATION, Math.min(MAX_DURATION, value));
}

// =============================================================================
// Component
// =============================================================================

export const TransitionPicker = memo(function TransitionPicker({
  className = '',
  selectedType: externalSelectedType,
  initialConfig,
  onSelect,
  onCancel,
}: TransitionPickerProps) {
  // Track if we've mounted to distinguish initial render from updates
  const isMountedRef = useRef(false);
  const prevExternalTypeRef = useRef(externalSelectedType);

  // Compute initial values only once using refs to avoid stale closures
  const initialValuesRef = useRef({
    type: initialConfig?.type ?? externalSelectedType ?? 'cross_dissolve',
    duration: clampDuration(initialConfig?.duration ?? DEFAULT_DURATION),
    direction: initialConfig?.direction ?? 'left',
    zoomType: initialConfig?.zoomType ?? 'in',
  });

  // State with validated initial values
  const [selectedType, setSelectedType] = useState<TransitionType>(initialValuesRef.current.type);
  const [duration, setDuration] = useState<number>(initialValuesRef.current.duration);
  const [direction, setDirection] = useState<TransitionDirection>(initialValuesRef.current.direction);
  const [zoomType, setZoomType] = useState<ZoomType>(initialValuesRef.current.zoomType);

  // Sync with external prop changes using useEffect for proper React lifecycle management
  // This prevents race conditions that occurred with render-time state updates
  useEffect(() => {
    // Skip initial mount - we already set initial values in useState
    if (!isMountedRef.current) {
      isMountedRef.current = true;
      return;
    }

    // Only sync if external type actually changed to a different valid value
    if (
      externalSelectedType &&
      externalSelectedType !== prevExternalTypeRef.current &&
      TRANSITION_TYPES.includes(externalSelectedType)
    ) {
      prevExternalTypeRef.current = externalSelectedType;
      setSelectedType(externalSelectedType);
    }
  }, [externalSelectedType]);

  // Cleanup ref on unmount to prevent stale state
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Build current config
  const buildConfig = useCallback(
    (type: TransitionType): TransitionConfig => {
      const config: TransitionConfig = {
        type,
        duration: clampDuration(duration),
      };

      if (needsDirection(type)) {
        config.direction = direction;
      }

      if (needsZoomType(type)) {
        config.zoomType = zoomType;
      }

      return config;
    },
    [duration, direction, zoomType]
  );

  // Handlers
  const handleCardClick = useCallback(
    (type: TransitionType) => {
      setSelectedType(type);
      onSelect(buildConfig(type));
    },
    [buildConfig, onSelect]
  );

  const handleCardKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, type: TransitionType) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleCardClick(type);
      }
    },
    [handleCardClick]
  );

  const handleApply = useCallback(() => {
    onSelect(buildConfig(selectedType));
  }, [buildConfig, onSelect, selectedType]);

  // Store handleApply in a ref to avoid circular dependency
  const handleApplyRef = useRef(handleApply);
  handleApplyRef.current = handleApply;

  const handleDurationChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = e.target.value;
    // Allow empty string for typing
    if (rawValue === '' || rawValue === '-') {
      return;
    }
    const value = parseFloat(rawValue);
    // Validate numeric input with reasonable bounds to prevent overflow
    // Use 100x max to allow typing but prevent absurd values
    if (Number.isFinite(value) && Math.abs(value) <= MAX_DURATION * 100) {
      // Allow values outside range while typing, clamp on blur
      setDuration(value);
    }
  }, []);

  // Clamp duration on blur to ensure valid value is displayed
  const handleDurationBlur = useCallback(() => {
    setDuration((prev) => {
      // Handle invalid states
      if (!Number.isFinite(prev)) {
        return DEFAULT_DURATION;
      }
      return clampDuration(prev);
    });
  }, []);

  // Handle keyboard navigation for duration input
  const handleDurationKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    // Step up/down with arrow keys
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setDuration((prev) => clampDuration(prev + 0.1));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setDuration((prev) => clampDuration(prev - 0.1));
    } else if (e.key === 'Enter') {
      // Apply on Enter using ref to get latest handler
      handleApplyRef.current();
    } else if (e.key === 'Escape' && onCancel) {
      onCancel();
    }
  }, [onCancel]);

  // Determine which type to show config for
  const configType = externalSelectedType ?? selectedType;

  return (
    <div className={`flex flex-col h-full ${className}`} data-testid="transition-picker">
      {/* Header */}
      <div className="flex items-center gap-2 p-3 border-b border-editor-border">
        <Layers className="w-5 h-5 text-primary-500" />
        <h2 className="text-sm font-medium text-editor-text">Transitions</h2>
      </div>

      {/* Transition Cards */}
      <div className="flex-1 overflow-auto p-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {TRANSITION_TYPES.map((type) => {
            const isSelected = type === configType;
            const label = EFFECT_TYPE_LABELS[type] ?? type;
            const description = TRANSITION_DESCRIPTIONS[type];

            return (
              <div
                key={type}
                data-testid={`transition-card-${type}`}
                role="button"
                tabIndex={0}
                className={`
                  p-3 rounded-lg border cursor-pointer transition-all
                  ${
                    isSelected
                      ? 'ring-2 ring-primary-500 border-primary-500 bg-primary-500/10'
                      : 'border-editor-border hover:border-primary-400 hover:bg-editor-hover'
                  }
                `}
                onClick={() => handleCardClick(type)}
                onKeyDown={(e) => handleCardKeyDown(e, type)}
              >
                <div className="text-sm font-medium text-editor-text mb-1">{label}</div>
                <div className="text-xs text-editor-text-muted">{description}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Configuration Panel */}
      <div className="p-3 border-t border-editor-border space-y-3">
        {/* Duration */}
        <div className="flex items-center gap-3">
          <label htmlFor="transition-duration" className="text-sm text-editor-text w-20">
            Duration
          </label>
          <input
            id="transition-duration"
            type="number"
            step="0.1"
            min={MIN_DURATION}
            max={MAX_DURATION}
            value={duration}
            onChange={handleDurationChange}
            onBlur={handleDurationBlur}
            onKeyDown={handleDurationKeyDown}
            aria-describedby="duration-hint"
            className="flex-1 px-2 py-1 text-sm bg-editor-input border border-editor-border rounded text-editor-text focus:border-primary-500 focus:outline-none"
          />
          <span className="text-xs text-editor-text-muted">sec</span>
        </div>

        {/* Direction (for wipe/slide) */}
        {needsDirection(configType) && (
          <div className="flex items-center gap-3">
            <label htmlFor="transition-direction" className="text-sm text-editor-text w-20">
              Direction
            </label>
            <select
              id="transition-direction"
              value={direction}
              onChange={(e) => setDirection(e.target.value as TransitionDirection)}
              className="flex-1 px-2 py-1 text-sm bg-editor-input border border-editor-border rounded text-editor-text focus:border-primary-500 focus:outline-none"
            >
              {DIRECTIONS.map((dir) => (
                <option key={dir} value={dir}>
                  {dir.charAt(0).toUpperCase() + dir.slice(1)}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Zoom Type (for zoom) */}
        {needsZoomType(configType) && (
          <div className="flex items-center gap-3">
            <label htmlFor="transition-zoom-type" className="text-sm text-editor-text w-20">
              Zoom Type
            </label>
            <select
              id="transition-zoom-type"
              value={zoomType}
              onChange={(e) => setZoomType(e.target.value as ZoomType)}
              className="flex-1 px-2 py-1 text-sm bg-editor-input border border-editor-border rounded text-editor-text focus:border-primary-500 focus:outline-none"
            >
              <option value="in">Zoom In</option>
              <option value="out">Zoom Out</option>
            </select>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-2 p-3 border-t border-editor-border">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-editor-text hover:bg-editor-hover rounded transition-colors"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={handleApply}
          className="px-3 py-1.5 text-sm bg-primary-500 text-white hover:bg-primary-600 rounded transition-colors"
        >
          Apply
        </button>
      </div>
    </div>
  );
});
