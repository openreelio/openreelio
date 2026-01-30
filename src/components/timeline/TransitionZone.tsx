/**
 * TransitionZone Component
 *
 * Displays a clickable zone between adjacent clips for adding or editing transitions.
 * Shows transition indicator when a transition effect is applied.
 *
 * Accessibility: Fully keyboard navigable with proper ARIA labels and focus management.
 * Security: All dynamic content is sanitized to prevent XSS.
 */

import { memo, useCallback, useMemo, type KeyboardEvent, type MouseEvent } from 'react';
import { Layers, X, Plus } from 'lucide-react';
import type { Clip, Effect, EffectId } from '@/types';
import { EFFECT_TYPE_LABELS } from '@/types';

// =============================================================================
// Security Helpers
// =============================================================================

/**
 * Sanitizes a string for safe display (XSS prevention).
 * Removes potentially dangerous characters while preserving readability.
 * Note: React auto-escapes text content, but this provides defense-in-depth
 * and is useful if the value is used in non-React contexts (e.g., aria-label).
 */
function sanitizeLabel(input: string): string {
  if (typeof input !== 'string') return '';

  return input
    // Remove HTML/script tags and angle brackets
    .replace(/[<>]/g, '')
    // Remove potential script protocol injections
    .replace(/javascript:/gi, '')
    .replace(/data:/gi, '')
    .replace(/vbscript:/gi, '')
    // Remove event handlers (onXxx patterns)
    .replace(/on\w+\s*=/gi, '')
    // Escape HTML entities for safe display
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    // Remove control characters that could cause rendering issues
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, '')
    // Limit length to prevent memory issues
    .slice(0, 100);
}

/**
 * Validates and clamps a numeric value to a safe range.
 */
function safeNumber(value: unknown, fallback: number, min?: number, max?: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  if (min !== undefined && num < min) return min;
  if (max !== undefined && num > max) return max;
  return num;
}

// =============================================================================
// Types
// =============================================================================

export interface TransitionZoneProps {
  /** First clip (before the junction) */
  clipA: Clip;
  /** Second clip (after the junction) */
  clipB: Clip;
  /** Zoom level (pixels per second) */
  zoom: number;
  /** Existing transition effect between clips */
  transition?: Effect;
  /** Zone width in pixels (default 24) */
  width?: number;
  /** Gap tolerance in seconds for considering clips adjacent (default 0.1) */
  gapTolerance?: number;
  /** Whether zone is always visible (default: hover reveal) */
  alwaysVisible?: boolean;
  /** Whether the zone is selected */
  selected?: boolean;
  /** Whether interactions are disabled */
  disabled?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Click handler */
  onClick?: (clipAId: string, clipBId: string) => void;
  /** Double-click handler */
  onDoubleClick?: (clipAId: string, clipBId: string) => void;
  /** Delete transition handler */
  onDelete?: (effectId: EffectId) => void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_ZONE_WIDTH = 24;
const DEFAULT_GAP_TOLERANCE = 0.1; // 100ms

// Standardized numeric bounds for consistent clamping across calculations
const ZOOM_MIN = 1;
const ZOOM_MAX = 10000;
const POSITION_MAX = 1e7; // 10 million pixels - reasonable max for timeline
const TRANSITION_WIDTH_MAX = 10000; // Max visual width for transition indicator

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if two clips are adjacent (touching or overlapping within tolerance)
 */
function areClipsAdjacent(clipA: Clip, clipB: Clip, tolerance: number): boolean {
  const clipAEnd = clipA.place.timelineInSec + clipA.place.durationSec;
  const clipBStart = clipB.place.timelineInSec;
  const gap = clipBStart - clipAEnd;

  // Adjacent if gap is within tolerance (including negative for overlap)
  return gap <= tolerance;
}

/**
 * Get junction point between two clips in seconds
 */
function getJunctionPoint(clipA: Clip, clipB: Clip): number {
  const clipAEnd = clipA.place.timelineInSec + clipA.place.durationSec;
  const clipBStart = clipB.place.timelineInSec;
  // Return the midpoint if overlapping, otherwise clipA end
  return clipAEnd <= clipBStart ? clipAEnd : (clipAEnd + clipBStart) / 2;
}

/**
 * Get transition label from effect type (sanitized for safe display)
 */
function getTransitionLabel(effect: Effect): string {
  const effectType = effect.effectType;
  if (typeof effectType === 'object' && 'custom' in effectType) {
    return sanitizeLabel(effectType.custom);
  }
  const label = EFFECT_TYPE_LABELS[effectType];
  return label ? sanitizeLabel(label) : sanitizeLabel(String(effectType));
}

/**
 * Get transition duration from effect params (validated and clamped)
 */
function getTransitionDuration(effect: Effect): number {
  const duration = effect.params.duration;
  // Clamp to reasonable range: 0.1s to 30s
  return safeNumber(duration, 1.0, 0.1, 30);
}

// =============================================================================
// Component
// =============================================================================

export const TransitionZone = memo(function TransitionZone({
  clipA,
  clipB,
  zoom,
  transition,
  width = DEFAULT_ZONE_WIDTH,
  gapTolerance = DEFAULT_GAP_TOLERANCE,
  alwaysVisible = false,
  selected = false,
  disabled = false,
  className = '',
  onClick,
  onDoubleClick,
  onDelete,
}: TransitionZoneProps) {
  // Validate inputs with safe defaults using standardized bounds
  const safeZoom = safeNumber(zoom, 100, ZOOM_MIN, ZOOM_MAX);
  const safeWidth = safeNumber(width, DEFAULT_ZONE_WIDTH, 8, 200);
  const safeTolerance = safeNumber(gapTolerance, DEFAULT_GAP_TOLERANCE, 0, 10);

  // All hooks must be called unconditionally at the top of the component
  // Handlers with validation
  const handleClick = useCallback(
    (e: MouseEvent) => {
      if (disabled) return;
      e.stopPropagation();
      // Validate clip IDs exist before calling handler
      if (clipA?.id && clipB?.id) {
        onClick?.(clipA.id, clipB.id);
      }
    },
    [disabled, onClick, clipA?.id, clipB?.id]
  );

  const handleDoubleClick = useCallback(
    (e: MouseEvent) => {
      if (disabled) return;
      e.stopPropagation();
      if (clipA?.id && clipB?.id) {
        onDoubleClick?.(clipA.id, clipB.id);
      }
    },
    [disabled, onDoubleClick, clipA?.id, clipB?.id]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (disabled) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (clipA?.id && clipB?.id) {
          onClick?.(clipA.id, clipB.id);
        }
      }
      // Escape to blur
      if (e.key === 'Escape') {
        (e.target as HTMLElement)?.blur?.();
      }
    },
    [disabled, onClick, clipA?.id, clipB?.id]
  );

