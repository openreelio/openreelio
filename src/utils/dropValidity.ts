/**
 * Drop Validity Utilities
 *
 * Provides validation logic for clip drop operations on the timeline.
 * Checks for overlaps, track type compatibility, locked tracks, and bounds.
 */

import type { Track, Clip, AssetKind, TrackKind } from '@/types';

// =============================================================================
// Types
// =============================================================================

/** Reason why a drop is invalid */
export type DropInvalidReason =
  | 'overlap'
  | 'wrong_track_type'
  | 'locked_track'
  | 'out_of_bounds'
  | 'track_hidden';

/** Result of drop validity check */
export interface DropValidity {
  /** Whether the drop is valid */
  isValid: boolean;
  /** Reason for invalid drop */
  reason?: DropInvalidReason;
  /** User-friendly error message */
  message?: string;
  /** ID of the conflicting clip (for overlap errors) */
  conflictingClipId?: string;
}

/** Context needed for drop validation */
export interface DropValidationContext {
  /** The track being dropped onto */
  track: Track;
  /** All clips currently in the track */
  clips: Clip[];
  /** The clip being moved (null if creating new clip) */
  sourceClip?: Clip | null;
  /** Type of asset being dropped */
  assetKind?: AssetKind;
}

// =============================================================================
// Track Type Compatibility
// =============================================================================

/** Track kinds that accept video assets */
const VIDEO_COMPATIBLE_TRACKS: TrackKind[] = ['video', 'overlay'];

/** Track kinds that accept audio assets */
const AUDIO_COMPATIBLE_TRACKS: TrackKind[] = ['audio', 'video'];

/** Track kinds that accept image assets */
const IMAGE_COMPATIBLE_TRACKS: TrackKind[] = ['video', 'overlay'];

/** Track kinds that accept subtitle assets */
const SUBTITLE_COMPATIBLE_TRACKS: TrackKind[] = ['caption'];

/**
 * Check if an asset type is compatible with a track type
 */
export function isAssetCompatibleWithTrack(
  assetKind: AssetKind | undefined,
  trackKind: TrackKind
): boolean {
  if (!assetKind) return true; // No asset info, assume compatible

  switch (assetKind) {
    case 'video':
      return VIDEO_COMPATIBLE_TRACKS.includes(trackKind);
    case 'audio':
      return AUDIO_COMPATIBLE_TRACKS.includes(trackKind);
    case 'image':
      return IMAGE_COMPATIBLE_TRACKS.includes(trackKind);
    case 'subtitle':
      return SUBTITLE_COMPATIBLE_TRACKS.includes(trackKind);
    default:
      return true;
  }
}

/**
 * Get user-friendly message for track type mismatch
 */
export function getTrackTypeMismatchMessage(
  assetKind: AssetKind,
  trackKind: TrackKind
): string {
  const assetLabel = assetKind.charAt(0).toUpperCase() + assetKind.slice(1);
  const trackLabel = trackKind.charAt(0).toUpperCase() + trackKind.slice(1);

  return `Cannot place ${assetLabel.toLowerCase()} on ${trackLabel.toLowerCase()} track`;
}

// =============================================================================
// Overlap Detection
// =============================================================================

/**
 * Check if a time range overlaps with any existing clips
 */
export function checkClipOverlap(
  clips: Clip[],
  startTime: number,
  endTime: number,
  excludeClipId?: string
): Clip | null {
  for (const clip of clips) {
    // Skip the clip being moved
    if (excludeClipId && clip.id === excludeClipId) continue;

    const clipStart = clip.place.timelineInSec;
    const clipDuration =
      (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
    const clipEnd = clipStart + clipDuration;

    // Check for overlap
    if (startTime < clipEnd && endTime > clipStart) {
      return clip;
    }
  }

  return null;
}

// =============================================================================
// Main Validation Function
// =============================================================================

/**
 * Validate a drop operation
 *
 * @param targetPosition - Target timeline position in seconds
 * @param clipDuration - Duration of the clip being dropped in seconds
 * @param context - Validation context (track, clips, etc.)
 * @returns DropValidity result
 */
export function validateDrop(
  targetPosition: number,
  clipDuration: number,
  context: DropValidationContext
): DropValidity {
  const { track, clips, sourceClip, assetKind } = context;

  // Check: Track is locked
  if (track.locked) {
    return {
      isValid: false,
      reason: 'locked_track',
      message: 'Track is locked',
    };
  }

  // Check: Track is hidden (optional - may want to allow drops on hidden tracks)
  // Commented out as this may not be desired behavior
  // if (!track.visible) {
  //   return {
  //     isValid: false,
  //     reason: 'track_hidden',
  //     message: 'Track is hidden',
  //   };
  // }

  // Check: Track type compatibility
  const effectiveAssetKind = assetKind ?? getAssetKindFromClip(sourceClip);
  if (effectiveAssetKind && !isAssetCompatibleWithTrack(effectiveAssetKind, track.kind)) {
    return {
      isValid: false,
      reason: 'wrong_track_type',
      message: getTrackTypeMismatchMessage(effectiveAssetKind, track.kind),
    };
  }

  // Check: Position is negative
  if (targetPosition < 0) {
    return {
      isValid: false,
      reason: 'out_of_bounds',
      message: 'Position cannot be negative',
    };
  }

  // Check: Overlap with existing clips
  const targetEnd = targetPosition + clipDuration;
  const overlappingClip = checkClipOverlap(
    clips,
    targetPosition,
    targetEnd,
    sourceClip?.id
  );

  if (overlappingClip) {
    return {
      isValid: false,
      reason: 'overlap',
      message: 'Clips would overlap',
      conflictingClipId: overlappingClip.id,
    };
  }

  // All checks passed
  return { isValid: true };
}

/**
 * Try to infer asset kind from a clip's properties
 */
function getAssetKindFromClip(clip?: Clip | null): AssetKind | undefined {
  if (!clip) return undefined;

  // This is a simplified heuristic - in a real implementation,
  // you'd look up the asset by clip.assetId to get the actual kind
  // For now, we return undefined to skip the track type check
  return undefined;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create a valid drop result
 */
export function validDrop(): DropValidity {
  return { isValid: true };
}

/**
 * Create an invalid drop result
 */
export function invalidDrop(
  reason: DropInvalidReason,
  message: string,
  conflictingClipId?: string
): DropValidity {
  return {
    isValid: false,
    reason,
    message,
    conflictingClipId,
  };
}
