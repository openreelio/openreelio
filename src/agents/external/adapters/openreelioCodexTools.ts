import { invoke } from '@tauri-apps/api/core';

import type {
  AgentPlan,
  AgentPlanResult,
  CommandResultDto,
  ExternalAgentApprovalTokenGrant,
  ExternalAgentApprovalTokenValidation,
  PlanRiskLevel,
  ProjectInfo,
  ProjectStateDto,
  StockMediaImportResult,
  StockMediaSearchResult,
} from '@/bindings';

import type { ExternalAgentApprovalDecisionProvider, ExternalAgentApprovalRequest } from '../types';
import type {
  CodexAppServerRequest,
  CodexDynamicToolCallResponse,
  CodexDynamicToolSpec,
  CodexJsonObject,
} from './CodexAppServerClient';

export interface OpenReelioCodexSessionContext {
  projectId: string;
  cwd?: string | null;
}

export interface OpenReelioCodexToolContext extends OpenReelioCodexSessionContext {
  runtimeId: 'codex';
  sessionId: string;
  sessionKnown?: boolean;
  approvalDecisionProvider?: ExternalAgentApprovalDecisionProvider;
}

const OPENREELIO_COMMAND_TYPES = [
  'InsertClip',
  'InsertEdit',
  'OverwriteEdit',
  'RippleDelete',
  'Lift',
  'ExtractEdit',
  'CloseGap',
  'CloseAllGaps',
  'RemoveClip',
  'MoveClip',
  'TrimClip',
  'SplitClip',
  'SetClipTransform',
  'SetClipSpeed',
  'ReverseClip',
  'SetClipEnabled',
  'LinkClips',
  'UnlinkClips',
  'GroupClips',
  'UngroupClips',
  'DetachAudio',
  'CreateFreezeFrame',
  'SetTimeRemap',
  'ClearTimeRemap',
  'SetClipMute',
  'SetClipAudio',
  'AddAudioKeyframe',
  'RemoveAudioKeyframe',
  'MoveAudioKeyframe',
  'SetAudioKeyframeValue',
  'SetAudioFadeIn',
  'SetAudioFadeOut',
  'SetTrackBlendMode',
  'SetClipBlendMode',
  'ImportAsset',
  'RemoveAsset',
  'CreateSequence',
  'SetMasterVolume',
  'CreateTrack',
  'RemoveTrack',
  'RenameTrack',
  'ReorderTracks',
  'ToggleTrackMute',
  'ToggleTrackLock',
  'ToggleTrackVisibility',
  'AddMarker',
  'RemoveMarker',
  'CreateCaption',
  'DeleteCaption',
  'UpdateCaption',
  'AddEffect',
  'RemoveEffect',
  'UpdateEffect',
  'AddMask',
  'UpdateMask',
  'RemoveMask',
  'AddTextClip',
  'UpdateTextClip',
  'RemoveTextClip',
  'CreateFolder',
  'RenameFile',
  'MoveFile',
  'DeleteFile',
  'ApplyAudioDucking',
  'CreateCompoundClip',
  'UnnestCompoundClip',
  'CreateAdjustmentLayer',
  'PasteEffects',
  'PasteAttributes',
  'RemoveAttributes',
] as const;

const OPENREELIO_COMMAND_TYPE_SET = new Set<string>(OPENREELIO_COMMAND_TYPES);

const OPENREELIO_WORKSPACE_COMMAND_TYPES = new Set<string>([
  'CreateFolder',
  'RenameFile',
  'MoveFile',
  'DeleteFile',
]);

const OPENREELIO_EXECUTABLE_COMMAND_TYPES = OPENREELIO_COMMAND_TYPES.filter(
  (commandType) => !OPENREELIO_WORKSPACE_COMMAND_TYPES.has(commandType),
);

const CONTEXT_TOKEN_TTL_MS = 10 * 60 * 1000;

interface ContextTokenRecord {
  token: string;
  sessionId: string;
  projectId: string;
  issuedAt: number;
  activeSequenceId: string | null;
  source: 'project_state' | 'timeline_snapshot' | 'assets_list' | 'selection_read';
}

const contextTokensBySessionId = new Map<string, ContextTokenRecord>();

export function clearOpenReelioCodexSession(sessionId: string): void {
  contextTokensBySessionId.delete(sessionId);
}

const EMPTY_OBJECT_SCHEMA: CodexJsonObject = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const COMMAND_EXECUTE_SCHEMA: CodexJsonObject = {
  type: 'object',
  required: ['commandType', 'payload', 'reason', 'contextToken'],
  properties: {
    commandType: {
      type: 'string',
      enum: OPENREELIO_EXECUTABLE_COMMAND_TYPES,
      description: 'PascalCase OpenReelio edit command type executable through command_execute.',
    },
    payload: {
      type: 'object',
      description: 'CamelCase JSON payload matching the command type.',
    },
    reason: {
      type: 'string',
      description: 'Short user-facing reason for the edit approval prompt.',
    },
    contextToken: {
      type: 'string',
      description:
        'Fresh mutation context token returned by openreelio.project_state, timeline_snapshot, or assets_list in this session.',
    },
  },
  additionalProperties: false,
};

const COMMAND_VALIDATE_SCHEMA: CodexJsonObject = {
  type: 'object',
  required: ['commandType', 'payload'],
  properties: {
    commandType: {
      type: 'string',
      enum: OPENREELIO_EXECUTABLE_COMMAND_TYPES,
      description: 'PascalCase OpenReelio edit command type to validate.',
    },
    payload: {
      type: 'object',
      description: 'CamelCase JSON payload matching the command type.',
    },
  },
  additionalProperties: false,
};

const PLAN_OBJECT_SCHEMA: CodexJsonObject = {
  type: 'object',
  description:
    'OpenReelio AgentPlan with id, goal, approvalGranted, and ordered steps using toolName and params.',
};

const PLAN_VALIDATE_SCHEMA: CodexJsonObject = {
  type: 'object',
  required: ['plan'],
  properties: {
    plan: PLAN_OBJECT_SCHEMA,
  },
  additionalProperties: false,
};

const PLAN_APPLY_SCHEMA: CodexJsonObject = {
  type: 'object',
  required: ['plan', 'reason', 'contextToken'],
  properties: {
    plan: PLAN_OBJECT_SCHEMA,
    reason: {
      type: 'string',
      description: 'Short user-facing reason for the plan approval prompt.',
    },
    contextToken: {
      type: 'string',
      description:
        'Fresh mutation context token returned by openreelio.project_state, timeline_snapshot, assets_list, or selection_read in this session.',
    },
  },
  additionalProperties: false,
};

const STOCK_MEDIA_SEARCH_SCHEMA: CodexJsonObject = {
  type: 'object',
  required: ['query'],
  properties: {
    query: {
      type: 'string',
      description: 'Concise English-first visual or audio search query.',
    },
    assetType: {
      type: 'string',
      enum: ['video', 'image', 'audio'],
      description: 'Candidate asset type. Defaults to video.',
    },
    limit: {
      type: 'number',
      description: 'Maximum results to return, from 1 to 50. Defaults to 10.',
    },
  },
  additionalProperties: false,
};