  const handleDeleteClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (transition?.id) {
        onDelete?.(transition.id);
      }
    },
    [onDelete, transition?.id]
  );

  // Calculate ARIA label for screen readers
  const ariaLabel = useMemo(() => {
    if (transition) {
      const label = getTransitionLabel(transition);
      const duration = getTransitionDuration(transition);
      return `${label} transition, ${duration.toFixed(1)} seconds. Press Enter to edit, Delete to remove.`;
    }
    return 'Add transition between clips. Press Enter to add.';
  }, [transition]);

  // Check if clips are adjacent - early return AFTER all hooks
  if (!clipA?.place || !clipB?.place || !areClipsAdjacent(clipA, clipB, safeTolerance)) {
    return null;
  }

  // Calculate position with validation using standardized bounds
  const junctionSec = getJunctionPoint(clipA, clipB);
  const junctionPx = safeNumber(junctionSec * safeZoom, 0, 0, POSITION_MAX);
  const leftPx = Math.max(0, junctionPx - safeWidth / 2);

  // Transition info with consistent bounds
  const hasTransition = transition !== undefined && transition !== null;
  const transitionLabel = hasTransition ? getTransitionLabel(transition) : '';
  const transitionDuration = hasTransition ? getTransitionDuration(transition) : 0;
  // Use consistent max bound for visual width calculation
  const transitionWidthPx = safeNumber(transitionDuration * safeZoom, 0, 0, TRANSITION_WIDTH_MAX);

  // Visibility
  const isVisible = alwaysVisible || hasTransition;

  return (
    <div
      data-testid="transition-zone"
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-disabled={disabled}
      aria-pressed={selected}
      className={`
        absolute top-0 h-full flex items-center justify-center
        transition-opacity duration-150
        ${isVisible ? 'opacity-100' : 'opacity-0 hover:opacity-100'}
        ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}
        ${selected ? 'ring-2 ring-primary-500 ring-inset' : ''}
        ${className}
      `}
      style={{
        left: `${leftPx}px`,
        width: `${safeWidth}px`,
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    >
      {hasTransition ? (
        /* Transition indicator */
        <div
          data-testid="transition-indicator"
          className="absolute flex flex-col items-center justify-center bg-primary-500/20 border border-primary-500/50 rounded"
          style={{
            width: `${transitionWidthPx}px`,
            height: '100%',
            left: `${(width - transitionWidthPx) / 2}px`,
          }}
        >
          <Layers className="w-3.5 h-3.5 text-primary-400 mb-0.5" />
          <span className="text-[10px] text-primary-400 font-medium truncate max-w-full px-1">
            {transitionLabel}
          </span>
          <span className="text-[9px] text-primary-300">{transitionDuration.toFixed(1)}s</span>

          {/* Delete button */}
          {onDelete && !disabled && (
            <button
              type="button"
              onClick={handleDeleteClick}
              aria-label="Delete transition"
              className="absolute -top-1 -right-1 p-0.5 bg-red-500 rounded-full text-white hover:bg-red-600 transition-colors"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          )}
        </div>
      ) : (
        /* Add transition icon */
        <div
          data-testid="add-transition-icon"
          className="flex items-center justify-center w-5 h-5 rounded-full bg-editor-bg border border-editor-border hover:border-primary-500 hover:bg-primary-500/10 transition-colors"
        >
          <Plus className="w-3 h-3 text-editor-text-muted" />
        </div>
      )}
    </div>
  );
});
