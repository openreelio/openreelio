/**
 * useMaskEditor Hook
 *
 * Orchestrates mask editing state including selection, tools, and CRUD operations.
 * This is the main hook for the MaskEditor component.
 *
 * @module hooks/useMaskEditor
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  Mask,
  MaskId,
  MaskShape,
  ClipId,
  EffectId,
  SequenceId,
  TrackId,
  CommandResult,
} from '@/types';
import {
  createRectangleMask,
  createEllipseMask,
  createPolygonMask,
  createBezierMask,
} from './useMask';
import { createLogger } from '@/services/logger';

const logger = createLogger('useMaskEditor');

// =============================================================================
// Types
// =============================================================================

export type MaskTool = 'select' | 'rectangle' | 'ellipse' | 'polygon' | 'bezier';

export interface UseMaskEditorOptions {
  /** The clip these masks belong to */
  clipId: ClipId;
  /** The effect that holds the masks */
  effectId: EffectId;
  /** The sequence ID */
  sequenceId: SequenceId;
  /** The track ID */
  trackId: TrackId;
  /** Initial masks (overrides fetch) */
  initialMasks?: Mask[];
  /** Whether to fetch masks on mount */
  fetchOnMount?: boolean;
}

export interface UseMaskEditorResult {
  /** List of masks */
  masks: Mask[];
  /** Currently selected mask ID */
  selectedMaskId: MaskId | null;
  /** Currently selected mask object */
  selectedMask: Mask | null;
  /** Active drawing tool */
  activeTool: MaskTool;
  /** Set the active tool */
  setActiveTool: (tool: MaskTool) => void;
  /** Select a mask by ID */
  selectMask: (id: MaskId) => void;
  /** Clear selection */
  clearSelection: () => void;
  /** Add a new mask */
  addMask: (type: MaskShape['type'], name?: string) => Promise<MaskId | null>;
  /** Update a mask (syncs to backend) */
  updateMask: (id: MaskId, updates: Partial<Mask>) => Promise<boolean>;
  /** Update a mask locally (no backend sync) */
  updateMaskLocal: (id: MaskId, updates: Partial<Mask>) => void;
  /** Delete a mask */
  deleteMask: (id: MaskId) => Promise<boolean>;
  /** Toggle mask enabled state */
  toggleEnabled: (id: MaskId) => Promise<boolean>;
  /** Toggle mask locked state */
  toggleLocked: (id: MaskId) => Promise<boolean>;
  /** Reorder masks */
  reorderMasks: (fromIndex: number, toIndex: number) => void;
  /** Whether loading */
  isLoading: boolean;
  /** Whether performing an operation */
  isOperating: boolean;
  /** Current error */
  error: string | null;
  /** Clear error */
  clearError: () => void;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Creates a default mask shape for the given type.
 */
function createDefaultShape(type: MaskShape['type']): MaskShape {
  switch (type) {
    case 'rectangle':
      return createRectangleMask();
    case 'ellipse':
      return createEllipseMask();
    case 'polygon':
      return createPolygonMask();
    case 'bezier':
      return createBezierMask();
    default:
      return createRectangleMask();
  }
}

/**
 * Generates a default name for a new mask.
 */
function generateMaskName(existingMasks: Mask[]): string {
  const used = new Set(existingMasks.map((mask) => mask.name.trim().toLowerCase()));
  let index = existingMasks.length + 1;
  while (used.has(`mask ${index}`)) {
    index += 1;
  }
  return `Mask ${index}`;
}

/**
 * Ensures incoming update payload only contains fields accepted by UpdateMask.
 */
function toMaskUpdatePayload(updates: Partial<Mask>): Partial<Mask> {
  const payload: Partial<Mask> = {};

  if (updates.shape !== undefined && isValidMaskShape(updates.shape)) {
    payload.shape = updates.shape;
  }
  if (typeof updates.name === 'string' && updates.name.trim().length > 0) {
    payload.name = updates.name.trim();
  }
  if (typeof updates.feather === 'number' && Number.isFinite(updates.feather)) {
    payload.feather = Math.max(0, Math.min(1, updates.feather));
  }
  if (typeof updates.opacity === 'number' && Number.isFinite(updates.opacity)) {
    payload.opacity = Math.max(0, Math.min(1, updates.opacity));
  }
  if (typeof updates.expansion === 'number' && Number.isFinite(updates.expansion)) {
    payload.expansion = Math.max(-1, Math.min(1, updates.expansion));
  }
  if (typeof updates.inverted === 'boolean') {
    payload.inverted = updates.inverted;
  }
  if (
    updates.blendMode === 'add' ||
    updates.blendMode === 'subtract' ||
    updates.blendMode === 'intersect' ||
    updates.blendMode === 'difference'
  ) {
    payload.blendMode = updates.blendMode;
  }
  if (typeof updates.enabled === 'boolean') {
    payload.enabled = updates.enabled;
  }
  if (typeof updates.locked === 'boolean') {
    payload.locked = updates.locked;
  }

  return payload;
}

function hasOwnProperties(obj: object): boolean {
  return Object.keys(obj).length > 0;
}

function isValidMaskShape(value: unknown): value is MaskShape {
  if (!value || typeof value !== 'object') return false;
  const shape = value as MaskShape;
  return (
    shape.type === 'rectangle' ||
    shape.type === 'ellipse' ||
    shape.type === 'polygon' ||
    shape.type === 'bezier'
  );
}

function normalizeFetchedMask(raw: unknown): Mask | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<Mask>;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;
  if (!isValidMaskShape(candidate.shape)) return null;

