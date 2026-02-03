/**
 * Multicam Utilities
 *
 * Provides functionality for multicam editing:
 * - Creating and managing multicam groups
 * - Audio waveform synchronization
 * - Angle switching and management
 *
 * @module utils/multicam
 */

import { nanoid } from 'nanoid';
import type { WaveformData, Color, ClipId, TrackId, SequenceId } from '@/types';

// =============================================================================
// Types
// =============================================================================

/** Audio mix mode for multicam playback */
export type AudioMixMode = 'active' | 'first' | 'mix' | 'mute';

/** Transition type for angle switches */
export type AngleTransitionType = 'cut' | 'dissolve' | 'wipe';

/**
 * A single angle (camera source) in a multicam group.
 */
export interface MulticamAngle {
  /** Unique identifier for this angle */
  id: string;
  /** Reference to the source clip */
  clipId: ClipId;
  /** Track containing the source clip */
  trackId: TrackId;
  /** Display label (e.g., "Camera 1", "Wide Shot") */
  label?: string;
  /** Visual color identifier */
  color?: Color;
  /** Whether this angle has audio */
  hasAudio?: boolean;
  /** Audio sync offset in seconds (relative to first angle) */
  syncOffsetSec?: number;
}

/**
 * An angle switch point within a multicam group.
 */
export interface AngleSwitch {
  /** Unique identifier */
  id: string;
  /** Timeline time of the switch (absolute, not relative to group start) */
  timeSec: number;
  /** Index of angle switching from */
  fromAngleIndex: number;
  /** Index of angle switching to */
  toAngleIndex: number;
  /** Type of transition */
  transitionType: AngleTransitionType;
  /** Duration of transition (for non-cut types) */
  transitionDurationSec?: number;
}

/**
 * A multicam group containing multiple synchronized angles.
 */
export interface MulticamGroup {
  /** Unique identifier */
  id: string;
  /** Sequence this group belongs to */
  sequenceId: SequenceId;
  /** Display name */
  name: string;
  /** All camera angles in this group */
  angles: MulticamAngle[];
  /** Currently active angle index */
  activeAngleIndex: number;
  /** Timeline start position in seconds */
  timelineInSec: number;
  /** Duration of the multicam group in seconds */
  durationSec: number;
  /** How to mix audio from multiple angles */
  audioMixMode: AudioMixMode;
  /** Recorded angle switches for editing */
  angleSwitches: AngleSwitch[];
  /** Creation timestamp */
  createdAt?: string;
  /** Last modification timestamp */
  modifiedAt?: string;
}

/** Options for creating a multicam group */
export interface CreateMulticamGroupOptions {
  sequenceId: SequenceId;
  name: string;
  angles: Omit<MulticamAngle, 'id'>[];
  timelineInSec: number;
  durationSec: number;
  activeAngleIndex?: number;
  audioMixMode?: AudioMixMode;
}

/** Validation result for multicam operations */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Options for creating an angle switch */
export interface CreateAngleSwitchOptions {
  timeSec: number;
  fromAngleIndex: number;
  toAngleIndex: number;
  transitionType?: AngleTransitionType;
  transitionDurationSec?: number;
}

/** Result of angle switch validation */
export interface AngleSwitchValidationResult {
  valid: boolean;
  error?: string;
}

/** Result of angle lookup at a specific time */
export interface AngleAtTimeResult {
  angleIndex: number;
  angle: MulticamAngle;
}

/** Result of audio synchronization */
export interface AudioSyncResult {
  /** Offset in seconds (negative = second waveform is ahead) */
  offsetSec: number;
  /** Confidence score (0-1) */
  confidence: number;
}

/** Options for audio sync */
export interface AudioSyncOptions {
  /** Maximum offset to search in seconds */
  maxOffsetSec?: number;
}

// =============================================================================
// Group Creation and Validation
// =============================================================================

/**
 * Creates a new multicam group with default values.
 */
export function createMulticamGroup(options: CreateMulticamGroupOptions): MulticamGroup {
  const now = new Date().toISOString();

  return {
    id: nanoid(),
    sequenceId: options.sequenceId,
    name: options.name,
    angles: options.angles.map((angle) => ({
      ...angle,
      id: nanoid(),
    })),
    activeAngleIndex: options.activeAngleIndex ?? 0,
    timelineInSec: options.timelineInSec,
    durationSec: options.durationSec,
    audioMixMode: options.audioMixMode ?? 'active',
    angleSwitches: [],
    createdAt: now,
    modifiedAt: now,
  };
}

/**
 * Validates a multicam group for consistency.
 */
