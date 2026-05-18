import type { ExecutionContext } from '../../ports/IToolExecutor';
import {
  getAssetCatalogSnapshot,
  getTimelineSnapshot,
  type ClipSnapshot,
} from '@/agents/tools/storeAccessor';
import { useProjectStore } from '@/stores/projectStore';
export { isReadOnlyToolName, requiresProjectMutationPreflight } from '../../core/toolSemantics';
import { requiresProjectMutationPreflight } from '../../core/toolSemantics';

const ID_PLACEHOLDER_PATTERNS: RegExp[] = [
  /(?:^|[_-])(placeholder|example|sample|dummy|temp|todo|tbd|unknown)(?:$|[_-])/i,
  /_from_(catalog|list|lookup|response|result)/i,
  /^asset_id(?:_|$)/i,
];

const TRACK_ALIAS_PATTERNS: RegExp[] = [/^(video|audio)_[0-9]+$/i];

const TIMELINE_NUMBER_ARG_KEYS = [
  'timelineStart',
  'timelineIn',
  'newTimelineIn',
  'position',
  'newPosition',
  'splitTime',
  'atTimelineSec',
  'startTime',
  'endTime',
  'duration',
  'durationSec',
  'newSourceIn',
  'newSourceOut',
  'sourceIn',
  'sourceOut',
] as const;

const SPLIT_TIME_ARG_KEYS = ['splitTime', 'atTimelineSec', 'position'] as const;
const EPSILON_SEC = 1e-6;

export function validateMutationStateRevision(
  context: ExecutionContext,
  trackedVersion?: number,
): { error: string | null; currentVersion: number } {
  const projectState = useProjectStore.getState();
  const currentVersion = projectState.stateVersion;

  if (!projectState.isLoaded) {
    return { error: null, currentVersion };
  }

  const expectedVersion = trackedVersion ?? context.expectedStateVersion ?? currentVersion;
  if (expectedVersion !== currentVersion) {
    return {
      currentVersion,
      error:
        `REV_CONFLICT: expected state version ${expectedVersion}, current version ${currentVersion}. ` +
        'Refresh context and re-plan with current IDs.',
    };
  }

  return { error: null, currentVersion };
}

export function validateMutationPreconditions(
  toolName: string,
  args: Record<string, unknown>,
  context: ExecutionContext,
  category?: string | null,
): string[] {
  const errors: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    if (!key.endsWith('Id') || typeof value !== 'string') {
      continue;
    }

    if (isPlaceholderId(value, key)) {
      errors.push(`${key} '${value}' looks like a placeholder or alias, not a real ID`);
    }
  }

  if (!requiresProjectMutationPreflight(toolName, category)) {
    return errors;
  }

  const timeline = getTimelineSnapshot();
  const catalog = getAssetCatalogSnapshot();

  if (!timeline.sequenceId) {
    errors.push('No active sequence is loaded for mutation preflight');
    return errors;
  }

  if (context.sequenceId && context.sequenceId !== timeline.sequenceId) {
    errors.push(
      `context sequence '${context.sequenceId}' does not match active sequence '${timeline.sequenceId}'`,
    );
    return errors;
  }

  if (typeof args.sequenceId === 'string' && args.sequenceId !== timeline.sequenceId) {
    errors.push(
      `sequenceId '${args.sequenceId}' does not match active sequence '${timeline.sequenceId}'`,
    );
  }

  const trackIds = new Set(timeline.tracks.map((track) => track.id));
  for (const trackKey of ['trackId', 'newTrackId', 'sourceTrackId', 'targetTrackId']) {
    const value = args[trackKey];
    if (typeof value === 'string' && !trackIds.has(value)) {
      errors.push(`${trackKey} '${value}' is not present in active timeline tracks`);
    }
  }

  const assetIds = new Set(catalog.assets.map((asset) => asset.id));
  for (const assetKey of ['assetId', 'sourceAssetId', 'targetAssetId']) {
    const value = args[assetKey];
    if (typeof value === 'string' && !assetIds.has(value)) {
      errors.push(`${assetKey} '${value}' is not present in project asset catalog`);
    }
  }

  const clipIds = new Set(timeline.clips.map((clip) => clip.id));
  for (const clipKey of ['clipId', 'sourceClipId', 'targetClipId']) {
    const value = args[clipKey];
    if (typeof value === 'string' && !clipIds.has(value)) {
      errors.push(`${clipKey} '${value}' is not present on the active timeline`);
    }
  }

  const clipById = new Map(timeline.clips.map((clip) => [clip.id, clip]));
  validateClipTrackPair(args, errors, clipById, trackIds, 'clipId', 'trackId');
  validateClipTrackPair(args, errors, clipById, trackIds, 'sourceClipId', 'sourceTrackId');
  validateClipTrackPair(args, errors, clipById, trackIds, 'targetClipId', 'targetTrackId');
  validateTimelineNumberArgs(args, errors);
  validateTrimRange(args, errors);
  validateSplitTime(toolName, args, errors, clipById);

  return errors;
}

