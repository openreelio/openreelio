import { useCallback, useMemo } from 'react';
import { globalToolRegistry } from '@/agents';
import type { AgentContext } from '@/agents/engine/core/types';
import { createLanguagePolicy } from '@/agents/engine/core/types';
import { isMetaToolsEnabled } from '@/config/featureFlags';
import { getVisibleMetaToolNames } from '@/agents/tools/metaTools';
import { getWorkspaceToolNames } from '@/agents/tools/workspaceTools';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { useProjectStore } from '@/stores';
import { useSettingsStore } from '@/stores/settingsStore';

interface StoreSnapshots {
  currentTime: number;
  duration: number;
  selectedClipIds: string[];
  selectedTrackIds: string[];
  activeSequenceId: string | null;
  projectStateVersion: number;
  sequences: Map<
    string,
    {
      tracks: Array<{
        id: string;
        name: string;
        kind: string;
        clips: Array<{
          id: string;
          assetId: string;
          label?: string;
          place: { timelineInSec: number };
        }>;
      }>;
    }
  >;
  assets: Map<string, { id: string; name: string; kind: string; durationSec?: number }>;
  uiLanguage: string;
}

export interface AgentRuntimeStoreContextResult {
  context: Partial<AgentContext>;
  contextRefresher: () => Partial<AgentContext>;
  aiMaxTokens: number;
  aiPrimaryModel: string | null;
  aiPrimaryProvider: string | null;
}

function getPromptVisibleToolNames(): string[] {
  const registeredNames = globalToolRegistry.listAll().map((tool) => tool.name);
  if (!isMetaToolsEnabled()) {
    return registeredNames;
  }

  const visibleNames = new Set([...getVisibleMetaToolNames(), ...getWorkspaceToolNames()]);
  const filteredNames = registeredNames.filter((name) => visibleNames.has(name));
  return filteredNames.length > 0 ? filteredNames : registeredNames;
}

export function buildAgentContextFromStoreSnapshots(
  stores: StoreSnapshots,
  externalContext?: Partial<AgentContext>,
): Partial<AgentContext> {
  const activeSequence = stores.activeSequenceId
    ? stores.sequences.get(stores.activeSequenceId)
    : undefined;

  const storeContext: Partial<AgentContext> = {
    projectId: 'current',
    sequenceId: stores.activeSequenceId ?? undefined,
    languagePolicy: createLanguagePolicy(stores.uiLanguage),
    projectStateVersion: stores.projectStateVersion,
    playheadPosition: stores.currentTime,
    timelineDuration: stores.duration,
    selectedClips: stores.selectedClipIds,
    selectedTracks: stores.selectedTrackIds,
    availableAssets: Array.from(stores.assets.values())
      .filter((asset) => asset.kind === 'video' || asset.kind === 'audio' || asset.kind === 'image')
      .map((asset) => ({
        id: asset.id,
        name: asset.name,
        type: asset.kind as 'video' | 'audio' | 'image',
        duration: asset.durationSec,
      })),
    availableTracks:
      activeSequence?.tracks.map((track) => ({
        id: track.id,
        name: track.name || `Track ${track.id}`,
        type: track.kind === 'audio' ? ('audio' as const) : ('video' as const),
        clipCount: track.clips.length,
      })) ?? [],
    availableTools: getPromptVisibleToolNames(),
  };

  return {
    ...storeContext,
    ...externalContext,
    projectId: externalContext?.projectId ?? storeContext.projectId,
  };
}

function readStoreSnapshots(): StoreSnapshots {
  const playback = usePlaybackStore.getState();
  const timeline = useTimelineStore.getState();
  const project = useProjectStore.getState();
  const settings = useSettingsStore.getState();

  return {
    currentTime: playback.currentTime,
    duration: playback.duration,
    selectedClipIds: timeline.selectedClipIds,
    selectedTrackIds: timeline.selectedTrackIds,
    activeSequenceId: project.activeSequenceId,
    projectStateVersion: project.stateVersion,
    sequences: project.sequences,
    assets: project.assets,
    uiLanguage: settings.settings.general.language,
  };
}

export function useAgentRuntimeStoreContext(
  externalContext?: Partial<AgentContext>,
): AgentRuntimeStoreContextResult {
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const duration = usePlaybackStore((state) => state.duration);
  const selectedClipIds = useTimelineStore((state) => state.selectedClipIds);
  const selectedTrackIds = useTimelineStore((state) => state.selectedTrackIds);
  const activeSequenceId = useProjectStore((state) => state.activeSequenceId);
  const projectStateVersion = useProjectStore((state) => state.stateVersion);
  const sequences = useProjectStore((state) => state.sequences);
  const assets = useProjectStore((state) => state.assets);
  const uiLanguage = useSettingsStore((state) => state.settings.general.language);

  const context = useMemo(
    () =>
      buildAgentContextFromStoreSnapshots(
        {
          currentTime,
          duration,
          selectedClipIds,
          selectedTrackIds,
          activeSequenceId,
          projectStateVersion,
          sequences,
          assets,
          uiLanguage,
        },
        externalContext,
      ),
    [
      activeSequenceId,
      assets,
      currentTime,
      duration,
      externalContext,
      projectStateVersion,
      selectedClipIds,
      selectedTrackIds,
      sequences,
      uiLanguage,
    ],
  );

  const contextRefresher = useCallback(
    () => buildAgentContextFromStoreSnapshots(readStoreSnapshots(), externalContext),
    [externalContext],
  );

  const aiMaxTokens = useSettingsStore((state) => state.settings.ai.maxTokens);
  const aiPrimaryModel = useSettingsStore((state) => state.settings.ai.primaryModel);
  const aiPrimaryProvider = useSettingsStore((state) => state.settings.ai.primaryProvider);

  return {
    context,
    contextRefresher,
    aiMaxTokens,
    aiPrimaryModel,
    aiPrimaryProvider,
  };
}
