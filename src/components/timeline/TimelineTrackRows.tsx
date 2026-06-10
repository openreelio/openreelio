import type { ComponentProps } from 'react';
import type {
  Caption,
  CaptionTrack as CaptionTrackType,
  Sequence,
  Track as TrackType,
} from '@/types';
import { getTrackSwapTargets, isProtectedBaseTrack } from '@/utils/trackReorder';
import { getClipTimelineEndSec } from '@/utils/clipTiming';
import { CaptionTrack } from './CaptionTrack';
import { Track } from './Track';

function adaptTrackToCaptionTrack(track: TrackType): CaptionTrackType {
  const captions: Caption[] = track.clips.map((clip) => ({
    id: clip.id,
    startSec: clip.place.timelineInSec,
    endSec: getClipTimelineEndSec(clip),
    text: clip.label || '',
    speaker: undefined,
    styleOverride: clip.captionStyle,
    positionOverride: clip.captionPosition,
    metadata: {},
  }));

  return {
    id: track.id,
    name: track.name,
    language: track.captionLanguage ?? 'en',
    visible: track.visible,
    locked: track.locked,
    captions,
    defaultStyle: {
      fontFamily: 'Arial',
      fontSize: 48,
      fontWeight: 'normal',
      color: { r: 255, g: 255, b: 255, a: 255 },
      outlineColor: { r: 0, g: 0, b: 0, a: 255 },
      outlineWidth: 2,
      shadowColor: { r: 0, g: 0, b: 0, a: 128 },
      shadowOffset: 2,
      alignment: 'center',
      italic: false,
      underline: false,
    },
    defaultPosition: {
      type: 'preset',
      vertical: 'bottom',
      marginPercent: 5,
    },
  };
}

type TrackControlHandler = (data: { sequenceId: string; trackId: string }) => void;

export interface TimelineTrackRowsProps {
  sequence: Sequence;
  zoom: number;
  scrollX: number;
  duration: number;
  viewportWidth: number;
  selectedClipIds: string[];
  getTrackClips: (trackId: string) => ComponentProps<typeof Track>['clips'];
  getClipWaveformConfig?: ComponentProps<typeof Track>['getClipWaveformConfig'];
  getClipThumbnailConfig?: ComponentProps<typeof Track>['getClipThumbnailConfig'];
  snapEnabled: boolean;
  snapPoints: NonNullable<ComponentProps<typeof Track>['snapPoints']>;
  snapThreshold: number;
  onClipClick?: ComponentProps<typeof Track>['onClipClick'];
  onClipRazorClick?: ComponentProps<typeof Track>['onClipRazorClick'];
  onClipDragStart?: ComponentProps<typeof Track>['onClipDragStart'];
  onClipDrag?: ComponentProps<typeof Track>['onClipDrag'];
  onClipDragEnd?: ComponentProps<typeof Track>['onClipDragEnd'];
  onClipAudioSettingsChange?: ComponentProps<typeof Track>['onClipAudioSettingsChange'];
  onSnapPointChange?: ComponentProps<typeof Track>['onSnapPointChange'];
  editTargetTrackId?: string | null;
  createTrackHandler: (callback?: TrackControlHandler) => (trackId: string) => void;
  onTrackMuteToggle?: TrackControlHandler;
  onTrackLockToggle?: TrackControlHandler;
  onTrackVisibilityToggle?: TrackControlHandler;
  onCaptionTrackLanguageChange?: (data: {
    sequenceId: string;
    trackId: string;
    language: string;
  }) => void | Promise<void>;
  onTrackDelete?: TrackControlHandler;
  onTrackSwap: (trackId: string, targetTrackId: string) => void;
  onClipSpeedChange?: ComponentProps<typeof Track>['onClipSpeedChange'];
  onClipReverse?: ComponentProps<typeof Track>['onClipReverse'];
  onClipFreezeFrame?: ComponentProps<typeof Track>['onClipFreezeFrame'];
  onClipToggleEnabled?: ComponentProps<typeof Track>['onClipToggleEnabled'];
  onClipLink?: ComponentProps<typeof Track>['onClipLink'];
  onClipUnlink?: ComponentProps<typeof Track>['onClipUnlink'];
  onClipDetachAudio?: ComponentProps<typeof Track>['onClipDetachAudio'];
  onCreateCompoundClip?: ComponentProps<typeof Track>['onCreateCompoundClip'];
  onUnnestCompoundClip?: ComponentProps<typeof Track>['onUnnestCompoundClip'];
  onCreateAdjustmentLayer?: ComponentProps<typeof Track>['onCreateAdjustmentLayer'];
  onClipDoubleClick?: ComponentProps<typeof Track>['onClipDoubleClick'];
  resolveLinkedClipRefs?: ComponentProps<typeof Track>['resolveLinkedClipRefs'];
  onClipGroup?: ComponentProps<typeof Track>['onClipGroup'];
  onClipUngroup?: ComponentProps<typeof Track>['onClipUngroup'];
  resolveGroupClipRefs?: ComponentProps<typeof Track>['resolveGroupClipRefs'];
  onCopyEffects?: ComponentProps<typeof Track>['onCopyEffects'];
  onPasteEffects?: ComponentProps<typeof Track>['onPasteEffects'];
  onPasteAttributes?: ComponentProps<typeof Track>['onPasteAttributes'];
  onRemoveAttributes?: ComponentProps<typeof Track>['onRemoveAttributes'];
  showTransitionZones?: ComponentProps<typeof Track>['showTransitionZones'];
  onTransitionZoneClick?: ComponentProps<typeof Track>['onTransitionZoneClick'];
  createCaptionDoubleClickHandler: (trackId: string) => (captionId: string) => void;
  onCaptionExportClick?: ComponentProps<typeof CaptionTrack>['onExportClick'];
}

