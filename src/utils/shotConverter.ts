/**
 * Shot Converter Utilities
 *
 * Converts between different shot data formats.
 * Bridges the annotation system with the existing shot detection system.
 */

import type { ShotResult } from '@/bindings';
import type { Shot } from '@/hooks/useShotDetection';

/**
 * Converts annotation ShotResult to the Shot format used by timeline components.
 *
 * @param shotResult - Shot result from the annotation system
 * @param assetId - Asset ID the shot belongs to
 * @param index - Shot index (used to generate ID)
 * @returns Shot in the format expected by ShotMarkers
 */
export function shotResultToShot(shotResult: ShotResult, assetId: string, index: number): Shot {
  return {
    id: `${assetId}-shot-${index}`,
    assetId,
    startSec: shotResult.startSec,
    endSec: shotResult.endSec,
    keyframePath: shotResult.keyframePath ?? null,
    qualityScore: shotResult.confidence,
    tags: [],
  };
}

/**
 * Converts an array of annotation ShotResults to Shot format.
 *
 * @param shotResults - Array of shot results from the annotation system
 * @param assetId - Asset ID the shots belong to
 * @returns Array of Shots in the format expected by ShotMarkers
 */
export function shotResultsToShots(shotResults: ShotResult[], assetId: string): Shot[] {
  return shotResults.map((result, index) => shotResultToShot(result, assetId, index));
}

/**
 * Converts a Shot back to ShotResult format.
 * Useful for storing shots in the annotation system.
 *
 * @param shot - Shot from the timeline components
 * @returns ShotResult for the annotation system
 */
export function shotToShotResult(shot: Shot): ShotResult {
  return {
    startSec: shot.startSec,
    endSec: shot.endSec,
    confidence: shot.qualityScore ?? 0.9,
    keyframePath: shot.keyframePath,
  };
}

/**
 * Merges shots from both the old detection system and the annotation system.
 * Prefers annotation shots when both are available for the same time range.
 *
 * @param detectionShots - Shots from the old detection system
 * @param annotationShots - Shots from the annotation system
 * @returns Merged shots array
 */
export function mergeShots(detectionShots: Shot[], annotationShots: Shot[]): Shot[] {
  // If annotation shots are available, prefer them
  if (annotationShots.length > 0) {
    return annotationShots;
  }
  return detectionShots;
}