const STOCK_MEDIA_IMPORT_SCHEMA: CodexJsonObject = {
  type: 'object',
  required: [
    'sourceUrl',
    'name',
    'assetType',
    'provider',
    'license',
    'licenseAck',
    'reason',
    'contextToken',
  ],
  properties: {
    sourceUrl: {
      type: 'string',
      description:
        'HTTPS download URL from a stock_media_search result metadata.downloadUrl or metadata.previewUrl.',
    },
    name: {
      type: 'string',
      description: 'Readable asset name to use in the OpenReelio project.',
    },
    assetType: {
      type: 'string',
      enum: ['video', 'image', 'audio'],
      description: 'Asset type matching the selected candidate.',
    },
    provider: {
      type: 'string',
      description: 'Provider name from the selected candidate, such as openverse or pexels.',
    },
    license: {
      type: 'object',
      description: 'LicenseInfo object from the selected stock_media_search candidate.',
    },
    licenseAck: {
      type: 'boolean',
      description:
        'Must be true after the agent has presented the provider/license terms in the approval reason.',
    },
    durationSec: {
      type: 'number',
      description: 'Optional candidate duration in seconds.',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional candidate tags to persist on the imported asset.',
    },
    providerUrl: {
      type: 'string',
      description: 'Optional provider landing page URL for attribution and review.',
    },
    reason: {
      type: 'string',
      description: 'Short user-facing reason for downloading and importing this stock asset.',
    },
    contextToken: {
      type: 'string',
      description:
        'Fresh mutation context token returned by openreelio.project_state, timeline_snapshot, assets_list, or selection_read in this session.',
    },
  },
  additionalProperties: false,
};

export const OPENREELIO_CODEX_DYNAMIC_TOOLS: CodexDynamicToolSpec[] = [
  {
    namespace: 'openreelio',
    name: 'host_context',
    description:
      'Read the OpenReelio desktop host context, active project identity, editing policy, and available app control capabilities.',
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'project_state',
    description:
      'Read the current OpenReelio project state, including assets, sequences, active sequence, and dirty state.',
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'timeline_snapshot',
    description:
      'Read a concise snapshot of the active OpenReelio timeline, tracks, clips, markers, and current sequence.',
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'assets_list',
    description: 'Read OpenReelio asset metadata and offline/missing status.',
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'stock_media_search',
    description:
      'Search configured stock providers for video, image, or audio candidates. Returns provider references, previews, license info, and license policy decisions. Does not import or place media.',
    inputSchema: STOCK_MEDIA_SEARCH_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'stock_media_import',
    description:
      'Download a selected stock_media_search candidate into the project and import it as an OpenReelio asset after explicit approval and license acknowledgement.',
    inputSchema: STOCK_MEDIA_IMPORT_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'selection_read',
    description:
      'Read current timeline selection, selected project asset, playhead, and active editing tool state.',
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'diagnostics_read',
    description:
      'Read non-mutating project/runtime diagnostics relevant to planning safe OpenReelio edits.',
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'preview_describe',
    description:
      'Read preview/playback state and whether raw frame inspection is available through the OpenReelio bridge.',
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'command_schema',
    description:
      'Read the supported OpenReelio event-sourced edit command types and payload conventions.',
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'command_validate',
    description:
      'Validate one OpenReelio edit command payload without mutating the project or asking for approval.',
    inputSchema: COMMAND_VALIDATE_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'plan_validate',
    description:
      'Validate an OpenReelio AgentPlan and every step payload without mutating the project or asking for approval.',
    inputSchema: PLAN_VALIDATE_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'diff_preview',
    description:
      'Preview a non-mutating structural summary of an OpenReelio AgentPlan after validation.',
    inputSchema: PLAN_VALIDATE_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'plan_apply',
    description:
      'Apply a validated OpenReelio AgentPlan atomically through execute_agent_plan after explicit user approval.',
    inputSchema: PLAN_APPLY_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'command_execute',
    description:
      'Execute one schema-validated OpenReelio edit command through the app command log after explicit user approval.',
    inputSchema: COMMAND_EXECUTE_SCHEMA,
  },
];

const OPENREELIO_DYNAMIC_TOOL_NAME_SET = new Set<string>(
  OPENREELIO_CODEX_DYNAMIC_TOOLS.map((tool) => tool.name),
);

interface NormalizedOpenReelioDynamicToolCall {
  namespace: string | null;
  tool: string;
  arguments: CodexJsonObject | null;
}

export function buildOpenReelioCodexDeveloperInstructions(
  context: OpenReelioCodexSessionContext,
): string {
  const projectPath = context.cwd?.trim() || 'not provided';
  return [
    'You are Codex running embedded inside OpenReelio, a Tauri desktop video-editing IDE.',
    'This is not a standalone terminal chat. Treat OpenReelio as the host application and the active video project as your primary workspace.',
    '',
    'Current OpenReelio session:',
    `- appSurface: tauri-desktop`,
    `- projectId: ${context.projectId}`,
    `- projectPath: ${projectPath}`,
    '',
    'OpenReelio editing rules:',
    '- Project truth is the OpenReelio command log, not direct JSON state mutation.',
    '- Use OpenReelio dynamic tools before claiming project, timeline, asset, or selection facts.',
    '- Use openreelio.host_context first when the user asks where you are, what you can use, or what environment this is.',
    '- Use openreelio.timeline_snapshot, openreelio.assets_list, openreelio.selection_read, and openreelio.command_schema before proposing concrete edits.',
    '- Use openreelio.stock_media_search for stock video, image, BGM, or SFX candidates before falling back to generic web links.',
    '- Use openreelio.stock_media_import to bring a selected stock candidate into the project before placing it on the timeline. Do not pass stock URLs directly to ImportAsset.',
    '- Prefer openreelio.plan_validate and openreelio.plan_apply for multi-step edits. Use openreelio.command_execute only for a narrow single-command edit.',
    '- Apply edits with the fresh contextToken returned by openreelio.project_state, openreelio.timeline_snapshot, openreelio.assets_list, or openreelio.selection_read so the app can validate, approve, persist, undo, and refresh the UI.',
    '- Do not manually edit .openreelio state files or invent command payloads without checking the schema and current IDs.',
    '- Do not use shell or filesystem tools to mutate OpenReelio project state; OpenReelio edits must go through the command log.',
    '- Shell and filesystem tools are secondary; prefer OpenReelio tools for video-editing state and mutations.',
    '',
    'Available OpenReelio dynamic tools:',
    OPENREELIO_CODEX_DYNAMIC_TOOLS.map((tool) => `- openreelio.${tool.name}`).join('\n'),
  ].join('\n');
}

