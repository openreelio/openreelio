import { useProjectStore } from '@/stores/projectStore';
import { getTimelineSnapshot, type ClipSnapshot } from './storeAccessor';

const EPSILON = 1e-6;

export interface PlannedCommandStep {
  commandType: string;
  payload: Record<string, unknown>;
}

export interface RippleEditPlan {
  steps: PlannedCommandStep[];
  timelineDelta: number;
  movedClipIds: string[];
}

export interface RollEditPlan {
  steps: PlannedCommandStep[];
  rollAmount: number;
}

export interface SlipEditPlan {
  steps: PlannedCommandStep[];
  offsetSeconds: number;
}

export interface SlideEditPlan {
  steps: PlannedCommandStep[];
  slideAmount: number;
  adjustedPrevClipId: string | null;
  adjustedNextClipId: string | null;
}

function requireStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function requireNumberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function isNearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
}

function effectiveSpeed(clip: ClipSnapshot): number {
  return Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
}

function timelineEnd(clip: ClipSnapshot): number {
  return clip.timelineIn + clip.duration;
}

function getTrackClips(trackId: string): ClipSnapshot[] {
  const snapshot = getTimelineSnapshot();
  return snapshot.clips
    .filter((clip) => clip.trackId === trackId)
    .sort((left, right) => left.timelineIn - right.timelineIn);
}

function findClipInTrack(
  trackClips: ClipSnapshot[],
  trackId: string,
  clipId: string,
): ClipSnapshot {
  const clip = trackClips.find((candidate) => candidate.id === clipId);
  if (!clip) {
    throw new Error(`Clip ${clipId} not found on track ${trackId}`);
  }
  return clip;
}

function getAssetDurationSec(assetId: string): number | null {
  const project = useProjectStore.getState() as {
    assets?: Map<string, { durationSec?: number }>;
  };

  if (!(project.assets instanceof Map)) {
    return null;
  }

  const asset = project.assets.get(assetId);
  if (!asset || typeof asset.durationSec !== 'number') {
    return null;
  }

  if (!Number.isFinite(asset.durationSec) || asset.durationSec <= 0) {
    return null;
  }

  return asset.durationSec;
}

function validateSourceUpperBound(
  clip: ClipSnapshot,
  newSourceOut: number,
  errorMessage: string,
): void {
  const assetDurationSec = getAssetDurationSec(clip.assetId);
  if (assetDurationSec === null) {
    return;
  }

  if (newSourceOut > assetDurationSec + EPSILON) {
    throw new Error(errorMessage);
  }
}

function validatePositiveSourceDuration(
  newSourceIn: number,
  newSourceOut: number,
  label: string,
): void {
  if (newSourceOut <= newSourceIn + EPSILON) {
    throw new Error(`${label} would create non-positive source duration`);
  }
}

function validateNonNegativeSourceIn(value: number, label: string): void {
  if (value < -EPSILON) {
    throw new Error(`${label} would move source in below 0`);
  }
}

function validateAdjacent(left: ClipSnapshot, right: ClipSnapshot, errorMessage: string): void {
  if (left.trackId !== right.trackId) {
    throw new Error(errorMessage);
  }

  if (left.timelineIn >= right.timelineIn) {
    throw new Error(errorMessage);
  }

  if (!isNearlyEqual(timelineEnd(left), right.timelineIn)) {
    throw new Error(errorMessage);
  }
}

function toStep(commandType: string, payload: Record<string, unknown>): PlannedCommandStep {
  return { commandType, payload };
}

