import type {
  Asset,
  Command,
  CommandResult,
  Effect,
  Sequence,
  TextClipData,
  Transform,
} from '@/types';
import { TEXT_ASSET_PREFIX } from '@/types';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
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
  effects?: Effect[];
  activeSequenceId: string;
  selectedAssetId: string | null;
  enableInMemoryCommands?: boolean;
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
      readProjectSnapshot: () => {
        activeSequenceId: string | null;
        sequenceCount: number;
        effectCount: number;
        trackCount: number;
        clipCount: number;
        selectedClipIds: string[];
        selectedClipTransform: Transform | null;
        selectedClipTiming: { timelineInSec: number; durationSec: number } | null;
      };
    };
  }
}

function createCommandResult(createdIds: string[] = [], deletedIds: string[] = []): CommandResult {
  return {
    opId: `e2e_op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    changes: [],
    createdIds,
    deletedIds,
  };
}

function textDataToEffectParams(textData: TextClipData): Effect['params'] {
  return {
    text: textData.content,
    font_family: textData.style.fontFamily,
    font_size: textData.style.fontSize,
    font_weight: textData.style.fontWeight ?? (textData.style.bold ? 700 : 400),
    color: textData.style.color,
    ...(textData.style.backgroundColor ? { background_color: textData.style.backgroundColor } : {}),
    background_padding: textData.style.backgroundPadding,
    alignment: textData.style.alignment,
    bold: textData.style.bold,
    italic: textData.style.italic,
    underline: textData.style.underline,
    line_height: textData.style.lineHeight,
    letter_spacing: textData.style.letterSpacing,
    x: textData.position.x,
    y: textData.position.y,
    ...(textData.shadow
      ? {
          shadow_color: textData.shadow.color,
          shadow_x: textData.shadow.offsetX,
          shadow_y: textData.shadow.offsetY,
          shadow_blur: textData.shadow.blur,
        }
      : {}),
    ...(textData.outline
      ? {
          outline_color: textData.outline.color,
          outline_width: textData.outline.width,
        }
      : {}),
    rotation: textData.rotation,
    opacity: textData.opacity,
  };
}

function installInMemoryCommandExecutor(): void {
  useProjectStore.setState({
    executeCommand: async (command: Command): Promise<CommandResult> => {
      switch (command.type) {
        case 'CreateTrack': {
          const payload = command.payload as {
            sequenceId: string;
            kind: 'video' | 'audio' | 'caption' | 'overlay';
            name?: string;
            position?: number;
          };
          const trackId = `e2e_track_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          useProjectStore.setState((state) => {
            const sequence = state.sequences.get(payload.sequenceId);
            if (!sequence) return state;

            const nextTrack = {
              id: trackId,
              kind: payload.kind,
              name: payload.name ?? `${payload.kind} track`,
              clips: [],
              blendMode: 'normal' as const,
              muted: false,
              locked: false,
              visible: true,
              volume: 1,
            };
            const tracks = [...sequence.tracks];
            const position =
              typeof payload.position === 'number'
                ? Math.max(0, Math.min(tracks.length, Math.round(payload.position)))
                : tracks.length;
            tracks.splice(position, 0, nextTrack);
            state.sequences.set(payload.sequenceId, { ...sequence, tracks });
            state.stateVersion += 1;
            state.isDirty = true;
            return state;
          });
          return createCommandResult([trackId]);
        }

        case 'SetCaptionTrackLanguage': {
          const payload = command.payload as {
            sequenceId: string;
            trackId: string;
            language: string;
          };
          useProjectStore.setState((state) => {
            const sequence = state.sequences.get(payload.sequenceId);
            if (!sequence) return state;

            const tracks = sequence.tracks.map((track) =>
              track.id === payload.trackId && track.kind === 'caption'
                ? { ...track, captionLanguage: payload.language }
                : track,
            );
            state.sequences.set(payload.sequenceId, { ...sequence, tracks });
            state.stateVersion += 1;
            state.isDirty = true;
            return state;
          });
          return createCommandResult();
        }

        case 'AddTextClip': {
          const payload = command.payload as {
            sequenceId: string;
            trackId: string;
            timelineIn: number;
            duration: number;
            textData: TextClipData;
          };
          const clipId = `e2e_text_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const effectId = `e2e_text_effect_${clipId}`;
          useProjectStore.setState((state) => {
            const sequence = state.sequences.get(payload.sequenceId);
            if (!sequence) return state;

            const tracks = sequence.tracks.map((track) => {
              if (track.id !== payload.trackId) return track;

              const clip = {
                id: clipId,
                assetId: `${TEXT_ASSET_PREFIX}${clipId}`,
                range: { sourceInSec: 0, sourceOutSec: payload.duration },
                place: { timelineInSec: payload.timelineIn, durationSec: payload.duration },
                transform: {
                  position: { ...payload.textData.position },
                  scale: { x: 1, y: 1 },
                  rotationDeg: payload.textData.rotation,
                  anchor: { x: 0.5, y: 0.5 },
                },
                opacity: payload.textData.opacity,
                speed: 1,
                effects: [effectId],
                audio: { volumeDb: 0, pan: 0, muted: false },
                label: `Text: ${payload.textData.content}`,
              };

              return {
                ...track,
                clips: [...track.clips, clip],
              };
            });

            state.effects.set(effectId, {
              id: effectId,
              effectType: 'text_overlay',
              enabled: true,
              params: textDataToEffectParams(payload.textData),
              keyframes: {},
              order: 0,
            });
            state.sequences.set(payload.sequenceId, { ...sequence, tracks });
            state.stateVersion += 1;
            state.isDirty = true;
            return state;
          });
          return createCommandResult([clipId, effectId]);
        }

        case 'MoveClip': {
          const payload = command.payload as {
            sequenceId: string;
            trackId: string;
            clipId: string;
            newTimelineIn: number;
            newTrackId?: string | null;
          };
          useProjectStore.setState((state) => {
            const sequence = state.sequences.get(payload.sequenceId);
            if (!sequence) return state;

            const sourceTrack = sequence.tracks.find((track) => track.id === payload.trackId);
            const clip = sourceTrack?.clips.find((candidate) => candidate.id === payload.clipId);
            if (!sourceTrack || !clip) return state;

            const targetTrackId = payload.newTrackId ?? payload.trackId;
            const tracks = sequence.tracks.map((track) => {
              if (track.id === payload.trackId) {
                return {
                  ...track,
                  clips: track.clips.filter((candidate) => candidate.id !== payload.clipId),
                };
              }
              return track;
            });
            const nextClip = {
              ...clip,
              place: {
                ...clip.place,
                timelineInSec: Math.max(0, payload.newTimelineIn),
              },
            };
            const nextTracks = tracks.map((track) =>
              track.id === targetTrackId ? { ...track, clips: [...track.clips, nextClip] } : track,
            );

            state.sequences.set(payload.sequenceId, { ...sequence, tracks: nextTracks });
            state.stateVersion += 1;
            state.isDirty = true;
            return state;
          });
          return createCommandResult();
        }

        case 'TrimClip': {
          const payload = command.payload as {
            sequenceId: string;
            trackId: string;
            clipId: string;
            newSourceIn?: number | null;
            newSourceOut?: number | null;
            newTimelineIn?: number | null;
          };
          useProjectStore.setState((state) => {
            const sequence = state.sequences.get(payload.sequenceId);
            if (!sequence) return state;

            const tracks = sequence.tracks.map((track) => {
              if (track.id !== payload.trackId) return track;

              return {
                ...track,
                clips: track.clips.map((clip) => {
                  if (clip.id !== payload.clipId) return clip;

                  const sourceInSec = payload.newSourceIn ?? clip.range.sourceInSec;
                  const sourceOutSec = payload.newSourceOut ?? clip.range.sourceOutSec;
                  const speed = Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
                  const durationSec = Math.max(0.01, (sourceOutSec - sourceInSec) / speed);

                  return {
                    ...clip,
                    range: { sourceInSec, sourceOutSec },
                    place: {
                      ...clip.place,
                      timelineInSec: payload.newTimelineIn ?? clip.place.timelineInSec,
                      durationSec,
                    },
                  };
                }),
              };
            });

            state.sequences.set(payload.sequenceId, { ...sequence, tracks });
            state.stateVersion += 1;
            state.isDirty = true;
            return state;
          });
          return createCommandResult();
        }

        case 'UpdateTextClip': {
          const payload = command.payload as {
            sequenceId: string;
            trackId: string;
            clipId: string;
            textData: TextClipData;
          };
          useProjectStore.setState((state) => {
            const sequence = state.sequences.get(payload.sequenceId);
            if (!sequence) return state;

            const tracks = sequence.tracks.map((track) => {
              if (track.id !== payload.trackId) return track;

              return {
                ...track,
                clips: track.clips.map((clip) =>
                  clip.id === payload.clipId
                    ? {
                        ...clip,
                        label: `Text: ${payload.textData.content}`,
                        opacity: payload.textData.opacity,
                        transform: {
                          ...clip.transform,
                          position: { ...payload.textData.position },
                          rotationDeg: payload.textData.rotation,
                        },
                      }
                    : clip,
                ),
              };
            });

            const clip = tracks
              .find((track) => track.id === payload.trackId)
              ?.clips.find((candidate) => candidate.id === payload.clipId);
            const effectId = clip?.effects[0];
            if (effectId) {
              const effect = state.effects.get(effectId);
              if (effect) {
                state.effects.set(effectId, {
                  ...effect,
                  params: textDataToEffectParams(payload.textData),
                });
              }
            }
            state.sequences.set(payload.sequenceId, { ...sequence, tracks });
            state.stateVersion += 1;
            state.isDirty = true;
            return state;
          });
          return createCommandResult();
        }

        case 'SetClipTransform': {
          const payload = command.payload as {
            sequenceId: string;
            trackId: string;
            clipId: string;
            transform: Transform;
          };
          useProjectStore.setState((state) => {
            const sequence = state.sequences.get(payload.sequenceId);
            if (!sequence) return state;
            const tracks = sequence.tracks.map((track) =>
              track.id === payload.trackId
                ? {
                    ...track,
                    clips: track.clips.map((clip) =>
                      clip.id === payload.clipId ? { ...clip, transform: payload.transform } : clip,
                    ),
                  }
                : track,
            );
            state.sequences.set(payload.sequenceId, { ...sequence, tracks });
            state.stateVersion += 1;
            state.isDirty = true;
            return state;
          });
          return createCommandResult();
        }

        case 'RemoveTextClip': {
          const payload = command.payload as {
            sequenceId: string;
            trackId: string;
            clipId: string;
          };
          let deletedEffectId: string | undefined;
          useProjectStore.setState((state) => {
            const sequence = state.sequences.get(payload.sequenceId);
            if (!sequence) return state;
            const tracks = sequence.tracks.map((track) => {
              if (track.id !== payload.trackId) return track;
              const deletedClip = track.clips.find((clip) => clip.id === payload.clipId);
              deletedEffectId = deletedClip?.effects[0];
              return {
                ...track,
                clips: track.clips.filter((clip) => clip.id !== payload.clipId),
              };
            });
            if (deletedEffectId) {
              state.effects.delete(deletedEffectId);
            }
            state.sequences.set(payload.sequenceId, { ...sequence, tracks });
            state.stateVersion += 1;
            state.isDirty = true;
            return state;
          });
          return createCommandResult(
            [],
            [payload.clipId, ...(deletedEffectId ? [deletedEffectId] : [])],
          );
        }

        case 'DeleteTrack': {
          const payload = command.payload as { sequenceId: string; trackId: string };
          useProjectStore.setState((state) => {
            const sequence = state.sequences.get(payload.sequenceId);
            if (!sequence) return state;
            state.sequences.set(payload.sequenceId, {
              ...sequence,
              tracks: sequence.tracks.filter((track) => track.id !== payload.trackId),
            });
            state.stateVersion += 1;
            state.isDirty = true;
            return state;
          });
          return createCommandResult([], [payload.trackId]);
        }

        default:
          throw new Error(`E2E in-memory command '${command.type}' is not implemented.`);
      }
    },
  });
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
      effects: new Map((state.effects ?? []).map((effect) => [effect.id, effect])),
      activeSequenceId: state.activeSequenceId,
      selectedAssetId: state.selectedAssetId,
      error: null,
    });

    useTimelineStore.setState({
      selectedClipIds: [],
      selectedTrackIds: [],
    });

    if (state.enableInMemoryCommands) {
      installInMemoryCommandExecutor();
    }

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
  readProjectSnapshot: () => {
    const project = useProjectStore.getState();
    const timeline = useTimelineStore.getState();
    const activeSequence = project.activeSequenceId
      ? project.sequences.get(project.activeSequenceId)
      : undefined;
    const selectedClipId = timeline.selectedClipIds[0];
    const selectedClip =
      selectedClipId && activeSequence
        ? activeSequence.tracks
            .flatMap((track) => track.clips)
            .find((clip) => clip.id === selectedClipId)
        : undefined;
    return {
      activeSequenceId: project.activeSequenceId,
      sequenceCount: project.sequences.size,
      effectCount: project.effects.size,
      trackCount: activeSequence?.tracks.length ?? 0,
      clipCount:
        activeSequence?.tracks.reduce((count, track) => count + track.clips.length, 0) ?? 0,
      selectedClipIds: timeline.selectedClipIds,
      selectedClipTransform: selectedClip?.transform ?? null,
      selectedClipTiming: selectedClip
        ? {
            timelineInSec: selectedClip.place.timelineInSec,
            durationSec: selectedClip.place.durationSec,
          }
        : null,
    };
  },
};
