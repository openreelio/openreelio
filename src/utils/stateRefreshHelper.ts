/**
 * State Refresh Helper
 *
 * Provides utilities for fetching and transforming project state from the backend.
 * Used by projectStore to refresh frontend state after command execution.
 *
 * This helper centralizes the pattern of fetching project state and transforming
 * it into the format expected by the Zustand store.
 */

import { invoke } from '@tauri-apps/api/core';
import type { Asset, Sequence } from '@/types';

/**
 * Raw project state returned from the backend.
 */
export interface BackendProjectState {
  assets: Asset[];
  sequences: Sequence[];
  activeSequenceId: string | null;
}

/**
 * Transformed project state for direct use in Zustand store.
 */
export interface TransformedProjectState {
  assets: Map<string, Asset>;
  sequences: Map<string, Sequence>;
  activeSequenceId: string | null;
}

/**
 * Fetches the current project state from the backend.
 *
 * @returns Raw project state from backend
 * @throws Error if IPC call fails or no project is open
 */
export async function fetchProjectState(): Promise<BackendProjectState> {
  return invoke<BackendProjectState>('get_project_state');
}

/**
 * Transforms backend project state arrays into Map structures
 * for efficient lookups in the frontend store.
 *
 * @param state - Raw project state from backend
 * @returns Transformed state with Map structures
 */
export function transformProjectState(state: BackendProjectState): TransformedProjectState {
  const assets = new Map<string, Asset>();
  for (const asset of state.assets) {
    assets.set(asset.id, asset);
  }

  const sequences = new Map<string, Sequence>();
  for (const sequence of state.sequences) {
    sequences.set(sequence.id, sequence);
  }

  return {
    assets,
    sequences,
    activeSequenceId: state.activeSequenceId,
  };
}

/**
 * Fetches and transforms project state from the backend in a single operation.
 *
 * This is a convenience function that combines fetchProjectState and
 * transformProjectState for common use cases.
 *
 * @returns Transformed project state ready for store update
 * @throws Error if IPC call fails or no project is open
 */
export async function refreshProjectState(): Promise<TransformedProjectState> {
  const state = await fetchProjectState();
  return transformProjectState(state);
}

/**
 * Applies transformed project state to a Zustand draft state.
 *
 * Use this within Immer's set() callback to update the store
 * with fresh backend data.
 *
 * @param draft - Zustand Immer draft state to update (must have assets, sequences, activeSequenceId)
 * @param state - Transformed project state to apply
 *
 * @example
 * ```typescript
 * const freshState = await refreshProjectState();
 * set((draft) => {
 *   applyProjectState(draft, freshState);
 *   draft.isDirty = true;
 * });
 * ```
 */
export function applyProjectState(
  draft: {
    assets: Map<string, Asset>;
    sequences: Map<string, Sequence>;
    activeSequenceId: string | null;
  },
  state: TransformedProjectState,
): void {
  draft.assets = state.assets;
  draft.sequences = state.sequences;
  draft.activeSequenceId = state.activeSequenceId;
}