export function buildRippleEditPlan(args: Record<string, unknown>): RippleEditPlan {
  const sequenceId = requireStringArg(args, 'sequenceId');
  const trackId = requireStringArg(args, 'trackId');
  const clipId = requireStringArg(args, 'clipId');
  const trimEnd = requireNumberArg(args, 'trimEnd');

  const trackClips = getTrackClips(trackId);
  const targetClip = trackClips.find((clip) => clip.id === clipId);
  if (!targetClip) {
    throw new Error(`Clip ${clipId} not found on track ${trackId}`);
  }

  validatePositiveSourceDuration(targetClip.sourceIn, trimEnd, 'ripple_edit');
  validateSourceUpperBound(targetClip, trimEnd, 'ripple_edit exceeds source media duration');

  const sourceDelta = trimEnd - targetClip.sourceOut;
  const timelineDelta = sourceDelta / effectiveSpeed(targetClip);
  const currentEnd = timelineEnd(targetClip);

  const subsequentClips = trackClips.filter(
    (clip) => clip.id !== targetClip.id && clip.timelineIn >= currentEnd - EPSILON,
  );

  const moveOrder =
    timelineDelta > 0
      ? [...subsequentClips].sort((left, right) => right.timelineIn - left.timelineIn)
      : [...subsequentClips].sort((left, right) => left.timelineIn - right.timelineIn);

  const trimStep = toStep('TrimClip', {
    sequenceId,
    trackId,
    clipId,
    newSourceOut: trimEnd,
  });

  const moveSteps = moveOrder.map((clip) =>
    toStep('MoveClip', {
      sequenceId,
      trackId,
      clipId: clip.id,
      newTimelineIn: clip.timelineIn + timelineDelta,
    }),
  );

  const steps = timelineDelta > 0 ? [...moveSteps, trimStep] : [trimStep, ...moveSteps];

  return {
    steps,
    timelineDelta,
    movedClipIds: moveOrder.map((clip) => clip.id),
  };
}

export function buildRollEditPlan(args: Record<string, unknown>): RollEditPlan {
  const sequenceId = requireStringArg(args, 'sequenceId');
  const trackId = requireStringArg(args, 'trackId');
  const leftClipId = requireStringArg(args, 'leftClipId');
  const rightClipId = requireStringArg(args, 'rightClipId');
  const rollAmount = requireNumberArg(args, 'rollAmount');

  const trackClips = getTrackClips(trackId);
  const leftClip = findClipInTrack(trackClips, trackId, leftClipId);
  const rightClip = findClipInTrack(trackClips, trackId, rightClipId);
  validateAdjacent(leftClip, rightClip, 'Clips must be adjacent for roll edit');

  const leftDeltaSource = rollAmount * effectiveSpeed(leftClip);
  const rightDeltaSource = rollAmount * effectiveSpeed(rightClip);

  const newLeftSourceOut = leftClip.sourceOut + leftDeltaSource;
  const newRightSourceIn = rightClip.sourceIn + rightDeltaSource;
  const newRightTimelineIn = rightClip.timelineIn + rollAmount;

  validatePositiveSourceDuration(leftClip.sourceIn, newLeftSourceOut, 'roll_edit left clip');
  validatePositiveSourceDuration(newRightSourceIn, rightClip.sourceOut, 'roll_edit right clip');
  validateNonNegativeSourceIn(newRightSourceIn, 'roll_edit right clip');
  validateSourceUpperBound(leftClip, newLeftSourceOut, 'roll_edit exceeds source media duration');

  if (newRightTimelineIn < -EPSILON) {
    throw new Error('roll_edit would move the right clip before timeline start');
  }

  const leftStep = toStep('TrimClip', {
    sequenceId,
    trackId,
    clipId: leftClipId,
    newSourceOut: newLeftSourceOut,
  });

  const rightStep = toStep('TrimClip', {
    sequenceId,
    trackId,
    clipId: rightClipId,
    newSourceIn: newRightSourceIn,
    newTimelineIn: newRightTimelineIn,
  });

  const steps = rollAmount > 0 ? [rightStep, leftStep] : [leftStep, rightStep];

  return {
    steps,
    rollAmount,
  };
}

export function buildSlipEditPlan(args: Record<string, unknown>): SlipEditPlan {
  const sequenceId = requireStringArg(args, 'sequenceId');
  const trackId = requireStringArg(args, 'trackId');
  const clipId = requireStringArg(args, 'clipId');
  const offsetSeconds = requireNumberArg(args, 'offsetSeconds');

  const trackClips = getTrackClips(trackId);
  const clip = findClipInTrack(trackClips, trackId, clipId);
  const newSourceIn = clip.sourceIn + offsetSeconds;
  const newSourceOut = clip.sourceOut + offsetSeconds;

  validateNonNegativeSourceIn(newSourceIn, 'slip_edit');
  validatePositiveSourceDuration(newSourceIn, newSourceOut, 'slip_edit');
  validateSourceUpperBound(clip, newSourceOut, 'Slip offset exceeds source media duration');

  return {
    steps: [
      toStep('TrimClip', {
        sequenceId,
        trackId,
        clipId,
        newSourceIn,
        newSourceOut,
      }),
    ],
    offsetSeconds,
  };
}