  return {
    id: candidate.id,
    name: typeof candidate.name === 'string' && candidate.name.length > 0 ? candidate.name : 'Mask',
    shape: candidate.shape,
    inverted: typeof candidate.inverted === 'boolean' ? candidate.inverted : false,
    feather: typeof candidate.feather === 'number' ? candidate.feather : 0,
    opacity: typeof candidate.opacity === 'number' ? candidate.opacity : 1,
    expansion: typeof candidate.expansion === 'number' ? candidate.expansion : 0,
    blendMode:
      candidate.blendMode === 'add' ||
      candidate.blendMode === 'subtract' ||
      candidate.blendMode === 'intersect' ||
      candidate.blendMode === 'difference'
        ? candidate.blendMode
        : 'add',
    enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : true,
    locked: typeof candidate.locked === 'boolean' ? candidate.locked : false,
  };
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useMaskEditor({
  clipId,
  effectId,
  sequenceId,
  trackId,
  initialMasks,
  fetchOnMount = false,
}: UseMaskEditorOptions): UseMaskEditorResult {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [masks, setMasks] = useState<Mask[]>(initialMasks ?? []);
  const [selectedMaskId, setSelectedMaskId] = useState<MaskId | null>(null);
  const [activeTool, setActiveTool] = useState<MaskTool>('rectangle');
  const [isLoading, setIsLoading] = useState(false);
  const [isOperating, setIsOperating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const masksRef = useRef<Mask[]>(initialMasks ?? []);
  const activeOperationCountRef = useRef(0);

  const beginOperation = useCallback(() => {
    activeOperationCountRef.current += 1;
    setIsOperating(true);
  }, []);

  const endOperation = useCallback(() => {
    activeOperationCountRef.current = Math.max(0, activeOperationCountRef.current - 1);
    if (activeOperationCountRef.current === 0) {
      setIsOperating(false);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Computed State
  // ---------------------------------------------------------------------------

  const selectedMask = useMemo(
    () => masks.find((m) => m.id === selectedMaskId) ?? null,
    [masks, selectedMaskId]
  );

  useEffect(() => {
    masksRef.current = masks;
  }, [masks]);

  // ---------------------------------------------------------------------------
  // Fetch Masks on Mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!fetchOnMount || (initialMasks?.length ?? 0) > 0) {
      return;
    }

    let cancelled = false;

    const fetchMasks = async () => {
      setIsLoading(true);
      setError(null);

      try {
        logger.debug('Fetching masks', { effectId });

        const fetchedMasks = await invoke<unknown>('get_effect_masks', {
          effectId,
        });
        const normalizedMasks = Array.isArray(fetchedMasks)
          ? fetchedMasks
              .map((mask) => normalizeFetchedMask(mask))
              .filter((mask): mask is Mask => mask !== null)
          : [];

        if (cancelled) return;
        setMasks(normalizedMasks);
        logger.info('Masks loaded', { effectId, count: normalizedMasks.length });
      } catch (err) {
        if (cancelled) return;
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to fetch masks', { error: err, effectId });
        setError(errorMsg);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    fetchMasks();

    return () => {
      cancelled = true;
    };
  }, [effectId, fetchOnMount, initialMasks?.length]);

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  const selectMask = useCallback((id: MaskId) => {
    setSelectedMaskId((current) => (current === id ? null : id));
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedMaskId(null);
  }, []);

  // ---------------------------------------------------------------------------
  // Add Mask
  // ---------------------------------------------------------------------------

  const addMask = useCallback(
    async (type: MaskShape['type'], name?: string): Promise<MaskId | null> => {
      beginOperation();
      setError(null);

      try {
        const shape = createDefaultShape(type);
        const maskName = name ?? generateMaskName(masksRef.current);

        logger.debug('Adding mask', { effectId, type, name: maskName });

        const result = await invoke<CommandResult>('execute_command', {
          commandType: 'AddMask',
          payload: {
            sequenceId,
            trackId,
            clipId,
            effectId,
            shape,
            name: maskName,
          },
        });

        const newMaskId = result.createdIds?.[0] ?? null;

        if (newMaskId) {
          // Create local mask object
          const newMask: Mask = {
            id: newMaskId,
            name: maskName,
            shape,
            inverted: false,
            feather: 0,
            opacity: 1,
            expansion: 0,
            blendMode: 'add',
            enabled: true,
            locked: false,
          };

          setMasks((prev) => [...prev, newMask]);
          setSelectedMaskId(newMaskId);

          logger.info('Mask added', { maskId: newMaskId });
        }

        return newMaskId;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to add mask', { error: err });
        setError(errorMsg);
        return null;
      } finally {
        endOperation();
      }
    },
    [effectId, sequenceId, trackId, clipId, beginOperation, endOperation]
  );

  // ---------------------------------------------------------------------------
  // Update Mask
  // ---------------------------------------------------------------------------

  const updateMask = useCallback(
    async (id: MaskId, updates: Partial<Mask>): Promise<boolean> => {
      // Find the mask
      const mask = masksRef.current.find((m) => m.id === id);
      if (!mask) {
        logger.warn('Mask not found for update', { maskId: id });
        return false;
      }

      // Don't update locked masks
      if (mask.locked) {
        logger.debug('Cannot update locked mask', { maskId: id });
        return false;
      }

      const payload = toMaskUpdatePayload(updates);
      if (!hasOwnProperties(payload)) {
        logger.debug('Skipping empty mask update payload', { maskId: id });
        return true;
      }

      beginOperation();
      setError(null);

      try {
        logger.debug('Updating mask', { effectId, maskId: id, updates });

        await invoke<CommandResult>('execute_command', {
          commandType: 'UpdateMask',
          payload: {
            effectId,
            maskId: id,
            ...payload,
          },
        });

        // Update local state
        setMasks((prev) =>
          prev.map((m) => (m.id === id ? { ...m, ...payload } : m))
        );

        logger.info('Mask updated', { maskId: id });
        return true;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to update mask', { error: err, maskId: id });
        setError(errorMsg);
        return false;
      } finally {
        endOperation();
      }
    },
    [effectId, beginOperation, endOperation]
  );

  const updateMaskLocal = useCallback((id: MaskId, updates: Partial<Mask>) => {
    const payload = toMaskUpdatePayload(updates);
    if (!hasOwnProperties(payload)) {
      return;
    }
    setMasks((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...payload } : m))
    );
  }, []);

  // ---------------------------------------------------------------------------
  // Delete Mask
  // ---------------------------------------------------------------------------

  const deleteMask = useCallback(
    async (id: MaskId): Promise<boolean> => {
      // Find the mask
      const mask = masksRef.current.find((m) => m.id === id);
      if (!mask) {
        logger.warn('Mask not found for deletion', { maskId: id });
        return false;
      }

      // Don't delete locked masks
      if (mask.locked) {
        logger.debug('Cannot delete locked mask', { maskId: id });
        return false;
      }

      beginOperation();
      setError(null);

      try {
        logger.debug('Deleting mask', { effectId, maskId: id });

        await invoke<CommandResult>('execute_command', {
          commandType: 'RemoveMask',
          payload: {
            effectId,
            maskId: id,
          },
        });

        // Remove from local state
        setMasks((prev) => prev.filter((m) => m.id !== id));

        // Clear selection if deleted mask was selected
        setSelectedMaskId((current) => (current === id ? null : current));

        logger.info('Mask deleted', { maskId: id });
        return true;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to delete mask', { error: err, maskId: id });
        setError(errorMsg);
        return false;
      } finally {
        endOperation();
      }
    },
    [effectId, beginOperation, endOperation]
  );

  // ---------------------------------------------------------------------------
  // Toggle Enabled/Locked
  // ---------------------------------------------------------------------------

  const toggleEnabled = useCallback(
    async (id: MaskId): Promise<boolean> => {
      const mask = masksRef.current.find((m) => m.id === id);
      if (!mask) return false;

      return updateMask(id, { enabled: !mask.enabled });
    },
    [updateMask]
  );

  const toggleLocked = useCallback(
    async (id: MaskId): Promise<boolean> => {
      const mask = masksRef.current.find((m) => m.id === id);
      if (!mask) return false;

      // Toggle lock is a special case - it should always be allowed
      // regardless of current lock state (otherwise we could never unlock)
      beginOperation();
      setError(null);

      try {
        const newLockedState = !mask.locked;
        logger.debug('Toggling mask lock', { effectId, maskId: id, newLockedState });

        await invoke<CommandResult>('execute_command', {
          commandType: 'UpdateMask',
          payload: {
            effectId,
            maskId: id,
            locked: newLockedState,
          },
        });

        // Update local state
        setMasks((prev) =>
          prev.map((m) => (m.id === id ? { ...m, locked: newLockedState } : m))
        );

        logger.info('Mask lock toggled', { maskId: id, locked: newLockedState });
        return true;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to toggle mask lock', { error: err, maskId: id });
        setError(errorMsg);
        return false;
      } finally {
        endOperation();
      }
    },
    [effectId, beginOperation, endOperation]
  );

  // ---------------------------------------------------------------------------
  // Reorder Masks
  // ---------------------------------------------------------------------------

  const reorderMasks = useCallback((fromIndex: number, toIndex: number) => {
    setMasks((prev) => {
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= prev.length ||
        toIndex >= prev.length ||
        fromIndex === toIndex
      ) {
        logger.warn('Invalid mask reorder indices', { fromIndex, toIndex, count: prev.length });
        return prev;
      }

      const result = [...prev];
      const [removed] = result.splice(fromIndex, 1);
      if (!removed) {
        return prev;
      }
      result.splice(toIndex, 0, removed);
      return result;
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Clear Error
  // ---------------------------------------------------------------------------

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    masks,
    selectedMaskId,
    selectedMask,
    activeTool,
    setActiveTool,
    selectMask,
    clearSelection,
    addMask,
    updateMask,
    updateMaskLocal,
    deleteMask,
    toggleEnabled,
    toggleLocked,
    reorderMasks,
    isLoading,
    isOperating,
    error,
    clearError,
  };
}

export default useMaskEditor;
