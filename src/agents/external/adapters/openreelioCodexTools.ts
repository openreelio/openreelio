import { invoke } from '@tauri-apps/api/core';

import type { CommandResultDto, ProjectInfo, ProjectStateDto } from '@/bindings';

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
  source: 'project_state' | 'timeline_snapshot' | 'assets_list';
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
    name: 'command_schema',
    description:
      'Read the supported OpenReelio event-sourced edit command types and payload conventions.',
    inputSchema: EMPTY_OBJECT_SCHEMA,
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
    '- Use openreelio.timeline_snapshot, openreelio.assets_list, and openreelio.command_schema before proposing concrete edits.',
    '- Apply edits through openreelio.command_execute with the fresh contextToken returned by openreelio.project_state, openreelio.timeline_snapshot, or openreelio.assets_list so the app can validate, approve, persist, undo, and refresh the UI.',
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
      case 'command_schema':
        return toolResponse(buildCommandSchema());
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
      commandExecuteWithApproval: true,
      undoableCommandLog: true,
    },
    policy: {
      mutationPath: 'openreelio.command_execute',
      approvalRequiredForMutations: true,
      directStateFileEdits: 'forbidden',
      contextTokenRequiredForMutations: true,
      mutationContextSources: ['project_state', 'timeline_snapshot', 'assets_list'],
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
      message: 'The OpenReelio command was not approved by the user.',
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
    const randomPart = Array.from(randomWords, (word) =>
      word.toString(36).padStart(7, '0'),
    ).join('');
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