export async function handleOpenReelioCodexDynamicToolCall(
  request: CodexAppServerRequest,
  context: OpenReelioCodexToolContext,
): Promise<CodexDynamicToolCallResponse | null> {
  const toolCall = normalizeOpenReelioDynamicToolCall(request);
  if (!toolCall) {
    return null;
  }

  if (!context.sessionKnown) {
    return toolResponse(
      {
        status: 'error',
        message:
          'OpenReelio tool call rejected because the Codex thread is not linked to an active OpenReelio session.',
      },
      false,
    );
  }

  try {
    switch (toolCall.tool) {
      case 'host_context':
        return toolResponse(await buildHostContext(context));
      case 'project_state':
        return toolResponse(await buildProjectStateResponse(context));
      case 'timeline_snapshot':
        return toolResponse(buildTimelineSnapshot(await readProjectState(), context));
      case 'assets_list':
        return toolResponse(buildAssetsList(await readProjectState(), context));
      case 'stock_media_search': {
        const result = await searchStockMediaToolCall(toolCall.arguments);
        return toolResponse(result, result.status === 'ok');
      }
      case 'stock_media_import': {
        const result = await importStockMediaToolCall(toolCall.arguments, request, context);
        return toolResponse(result, result.status === 'ok');
      }
      case 'selection_read':
        return toolResponse(await buildSelectionResponse(context));
      case 'diagnostics_read':
        return toolResponse(await buildDiagnosticsResponse());
      case 'preview_describe':
        return toolResponse(await buildPreviewDescription());
      case 'command_schema':
        return toolResponse(buildCommandSchema());
      case 'command_validate': {
        const result = await validateCommandToolCall(toolCall.arguments);
        return toolResponse(result, result.status === 'ok');
      }
      case 'plan_validate': {
        const result = await validatePlanToolCall(toolCall.arguments);
        return toolResponse(result, result.status === 'ok');
      }
      case 'diff_preview': {
        const result = await previewPlanDiff(toolCall.arguments);
        return toolResponse(result, result.status === 'ok');
      }
      case 'plan_apply': {
        const result = await applyApprovedPlan(toolCall.arguments, request, context);
        return toolResponse(result, result.status === 'ok');
      }
      case 'command_execute': {
        const result = await executeApprovedCommand(toolCall.arguments, request, context);
        return toolResponse(result, result.status === 'ok');
      }
      default:
        return toolResponse(
          {
            status: 'error',
            message: `OpenReelio dynamic tool '${toolCall.tool}' is not available.`,
          },
          false,
        );
    }
  } catch (error) {
    return toolResponse(
      {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      },
      false,
    );
  }
}

function normalizeOpenReelioDynamicToolCall(
  request: CodexAppServerRequest,
): NormalizedOpenReelioDynamicToolCall | null {
  if (request.method !== 'item/tool/call') {
    return null;
  }

  const params = request.params ?? {};
  const toolIdentity = parseDynamicToolIdentity(params);
  if (!toolIdentity) {
    return null;
  }

  if (toolIdentity.namespace && toolIdentity.namespace !== 'openreelio') {
    return null;
  }

  if (!OPENREELIO_DYNAMIC_TOOL_NAME_SET.has(toolIdentity.tool)) {
    return null;
  }

  return {
    namespace: toolIdentity.namespace,
    tool: toolIdentity.tool,
    arguments: parseDynamicToolArguments(params),
  };
}

function parseDynamicToolIdentity(
  params: CodexJsonObject,
): { namespace: string | null; tool: string } | null {
  const rawTool =
    getString(params, 'tool') ?? getString(params, 'name') ?? getString(params, 'toolName');
  if (!rawTool?.trim()) {
    return null;
  }

  const parsedTool = splitQualifiedToolName(rawTool);
  const rawNamespace =
    getString(params, 'namespace') ?? getString(params, 'toolNamespace') ?? parsedTool.namespace;
  const namespace = rawNamespace?.trim() || null;
  const tool = parsedTool.tool.trim();
  if (!tool) {
    return null;
  }

  return { namespace, tool };
}

function splitQualifiedToolName(rawTool: string): { namespace: string | null; tool: string } {
  const trimmed = rawTool.trim();
  for (const separator of ['.', '/', ':']) {
    const separatorIndex = trimmed.indexOf(separator);
    if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
      continue;
    }

    return {
      namespace: trimmed.slice(0, separatorIndex),
      tool: trimmed.slice(separatorIndex + 1),
    };
  }

  return { namespace: null, tool: trimmed };
}

