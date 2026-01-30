/**
 * useAudioEffectChain Hook
 *
 * Manages a chain of Web Audio effect nodes for real-time audio preview.
 * Creates, connects, and updates effect nodes based on effect definitions.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Effect, EffectType } from '@/types';
import {
  createAudioEffectNode,
  updateAudioEffectNode,
  getEffectNodeType,
  type AudioEffectNode,
  type EffectNodeConfig,
} from '@/services/audioEffectFactory';

// =============================================================================
// Types
// =============================================================================

export interface UseAudioEffectChainProps {
  /** Array of effects to apply */
  effects: Effect[];
  /** AudioContext instance (null if not available) */
  audioContext: AudioContext | null;
}

export interface UseAudioEffectChainResult {
  /** Array of created effect nodes */
  effectNodes: AudioEffectNode[];
  /** Input node to connect source to (first in chain) */
  chainInput: AudioNode | null;
  /** Output node to connect to destination (last in chain) */
  chainOutput: AudioNode | null;
  /** Update a specific effect parameter */
  updateEffect: (effectId: string, paramName: string, value: number) => void;
  /** Toggle an effect on/off */
  toggleEffect: (effectId: string, enabled: boolean) => void;
  /** Check if an effect type is supported for real-time preview */
  isEffectSupported: (effectType: string) => boolean;
}

// =============================================================================
// Internal Types
// =============================================================================

interface EffectNodeEntry {
  effectId: string;
  effectNode: AudioEffectNode;
  params: Record<string, number>;
}

