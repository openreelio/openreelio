import type { ExecutionContext } from '../../ports/IToolExecutor';
import {
  getAssetCatalogSnapshot,
  getTimelineSnapshot,
} from '@/agents/tools/storeAccessor';
import { useProjectStore } from '@/stores/projectStore';

const READ_ONLY_TOOL_PREFIXES = [
  'get_',
  'list_',
  'find_',
  'search_',
  'analyze_',
  'inspect_',
  'query_',
  'read_',
];

const ID_PLACEHOLDER_PATTERNS: RegExp[] = [
  /(?:^|[_-])(placeholder|example|sample|dummy|temp|todo|tbd|unknown)(?:$|[_-])/i,
  /_from_(catalog|list|lookup|response|result)/i,
  /^asset_id(?:_|$)/i,
];

const TRACK_ALIAS_PATTERNS: RegExp[] = [/^(video|audio)_[0-9]+$/i];

export function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return READ_ONLY_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

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
        `REV_CONFLICT: expected state version ${expectedVersion}, current version ${currentVersion}. `
        + 'Refresh context and re-plan with current IDs.',
    };
  }

  return { error: null, currentVersion };
}

export function validateMutationPreconditions(
  toolName: string,
  args: Record<string, unknown>,
  context: ExecutionContext,
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

  if (isReadOnlyToolName(toolName)) {
    return errors;
  }

  const timeline = getTimelineSnapshot();
  const catalog = getAssetCatalogSnapshot();

  if (!timeline.sequenceId) {
    return errors;
  }

  if (context.sequenceId && context.sequenceId !== timeline.sequenceId) {
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

  return errors;
}

function isPlaceholderId(value: string, key: string): boolean {
  if (ID_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))) {
    return true;
  }

  if (
    key.toLowerCase().includes('track')
    && TRACK_ALIAS_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    return true;
  }

  return false;
}
