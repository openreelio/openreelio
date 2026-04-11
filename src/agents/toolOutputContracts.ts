export interface ToolOutputContract {
  summary: string;
  examples: string[];
  validatePath?: (path: string) => boolean;
}

const CLIP_OUTPUT_FIELDS = [
  'id',
  'assetId',
  'trackId',
  'timelineIn',
  'duration',
  'sourceIn',
  'sourceOut',
  'speed',
  'opacity',
  'hasEffects',
  'effectCount',
  'label',
] as const;

const TRACK_OUTPUT_FIELDS = [
  'id',
  'name',
  'kind',
  'clipCount',
  'muted',
  'locked',
  'visible',
  'volume',
] as const;

const TIMELINE_INFO_FIELDS = [
  'stateVersion',
  'sequenceId',
  'name',
  'duration',
  'trackCount',
  'clipCount',
  'playheadPosition',
] as const;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesArrayItemPath(
  path: string,
  base: string,
  allowedFields: readonly string[],
): boolean {
  const fieldPattern = allowedFields.join('|');
  return new RegExp(`^${escapeRegex(base)}(?:\\[\\d+\\])?(?:\\.(?:${fieldPattern}))?$`).test(path);
}

function matchesTrackClipsPath(path: string): boolean {
  const trackFieldPattern = TRACK_OUTPUT_FIELDS.join('|');
  const clipFieldPattern = CLIP_OUTPUT_FIELDS.join('|');

  return (
    path === 'data' ||
    path === 'data.track' ||
    path === 'data.clips' ||
    new RegExp(`^data\\.track\\.(?:${trackFieldPattern})$`).test(path) ||
    new RegExp(`^data\\.clips\\[\\d+\\](?:\\.(?:${clipFieldPattern}))?$`).test(path)
  );
}

function matchesTimelineInfoPath(path: string): boolean {
  const infoFieldPattern = TIMELINE_INFO_FIELDS.join('|');
  return (
    path === 'data' ||
    new RegExp(`^data\\.(?:${infoFieldPattern})$`).test(path) ||
    /^data\.selectedClipIds(?:\[\d+\])?$/.test(path) ||
    /^data\.selectedTrackIds(?:\[\d+\])?$/.test(path)
  );
}

function matchesInsertClipPath(path: string): boolean {
  return (
    path === 'data' ||
    path === 'data.clipId' ||
    path === 'data.operationId' ||
    path === 'data.createdIds' ||
    /^data\.createdIds\[\d+\]$/.test(path)
  );
}

function matchesSplitClipPath(path: string): boolean {
  return (
    matchesInsertClipPath(path) ||
    path === 'data.newClipId' ||
    path === 'data.sourceClipId' ||
    path === 'data.deletedIds' ||
    /^data\.deletedIds\[\d+\]$/.test(path)
  );
}

export const TOOL_OUTPUT_CONTRACTS: Record<string, ToolOutputContract> = {
  get_timeline_info: {
    summary:
      'returns timeline metadata under data.* including sequenceId, duration, trackCount, clipCount, playheadPosition, selectedClipIds[n], and selectedTrackIds[n]',
    examples: ['data.sequenceId', 'data.duration', 'data.selectedTrackIds[0]'],
    validatePath: matchesTimelineInfoPath,
  },
  get_track_clips: {
    summary:
      'returns one track summary under data.track.* and track-scoped clips under data.clips[n].*',
    examples: ['data.track.id', 'data.clips[0].id', 'data.clips[0].timelineIn'],
    validatePath: matchesTrackClipsPath,
  },
  get_clips_at_time: {
    summary: 'returns clips across tracks under data[n].*',
    examples: ['data[0].id', 'data[0].trackId', 'data[0].timelineIn'],
    validatePath: (path) => matchesArrayItemPath(path, 'data', CLIP_OUTPUT_FIELDS),
  },
  get_selected_clips: {
    summary: 'returns selected clips under data[n].*',
    examples: ['data[0].id', 'data[0].trackId', 'data[0].timelineIn'],
    validatePath: (path) => matchesArrayItemPath(path, 'data', CLIP_OUTPUT_FIELDS),
  },
  insert_clip: {
    summary:
      'returns newly created timeline clip identifiers under data.clipId and data.createdIds[0]',
    examples: ['data.clipId', 'data.createdIds[0]'],
    validatePath: matchesInsertClipPath,
  },
  insert_clip_from_file: {
    summary:
      'returns newly created timeline clip identifiers under data.clipId and data.createdIds[0]',
    examples: ['data.clipId', 'data.createdIds[0]'],
    validatePath: matchesInsertClipPath,
  },
  split_clip: {
    summary:
      'returns split result fields under data.* including data.newClipId for the newly created right-hand segment',
    examples: ['data.newClipId', 'data.sourceClipId', 'data.createdIds[0]'],
    validatePath: matchesSplitClipPath,
  },
};

export function getToolOutputContract(toolName: string): ToolOutputContract | null {
  return TOOL_OUTPUT_CONTRACTS[toolName.trim().toLowerCase()] ?? null;
}

export function buildToolOutputContractSection(toolNames: string[]): string {
  const lines = toolNames
    .map((toolName) => {
      const contract = getToolOutputContract(toolName);
      if (!contract) {
        return null;
      }

      return `- ${toolName} -> ${contract.summary}; examples: ${contract.examples.join(', ')}`;
    })
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) {
    return '';
  }

  return ['## Tool Output Contracts', ...lines].join('\n');
}
