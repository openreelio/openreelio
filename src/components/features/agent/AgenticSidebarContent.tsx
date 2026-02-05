/**
 * AgenticSidebarContent Component
 *
 * Content for the AI sidebar when the agentic engine is enabled.
 * Provides the full Think-Plan-Act-Observe loop experience.
 */

import { useMemo, useCallback } from 'react';
import { AgenticChat } from './AgenticChat';
import { createTauriLLMAdapter } from '@/agents/engine/adapters/llm/TauriLLMAdapter';
import { createToolRegistryAdapter } from '@/agents/engine/adapters/tools/ToolRegistryAdapter';
import type { AgentContext } from '@/agents/engine';
import { globalToolRegistry } from '@/agents';
import { initializeAgentSystem } from '@/stores/aiStore';
import { useProjectStore } from '@/stores';
import { createLogger } from '@/services/logger';

const logger = createLogger('AgenticSidebarContent');

// =============================================================================
// Types
// =============================================================================

export interface AgenticSidebarContentProps {
  /** Whether the component is visible */
  visible?: boolean;
  /** Callback when a session completes */
  onSessionComplete?: () => void;
  /** Optional className */
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

export function AgenticSidebarContent({
  visible = true,
  onSessionComplete,
  className = '',
}: AgenticSidebarContentProps) {
  // ===========================================================================
  // Adapters
  // ===========================================================================

  // Create LLM adapter (memoized to prevent recreation)
  const llmClient = useMemo(() => {
    logger.info('Creating TauriLLMAdapter');
    return createTauriLLMAdapter();
  }, []);

  // Create tool executor adapter (memoized)
  const toolExecutor = useMemo(() => {
    logger.info('Creating ToolRegistryAdapter');
    initializeAgentSystem();
    return createToolRegistryAdapter(globalToolRegistry);
  }, []);

  // ===========================================================================
  // Context
  // ===========================================================================

  // Get project context from stores
  const activeSequenceId = useProjectStore((state) => state.activeSequenceId);
  const sequences = useProjectStore((state) => state.sequences);
  const assets = useProjectStore((state) => state.assets);

  // Build context for the agentic loop
  const context = useMemo((): Partial<AgentContext> => {
    const activeSequence = activeSequenceId ? sequences.get(activeSequenceId) : undefined;

    const timelineDuration = (() => {
      if (!activeSequence) return 0;
      let maxEnd = 0;
      for (const track of activeSequence.tracks) {
        for (const clip of track.clips) {
          maxEnd = Math.max(maxEnd, clip.place.timelineInSec + clip.place.durationSec);
        }
      }
      return maxEnd;
    })();

    return {
      projectId: 'current', // TODO: Get from project store when available
      sequenceId: activeSequenceId ?? undefined,
      playheadPosition: 0, // TODO: Get from timeline store
      timelineDuration,
      availableAssets: Array.from(assets.values())
        .filter(
          (asset) =>
            asset.kind === 'video' || asset.kind === 'audio' || asset.kind === 'image'
        )
        .map((asset) => ({
          id: asset.id,
          name: asset.name,
          type: asset.kind as 'video' | 'audio' | 'image',
          duration: asset.durationSec,
        })),
      availableTracks: activeSequence?.tracks.map((track) => ({
        id: track.id,
        name: track.name || `Track ${track.id}`,
        type: track.kind === 'audio' ? 'audio' : 'video',
        clipCount: track.clips.length,
      })) ?? [],
      availableTools: globalToolRegistry.listAll().map((t) => t.name),
    };
  }, [activeSequenceId, sequences, assets]);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleComplete = useCallback(
    (result: unknown) => {
      logger.info('Agentic session completed', { result });
      onSessionComplete?.();
    },
    [onSessionComplete]
  );

  const handleError = useCallback((error: Error) => {
    logger.error('Agentic session error', { error: error.message });
  }, []);

  const handleSubmit = useCallback((input: string) => {
    logger.info('User submitted input', { input: input.substring(0, 50) });
  }, []);

  // ===========================================================================
  // Render
  // ===========================================================================

  if (!visible) {
    return null;
  }

  return (
    <div
      data-testid="agentic-sidebar-content"
      className={`flex flex-col flex-1 overflow-hidden ${className}`}
    >
      <AgenticChat
        llmClient={llmClient}
        toolExecutor={toolExecutor}
        context={context}
        onSubmit={handleSubmit}
        onComplete={handleComplete}
        onError={handleError}
        showThinking={true}
        showPlan={true}
        showActions={true}
        placeholder="Describe what you want to edit..."
        className="flex-1"
      />
    </div>
  );
}