function toEffectTypeId(effectType: EffectType): string {
  if (typeof effectType === 'string') return effectType;
  return effectType.custom;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useAudioEffectChain({
  effects,
  audioContext,
}: UseAudioEffectChainProps): UseAudioEffectChainResult {
  // Track effect nodes by ID
  const [nodeEntries, setNodeEntries] = useState<EffectNodeEntry[]>([]);

  // Reference to bypass node (used when no effects or no context)
  const bypassNodeRef = useRef<GainNode | null>(null);

  // Memoize sorted and filtered effects
  const sortedEffects = useMemo(() => {
    return [...effects]
      .filter((e) => getEffectNodeType(toEffectTypeId(e.effectType)) !== null)
      .sort((a, b) => a.order - b.order);
  }, [effects]);

  // -------------------------------------------------------------------------
  // Create/Update Effect Nodes
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!audioContext) {
      // Only update if not already empty to avoid re-render loop
      setNodeEntries((prev) => (prev.length === 0 ? prev : []));
      return;
    }

    // Create new entries for each effect
    const newEntries: EffectNodeEntry[] = [];

    for (const effect of sortedEffects) {
      const config: EffectNodeConfig = {
        effectType: toEffectTypeId(effect.effectType),
        params: extractNumericParams(effect.params),
        enabled: effect.enabled,
      };

      const effectNode = createAudioEffectNode(audioContext, config);

      if (effectNode) {
        newEntries.push({
          effectId: effect.id,
          effectNode,
          params: config.params,
        });
      }
    }

    // Connect nodes in chain
    connectChain(newEntries, audioContext, bypassNodeRef);

    setNodeEntries(newEntries);

    // Cleanup on unmount or when effects change
    return () => {
      for (const entry of newEntries) {
        try {
          entry.effectNode.node.disconnect();
        } catch {
          // Node might already be disconnected
        }
      }
    };
  }, [sortedEffects, audioContext]);

  // -------------------------------------------------------------------------
  // Update Effect Parameter
  // -------------------------------------------------------------------------

  const updateEffect = useCallback(
    (effectId: string, paramName: string, value: number) => {
      if (!audioContext) return;

      setNodeEntries((currentEntries) => {
        const entryIndex = currentEntries.findIndex((e) => e.effectId === effectId);
        if (entryIndex === -1) return currentEntries;

        const entry = currentEntries[entryIndex];
        const newParams = { ...entry.params, [paramName]: value };

        // Update the Web Audio node
        updateAudioEffectNode(entry.effectNode, newParams);

        // Update the entry's params
        const newEntries = [...currentEntries];
        newEntries[entryIndex] = {
          ...entry,
          params: newParams,
        };

        return newEntries;
      });
    },
    [audioContext]
  );

  // -------------------------------------------------------------------------
  // Toggle Effect
  // -------------------------------------------------------------------------

  const toggleEffect = useCallback(
    (effectId: string, enabled: boolean) => {
      if (!audioContext) return;

      setNodeEntries((currentEntries) => {
        const entryIndex = currentEntries.findIndex((e) => e.effectId === effectId);
        if (entryIndex === -1) return currentEntries;

        const entry = currentEntries[entryIndex];

        // Find the original effect to get its params
        const originalEffect = effects.find((e) => e.id === effectId);
        if (!originalEffect) return currentEntries;

        // Recreate the node with new enabled state
        const config: EffectNodeConfig = {
          effectType: entry.effectNode.effectType,
          params: enabled ? entry.params : {},
          enabled,
        };

        const newEffectNode = createAudioEffectNode(audioContext, config);
        if (!newEffectNode) return currentEntries;

        // Disconnect old node
        try {
          entry.effectNode.node.disconnect();
        } catch {
          // Node might already be disconnected
        }

        // Create new entries with updated node
        const newEntries = [...currentEntries];
        newEntries[entryIndex] = {
          ...entry,
          effectNode: newEffectNode,
        };

        // Reconnect chain
        connectChain(newEntries, audioContext, bypassNodeRef);

        return newEntries;
      });
    },
    [audioContext, effects]
  );

  // -------------------------------------------------------------------------
  // Check Effect Support
  // -------------------------------------------------------------------------

  const isEffectSupported = useCallback((effectType: string): boolean => {
    return getEffectNodeType(effectType) !== null;
  }, []);

  // -------------------------------------------------------------------------
  // Compute Chain Input/Output
  // -------------------------------------------------------------------------

  const chainInput = useMemo(() => {
    if (!audioContext) return null;

    if (nodeEntries.length === 0) {
      // Create or return bypass node
      if (!bypassNodeRef.current) {
        bypassNodeRef.current = audioContext.createGain();
        bypassNodeRef.current.gain.value = 1;
      }
      return bypassNodeRef.current;
    }

    return nodeEntries[0].effectNode.node;
  }, [nodeEntries, audioContext]);

  const chainOutput = useMemo(() => {
    if (!audioContext) return null;

    if (nodeEntries.length === 0) {
      // Return same bypass node for both input and output
      if (!bypassNodeRef.current) {
        bypassNodeRef.current = audioContext.createGain();
        bypassNodeRef.current.gain.value = 1;
      }
      return bypassNodeRef.current;
    }

    return nodeEntries[nodeEntries.length - 1].effectNode.node;
  }, [nodeEntries, audioContext]);

  // -------------------------------------------------------------------------
  // Return Value
  // -------------------------------------------------------------------------

  const effectNodes = useMemo(() => {
    return nodeEntries.map((entry) => entry.effectNode);
  }, [nodeEntries]);

  return {
    effectNodes,
    chainInput,
    chainOutput,
    updateEffect,
    toggleEffect,
    isEffectSupported,
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract numeric parameters from effect params
 */
function extractNumericParams(
  params: Record<string, unknown>
): Record<string, number> {
  const result: Record<string, number> = {};

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'number') {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Connect effect nodes in chain order
 */
function connectChain(
  entries: EffectNodeEntry[],
  audioContext: AudioContext,
  bypassNodeRef: React.MutableRefObject<GainNode | null>
): void {
  if (entries.length === 0) {
    // Create bypass node if needed
    if (!bypassNodeRef.current) {
      bypassNodeRef.current = audioContext.createGain();
      bypassNodeRef.current.gain.value = 1;
    }
    return;
  }

  // Connect each node to the next
  for (let i = 0; i < entries.length - 1; i++) {
    try {
      entries[i].effectNode.node.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    entries[i].effectNode.node.connect(entries[i + 1].effectNode.node);
  }
}