export function buildSlideEditPlan(args: Record<string, unknown>): SlideEditPlan {
  const sequenceId = requireStringArg(args, 'sequenceId');
  const trackId = requireStringArg(args, 'trackId');
  const clipId = requireStringArg(args, 'clipId');
  const slideAmount = requireNumberArg(args, 'slideAmount');

  const trackClips = getTrackClips(trackId);
  const clipIndex = trackClips.findIndex((clip) => clip.id === clipId);
  if (clipIndex === -1) {
    throw new Error(`Clip ${clipId} not found on track ${trackId}`);
  }

  const targetClip = trackClips[clipIndex];
  const prevClip = clipIndex > 0 ? trackClips[clipIndex - 1] : null;
  const nextClip = clipIndex < trackClips.length - 1 ? trackClips[clipIndex + 1] : null;

  if (prevClip && !isNearlyEqual(timelineEnd(prevClip), targetClip.timelineIn)) {
    throw new Error('slide_edit requires the target clip to be contiguous with the previous clip');
  }
  if (nextClip && !isNearlyEqual(timelineEnd(targetClip), nextClip.timelineIn)) {
    throw new Error('slide_edit requires the target clip to be contiguous with the next clip');
  }

  const newTargetTimelineIn = targetClip.timelineIn + slideAmount;
  if (newTargetTimelineIn < -EPSILON) {
    throw new Error('slide_edit would move the clip before timeline start');
  }

  const beforeMoveSteps: PlannedCommandStep[] = [];
  const afterMoveSteps: PlannedCommandStep[] = [];

  if (prevClip) {
    const newPrevSourceOut = prevClip.sourceOut + slideAmount * effectiveSpeed(prevClip);
    validatePositiveSourceDuration(prevClip.sourceIn, newPrevSourceOut, 'slide_edit previous clip');
    validateSourceUpperBound(
      prevClip,
      newPrevSourceOut,
      'slide_edit exceeds source media duration',
    );

    const prevStep = toStep('TrimClip', {
      sequenceId,
      trackId,
      clipId: prevClip.id,
      newSourceOut: newPrevSourceOut,
    });

    if (slideAmount < 0) {
      beforeMoveSteps.push(prevStep);
    } else {
      afterMoveSteps.push(prevStep);
    }
  }

  if (nextClip) {
    const newNextSourceIn = nextClip.sourceIn + slideAmount * effectiveSpeed(nextClip);
    const newNextTimelineIn = nextClip.timelineIn + slideAmount;

    validateNonNegativeSourceIn(newNextSourceIn, 'slide_edit next clip');
    validatePositiveSourceDuration(newNextSourceIn, nextClip.sourceOut, 'slide_edit next clip');

    const nextStep = toStep('TrimClip', {
      sequenceId,
      trackId,
      clipId: nextClip.id,
      newSourceIn: newNextSourceIn,
      newTimelineIn: newNextTimelineIn,
    });

    if (slideAmount > 0) {
      beforeMoveSteps.push(nextStep);
    } else {
      afterMoveSteps.push(nextStep);
    }
  }

  const moveStep = toStep('MoveClip', {
    sequenceId,
    trackId,
    clipId,
    newTimelineIn: newTargetTimelineIn,
  });

  return {
    steps: [...beforeMoveSteps, moveStep, ...afterMoveSteps],
    slideAmount,
    adjustedPrevClipId: prevClip?.id ?? null,
    adjustedNextClipId: nextClip?.id ?? null,
  };
}

export function toBackendCompoundSteps(planSteps: PlannedCommandStep[]): Array<{
  toolName: string;
  params: Record<string, unknown>;
}> {
  return planSteps.map((step) => ({
    toolName: step.commandType,
    params: step.payload,
  }));
}