export function TimelineTrackRows({
  sequence,
  zoom,
  scrollX,
  duration,
  viewportWidth,
  selectedClipIds,
  getTrackClips,
  getClipWaveformConfig,
  getClipThumbnailConfig,
  snapEnabled,
  snapPoints,
  snapThreshold,
  onClipClick,
  onClipRazorClick,
  onClipDragStart,
  onClipDrag,
  onClipDragEnd,
  onClipAudioSettingsChange,
  onSnapPointChange,
  editTargetTrackId,
  createTrackHandler,
  onTrackMuteToggle,
  onTrackLockToggle,
  onTrackVisibilityToggle,
  onCaptionTrackLanguageChange,
  onTrackDelete,
  onTrackSwap,
  onClipSpeedChange,
  onClipReverse,
  onClipFreezeFrame,
  onClipToggleEnabled,
  onClipLink,
  onClipUnlink,
  onClipDetachAudio,
  onCreateCompoundClip,
  onUnnestCompoundClip,
  onCreateAdjustmentLayer,
  onClipDoubleClick,
  resolveLinkedClipRefs,
  onClipGroup,
  onClipUngroup,
  resolveGroupClipRefs,
  onCopyEffects,
  onPasteEffects,
  onPasteAttributes,
  onRemoveAttributes,
  showTransitionZones,
  onTransitionZoneClick,
  createCaptionDoubleClickHandler,
  onCaptionExportClick,
}: TimelineTrackRowsProps): JSX.Element {
  return (
    <>
      {sequence.tracks.map((track) => {
        const swapTargets = getTrackSwapTargets(sequence.tracks, track.id);

        if (track.kind === 'caption') {
          const captionTrack = adaptTrackToCaptionTrack(track);
          return (
            <CaptionTrack
              key={track.id}
              track={captionTrack}
              zoom={zoom}
              scrollX={scrollX}
              duration={duration}
              viewportWidth={viewportWidth}
              selectedCaptionIds={selectedClipIds}
              onLockToggle={createTrackHandler(onTrackLockToggle)}
              onVisibilityToggle={createTrackHandler(onTrackVisibilityToggle)}
              onLanguageChange={(trackId, language) =>
                onCaptionTrackLanguageChange?.({
                  sequenceId: sequence.id,
                  trackId,
                  language,
                })
              }
              onDeleteTrack={createTrackHandler(onTrackDelete)}
              canDeleteTrack={!isProtectedBaseTrack(sequence.tracks, track.id)}
              isEditTarget={track.id === editTargetTrackId}
              swapTargets={swapTargets}
              onSwapTracks={onTrackSwap}
              onCaptionClick={onClipClick}
              onCaptionDoubleClick={createCaptionDoubleClickHandler(track.id)}
              onExportClick={onCaptionExportClick}
            />
          );
        }

        return (
          <Track
            key={track.id}
            track={track}
            sequenceId={sequence.id}
            clips={getTrackClips(track.id)}
            zoom={zoom}
            scrollX={scrollX}
            duration={duration}
            viewportWidth={viewportWidth}
            selectedClipIds={selectedClipIds}
            getClipWaveformConfig={getClipWaveformConfig}
            getClipThumbnailConfig={getClipThumbnailConfig}
            snapPoints={snapEnabled ? snapPoints : []}
            snapThreshold={snapEnabled ? snapThreshold : 0}
            onClipClick={onClipClick}
            onClipRazorClick={onClipRazorClick}
            onClipDragStart={onClipDragStart}
            onClipDrag={onClipDrag}
            onClipDragEnd={onClipDragEnd}
            onClipAudioSettingsChange={onClipAudioSettingsChange}
            onSnapPointChange={onSnapPointChange}
            isEditTarget={track.id === editTargetTrackId}
            onMuteToggle={createTrackHandler(onTrackMuteToggle)}
            onLockToggle={createTrackHandler(onTrackLockToggle)}
            onVisibilityToggle={createTrackHandler(onTrackVisibilityToggle)}
            onDeleteTrack={createTrackHandler(onTrackDelete)}
            canDeleteTrack={!isProtectedBaseTrack(sequence.tracks, track.id)}
            swapTargets={swapTargets}
            onSwapTracks={onTrackSwap}
            onClipSpeedChange={onClipSpeedChange}
            onClipReverse={onClipReverse}
            onClipFreezeFrame={onClipFreezeFrame}
            onClipToggleEnabled={onClipToggleEnabled}
            onClipLink={onClipLink}
            onClipUnlink={onClipUnlink}
            onClipDetachAudio={onClipDetachAudio}
            onCreateCompoundClip={onCreateCompoundClip}
            onUnnestCompoundClip={onUnnestCompoundClip}
            onCreateAdjustmentLayer={onCreateAdjustmentLayer}
            onClipDoubleClick={onClipDoubleClick}
            resolveLinkedClipRefs={resolveLinkedClipRefs}
            onClipGroup={onClipGroup}
            onClipUngroup={onClipUngroup}
            resolveGroupClipRefs={resolveGroupClipRefs}
            onCopyEffects={onCopyEffects}
            onPasteEffects={onPasteEffects}
            onPasteAttributes={onPasteAttributes}
            onRemoveAttributes={onRemoveAttributes}
            showTransitionZones={showTransitionZones}
            onTransitionZoneClick={onTransitionZoneClick}
          />
        );
      })}
    </>
  );
}