function parseDynamicToolArguments(params: CodexJsonObject): CodexJsonObject | null {
  const rawArguments = getFirstProperty(params, ['arguments', 'input', 'args', 'parameters']);
  if (rawArguments === undefined || rawArguments === null) {
    return {};
  }

  const objectArguments = asObject(rawArguments);
  if (objectArguments) {
    return objectArguments;
  }

  if (typeof rawArguments !== 'string') {
    return null;
  }

  const trimmed = rawArguments.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return asObject(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

async function buildHostContext(context: OpenReelioCodexToolContext): Promise<CodexJsonObject> {
  const projectInfo = await readOptionalProjectInfo();
  const projectState = await readOptionalProjectState();
  return {
    host: {
      appId: 'openreelio',
      appName: 'OpenReelio',
      surface: 'tauri-desktop',
      runtime: 'codex-app-server',
      controlMode: 'dynamic-tools',
    },
    project: {
      available: Boolean(projectInfo ?? projectState),
      projectId: projectInfo?.id ?? context.projectId,
      projectName: projectInfo?.name ?? projectState?.meta?.name ?? null,
      projectPath: projectInfo?.path ?? context.cwd ?? null,
      activeSequenceId: projectState?.activeSequenceId ?? null,
      assetCount: projectState?.assets?.length ?? null,
      sequenceCount: projectState?.sequences?.length ?? null,
      isDirty: projectState?.isDirty ?? null,
    },
    ui: {
      activePanel: 'agent-chat',
      previewFrameAccess: false,
      rawMediaAccess: 'not-exposed',
    },
    capabilities: {
      projectStateRead: true,
      timelineRead: true,
      assetRead: true,
      commandSchemaRead: true,
      commandValidate: true,
      stockMediaSearch: true,
      stockMediaImport: true,
      planValidate: true,
      planApplyWithApproval: true,
      diffPreview: true,
      selectionRead: true,
      diagnosticsRead: true,
      previewDescribe: true,
      commandExecuteWithApproval: true,
      undoableCommandLog: true,
    },
    policy: {
      mutationPath: 'openreelio.plan_apply',
      approvalRequiredForMutations: true,
      directStateFileEdits: 'forbidden',
      contextTokenRequiredForMutations: true,
      mutationContextSources: [
        'project_state',
        'timeline_snapshot',
        'assets_list',
        'selection_read',
      ],
    },
  };
}

async function buildProjectStateResponse(
  context: OpenReelioCodexToolContext,
): Promise<CodexJsonObject> {
  const state = await readProjectState();
  const contextToken = issueContextToken(context, state, 'project_state');
  return {
    contextToken: contextToken.token,
    contextTokenExpiresAt: contextToken.issuedAt + CONTEXT_TOKEN_TTL_MS,
    projectState: state as unknown as CodexJsonObject,
  };
}

async function buildSelectionResponse(
  context: OpenReelioCodexToolContext,
): Promise<CodexJsonObject> {
  const [state, timelineModule, playbackModule, projectModule, editorToolModule] =
    await Promise.all([
      readProjectState(),
      import('@/stores/timelineStore'),
      import('@/stores/playbackStore'),
      import('@/stores/projectStore'),
      import('@/stores/editorToolStore'),
    ]);
  const timelineState = timelineModule.useTimelineStore.getState();
  const playbackState = playbackModule.usePlaybackStore.getState();
  const projectStoreState = projectModule.useProjectStore.getState();
  const editorToolState = editorToolModule.useEditorToolStore.getState();
  const selectedClipIds = [...timelineState.selectedClipIds];
  const selectedTrackIds = [...timelineState.selectedTrackIds];
  const contextToken = issueContextToken(context, state, 'selection_read');

  return {
    contextToken: contextToken.token,
    contextTokenExpiresAt: contextToken.issuedAt + CONTEXT_TOKEN_TTL_MS,
    activeSequenceId: state.activeSequenceId,
    selectedClipIds,
    selectedTrackIds,
    selectedAssetId: projectStoreState.selectedAssetId,
    playheadSec: playbackState.currentTime,
    playback: {
      isPlaying: playbackState.isPlaying,
      duration: playbackState.duration,
      playbackRate: playbackState.playbackRate,
      muted: playbackState.isMuted,
    },
    activeTool: editorToolState.activeTool,
    selectedClips: selectedClipIds.map((clipId) => findClipSummary(state, clipId)).filter(Boolean),
    selectedTracks: selectedTrackIds
      .map((trackId) => findTrackSummary(state, trackId))
      .filter(Boolean),
  };
}

async function buildDiagnosticsResponse(): Promise<CodexJsonObject> {
  const [projectInfo, projectState] = await Promise.all([
    readOptionalProjectInfo(),
    readOptionalProjectState(),
  ]);
  let frontendError: string | null = null;
  try {
    const projectModule = await import('@/stores/projectStore');
    frontendError = projectModule.useProjectStore.getState().error;
  } catch {
    frontendError = null;
  }

  const missingAssets =
    projectState?.assets
      ?.filter((asset) => asset.missing)
      .map((asset) => ({
        id: asset.id,
        name: asset.name,
        kind: asset.kind,
      })) ?? [];

  return {
    available: Boolean(projectInfo ?? projectState),
    projectId: projectInfo?.id ?? null,
    projectName: projectInfo?.name ?? projectState?.meta?.name ?? null,
    activeSequenceId: projectState?.activeSequenceId ?? null,
    isDirty: projectState?.isDirty ?? null,
    assetCount: projectState?.assets?.length ?? 0,
    sequenceCount: projectState?.sequences?.length ?? 0,
    missingAssetCount: missingAssets.length,
    missingAssets,
    frontendError,
    policy: {
      mutationRequiresApproval: true,
      commandPayloadValidation: true,
      planApplyPath: 'execute_agent_plan',
      directStateFileEdits: 'forbidden',
    },
  };
}

async function buildPreviewDescription(): Promise<CodexJsonObject> {
  const [state, playbackModule, previewModule] = await Promise.all([
    readOptionalProjectState(),
    import('@/stores/playbackStore'),
    import('@/stores/previewStore'),
  ]);
  const playbackState = playbackModule.usePlaybackStore.getState();
  const previewState = previewModule.usePreviewStore.getState();
  const activeSequence = state?.sequences.find(
    (sequence) => sequence.id === state.activeSequenceId,
  );

  return {
    available: Boolean(state),
    activeSequenceId: state?.activeSequenceId ?? null,
    activeSequence: activeSequence ? summarizeSequence(activeSequence) : null,
    playheadSec: playbackState.currentTime,
    durationSec: playbackState.duration,
    isPlaying: playbackState.isPlaying,
    playbackRate: playbackState.playbackRate,
    preview: {
      zoomLevel: previewState.zoomLevel,
      zoomMode: previewState.zoomMode,
      panX: previewState.panX,
      panY: previewState.panY,
    },
    mediaInspection: {
      rawFrameAccess: false,
      transcriptAccess: false,
      waveformAccess: false,
      message:
        'Raw frame, transcript, and waveform analysis are not exposed through this Codex bridge yet.',
    },
  };
}

async function executeApprovedCommand(
  args: CodexJsonObject | null,
  request: CodexAppServerRequest,
  context: OpenReelioCodexToolContext,
): Promise<CodexJsonObject> {
  if (!args) {
    throw new Error('OpenReelio command_execute requires object arguments.');
  }

  const commandType = getString(args, 'commandType')?.trim();
  if (!commandType) {
    throw new Error('OpenReelio command_execute requires commandType.');
  }

  if (!OPENREELIO_COMMAND_TYPE_SET.has(commandType)) {
    return {
      status: 'error',
      commandType,
      message: `OpenReelio command '${commandType}' is not in the supported command enum.`,
    };
  }

  if (OPENREELIO_WORKSPACE_COMMAND_TYPES.has(commandType)) {
    return {
      status: 'error',
      commandType,
      message:
        'Workspace filesystem commands are not available through Codex timeline editing. Use the dedicated OpenReelio workspace flow instead.',
    };
  }

  const payload = asObject(args.payload);
  if (!payload) {
    throw new Error('OpenReelio command_execute requires an object payload.');
  }

  const reason = getString(args, 'reason')?.trim() || `Execute ${commandType}`;
  const contextToken = getString(args, 'contextToken')?.trim() ?? null;
  const tokenValidation = validateContextToken(context, contextToken);
  if (!tokenValidation.valid) {
    return {
      status: 'error',
      commandType,
      message: tokenValidation.message,
    };
  }

  const payloadValidation = await validateCommandPayload(commandType, payload);
  if (!payloadValidation.valid) {
    return {
      status: 'error',
      commandType,
      message: payloadValidation.message,
    };
  }

  const decision = context.approvalDecisionProvider
    ? await context.approvalDecisionProvider(
        buildCommandApprovalRequest({
          request,
          context,
          commandType,
          payload,
          reason,
        }),
      )
    : 'decline';

  if (decision !== 'accept' && decision !== 'acceptForSession') {
    return {
      status: 'denied',
      commandType,
      message:
        'The OpenReelio command was not approved. Approve it with the chat approval card; plain chat replies do not grant tool execution.',
    };
  }

  const result = await invoke<CommandResultDto>('execute_command', {
    commandType,
    payload,
  });
  contextTokensBySessionId.delete(context.sessionId);
  const refresh = await refreshProjectStoreAfterMutation();

  return {
    status: 'ok',
    commandType,
    result,
    refresh,
  };
}

async function validateCommandToolCall(args: CodexJsonObject | null): Promise<CodexJsonObject> {
  if (!args) {
    throw new Error('OpenReelio command_validate requires object arguments.');
  }

  const commandType = getString(args, 'commandType')?.trim();
  if (!commandType) {
    throw new Error('OpenReelio command_validate requires commandType.');
  }
  const unsupported = getUnsupportedExecutableCommandMessage(commandType);
  if (unsupported) {
    return {
      status: 'error',
      commandType,
      message: unsupported,
    };
  }

  const payload = asObject(args.payload);
  if (!payload) {
    throw new Error('OpenReelio command_validate requires an object payload.');
  }

  const validation = await validateCommandPayload(commandType, payload);
  if (!validation.valid) {
    return {
      status: 'error',
      commandType,
      message: validation.message,
    };
  }

  return {
    status: 'ok',
    commandType,
    message: 'Command payload is valid.',
  };
}

async function validatePlanToolCall(args: CodexJsonObject | null): Promise<CodexJsonObject> {
  const validation = await validateAgentPlanArgument(args);
  if (!validation.valid) {
    return {
      status: 'error',
      message: validation.message,
    };
  }

  return {
    status: 'ok',
    planId: validation.plan.id,
    goal: validation.plan.goal,
    totalSteps: validation.plan.steps.length,
    steps: validation.plan.steps.map((step) => ({
      id: step.id,
      toolName: step.toolName,
      riskLevel: step.riskLevel,
      optional: step.optional ?? false,
      dependsOn: step.dependsOn ?? [],
    })),
  };
}

async function previewPlanDiff(args: CodexJsonObject | null): Promise<CodexJsonObject> {
  const validation = await validateAgentPlanArgument(args);
  if (!validation.valid) {
    return {
      status: 'error',
      message: validation.message,
    };
  }

  return {
    status: 'ok',
    previewType: 'structural',
    renderedVisualDiffAvailable: false,
    planId: validation.plan.id,
    goal: validation.plan.goal,
    totalSteps: validation.plan.steps.length,
    commands: validation.plan.steps.map((step, index) => ({
      index,
      stepId: step.id,
      commandType: step.toolName,
      description: step.description,
      riskLevel: step.riskLevel,
      params: step.params,
    })),
  };
}

async function applyApprovedPlan(
  args: CodexJsonObject | null,
  request: CodexAppServerRequest,
  context: OpenReelioCodexToolContext,
): Promise<CodexJsonObject> {
  if (!args) {
    throw new Error('OpenReelio plan_apply requires object arguments.');
  }

  const validation = await validateAgentPlanArgument(args);
  if (!validation.valid) {
    return {
      status: 'error',
      message: validation.message,
    };
  }

  const contextToken = getString(args, 'contextToken')?.trim() ?? null;
  const tokenValidation = validateContextToken(context, contextToken);
  if (!tokenValidation.valid) {
    return {
      status: 'error',
      planId: validation.plan.id,
      message: tokenValidation.message.replace(/command_execute/g, 'plan_apply'),
    };
  }

  const reason = getString(args, 'reason')?.trim() || `Apply plan ${validation.plan.id}`;
  const decision = context.approvalDecisionProvider
    ? await context.approvalDecisionProvider(
        buildPlanApprovalRequest({
          request,
          context,
          plan: validation.plan,
          reason,
        }),
      )
    : 'decline';

  if (decision !== 'accept' && decision !== 'acceptForSession') {
    return {
      status: 'denied',
      planId: validation.plan.id,
      message:
        'The OpenReelio plan was not approved. Approve it with the chat approval card; plain chat replies do not grant tool execution.',
    };
  }

  const approvalGrant = await issueAndConsumePlanApplyApproval(context, validation.plan.id);
  const plan: AgentPlan = {
    ...validation.plan,
    approvalGranted: true,
    sessionId: validation.plan.sessionId ?? context.sessionId,
  };
  const result = await invoke<AgentPlanResult>('execute_agent_plan', { plan });
  contextTokensBySessionId.delete(context.sessionId);
  const refresh = await refreshProjectStoreAfterMutation();

  return {
    status: result.success ? 'ok' : 'error',
    planId: validation.plan.id,
    approval: {
      tokenId: approvalGrant.tokenId,
      consumed: true,
    },
    result,
    refresh,
  };
}

async function validateCommandPayload(
  commandType: string,
  payload: CodexJsonObject,
): Promise<{ valid: true } | { valid: false; message: string }> {
  try {
    await invoke('validate_command_payload', { commandType, payload });
    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      message: `OpenReelio command_execute rejected an invalid ${commandType} payload before approval: ${message}`,
    };
  }
}

function getUnsupportedExecutableCommandMessage(commandType: string): string | null {
  if (!OPENREELIO_COMMAND_TYPE_SET.has(commandType)) {
    return `OpenReelio command '${commandType}' is not in the supported command enum.`;
  }

  if (OPENREELIO_WORKSPACE_COMMAND_TYPES.has(commandType)) {
    return 'Workspace filesystem commands are not available through Codex timeline editing. Use the dedicated OpenReelio workspace flow instead.';
  }

  return null;
}

async function validateAgentPlanArgument(
  args: CodexJsonObject | null,
): Promise<{ valid: true; plan: AgentPlan } | { valid: false; message: string }> {
  if (!args) {
    return { valid: false, message: 'OpenReelio plan validation requires object arguments.' };
  }
  const rawPlan = asObject(args.plan);
  if (!rawPlan) {
    return { valid: false, message: 'OpenReelio plan validation requires an object plan.' };
  }

  const normalized = normalizeAgentPlan(rawPlan);
  if (!normalized.valid) {
    return normalized;
  }

  const dependencyValidation = validatePlanDependencies(normalized.plan);
  if (!dependencyValidation.valid) {
    return dependencyValidation;
  }

  for (const step of normalized.plan.steps) {
    const unsupported = getUnsupportedExecutableCommandMessage(step.toolName);
    if (unsupported) {
      return {
        valid: false,
        message: `Plan step '${step.id}' is invalid: ${unsupported}`,
      };
    }
    const params = asObject(step.params);
    if (!params) {
      return {
        valid: false,
        message: `Plan step '${step.id}' params must be an object.`,
      };
    }
    const payloadValidation = await validateCommandPayload(step.toolName, params);
    if (!payloadValidation.valid) {
      return {
        valid: false,
        message: `Plan step '${step.id}' rejected invalid ${step.toolName} params: ${payloadValidation.message}`,
      };
    }
  }

  return normalized;
}

function normalizeAgentPlan(
  rawPlan: CodexJsonObject,
): { valid: true; plan: AgentPlan } | { valid: false; message: string } {
  const id = getString(rawPlan, 'id')?.trim();
  const goal = getString(rawPlan, 'goal')?.trim();
  const rawSteps = rawPlan.steps;
  if (!id) {
    return { valid: false, message: 'AgentPlan.id is required.' };
  }
  if (!goal) {
    return { valid: false, message: 'AgentPlan.goal is required.' };
  }
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { valid: false, message: 'AgentPlan.steps must contain at least one step.' };
  }

  const steps: AgentPlan['steps'] = [];
  for (const [index, rawStep] of rawSteps.entries()) {
    const stepObject = asObject(rawStep);
    if (!stepObject) {
      return { valid: false, message: `AgentPlan.steps[${index}] must be an object.` };
    }
    const stepId = getString(stepObject, 'id')?.trim();
    const toolName = getString(stepObject, 'toolName')?.trim();
    const params = asObject(stepObject.params);
    const description =
      getString(stepObject, 'description')?.trim() || (toolName ? `Run ${toolName}` : '');
    const riskLevel = normalizePlanRiskLevel(getString(stepObject, 'riskLevel'));
    const dependsOn = normalizeStringArray(stepObject.dependsOn);
    const optional = typeof stepObject.optional === 'boolean' ? stepObject.optional : false;

    if (!stepId) {
      return { valid: false, message: `AgentPlan.steps[${index}].id is required.` };
    }
    if (!toolName) {
      return { valid: false, message: `AgentPlan.steps[${index}].toolName is required.` };
    }
    if (!params) {
      return { valid: false, message: `AgentPlan.steps[${index}].params must be an object.` };
    }

    steps.push({
      id: stepId,
      toolName,
      params: params as AgentPlan['steps'][number]['params'],
      description,
      riskLevel,
      dependsOn,
      optional,
    });
  }

  return {
    valid: true,
    plan: {
      id,
      goal,
      steps,
      approvalGranted: Boolean(rawPlan.approvalGranted),
      sessionId: getString(rawPlan, 'sessionId'),
    },
  };
}

