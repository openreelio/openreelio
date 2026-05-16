import type { Asset, Sequence } from '@/types';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useProjectStore } from '@/stores/projectStore';
import { useWorkspaceLayoutStore, type PanelId } from '@/stores/workspaceLayoutStore';

interface ProjectMetaFixture {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  modifiedAt: string;
}

interface ProxyPreviewFixtureState {
  project: ProjectMetaFixture;
  assets: Asset[];
  sequences: Sequence[];
  activeSequenceId: string;
  selectedAssetId: string | null;
  playback: {
    currentTime: number;
    duration: number;
    isPlaying: boolean;
    playbackRate: number;
    volume: number;
    isMuted: boolean;
    loop: boolean;
    syncWithTimeline: boolean;
  };
  activePanel?: {
    zoneId: 'left' | 'center-top' | 'center-bottom' | 'right' | 'bottom';
    panelId: PanelId;
  };
}

interface PlaybackSnapshot {
  currentTime: number;
  isPlaying: boolean;
}

declare global {
  interface Window {
    __OPENREELIO_E2E__?: {
      seedProxyPreviewState: (state: ProxyPreviewFixtureState) => void;
      seekPlayback: (time: number, source?: string) => void;
      readPlaybackSnapshot: () => PlaybackSnapshot;
    };
  }
}

window.__OPENREELIO_E2E__ = {
  seedProxyPreviewState: (state) => {
    useProjectStore.setState({
      isLoaded: true,
      isLoading: false,
      isDirty: false,
      meta: state.project,
      assets: new Map(state.assets.map((asset) => [asset.id, asset])),
      sequences: new Map(state.sequences.map((sequence) => [sequence.id, sequence])),
      activeSequenceId: state.activeSequenceId,
      selectedAssetId: state.selectedAssetId,
      error: null,
    });

    usePlaybackStore.setState({
      currentTime: state.playback.currentTime,
      duration: state.playback.duration,
      isPlaying: state.playback.isPlaying,
      playbackRate: state.playback.playbackRate,
      volume: state.playback.volume,
      isMuted: state.playback.isMuted,
      loop: state.playback.loop,
      syncWithTimeline: state.playback.syncWithTimeline,
    });

    if (state.activePanel) {
      useWorkspaceLayoutStore
        .getState()
        .setActivePanel(state.activePanel.zoneId, state.activePanel.panelId);
    }
  },
  seekPlayback: (time, source = 'e2e-seek') => {
    usePlaybackStore.getState().seek(time, source);
  },
  readPlaybackSnapshot: () => {
    const state = usePlaybackStore.getState();
    return { currentTime: state.currentTime, isPlaying: state.isPlaying };
  },
};