export function validateMulticamGroup(group: MulticamGroup): ValidationResult {
  const errors: string[] = [];

  if (group.angles.length === 0) {
    errors.push('Multicam group must have at least one angle');
  }

  if (group.activeAngleIndex < 0 || group.activeAngleIndex >= group.angles.length) {
    errors.push('Active angle index out of bounds');
  }

  if (group.durationSec <= 0) {
    errors.push('Duration must be positive');
  }

  if (group.timelineInSec < 0) {
    errors.push('Timeline start must be non-negative');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// =============================================================================
// Audio Synchronization
// =============================================================================

/**
 * Normalizes waveform peaks to 0-1 range.
 */
export function normalizeWaveformPeaks(peaks: number[]): number[] {
  if (peaks.length === 0) return [];

  const max = Math.max(...peaks);
  if (max === 0) return peaks;

  return peaks.map((p) => p / max);
}

/**
 * Calculates normalized cross-correlation between two signals at a given offset.
 *
 * @param signal1 First signal array
 * @param signal2 Second signal array
 * @param offset Sample offset (positive = signal2 is shifted right)
 * @returns Correlation value (0-1)
 */
export function calculateCrossCorrelation(
  signal1: number[],
  signal2: number[],
  offset: number
): number {
  if (signal1.length === 0 || signal2.length === 0) return 0;

  let sum = 0;
  let count = 0;
  let sum1Sq = 0;
  let sum2Sq = 0;

  for (let i = 0; i < signal1.length; i++) {
    const j = i + offset;
    if (j >= 0 && j < signal2.length) {
      sum += signal1[i] * signal2[j];
      sum1Sq += signal1[i] * signal1[i];
      sum2Sq += signal2[j] * signal2[j];
      count++;
    }
  }

  if (count === 0 || sum1Sq === 0 || sum2Sq === 0) return 0;

  // Normalized correlation
  return sum / Math.sqrt(sum1Sq * sum2Sq);
}

/**
 * Validates waveform data for audio sync operations.
 */
function validateWaveformData(waveform: WaveformData, name: string): string[] {
  const errors: string[] = [];

  if (!waveform.peaks || waveform.peaks.length === 0) {
    errors.push(`${name} has no peak data`);
  }

  if (waveform.samplesPerSecond <= 0) {
    errors.push(`${name} has invalid samplesPerSecond: ${waveform.samplesPerSecond}`);
  }

  return errors;
}

/**
 * Finds the audio sync offset between two waveforms using cross-correlation.
 *
 * @param waveform1 Reference waveform
 * @param waveform2 Waveform to sync
 * @param options Sync options
 * @returns Sync result with offset and confidence
 * @throws Error if waveform data is invalid
 */
export function findAudioSyncOffset(
  waveform1: WaveformData,
  waveform2: WaveformData,
  options: AudioSyncOptions = {}
): AudioSyncResult {
  // Validate inputs
  const errors = [
    ...validateWaveformData(waveform1, 'waveform1'),
    ...validateWaveformData(waveform2, 'waveform2'),
  ];

  if (errors.length > 0) {
    throw new Error(`Invalid waveform data: ${errors.join(', ')}`);
  }

  const maxOffsetSec = options.maxOffsetSec ?? 5.0;

  // Validate maxOffsetSec
  if (maxOffsetSec <= 0) {
    throw new Error('maxOffsetSec must be positive');
  }

  // Normalize peaks for comparison
  const peaks1 = normalizeWaveformPeaks(waveform1.peaks);
  const peaks2 = normalizeWaveformPeaks(waveform2.peaks);

  // Handle empty normalized peaks
  if (peaks1.length === 0 || peaks2.length === 0) {
    return { offsetSec: 0, confidence: 0 };
  }

  // Calculate max offset in samples
  const sps = waveform1.samplesPerSecond;
  const maxOffsetSamples = Math.floor(maxOffsetSec * sps);

  let bestOffset = 0;
  let bestCorrelation = -1;

  // Search through offsets (both positive and negative)
  for (let offset = -maxOffsetSamples; offset <= maxOffsetSamples; offset++) {
    const correlation = calculateCrossCorrelation(peaks1, peaks2, offset);
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestOffset = offset;
    }
  }

  // Convert samples to seconds
  // Negative bestOffset means peaks2 should be shifted left (earlier)
  const offsetSec = -bestOffset / sps;

  return {
    offsetSec,
    confidence: Math.max(0, bestCorrelation),
  };
}

/**
 * Checks if angles can be synchronized using audio.
 */
export function canSyncAngles(angles: MulticamAngle[]): boolean {
  const anglesWithAudio = angles.filter((a) => a.hasAudio !== false);
  return anglesWithAudio.length >= 2;
}

// =============================================================================
// Angle Management
// =============================================================================

/**
 * Adds a new angle to a multicam group.
 */
export function addAngleToGroup(
  group: MulticamGroup,
  angle: MulticamAngle
): MulticamGroup {
  return {
    ...group,
    angles: [...group.angles, angle],
    modifiedAt: new Date().toISOString(),
  };
}

/**
 * Removes an angle from a multicam group by ID.
 */
export function removeAngleFromGroup(
  group: MulticamGroup,
  angleId: string
): MulticamGroup {
  const angleIndex = group.angles.findIndex((a) => a.id === angleId);
  if (angleIndex === -1) return group;

  const newAngles = group.angles.filter((a) => a.id !== angleId);

  // Adjust active angle index if needed
  let newActiveIndex = group.activeAngleIndex;
  if (newActiveIndex >= newAngles.length) {
    newActiveIndex = Math.max(0, newAngles.length - 1);
  }

  // Remove angle switches that reference the removed angle
  const newSwitches = group.angleSwitches.filter(
    (sw) => sw.fromAngleIndex !== angleIndex && sw.toAngleIndex !== angleIndex
  );

  // Adjust switch indices for removed angle
  const adjustedSwitches = newSwitches.map((sw) => ({
    ...sw,
    fromAngleIndex: sw.fromAngleIndex > angleIndex ? sw.fromAngleIndex - 1 : sw.fromAngleIndex,
    toAngleIndex: sw.toAngleIndex > angleIndex ? sw.toAngleIndex - 1 : sw.toAngleIndex,
  }));

  return {
    ...group,
    angles: newAngles,
    activeAngleIndex: newActiveIndex,
    angleSwitches: adjustedSwitches,
    modifiedAt: new Date().toISOString(),
  };
}

/**
 * Switches the active angle in a multicam group.
 */
export function switchActiveAngle(
  group: MulticamGroup,
  newAngleIndex: number
): MulticamGroup {
  if (newAngleIndex < 0 || newAngleIndex >= group.angles.length) {
    throw new Error('Invalid angle index');
  }

  return {
    ...group,
    activeAngleIndex: newAngleIndex,
    modifiedAt: new Date().toISOString(),
  };
}

// =============================================================================
// Angle Switches
// =============================================================================

/**
 * Creates a new angle switch point.
 */
export function createAngleSwitchPoint(options: CreateAngleSwitchOptions): AngleSwitch {
  return {
    id: nanoid(),
    timeSec: options.timeSec,
    fromAngleIndex: options.fromAngleIndex,
    toAngleIndex: options.toAngleIndex,
    transitionType: options.transitionType ?? 'cut',
    transitionDurationSec: options.transitionDurationSec,
  };
}

/**
 * Validates an angle switch against a multicam group.
 */
export function validateAngleSwitch(
  switchPoint: AngleSwitch,
  group: MulticamGroup
): AngleSwitchValidationResult {
  const groupStart = group.timelineInSec;
  const groupEnd = groupStart + group.durationSec;

  // Check time range - switch must be within group bounds
  // Note: A switch at exactly groupEnd is technically at the last frame,
  // but has no visible effect. We allow it for flexibility but exclude
  // it from strict validation.
  if (switchPoint.timeSec < groupStart || switchPoint.timeSec >= groupEnd) {
    return {
      valid: false,
      error: `Switch time ${switchPoint.timeSec} is outside group time range [${groupStart}, ${groupEnd})`,
    };
  }

  // Check same angle
  if (switchPoint.fromAngleIndex === switchPoint.toAngleIndex) {
    return {
      valid: false,
      error: 'Cannot switch to same angle',
    };
  }

  // Check angle indices
  if (
    switchPoint.fromAngleIndex < 0 ||
    switchPoint.fromAngleIndex >= group.angles.length ||
    switchPoint.toAngleIndex < 0 ||
    switchPoint.toAngleIndex >= group.angles.length
  ) {
    return {
      valid: false,
      error: `Invalid angle index (valid range: 0-${group.angles.length - 1})`,
    };
  }

  // Check transition duration for non-cut transitions
  if (
    switchPoint.transitionType !== 'cut' &&
    switchPoint.transitionDurationSec !== undefined
  ) {
    if (switchPoint.transitionDurationSec <= 0) {
      return {
        valid: false,
        error: 'Transition duration must be positive',
      };
    }
    // Ensure transition doesn't extend beyond group
    if (switchPoint.timeSec + switchPoint.transitionDurationSec > groupEnd) {
      return {
        valid: false,
        error: 'Transition extends beyond group end',
      };
    }
  }

  return { valid: true };
}

/**
 * Gets the active angle at a specific timeline time.
 */
export function getAngleAtTime(
  group: MulticamGroup,
  timeSec: number
): AngleAtTimeResult | null {
  const groupStart = group.timelineInSec;
  const groupEnd = groupStart + group.durationSec;

  // Check if time is within group
  if (timeSec < groupStart || timeSec > groupEnd) {
    return null;
  }

  // Find the active angle by applying switches in order
  let currentAngleIndex = group.activeAngleIndex;

  // Sort switches by time and find the most recent one before timeSec
  const sortedSwitches = sortAngleSwitches(group.angleSwitches);

  for (const sw of sortedSwitches) {
    if (sw.timeSec <= timeSec) {
      currentAngleIndex = sw.toAngleIndex;
    } else {
      break;
    }
  }

  return {
    angleIndex: currentAngleIndex,
    angle: group.angles[currentAngleIndex],
  };
}

/**
 * Gets angle switches within a time range.
 */
export function getAngleSwitchesInRange(
  switches: AngleSwitch[],
  startSec: number,
  endSec: number
): AngleSwitch[] {
  return switches.filter((sw) => sw.timeSec >= startSec && sw.timeSec <= endSec);
}

/**
 * Sorts angle switches by time in ascending order.
 */
export function sortAngleSwitches(switches: AngleSwitch[]): AngleSwitch[] {
  return [...switches].sort((a, b) => a.timeSec - b.timeSec);
}

// =============================================================================
// Group Operations
// =============================================================================

/**
 * Calculates the total duration of a multicam group.
 */
export function calculateGroupDuration(group: MulticamGroup): number {
  return group.durationSec;
}

/**
 * Merges two overlapping multicam groups.
 */
export function mergeOverlappingGroups(
  group1: MulticamGroup,
  group2: MulticamGroup
): MulticamGroup {
  const start1 = group1.timelineInSec;
  const end1 = start1 + group1.durationSec;
  const start2 = group2.timelineInSec;
  const end2 = start2 + group2.durationSec;

  // Check for overlap
  if (end1 < start2 || end2 < start1) {
    throw new Error('Groups do not overlap');
  }

  const newStart = Math.min(start1, start2);
  const newEnd = Math.max(end1, end2);

  // Merge angles (avoid duplicates by clipId)
  const allAngles = [...group1.angles];
  for (const angle of group2.angles) {
    if (!allAngles.some((a) => a.clipId === angle.clipId)) {
      allAngles.push(angle);
    }
  }

  // Merge switches (adjust indices as needed)
  const allSwitches = [...group1.angleSwitches, ...group2.angleSwitches];

  return {
    id: nanoid(),
    sequenceId: group1.sequenceId,
    name: `${group1.name} + ${group2.name}`,
    angles: allAngles,
    activeAngleIndex: 0,
    timelineInSec: newStart,
    durationSec: newEnd - newStart,
    audioMixMode: group1.audioMixMode,
    angleSwitches: sortAngleSwitches(allSwitches),
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
  };
}

/**
 * Splits a multicam group at a specific time.
 */
export function splitMulticamGroup(
  group: MulticamGroup,
  splitTimeSec: number
): [MulticamGroup, MulticamGroup] {
  const groupStart = group.timelineInSec;
  const groupEnd = groupStart + group.durationSec;

  if (splitTimeSec <= groupStart || splitTimeSec >= groupEnd) {
    throw new Error('Split time outside group range');
  }

  const now = new Date().toISOString();

  // Get angle at split time to determine initial active angle for second group
  const angleAtSplit = getAngleAtTime(group, splitTimeSec);
  const secondActiveAngle = angleAtSplit?.angleIndex ?? group.activeAngleIndex;

  // Split switches
  const firstSwitches = group.angleSwitches.filter((sw) => sw.timeSec < splitTimeSec);
  const secondSwitches = group.angleSwitches.filter((sw) => sw.timeSec >= splitTimeSec);

  const first: MulticamGroup = {
    id: nanoid(),
    sequenceId: group.sequenceId,
    name: `${group.name} (Part 1)`,
    angles: [...group.angles],
    activeAngleIndex: group.activeAngleIndex,
    timelineInSec: groupStart,
    durationSec: splitTimeSec - groupStart,
    audioMixMode: group.audioMixMode,
    angleSwitches: firstSwitches,
    createdAt: now,
    modifiedAt: now,
  };

  const second: MulticamGroup = {
    id: nanoid(),
    sequenceId: group.sequenceId,
    name: `${group.name} (Part 2)`,
    angles: [...group.angles],
    activeAngleIndex: secondActiveAngle,
    timelineInSec: splitTimeSec,
    durationSec: groupEnd - splitTimeSec,
    audioMixMode: group.audioMixMode,
    angleSwitches: secondSwitches,
    createdAt: now,
    modifiedAt: now,
  };

  return [first, second];
}