function normalizePlanRiskLevel(value: string | null): PlanRiskLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical'
    ? value
    : 'medium';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function validatePlanDependencies(
  plan: AgentPlan,
): { valid: true } | { valid: false; message: string } {
  const stepIds = new Set<string>();
  const dependencyMap = new Map<string, string[]>();
  for (const step of plan.steps) {
    if (stepIds.has(step.id)) {
      return { valid: false, message: `AgentPlan contains duplicate step id '${step.id}'.` };
    }
    stepIds.add(step.id);
    dependencyMap.set(step.id, step.dependsOn ?? []);
  }

  for (const step of plan.steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (dependency === step.id) {
        return { valid: false, message: `Plan step '${step.id}' cannot depend on itself.` };
      }
      if (!stepIds.has(dependency)) {
        return {
          valid: false,
          message: `Plan step '${step.id}' depends on unknown step '${dependency}'.`,
        };
      }
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];

  const findCycle = (stepId: string): string[] | null => {
    const activeIndex = stack.indexOf(stepId);
    if (activeIndex >= 0) {
      return [...stack.slice(activeIndex), stepId];
    }
    if (visited.has(stepId)) {
      return null;
    }

    visiting.add(stepId);
    stack.push(stepId);
    for (const dependency of dependencyMap.get(stepId) ?? []) {
      const cycle = findCycle(dependency);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(stepId);
    visited.add(stepId);
    return null;
  };

  for (const stepId of stepIds) {
    if (visiting.has(stepId) || visited.has(stepId)) {
      continue;
    }
    const cycle = findCycle(stepId);
    if (cycle) {
      return {
        valid: false,
        message: `Plan contains cyclic dependency: ${cycle.join(' -> ')}`,
      };
    }
  }

  return { valid: true };
}

function buildCommandApprovalRequest(input: {
  request: CodexAppServerRequest;
  context: OpenReelioCodexToolContext;
  commandType: string;
  payload: CodexJsonObject;
  reason: string;
}): ExternalAgentApprovalRequest {
  const params = input.request.params ?? {};
  return {
    id: `codex:openreelio:${input.request.id}:${getString(params, 'callId') ?? input.commandType}`,
    runtimeId: input.context.runtimeId,
    sessionId: input.context.sessionId,
    turnId: getString(params, 'turnId'),
    itemId: getString(params, 'callId'),
    requestId: input.request.id,
    approvalType: 'openreelio_edit_command',
    tool: 'OpenReelio edit',
    description: input.reason,
    args: {
      commandType: input.commandType,
      payload: input.payload,
      projectId: input.context.projectId,
      cwd: input.context.cwd ?? null,
    },
    reason: input.reason,
    requestedAt: Date.now(),
  };
}

function buildPlanApprovalRequest(input: {
  request: CodexAppServerRequest;
  context: OpenReelioCodexToolContext;
  plan: AgentPlan;
  reason: string;
}): ExternalAgentApprovalRequest {
  const params = input.request.params ?? {};
  return {
    id: `codex:openreelio-plan:${input.request.id}:${getString(params, 'callId') ?? input.plan.id}`,
    runtimeId: input.context.runtimeId,
    sessionId: input.context.sessionId,
    turnId: getString(params, 'turnId'),
    itemId: getString(params, 'callId'),
    requestId: input.request.id,
    approvalType: 'openreelio_plan_apply',
    tool: 'OpenReelio plan apply',
    description: input.reason,
    args: {
      planId: input.plan.id,
      goal: input.plan.goal,
      stepCount: input.plan.steps.length,
      commands: input.plan.steps.map((step) => ({
        id: step.id,
        toolName: step.toolName,
        description: step.description,
        riskLevel: step.riskLevel,
      })),
      projectId: input.context.projectId,
      cwd: input.context.cwd ?? null,
    },
    reason: input.reason,
    requestedAt: Date.now(),
  };
}

async function issueAndConsumePlanApplyApproval(
  context: OpenReelioCodexToolContext,
  planId: string,
): Promise<ExternalAgentApprovalTokenGrant> {
  const grant = await invoke<ExternalAgentApprovalTokenGrant>(
    'create_external_agent_approval_token',
    {
      input: {
        sessionId: context.sessionId,
        runId: null,
        planId,
        projectId: context.projectId,
        runtimeId: context.runtimeId,
        scopes: ['openreelio.plan.apply'],
        ttlMs: 10 * 60 * 1000,
      },
    },
  );
  const validation = await invoke<ExternalAgentApprovalTokenValidation>(
    'consume_external_agent_approval_token',
    {
      input: {
        token: grant.token,
        sessionId: context.sessionId,
        planId,
        projectId: context.projectId,
        runtimeId: context.runtimeId,
        requiredScope: 'openreelio.plan.apply',
      },
    },
  );

  if (!validation.valid) {
    throw new Error(
      validation.reason ?? 'OpenReelio plan approval token was rejected before plan execution.',
    );
  }

  return grant;
}

async function readProjectState(): Promise<ProjectStateDto> {
  return await invoke<ProjectStateDto>('get_project_state');
}

async function readOptionalProjectState(): Promise<ProjectStateDto | null> {
  try {
    return await readProjectState();
  } catch {
    return null;
  }
}

async function readOptionalProjectInfo(): Promise<ProjectInfo | null> {
  try {
    return await invoke<ProjectInfo | null>('get_project_info');
  } catch {
    return null;
  }
}

function normalizeStockMediaAssetType(
  value: unknown,
  fallback?: 'video' | 'image' | 'audio',
): 'video' | 'image' | 'audio' {
  if (value === 'image' || value === 'audio' || value === 'video') {
    return value;
  }
  if ((value === undefined || value === null) && fallback) {
    return fallback;
  }
  throw new Error('OpenReelio stock media assetType must be one of video, image, or audio.');
}

function normalizeStockMediaLimit(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 10;
  return Math.min(Math.max(numeric, 1), 50);
}

async function searchStockMediaToolCall(args: CodexJsonObject | null): Promise<CodexJsonObject> {
  if (!args) {
    throw new Error('OpenReelio stock_media_search requires object arguments.');
  }

  const query = getString(args, 'query')?.trim();
  if (!query) {
    throw new Error('OpenReelio stock_media_search requires query.');
  }

  const assetType = normalizeStockMediaAssetType(args.assetType, 'video');
  const limit = normalizeStockMediaLimit(args.limit);

  try {
    const assets = await invoke<StockMediaSearchResult[]>('search_stock_media', {
      query,
      assetType,
      limit,
    });
    const policySummary = assets.reduce<Record<string, number>>((summary, asset) => {
      const status = asset.licensePolicy?.status ?? 'unknown';
      summary[status] = (summary[status] ?? 0) + 1;
      return summary;
    }, {});

    return {
      status: 'ok',
      query,
      assetType,
      count: assets.length,
      requiresImport: true,
      policySummary,
      assets: assets as unknown as CodexJsonObject[],
    };
  } catch (error) {
    return {
      status: 'error',
      query,
      assetType,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function importStockMediaToolCall(
  args: CodexJsonObject | null,
  request: CodexAppServerRequest,
  context: OpenReelioCodexToolContext,
): Promise<CodexJsonObject> {
  if (!args) {
    throw new Error('OpenReelio stock_media_import requires object arguments.');
  }

  const sourceUrl = getString(args, 'sourceUrl')?.trim();
  if (!sourceUrl) {
    throw new Error('OpenReelio stock_media_import requires sourceUrl.');
  }

  const name = getString(args, 'name')?.trim();
  if (!name) {
    throw new Error('OpenReelio stock_media_import requires name.');
  }

  const assetType = normalizeStockMediaAssetType(args.assetType);
  const provider = getString(args, 'provider')?.trim();
  if (!provider) {
    throw new Error('OpenReelio stock_media_import requires provider.');
  }

  const license = asObject(args.license);
  if (!license) {
    throw new Error('OpenReelio stock_media_import requires a LicenseInfo object.');
  }

  const licenseAck = args.licenseAck === true;
  if (!licenseAck) {
    return {
      status: 'error',
      message:
        'OpenReelio stock_media_import requires licenseAck=true after presenting provider/license terms in the approval reason.',
    };
  }

  const contextToken = getString(args, 'contextToken')?.trim() ?? null;
  const tokenValidation = validateContextToken(context, contextToken);
  if (!tokenValidation.valid) {
    return {
      status: 'error',
      message: tokenValidation.message.replace(/command_execute/g, 'stock_media_import'),
    };
  }

  const reason =
    getString(args, 'reason')?.trim() ||
    `Download and import stock ${assetType} asset from ${provider}`;
  const durationSec =
    typeof args.durationSec === 'number' && Number.isFinite(args.durationSec)
      ? args.durationSec
      : null;
  const tags = Array.isArray(args.tags)
    ? args.tags.filter((tag): tag is string => typeof tag === 'string')
    : null;
  const providerUrl = getString(args, 'providerUrl')?.trim() || null;

  const decision = context.approvalDecisionProvider
    ? await context.approvalDecisionProvider(
        buildCommandApprovalRequest({
          request,
          context,
          commandType: 'ImportAsset',
          payload: {
            uri: sourceUrl,
            name,
            provider,
            assetType,
            providerUrl,
            license,
          },
          reason,
        }),
      )
    : 'decline';

  if (decision !== 'accept' && decision !== 'acceptForSession') {
    return {
      status: 'denied',
      message:
        'The stock media import was not approved. Approve it with the chat approval card; plain chat replies do not grant tool execution.',
    };
  }

  const result = await invoke<StockMediaImportResult>('import_stock_media_asset', {
    sourceUrl,
    name,
    assetType,
    provider,
    license,
    licenseAck,
    durationSec,
    tags,
    providerUrl,
  });
  contextTokensBySessionId.delete(context.sessionId);
  const refresh = await refreshProjectStoreAfterMutation();

  return {
    status: 'ok',
    import: result as unknown as CodexJsonObject,
    refresh,
  };
}

function buildTimelineSnapshot(
  state: ProjectStateDto,
  context: OpenReelioCodexToolContext,
): CodexJsonObject {
  const activeSequence = state.sequences.find((sequence) => sequence.id === state.activeSequenceId);
  const contextToken = issueContextToken(context, state, 'timeline_snapshot');
  return {
    contextToken: contextToken.token,
    contextTokenExpiresAt: contextToken.issuedAt + CONTEXT_TOKEN_TTL_MS,
    available: true,
    activeSequenceId: state.activeSequenceId,
    activeSequence: activeSequence ? summarizeSequence(activeSequence) : null,
    sequences: state.sequences.map(summarizeSequence),
  };
}

function summarizeSequence(sequence: unknown): CodexJsonObject {
  const sequenceObject = asObject(sequence) ?? {};
  const tracks = Array.isArray(sequenceObject.tracks) ? sequenceObject.tracks : [];
  return {
    id: sequenceObject.id,
    name: sequenceObject.name,
    trackCount: tracks.length,
    markerCount: Array.isArray(sequenceObject.markers) ? sequenceObject.markers.length : 0,
    tracks: tracks.map((track) => {
      const trackObject = asObject(track) ?? {};
      const clips = Array.isArray(trackObject.clips) ? trackObject.clips : [];
      return {
        id: trackObject.id,
        name: trackObject.name,
        kind: trackObject.kind,
        muted: trackObject.muted,
        locked: trackObject.locked,
        visible: trackObject.visible,
        clipCount: clips.length,
        clips: clips.map((clip) => {
          const clipObject = asObject(clip) ?? {};
          const place = asObject(clipObject.place) ?? {};
          const range = asObject(clipObject.range) ?? {};
          return {
            id: clipObject.id,
            assetId: clipObject.assetId,
            timelineInSec: place.timelineInSec,
            durationSec: place.durationSec,
            sourceInSec: range.sourceInSec,
            sourceOutSec: range.sourceOutSec,
            speed: clipObject.speed,
            enabled: clipObject.enabled,
          };
        }),
      };
    }),
  };
}

function findClipSummary(state: ProjectStateDto, clipId: string): CodexJsonObject | null {
  for (const sequence of state.sequences) {
    const sequenceObject = asObject(sequence) ?? {};
    const tracks = Array.isArray(sequenceObject.tracks) ? sequenceObject.tracks : [];
    for (const track of tracks) {
      const trackObject = asObject(track) ?? {};
      const clips = Array.isArray(trackObject.clips) ? trackObject.clips : [];
      const clip = clips.find((candidate) => asObject(candidate)?.id === clipId);
      const clipObject = asObject(clip);
      if (!clipObject) {
        continue;
      }
      const place = asObject(clipObject.place) ?? {};
      const range = asObject(clipObject.range) ?? {};
      return {
        id: clipObject.id,
        assetId: clipObject.assetId,
        sequenceId: sequenceObject.id,
        trackId: trackObject.id,
        trackName: trackObject.name,
        timelineInSec: place.timelineInSec,
        durationSec: place.durationSec,
        sourceInSec: range.sourceInSec,
        sourceOutSec: range.sourceOutSec,
        speed: clipObject.speed,
        enabled: clipObject.enabled,
      };
    }
  }

  return null;
}

function findTrackSummary(state: ProjectStateDto, trackId: string): CodexJsonObject | null {
  for (const sequence of state.sequences) {
    const sequenceObject = asObject(sequence) ?? {};
    const tracks = Array.isArray(sequenceObject.tracks) ? sequenceObject.tracks : [];
    const track = tracks.find((candidate) => asObject(candidate)?.id === trackId);
    const trackObject = asObject(track);
    if (!trackObject) {
      continue;
    }
    const clips = Array.isArray(trackObject.clips) ? trackObject.clips : [];
    return {
      id: trackObject.id,
      sequenceId: sequenceObject.id,
      name: trackObject.name,
      kind: trackObject.kind,
      muted: trackObject.muted,
      locked: trackObject.locked,
      visible: trackObject.visible,
      clipCount: clips.length,
    };
  }

  return null;
}

function buildAssetsList(
  state: ProjectStateDto,
  context: OpenReelioCodexToolContext,
): CodexJsonObject {
  const contextToken = issueContextToken(context, state, 'assets_list');
  return {
    contextToken: contextToken.token,
    contextTokenExpiresAt: contextToken.issuedAt + CONTEXT_TOKEN_TTL_MS,
    available: true,
    count: state.assets.length,
    assets: state.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      durationSec: asset.durationSec,
      missing: asset.missing,
      workspaceManaged: asset.workspaceManaged,
      tags: asset.tags,
    })),
  };
}

function issueContextToken(
  context: OpenReelioCodexToolContext,
  state: ProjectStateDto | null,
  source: ContextTokenRecord['source'],
): ContextTokenRecord {
  const issuedAt = Date.now();
  const token = createContextToken();
  const record = {
    token,
    sessionId: context.sessionId,
    projectId: context.projectId,
    issuedAt,
    activeSequenceId: state?.activeSequenceId ?? null,
    source,
  };
  contextTokensBySessionId.set(context.sessionId, record);
  return record;
}

function createContextToken(): string {
  const cryptoApi = globalThis.crypto;
  const uuid = cryptoApi?.randomUUID?.();
  if (uuid) {
    return `orctx:${uuid}`;
  }

  if (cryptoApi?.getRandomValues) {
    const randomWords = new Uint32Array(4);
    cryptoApi.getRandomValues(randomWords);
    const randomPart = Array.from(randomWords, (word) => word.toString(36).padStart(7, '0')).join(
      '',
    );
    return `orctx:${Date.now()}:${randomPart}`;
  }

  return `orctx:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function validateContextToken(
  context: OpenReelioCodexToolContext,
  token: string | null,
): { valid: true } | { valid: false; message: string } {
  if (!token) {
    return {
      valid: false,
      message:
        'OpenReelio command_execute requires a fresh mutation contextToken from project_state, timeline_snapshot, or assets_list.',
    };
  }

  const record = contextTokensBySessionId.get(context.sessionId);
  if (!record || record.token !== token) {
    return {
      valid: false,
      message: 'OpenReelio command_execute rejected a missing or stale contextToken.',
    };
  }

  if (record.projectId !== context.projectId) {
    return {
      valid: false,
      message: 'OpenReelio command_execute rejected a contextToken for a different project.',
    };
  }

  if (Date.now() - record.issuedAt > CONTEXT_TOKEN_TTL_MS) {
    contextTokensBySessionId.delete(context.sessionId);
    return {
      valid: false,
      message: 'OpenReelio command_execute rejected an expired contextToken.',
    };
  }

  return { valid: true };
}

function buildCommandSchema(): CodexJsonObject {
  return {
    commands: OPENREELIO_COMMAND_TYPES,
    count: OPENREELIO_COMMAND_TYPES.length,
    payloadHints: {
      CreateSequence: {
        required: ['name'],
        optional: ['format'],
        formatAliases: [
          'youtube_shorts',
          'shorts',
          'vertical_1080',
          '1080x1920',
          '9:16',
          'youtube_1080',
          '1920x1080',
          'youtube_4k',
        ],
        note: 'Use youtube_shorts or 1080x1920 for Shorts/vertical edits. A newly created sequence becomes the active timeline.',
      },
    },
    payloadFormat: {
      commandType: 'PascalCase OpenReelio backend command type',
      payload: 'CamelCase JSON object matching the selected command type',
      contextToken:
        'Fresh mutation contextToken returned by project_state, timeline_snapshot, or assets_list',
      mutationTool: 'openreelio.command_execute',
    },
    rules: [
      'Read project_state or timeline_snapshot before using IDs and before every mutation.',
      'Pass the returned contextToken to command_execute.',
      'Never edit .openreelio state files directly.',
      'command_execute prompts the user for approval and persists through the OpenReelio command log.',
      'Workspace filesystem commands are intentionally not exposed through command_execute.',
    ],
  };
}

async function refreshProjectStoreAfterMutation(): Promise<CodexJsonObject> {
  try {
    const module = await import('@/stores/projectStore');
    const version = await module.useProjectStore.getState().refreshFromBackendMutation();
    return { status: 'ok', stateVersion: version };
  } catch (error) {
    return {
      status: 'warning',
      message:
        error instanceof Error
          ? error.message
          : 'Command executed, but the frontend project store could not be refreshed.',
    };
  }
}

function toolResponse(value: unknown, success = true): CodexDynamicToolCallResponse {
  return {
    contentItems: [
      {
        type: 'inputText',
        text: JSON.stringify(value, null, 2),
      },
    ],
    success,
  };
}

function asObject(value: unknown): CodexJsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as CodexJsonObject;
}

function getString(input: CodexJsonObject | null | undefined, key: string): string | null {
  const value = input?.[key];
  return typeof value === 'string' ? value : null;
}

function getFirstProperty(input: CodexJsonObject, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      return input[key];
    }
  }

  return undefined;
}
