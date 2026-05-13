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

const EMPTY_OBJECT_SCHEMA: CodexJsonObject = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const COMMAND_EXECUTE_SCHEMA: CodexJsonObject = {
  type: 'object',
  required: ['commandType', 'payload', 'reason'],
  properties: {
    commandType: {
      type: 'string',
      enum: OPENREELIO_COMMAND_TYPES,
      description: 'PascalCase OpenReelio backend command type.',
    },
    payload: {
      type: 'object',
      description: 'CamelCase JSON payload matching the command type.',
    },
    reason: {
      type: 'string',
      description: 'Short user-facing reason for the edit approval prompt.',
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
    '- Apply edits through openreelio.command_execute so the app can validate, approve, persist, undo, and refresh the UI.',
    '- Do not manually edit .openreelio state files or invent command payloads without checking the schema and current IDs.',
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
  if (request.method !== 'item/tool/call') {
    return null;
  }

  const params = request.params ?? {};
  const namespace = getString(params, 'namespace');
  const tool = getString(params, 'tool');
  if (namespace !== 'openreelio' || !tool) {
    return null;
  }

  try {
    switch (tool) {
      case 'host_context':
        return toolResponse(await buildHostContext(context));
      case 'project_state':
        return toolResponse(await readProjectState());
      case 'timeline_snapshot':
        return toolResponse(buildTimelineSnapshot(await readProjectState()));
      case 'assets_list':
        return toolResponse(buildAssetsList(await readProjectState()));
      case 'command_schema':
        return toolResponse(buildCommandSchema());
      case 'command_execute':
        return toolResponse(await executeApprovedCommand(request, context));
      default:
        return toolResponse(
          {
            status: 'error',
            message: `OpenReelio dynamic tool '${tool}' is not available.`,
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
    },
  };
}

async function executeApprovedCommand(
  request: CodexAppServerRequest,
  context: OpenReelioCodexToolContext,
): Promise<CodexJsonObject> {
  const params = request.params ?? {};
  const args = asObject(params.arguments);
  if (!args) {
    throw new Error('OpenReelio command_execute requires object arguments.');
  }

  const commandType = getString(args, 'commandType')?.trim();
  if (!commandType) {
    throw new Error('OpenReelio command_execute requires commandType.');
  }

  const payload = asObject(args.payload);
  if (!payload) {
    throw new Error('OpenReelio command_execute requires an object payload.');
  }

  const reason = getString(args, 'reason')?.trim() || `Execute ${commandType}`;
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
  const refresh = await refreshProjectStoreAfterMutation();

  return {
    status: 'ok',
    commandType,
    result,
    refresh,
  };
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
    approvalType: 'command',
    tool: 'OpenReelio command',
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

function buildTimelineSnapshot(state: ProjectStateDto): CodexJsonObject {
  const activeSequence = state.sequences.find((sequence) => sequence.id === state.activeSequenceId);
  return {
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

function buildAssetsList(state: ProjectStateDto): CodexJsonObject {
  return {
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

function buildCommandSchema(): CodexJsonObject {
  return {
    commands: OPENREELIO_COMMAND_TYPES,
    count: OPENREELIO_COMMAND_TYPES.length,
    payloadFormat: {
      commandType: 'PascalCase OpenReelio backend command type',
      payload: 'CamelCase JSON object matching the selected command type',
      mutationTool: 'openreelio.command_execute',
    },
    rules: [
      'Read project_state or timeline_snapshot before using IDs.',
      'Never edit .openreelio state files directly.',
      'command_execute prompts the user for approval and persists through the OpenReelio command log.',
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