function isPlaceholderId(value: string, key: string): boolean {
  if (ID_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))) {
    return true;
  }

  if (
    key.toLowerCase().includes('track') &&
    TRACK_ALIAS_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    return true;
  }

  return false;
}

function normalizeToolName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .replace(/__+/g, '_')
    .toLowerCase();
}

function validateClipTrackPair(
  args: Record<string, unknown>,
  errors: string[],
  clipById: Map<string, ClipSnapshot>,
  trackIds: Set<string>,
  clipKey: string,
  trackKey: string,
): void {
  const clipId = args[clipKey];
  const trackId = args[trackKey];
  if (typeof clipId !== 'string' || typeof trackId !== 'string' || !trackIds.has(trackId)) {
    return;
  }

  const clip = clipById.get(clipId);
  if (!clip || clip.trackId === trackId) {
    return;
  }

  errors.push(
    `${clipKey} '${clipId}' is on track '${clip.trackId}', not ${trackKey} '${trackId}'`,
  );
}

function validateTimelineNumberArgs(args: Record<string, unknown>, errors: string[]): void {
  for (const key of TIMELINE_NUMBER_ARG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) {
      continue;
    }

    const value = args[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${key} must be a finite number`);
      continue;
    }

    if (value < 0) {
      errors.push(`${key} must be >= 0`);
    }
  }
}

function validateTrimRange(args: Record<string, unknown>, errors: string[]): void {
  const sourceIn = args.newSourceIn;
  const sourceOut = args.newSourceOut;
  if (typeof sourceIn !== 'number' || typeof sourceOut !== 'number') {
    return;
  }

  if (!Number.isFinite(sourceIn) || !Number.isFinite(sourceOut)) {
    return;
  }

  if (sourceOut <= sourceIn) {
    errors.push(`newSourceOut ${sourceOut} must be greater than newSourceIn ${sourceIn}`);
  }
}

function validateSplitTime(
  toolName: string,
  args: Record<string, unknown>,
  errors: string[],
  clipById: Map<string, ClipSnapshot>,
): void {
  if (normalizeToolName(toolName) !== 'split_clip') {
    return;
  }

  const clipId = args.clipId;
  if (typeof clipId !== 'string') {
    return;
  }

  const clip = clipById.get(clipId);
  if (!clip) {
    return;
  }

  const splitTime = getFirstNumberArg(args, SPLIT_TIME_ARG_KEYS);
  if (!splitTime || !Number.isFinite(splitTime.value)) {
    return;
  }

  const clipStart = clip.timelineIn;
  const clipEnd = clip.timelineIn + clip.duration;
  if (splitTime.value <= clipStart + EPSILON_SEC || splitTime.value >= clipEnd - EPSILON_SEC) {
    errors.push(
      `${splitTime.key} ${splitTime.value} must be inside clip '${clip.id}' timeline range (${clipStart} - ${clipEnd})`,
    );
  }
}

function getFirstNumberArg<T extends readonly string[]>(
  args: Record<string, unknown>,
  keys: T,
): { key: T[number]; value: number } | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number') {
      return { key, value };
    }
  }

  return null;
}
