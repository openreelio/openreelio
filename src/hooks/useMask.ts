/**
 * useMask Hook
 *
 * Hook for mask (Power Windows) CRUD operations.
 * Provides functions to add, update, and remove masks from effects.
 */

import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  SequenceId,
  TrackId,
  ClipId,
  EffectId,
  MaskId,
  MaskShape,
  MaskBlendMode,
  Point2D,
  BezierPoint,
  CommandResult,
} from '@/types';
import { createLogger } from '@/services/logger';

const logger = createLogger('useMask');

// =============================================================================
// Constants
// =============================================================================

/** Default mask position (center) */
const DEFAULT_CENTER_X = 0.5;
const DEFAULT_CENTER_Y = 0.5;

/** Default rectangle size */
const DEFAULT_RECT_WIDTH = 0.5;
const DEFAULT_RECT_HEIGHT = 0.5;

/** Default ellipse radii */
const DEFAULT_ELLIPSE_RADIUS_X = 0.25;
const DEFAULT_ELLIPSE_RADIUS_Y = 0.25;

// =============================================================================
// Types
// =============================================================================

export interface AddMaskPayload {
  sequenceId: SequenceId;
  trackId: TrackId;
  clipId: ClipId;
  effectId: EffectId;
  shape: MaskShape;
  name?: string;
  feather?: number;
  inverted?: boolean;
}

export interface UpdateMaskPayload {
  effectId: EffectId;
  maskId: MaskId;
  shape?: MaskShape;
  name?: string;
  feather?: number;
  opacity?: number;
  expansion?: number;
  inverted?: boolean;
  blendMode?: MaskBlendMode;
  enabled?: boolean;
  locked?: boolean;
}

export interface RemoveMaskPayload {
  effectId: EffectId;
  maskId: MaskId;
}

export interface UseMaskResult {
  /** Add a new mask to an effect */
  addMask: (payload: AddMaskPayload) => Promise<MaskId | null>;
  /** Update an existing mask */
  updateMask: (payload: UpdateMaskPayload) => Promise<boolean>;
  /** Remove a mask from an effect */
  removeMask: (payload: RemoveMaskPayload) => Promise<boolean>;
  /** Whether an add operation is in progress */
  isAdding: boolean;
  /** Whether an update operation is in progress */
  isUpdating: boolean;
  /** Whether a remove operation is in progress */
  isRemoving: boolean;
  /** Current error message */
  error: string | null;
  /** Clear the error state */
  clearError: () => void;
}

// =============================================================================
// Shape Factories
// =============================================================================

// =============================================================================
// Specific Shape Types (for factory return types)
// =============================================================================

/** Rectangle mask shape with type discriminant */
export type RectangleMaskShape = Extract<MaskShape, { type: 'rectangle' }>;

/** Ellipse mask shape with type discriminant */
export type EllipseMaskShape = Extract<MaskShape, { type: 'ellipse' }>;

/** Polygon mask shape with type discriminant */
export type PolygonMaskShape = Extract<MaskShape, { type: 'polygon' }>;

/** Bezier mask shape with type discriminant */
export type BezierMaskShape = Extract<MaskShape, { type: 'bezier' }>;

// =============================================================================
// Shape Factory Functions
// =============================================================================

/**
 * Creates a rectangle mask shape with default or custom values.
 */
export function createRectangleMask(
  x = DEFAULT_CENTER_X,
  y = DEFAULT_CENTER_Y,
  width = DEFAULT_RECT_WIDTH,
  height = DEFAULT_RECT_HEIGHT
): RectangleMaskShape {
  return {
    type: 'rectangle',
    x,
    y,
    width,
    height,
    cornerRadius: 0,
    rotation: 0,
  };
}

/**
 * Creates an ellipse mask shape with default or custom values.
 */
export function createEllipseMask(
  x = DEFAULT_CENTER_X,
  y = DEFAULT_CENTER_Y,
  radiusX = DEFAULT_ELLIPSE_RADIUS_X,
  radiusY = DEFAULT_ELLIPSE_RADIUS_Y
): EllipseMaskShape {
  return {
    type: 'ellipse',
    x,
    y,
    radiusX,
    radiusY,
    rotation: 0,
  };
}

/**
 * Creates a polygon mask shape with provided points.
 * If no points provided, creates a default centered triangle.
 */
export function createPolygonMask(points?: Point2D[]): PolygonMaskShape {
  const defaultTriangle: Point2D[] = [
    { x: 0.5, y: 0.3 },
    { x: 0.7, y: 0.7 },
    { x: 0.3, y: 0.7 },
  ];

  return {
    type: 'polygon',
    points: points ?? defaultTriangle,
  };
}

/**
 * Creates a bezier mask shape with provided control points.
 * If no points provided, creates a default simple curve.
 */
export function createBezierMask(
  points?: BezierPoint[],
  closed = true
): BezierMaskShape {
  const defaultCurve: BezierPoint[] = [
    { anchor: { x: 0.3, y: 0.5 }, handleOut: { x: 0.4, y: 0.2 } },
    { anchor: { x: 0.7, y: 0.5 }, handleIn: { x: 0.6, y: 0.2 } },
  ];

  return {
    type: 'bezier',
    points: points ?? defaultCurve,
    closed,
  };
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useMask(): UseMaskResult {
  const [isAdding, setIsAdding] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Add a new mask to an effect
   */
  const addMask = useCallback(
    async (payload: AddMaskPayload): Promise<MaskId | null> => {
      setIsAdding(true);
      setError(null);

      try {
        logger.debug('Adding mask', {
          effectId: payload.effectId,
          shapeType: payload.shape.type,
        });

        const result = await invoke<CommandResult>('execute_command', {
          commandType: 'AddMask',
          payload,
        });

        const createdId = result.createdIds?.[0] ?? null;
        logger.info('Mask added successfully', { maskId: createdId });

        return createdId;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to add mask', { error: err });
        setError(errorMsg);
        return null;
      } finally {
        setIsAdding(false);
      }
    },
    []
  );

  /**
   * Update an existing mask
   */
  const updateMask = useCallback(
    async (payload: UpdateMaskPayload): Promise<boolean> => {
      setIsUpdating(true);
      setError(null);

      try {
        logger.debug('Updating mask', {
          effectId: payload.effectId,
          maskId: payload.maskId,
        });

        await invoke<CommandResult>('execute_command', {
          commandType: 'UpdateMask',
          payload,
        });

        logger.info('Mask updated successfully', { maskId: payload.maskId });
        return true;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to update mask', { error: err, maskId: payload.maskId });
        setError(errorMsg);
        return false;
      } finally {
        setIsUpdating(false);
      }
    },
    []
  );

  /**
   * Remove a mask from an effect
   */
  const removeMask = useCallback(
    async (payload: RemoveMaskPayload): Promise<boolean> => {
      setIsRemoving(true);
      setError(null);

      try {
        logger.debug('Removing mask', {
          effectId: payload.effectId,
          maskId: payload.maskId,
        });

        await invoke<CommandResult>('execute_command', {
          commandType: 'RemoveMask',
          payload,
        });

        logger.info('Mask removed successfully', { maskId: payload.maskId });
        return true;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to remove mask', { error: err, maskId: payload.maskId });
        setError(errorMsg);
        return false;
      } finally {
        setIsRemoving(false);
      }
    },
    []
  );

  /**
   * Clear the error state
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    addMask,
    updateMask,
    removeMask,
    isAdding,
    isUpdating,
    isRemoving,
    error,
    clearError,
  };
}

export default useMask;
