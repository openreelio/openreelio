import { invoke } from '@tauri-apps/api/core';

import {
  commands,
  type AgentPlan,
  type AgentPlanResult,
  type ClipAnalysisOptions,
  type ClipAnalysisResponse,
  type ClipPerceptionOptions,
  type ClipPerceptionResponse,
  type PlanRiskLevel,
  type ProjectInfo,
  type ProjectStateDto,
  type SemanticTemporalEditAction,
  type SemanticTemporalEditPlan,
  type SemanticTemporalEditPlanOptions,
  type StockMediaImportResult,
  type StockMediaSearchResult,
  type TranscriptionOptionsDto,
  type TranscriptionResultDto,
  type TranscriptionStatusDto,
} from '@/bindings';

import type { ExternalAgentApprovalDecisionProvider, ExternalAgentApprovalRequest } from '../types';
import type {
  CodexAppServerRequest,
  CodexDynamicToolCallResponse,
  CodexDynamicToolSpec,
  CodexJsonObject,
} from './CodexAppServerClient';
import { runProjectBackendMutation } from '@/services/projectMutationGateway';
import { issueAgentPlanApprovalProof } from '@/services/agentPlanApprovalProof';
import { insertAgentMediaClip } from '@/agents/tools/mediaInsertion';

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

const EXTERNAL_AGENT_MUTATION_TIMEOUT_MS = 5 * 60 * 1000;

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
  'SetClipMotionKeyframes',
  'SetClipSpeed',
  'SetClipSlowMotionInterpolation',
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
  'SetTrackVolume',
  'SetCaptionTrackLanguage',
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
  'ImportGeneratedCaptions',
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
const FULL_TEXT_PREVIEW_LIMIT = 12_000;

const WHISPER_MODEL_FILES: Record<string, string> = {
  tiny: 'ggml-tiny.bin',
  base: 'ggml-base.bin',
  small: 'ggml-small.bin',
  medium: 'ggml-medium.bin',
  large: 'ggml-large.bin',
  'large-v3': 'ggml-large-v3.bin',
  'large-v3-turbo': 'ggml-large-v3-turbo.bin',
};

const WHISPER_MODEL_NAME_SET = new Set(Object.keys(WHISPER_MODEL_FILES));
const WHISPER_MODEL_SELECTION_PREFERENCE = [
  'large-v3',
  'large-v3-turbo',
  'large',
  'medium',
  'small',
  'base',
  'tiny',
];

const ACTIVE_TIMELINE_SCOPED_COMMAND_TYPES = new Set<string>([
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
  'SetClipMotionKeyframes',
  'SetClipSpeed',
  'SetClipSlowMotionInterpolation',
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
  'SetTrackVolume',
  'SetCaptionTrackLanguage',
  'SetClipBlendMode',
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
  'ImportGeneratedCaptions',
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
  'ApplyAudioDucking',
  'CreateCompoundClip',
  'UnnestCompoundClip',
  'CreateAdjustmentLayer',
  'PasteEffects',
  'PasteAttributes',
  'RemoveAttributes',
]);

const CLIP_TARGET_COMMAND_TYPES = new Set<string>([
  'RemoveClip',
  'MoveClip',
  'TrimClip',
  'SplitClip',
  'SetClipTransform',
  'SetClipMotionKeyframes',
  'SetClipSpeed',
  'SetClipSlowMotionInterpolation',
  'ReverseClip',
  'SetClipEnabled',
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
  'AddEffect',
  'RemoveEffect',
  'UpdateEffect',
  'AddMask',
  'UpdateMask',
  'RemoveMask',
  'UpdateTextClip',
  'RemoveTextClip',
  'ApplyAudioDucking',
  'UnnestCompoundClip',
]);

const TEXT_OVERLAY_COMMAND_TYPES = new Set<string>(['AddTextClip']);
const CAPTION_TRACK_COMMAND_TYPES = new Set<string>([
  'CreateCaption',
  'ImportGeneratedCaptions',
  'UpdateCaption',
]);
const PRIMITIVE_MEDIA_INSERT_COMMAND_TYPES = new Set<string>([
  'InsertClip',
  'InsertEdit',
  'OverwriteEdit',
]);
const VISUAL_TRACK_KINDS = new Set<string>(['video', 'overlay', 'caption']);
const TEXT_OVERLAY_TRACK_KINDS = new Set<string>(['video', 'overlay']);

interface TimelineTargetNormalization {
  payload: CodexJsonObject;
  notes: CodexJsonObject[];
}

interface MediaInsertTargetNormalization {
  sequenceId: string;
  trackId: string;
  notes: CodexJsonObject[];
}

interface TrackWithIndex {
  track: ProjectStateDto['sequences'][number]['tracks'][number];
  index: number;
}

interface ContextTokenRecord {
  token: string;
  sessionId: string;
  projectId: string;
  issuedAt: number;
  activeSequenceId: string | null;
  source: 'project_state' | 'timeline_snapshot' | 'assets_list' | 'selection_read';
}

interface CaptionSegmentForImport {
  startSec: number;
  endSec: number;
  text: string;
  partial?: boolean;
  sourceStartSec?: number;
  sourceEndSec?: number;
}

interface ClipTimeMapping {
  sequenceId: string;
  trackId: string;
  clipId: string;
  assetId: string;
  timelineInSec: number;
  timelineOutSec: number;
  durationSec: number;
  sourceInSec: number;
  sourceOutSec: number;
  speed: number;
  reverse: boolean;
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

const ANNOTATION_READ_SCHEMA: CodexJsonObject = {
  type: 'object',
  required: ['assetId'],
  properties: {
    assetId: {
      type: 'string',
      description:
        'Project asset ID whose cached analysis annotation should be read for placement or edit planning.',
    },
  },
  additionalProperties: false,
};

const CLIP_ANALYZE_SCHEMA_PROPERTIES: CodexJsonObject = {
  sequenceId: {
    type: 'string',
    description:
      'Optional target sequence ID. Defaults to the active timeline when omitted or stale.',
  },
  trackId: {
    type: 'string',
    description:
      'Optional timeline track ID. The active timeline clip location is resolved when omitted or stale.',
  },
  clipId: { type: 'string', description: 'Timeline clip ID to sample.' },
  mode: {
    type: 'string',
    enum: ['representative', 'dense'],
    description: 'Frame sampling mode. Defaults to dense for close inspection.',
  },
  targetIntervalSec: {
    type: 'number',
    description: 'Dense sampling interval in timeline seconds.',
  },
  maxSamples: { type: 'number', description: 'Maximum frame samples to extract.' },
  includeEdges: { type: 'boolean', description: 'Include clip/range edge samples.' },
  rangeStartSec: {
    type: 'number',
    description: 'Optional absolute timeline range start inside the target clip.',
  },
  rangeEndSec: {
    type: 'number',
    description: 'Optional absolute timeline range end inside the target clip.',
  },
  forceRefresh: { type: 'boolean', description: 'Ignore compatible cached analysis.' },
};

const CLIP_ANALYZE_SCHEMA: CodexJsonObject = {
  type: 'object',
  required: ['clipId'],
  properties: CLIP_ANALYZE_SCHEMA_PROPERTIES,
  additionalProperties: false,
};

const CLIP_DESCRIBE_SCHEMA: CodexJsonObject = {
  type: 'object',
  required: ['clipId'],
  properties: {
    ...CLIP_ANALYZE_SCHEMA_PROPERTIES,
    maxFrames: {
      type: 'number',
      description: 'Maximum sampled frames to semantically describe.',
    },
    detail: {
      type: 'string',
      enum: ['low', 'auto', 'high'],
      description: 'Vision detail level. Defaults to low.',
    },
    provider: { type: 'string', description: 'Optional perception provider, such as openai.' },
    model: { type: 'string', description: 'Optional provider model override.' },
    reuseSourceAnalysis: {
      type: 'boolean',
      description: 'Reuse cached source-analysis frame observations before provider calls.',
    },
    allowCloud: {
      type: 'boolean',
      description: 'Allow configured cloud vision calls. Defaults to false.',
    },
    includeContactSheet: {
      type: 'boolean',
      description: 'Include contact sheet context where supported.',
    },
  },
  additionalProperties: false,
};

const SEMANTIC_EDIT_PLAN_SCHEMA: CodexJsonObject = {
  type: 'object',
  required: ['perceptionFingerprint', 'query'],
  properties: {
    perceptionFingerprint: {
      type: 'string',
      description: 'Perception fingerprint returned by openreelio.clip_describe.',
    },
    query: {
      type: 'string',
      description: 'Semantic target query, such as logo, face, chart, text, or product.',
    },
    action: {
      type: 'string',
      enum: ['blur', 'highlight', 'remove', 'marker', 'addText'],
      description: 'Planned edit action. Defaults to blur.',
    },
    paddingSec: {
      type: 'number',
      description: 'Seconds to pad before and after each matched sample.',
    },
    mergeGapSec: {
      type: 'number',
      description: 'Merge planned ranges separated by this many seconds or less.',
    },
    minConfidence: {
      type: 'number',
      description: 'Minimum semantic evidence confidence from 0 to 1.',
    },
    maxRanges: { type: 'number', description: 'Maximum planned ranges to return.' },
    text: { type: 'string', description: 'Text content when action is addText.' },
    effectStrength: {
      type: 'number',
      description: 'Effect strength, such as blur radius or brightness amount.',
    },
    includeCommandDrafts: {
      type: 'boolean',
      description: 'Include command draft payloads. Defaults to true.',
    },
    spatialTimeToleranceSec: {
      type: 'number',
      description: 'Source-time tolerance for matching annotation bounding boxes.',
    },
    includeSpatialTargets: {
      type: 'boolean',
      description: 'Include object/face/OCR bounding boxes when available. Defaults to true.',
    },
  },
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

const MEDIA_INSERT_SCHEMA: CodexJsonObject = {
  type: 'object',
  required: ['sequenceId', 'trackId', 'assetId', 'timelineStart', 'reason', 'contextToken'],
  properties: {
    sequenceId: {
      type: 'string',
      description: 'Target sequence ID.',
    },
    trackId: {
      type: 'string',
      description:
        'Target visible video/overlay track for video/image media, or audio track for audio media.',
    },
    assetId: {
      type: 'string',
      description: 'Project asset ID to place on the timeline.',
    },
    timelineStart: {
      type: 'number',
      description: 'Timeline start in seconds.',
    },
    sourceIn: {
      type: 'number',
      description: 'Optional source media in point in seconds.',
    },
    sourceOut: {
      type: 'number',
      description: 'Optional source media out point in seconds.',
    },
    audioOnly: {
      type: 'boolean',
      description:
        'Set true only when intentionally placing the audio stream from a video asset onto an audio track.',
    },
    autoExtractLinkedAudio: {
      type: 'boolean',
      description:
        'Defaults true for video on visual tracks: create matching linked audio, link clips, and mute source video audio.',
    },
    reason: {
      type: 'string',
      description: 'Short user-facing reason for the edit approval prompt.',
    },
    contextToken: {
      type: 'string',
      description:
        'Fresh mutation context token returned by openreelio.project_state, timeline_snapshot, assets_list, or selection_read in this session.',
    },
  },
  additionalProperties: false,
};

const TRANSCRIPTION_GENERATE_SCHEMA: CodexJsonObject = {
  type: 'object',
  properties: {
    assetId: {
      type: 'string',
      description:
        'Project asset ID whose audio should be transcribed when sequenceAudio is false.',
    },
    sequenceAudio: {
      type: 'boolean',
      description:
        'Set true to transcribe the audible audio mix of an edited sequence instead of one source asset.',
    },
    language: {
      type: 'string',
      description:
        'BCP-47/Whisper language code such as auto, en, ko, ja, or zh. Defaults to auto.',
    },
    model: {
      type: 'string',
      enum: ['auto', 'tiny', 'base', 'small', 'medium', 'large', 'large-v3', 'large-v3-turbo'],
      description: 'Installed Whisper model to use. Defaults to the best installed model.',
    },
    translate: {
      type: 'boolean',
      description: 'Translate recognized speech to English when supported by the model.',
    },
    async: {
      type: 'boolean',
      description:
        'Submit the transcription to the worker queue and return a job ID instead of waiting for segments.',
    },
    sequenceId: {
      type: 'string',
      description:
        'Optional sequence ID for clip-time mapping. Provide with clipId when captions must align to a timeline clip.',
    },
    trackId: {
      type: 'string',
      description:
        'Optional track ID for clip-time mapping. Provide with clipId when multiple clips share an ID namespace.',
    },
    clipId: {
      type: 'string',
      description:
        'Optional timeline clip ID. When present, returned timelineCaptionSegments are clipped and remapped from source time to timeline time.',
    },
  },
  additionalProperties: false,
};

const TRANSCRIPTION_INSTALL_MODEL_SCHEMA: CodexJsonObject = {
  type: 'object',
  properties: {
    model: {
      type: 'string',
      enum: ['tiny', 'base', 'small', 'medium', 'large', 'large-v3', 'large-v3-turbo'],
      description: 'Whisper model to install. Defaults to large-v3-turbo.',
    },
    force: {
      type: 'boolean',
      description: 'Replace an existing local model file.',
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
    name: 'transcription_status',
    description:
      'Read local Whisper transcription readiness, model directory, and installed model inventory.',
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'transcription_install_model',
    description:
      'Download and install a local Whisper model. Use only after the user approves downloading a model.',
    inputSchema: TRANSCRIPTION_INSTALL_MODEL_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'transcription_generate',
    description:
      'Generate speech-to-text transcript segments from a project audio/video asset. Can also remap source-time segments onto a timeline clip for caption import.',
    inputSchema: TRANSCRIPTION_GENERATE_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'annotation_read',
    description:
      'Read cached objects/faces/OCR/shot annotations for one asset. Use this before choosing safe text/caption placement when exact visual position matters.',
    inputSchema: ANNOTATION_READ_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'clip_analyze',
    description:
      'Extract indexed clip-local frame samples for one timeline clip. Use this before detailed edits, highlight selection, or timing-sensitive SFX placement.',
    inputSchema: CLIP_ANALYZE_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'clip_describe',
    description:
      'Build semantic per-frame evidence for one timeline clip using cached source analysis or configured vision providers. Returns observations, confidence, image paths, and a perceptionFingerprint.',
    inputSchema: CLIP_DESCRIBE_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'semantic_edit_plan',
    description:
      'Convert a perceptionFingerprint plus semantic query into read-only timeline ranges and command drafts, including spatial AddMask drafts when annotations have bounding boxes.',
    inputSchema: SEMANTIC_EDIT_PLAN_SCHEMA,
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
      'Read the supported OpenReelio event-sourced edit command types, text/caption workflows, and payload conventions.',
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
    name: 'media_insert',
    description:
      'Insert a media asset like the OpenReelio UI drag-and-drop path: validates track/asset compatibility, supports sourceIn/sourceOut, and auto-creates linked audio for video clips.',
    inputSchema: MEDIA_INSERT_SCHEMA,
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
    '- Unless the user explicitly switched to a named sequence, "the timeline", "current edit", "this part", and similar edit requests mean the active OpenReelio timeline from timeline_snapshot.activeSequenceId.',
    '- Track order is front-to-back for visual output: tracks[0] is the top/front video layer. Create video/overlay/caption/text tracks at position 0 so they appear above the base video. Audio tracks can remain below/end.',
    '- Use openreelio.annotation_read for the source asset before deciding exact text placement that should avoid faces, objects, or existing OCR text.',
    '- Use openreelio.clip_analyze and openreelio.clip_describe for detailed clip-local frame evidence before choosing a highlight clip, placing timing-sensitive SFX, or making semantic visual edits.',
    '- Use openreelio.semantic_edit_plan after clip_describe when a semantic target needs ranges, draft edits, or spatial mask guidance.',
    '- For privacy blur or mosaic, add gaussian_blur or pixelate through the command log, then add a rectangle or ellipse mask to the created effectId for editable region coverage. When object_tracking data exists, include AddMask keyframes plus trackingSourceId so region blur and object highlight masks follow the subject.',
    '- Use openreelio.transcription_status to check local Whisper readiness before promising automatic subtitles.',
    '- Use openreelio.transcription_generate before creating or replacing subtitles from speech. Pass clipId with sequenceId/trackId when captions must align to a timeline clip rather than the full source asset.',
    '- After openreelio.transcription_install_model or any other long-running tool, read openreelio.project_state or openreelio.timeline_snapshot again before the next mutation. Do not reuse a contextToken captured before that long-running operation.',
    '- Use openreelio.stock_media_search for stock video, image, BGM, or SFX candidates before falling back to generic web links.',
    '- Use openreelio.stock_media_import to bring a selected stock candidate into the project before placing it on the timeline. Do not pass stock URLs directly to ImportAsset.',
    '- Use openreelio.media_insert when placing media assets on the timeline. It is the drag-and-drop parity path for source ranges, visible video placement, linked audio, clip linking, muting, undo, and UI refresh.',
    '- For editable on-video text, titles, lower thirds, and callouts, use AddTextClip/UpdateTextClip/SetClipTransform with full TextClipData and preview transform data. For timed subtitles from speech, call openreelio.transcription_generate first, then use CreateCaption/UpdateCaption/ImportGeneratedCaptions with the returned caption segments.',
    '- Prefer openreelio.plan_validate and openreelio.plan_apply for multi-step non-media edits. Use openreelio.command_execute only for a narrow single-command edit; do not use raw InsertClip for normal asset placement.',
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
      case 'transcription_status': {
        const result = await buildTranscriptionStatusToolCall();
        return toolResponse(result, result.status === 'ok');
      }
      case 'transcription_install_model': {
        const result = await installTranscriptionModelToolCall(toolCall.arguments);
        contextTokensBySessionId.delete(context.sessionId);
        return toolResponse(result, result.status === 'ok');
      }
      case 'transcription_generate': {
        const result = await generateTranscriptionToolCall(toolCall.arguments);
        return toolResponse(result, result.status === 'ok');
      }
      case 'annotation_read': {
        const result = await readAnnotationToolCall(toolCall.arguments);
        return toolResponse(result, result.status === 'ok');
      }
      case 'clip_analyze': {
        const result = await analyzeClipToolCall(toolCall.arguments);
        return toolResponse(result, result.status === 'ok');
      }
      case 'clip_describe': {
        const result = await describeClipToolCall(toolCall.arguments);
        return toolResponse(result, result.status === 'ok');
      }
      case 'semantic_edit_plan': {
        const result = await planSemanticEditToolCall(toolCall.arguments);
        return toolResponse(result, result.status === 'ok');
      }
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
      case 'media_insert': {
        const result = await insertMediaToolCall(toolCall.arguments, request, context);
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
  const [projectInfo, projectState, transcriptionReady] = await Promise.all([
    readOptionalProjectInfo(),
    readOptionalProjectState(),
    readTranscriptionAvailability(),
  ]);
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
      previewFrameAccess: true,
      rawMediaAccess: 'clip-analysis-tools',
    },
    capabilities: {
      projectStateRead: true,
      timelineRead: true,
      assetRead: true,
      transcriptionGenerate: true,
      transcriptionReady,
      annotationRead: true,
      clipAnalyze: true,
      clipDescribe: true,
      semanticEditPlan: true,
      commandSchemaRead: true,
      commandValidate: true,
      stockMediaSearch: true,
      stockMediaImport: true,
      mediaInsert: true,
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
      mutationPath: 'openreelio.media_insert or openreelio.plan_apply',
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
  const [state, playbackModule, previewModule, transcriptionAvailable] = await Promise.all([
    readOptionalProjectState(),
    import('@/stores/playbackStore'),
    import('@/stores/previewStore'),
    readTranscriptionAvailability(),
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
      rawFrameAccess: true,
      transcriptAccess: transcriptionAvailable,
      waveformAccess: false,
      message:
        'Use openreelio.clip_analyze for indexed frame samples, openreelio.clip_describe for semantic clip-local frame evidence, and openreelio.transcription_generate for speech-to-text subtitle timing. Waveform inspection is not exposed through this Codex bridge yet.',
    },
  };
}

async function insertMediaToolCall(
  args: CodexJsonObject | null,
  request: CodexAppServerRequest,
  context: OpenReelioCodexToolContext,
): Promise<CodexJsonObject> {
  if (!args) {
    throw new Error('OpenReelio media_insert requires object arguments.');
  }

  let sequenceId = getRequiredStringArg(args, 'sequenceId', 'media_insert');
  let trackId = getRequiredStringArg(args, 'trackId', 'media_insert');
  const assetId = getRequiredStringArg(args, 'assetId', 'media_insert');
  const timelineStart = getFiniteNonNegativeNumberArg(args, 'timelineStart', 'media_insert', true);
  if (timelineStart === undefined) {
    throw new Error('OpenReelio media_insert requires timelineStart.');
  }
  const sourceIn = getFiniteNonNegativeNumberArg(args, 'sourceIn', 'media_insert');
  const sourceOut = getFiniteNonNegativeNumberArg(args, 'sourceOut', 'media_insert');
  const audioOnly = args.audioOnly === true;
  const autoExtractLinkedAudio =
    typeof args.autoExtractLinkedAudio === 'boolean' ? args.autoExtractLinkedAudio : undefined;
  const reason =
    getString(args, 'reason')?.trim() || `Insert media asset ${assetId} on the timeline`;
  const contextToken = getString(args, 'contextToken')?.trim() ?? null;
  const tokenValidation = validateContextToken(context, contextToken);
  if (!tokenValidation.valid) {
    return {
      status: 'error',
      message: tokenValidation.message.replace(/command_execute/g, 'media_insert'),
    };
  }

  const targetNormalization = await normalizeMediaInsertTarget(
    { sequenceId, trackId, assetId, audioOnly },
    tokenValidation.record,
  );
  sequenceId = targetNormalization.sequenceId;
  trackId = targetNormalization.trackId;

  const payload: CodexJsonObject = {
    sequenceId,
    trackId,
    assetId,
    timelineStart,
    ...(sourceIn !== undefined ? { sourceIn } : {}),
    ...(sourceOut !== undefined ? { sourceOut } : {}),
    ...(audioOnly ? { audioOnly } : {}),
    ...(autoExtractLinkedAudio !== undefined ? { autoExtractLinkedAudio } : {}),
  };
  const decision = context.approvalDecisionProvider
    ? await context.approvalDecisionProvider(
        buildCommandApprovalRequest({
          request,
          context,
          commandType: 'MediaInsert',
          payload,
          reason,
        }),
      )
    : 'decline';

  if (decision !== 'accept' && decision !== 'acceptForSession') {
    return {
      status: 'denied',
      message:
        'The OpenReelio media insert was not approved. Approve it with the chat approval card; plain chat replies do not grant tool execution.',
    };
  }

  try {
    const insert = await insertAgentMediaClip({
      sequenceId,
      trackId,
      assetId,
      timelineStart,
      sourceIn,
      sourceOut,
      audioOnly,
      autoExtractLinkedAudio,
    });
    const refresh = await refreshProjectStoreAfterMutation();

    return {
      status: 'ok',
      message: 'Media inserted through the drag-and-drop parity path.',
      result: {
        opId: insert.insertResult.opId,
        createdIds: insert.insertResult.createdIds,
        clipId: insert.clipId,
        sequenceId: insert.sequenceId,
        trackId: insert.trackId,
        assetId: insert.assetId,
        timelineStart: insert.timelineStart,
        sourceIn: insert.sourceIn ?? null,
        sourceOut: insert.sourceOut ?? null,
        durationSec: insert.durationSec,
        linkedAudio: insert.linkedAudio ?? null,
      },
      targeting: targetNormalization.notes.length > 0 ? targetNormalization.notes : undefined,
      refresh,
    };
  } finally {
    contextTokensBySessionId.delete(context.sessionId);
  }
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

  const rawPayload = asObject(args.payload);
  if (!rawPayload) {
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

  const payloadNormalization = await normalizeCommandPayloadForExternalMutation(
    commandType,
    rawPayload,
    tokenValidation.record,
  );
  const payload = payloadNormalization.payload;

  if (commandType === 'InsertClip') {
    const mediaArgs: CodexJsonObject = {
      ...payload,
      reason,
      contextToken,
    };
    if (mediaArgs.timelineStart === undefined && mediaArgs.timelineIn !== undefined) {
      mediaArgs.timelineStart = mediaArgs.timelineIn;
    }

    return insertMediaToolCall(mediaArgs, request, context);
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

  const plan: AgentPlan = {
    id: `codex-command-${context.sessionId}-${request.id}`,
    goal: reason,
    steps: [
      {
        id: 'step-1',
        toolName: commandType,
        params: payload as AgentPlan['steps'][number]['params'],
        description: reason,
        riskLevel: 'medium',
        dependsOn: [],
        optional: false,
      },
    ],
    approvalGranted: true,
    sessionId: context.sessionId,
  };
  let execution: ApprovedAgentPlanExecution;
  try {
    execution = await executeAgentPlanWithApprovalProof(
      context,
      plan,
      `externalAgentPlan:${commandType}`,
    );
  } finally {
    contextTokensBySessionId.delete(context.sessionId);
  }
  const refresh = await refreshProjectStoreAfterMutation();

  return {
    status: execution.result.success ? 'ok' : 'error',
    commandType,
    approval: buildApprovalExecutionSummary(execution),
    result: execution.result,
    targeting: payloadNormalization.notes.length > 0 ? payloadNormalization.notes : undefined,
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

  const rawPlan = asObject(args.plan);
  const rawPlanId = getString(rawPlan, 'id')?.trim() ?? null;
  const contextToken = getString(args, 'contextToken')?.trim() ?? null;
  const tokenValidation = validateContextToken(context, contextToken);
  if (!tokenValidation.valid) {
    return {
      status: 'error',
      planId: rawPlanId,
      message: tokenValidation.message.replace(/command_execute/g, 'plan_apply'),
    };
  }

  const validation = await validateAgentPlanArgument(args, { tokenRecord: tokenValidation.record });
  if (!validation.valid) {
    return {
      status: 'error',
      message: validation.message,
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

  let execution: ApprovedAgentPlanExecution;
  try {
    execution = await executeAgentPlanWithApprovalProof(
      context,
      validation.plan,
      'externalAgentPlan',
    );
  } finally {
    contextTokensBySessionId.delete(context.sessionId);
  }
  const refresh = await refreshProjectStoreAfterMutation();

  return {
    status: execution.result.success ? 'ok' : 'error',
    planId: validation.plan.id,
    approval: buildApprovalExecutionSummary(execution),
    result: execution.result,
    targeting: validation.normalizationNotes.length > 0 ? validation.normalizationNotes : undefined,
    refresh,
  };
}

interface ApprovedAgentPlanExecution {
  result: AgentPlanResult;
  approval: Awaited<ReturnType<typeof issuePlanApplyApprovalProof>>;
  retryApproval: Awaited<ReturnType<typeof issuePlanApplyApprovalProof>> | null;
  retriedApprovalProof: boolean;
}

async function executeAgentPlanWithApprovalProof(
  context: OpenReelioCodexToolContext,
  plan: AgentPlan,
  operationName: string,
): Promise<ApprovedAgentPlanExecution> {
  const approval = await issuePlanApplyApprovalProof(context, plan.id);
  let result = await executeAgentPlanOnceWithApprovalProof(context, plan, approval, operationName);

  if (!shouldRetryPlanApprovalProof(result)) {
    return {
      result,
      approval,
      retryApproval: null,
      retriedApprovalProof: false,
    };
  }

  const retryApproval = await issuePlanApplyApprovalProof(context, plan.id);
  result = await executeAgentPlanOnceWithApprovalProof(
    context,
    plan,
    retryApproval,
    `${operationName}:approvalRetry`,
  );

  return {
    result,
    approval,
    retryApproval,
    retriedApprovalProof: true,
  };
}

async function executeAgentPlanOnceWithApprovalProof(
  context: OpenReelioCodexToolContext,
  plan: AgentPlan,
  approval: Awaited<ReturnType<typeof issuePlanApplyApprovalProof>>,
  operationName: string,
): Promise<AgentPlanResult> {
  const approvedPlan: AgentPlan = {
    ...plan,
    approvalGranted: true,
    approvalProof: approval.proof,
    sessionId: context.sessionId,
  };

  return await runProjectBackendMutation(
    operationName,
    () => invoke<AgentPlanResult>('execute_agent_plan', { plan: approvedPlan }),
    {
      refreshProjectState: false,
      markDirty: false,
      timeoutMs: EXTERNAL_AGENT_MUTATION_TIMEOUT_MS,
    },
  );
}

function shouldRetryPlanApprovalProof(result: AgentPlanResult): boolean {
  const errorMessage = result.errorMessage ?? '';

  return (
    !result.success &&
    result.stepsCompleted === 0 &&
    result.operationIds.length === 0 &&
    /approvalToken is invalid or expired|approvalToken is expired|Plan approval proof was rejected/i.test(
      errorMessage,
    )
  );
}

function buildApprovalExecutionSummary(execution: ApprovedAgentPlanExecution): CodexJsonObject {
  if (!execution.retryApproval) {
    return {
      tokenId: execution.approval.grant.tokenId,
      consumedBy: 'execute_agent_plan',
    };
  }

  return {
    tokenId: execution.retryApproval.grant.tokenId,
    consumedBy: 'execute_agent_plan',
    retried: execution.retriedApprovalProof,
    initialTokenId: execution.approval.grant.tokenId,
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
  options?: { tokenRecord?: ContextTokenRecord },
): Promise<
  | { valid: true; plan: AgentPlan; normalizationNotes: CodexJsonObject[] }
  | { valid: false; message: string }
> {
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

  const createSequenceBoundaryValidation = validateCreateSequencePlanBoundary(normalized.plan);
  if (!createSequenceBoundaryValidation.valid) {
    return createSequenceBoundaryValidation;
  }

  let planForValidation = normalized.plan;
  let normalizationNotes: CodexJsonObject[] = [];
  if (options?.tokenRecord) {
    const state = planRequiresProjectStateForTargeting(normalized.plan)
      ? await readOptionalProjectState()
      : null;
    const normalizedForMutation = normalizeAgentPlanForExternalMutation(
      normalized.plan,
      options.tokenRecord,
      state,
    );
    planForValidation = normalizedForMutation.plan;
    normalizationNotes = normalizedForMutation.notes;
  }

  for (const step of planForValidation.steps) {
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

  return { valid: true, plan: planForValidation, normalizationNotes };
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

async function issuePlanApplyApprovalProof(
  context: OpenReelioCodexToolContext,
  planId: string,
): ReturnType<typeof issueAgentPlanApprovalProof> {
  return issueAgentPlanApprovalProof({
    sessionId: context.sessionId,
    runId: null,
    planId,
    projectId: context.projectId,
    runtimeId: context.runtimeId,
  });
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

async function readTranscriptionAvailability(): Promise<boolean> {
  const status = await readTranscriptionStatus();
  if (status) {
    return status.ready;
  }

  try {
    const result = await commands.isTranscriptionAvailable();
    return result.status === 'ok' && result.data === true;
  } catch {
    return false;
  }
}

async function readTranscriptionStatus(): Promise<TranscriptionStatusDto | null> {
  try {
    const result = await commands.getTranscriptionStatus();
    return result.status === 'ok' ? result.data : null;
  } catch {
    return null;
  }
}

function normalizeWhisperModelName(
  value: string | null,
  fallback = 'large-v3-turbo',
): { valid: true; model: string } | { valid: false; message: string } {
  const raw = value?.trim().toLowerCase() || '';
  const requested =
    raw.length === 0 || raw === 'auto' || raw === 'default' || raw === 'best' ? fallback : raw;
  const model =
    requested === 'turbo' || requested === 'largev3turbo'
      ? 'large-v3-turbo'
      : requested === 'largev3'
        ? 'large-v3'
        : requested;
  if (!WHISPER_MODEL_NAME_SET.has(model)) {
    return {
      valid: false,
      message: `Unknown Whisper model '${value}'. Supported models: ${Object.keys(
        WHISPER_MODEL_FILES,
      ).join(', ')}.`,
    };
  }

  return { valid: true, model };
}

function selectDefaultWhisperModel(status: TranscriptionStatusDto | null): string {
  if (status?.defaultModel && WHISPER_MODEL_NAME_SET.has(status.defaultModel)) {
    return status.defaultModel;
  }
  const installed = new Set(
    status?.models.filter((candidate) => candidate.installed).map((candidate) => candidate.id) ??
      [],
  );
  return (
    WHISPER_MODEL_SELECTION_PREFERENCE.find((candidate) => installed.has(candidate)) ??
    'large-v3-turbo'
  );
}

function buildTranscriptionModelHint(model: string): CodexJsonObject {
  return {
    model,
    filename: WHISPER_MODEL_FILES[model] ?? null,
    installLocation:
      'OpenReelio local app data directory under models/whisper, for example openreelio/models/whisper.',
  };
}

function truncateFullText(fullText: string): CodexJsonObject {
  return {
    fullTextPreview:
      fullText.length > FULL_TEXT_PREVIEW_LIMIT
        ? `${fullText.slice(0, FULL_TEXT_PREVIEW_LIMIT)}...`
        : fullText,
    fullTextTruncated: fullText.length > FULL_TEXT_PREVIEW_LIMIT,
    fullTextLength: fullText.length,
  };
}

async function buildTranscriptionStatusToolCall(): Promise<CodexJsonObject> {
  const transcriptionStatus = await readTranscriptionStatus();
  if (!transcriptionStatus) {
    return {
      status: 'error',
      message: 'Unable to read OpenReelio transcription status.',
    };
  }

  return {
    status: 'ok',
    ...transcriptionStatus,
    installedModels: transcriptionStatus.models
      .filter((model) => model.installed)
      .map((model) => model.id),
  } as unknown as CodexJsonObject;
}

async function installTranscriptionModelToolCall(
  args: CodexJsonObject | null,
): Promise<CodexJsonObject> {
  const modelResult = normalizeWhisperModelName(getString(args ?? {}, 'model'), 'large-v3-turbo');
  if (!modelResult.valid) {
    return {
      status: 'error',
      message: modelResult.message,
    };
  }

  const model = modelResult.model;
  const force = args?.force === true;
  const transcriptionStatus = await readTranscriptionStatus();
  const existingModel = transcriptionStatus?.models.find((candidate) => candidate.id === model);
  if (existingModel?.installed && !force) {
    return {
      status: 'ok',
      model,
      alreadyInstalled: true,
      modelStatus: existingModel as unknown as CodexJsonObject,
      mutationContextStale: true,
      nextStep:
        'Read openreelio.project_state or openreelio.timeline_snapshot again before media_insert, plan_apply, or command_execute. Do not reuse a contextToken captured before this model check.',
    };
  }

  try {
    const result = await commands.downloadWhisperModel(model, force);
    if (result.status === 'error') {
      return {
        status: 'error',
        model,
        message: result.error,
        modelHint: buildTranscriptionModelHint(model),
      };
    }

    const updatedStatus = await readTranscriptionStatus();
    return {
      status: 'ok',
      model,
      alreadyInstalled: false,
      modelStatus: result.data as unknown as CodexJsonObject,
      transcriptionReady: updatedStatus?.ready ?? result.data.installed,
      installedModels: updatedStatus?.models
        .filter((candidate) => candidate.installed)
        .map((candidate) => candidate.id) ?? [model],
      mutationContextStale: true,
      nextStep:
        'Read openreelio.project_state or openreelio.timeline_snapshot again before media_insert, plan_apply, or command_execute. Do not reuse a contextToken captured before model installation.',
    };
  } catch (error) {
    return {
      status: 'error',
      model,
      message: error instanceof Error ? error.message : String(error),
      modelHint: buildTranscriptionModelHint(model),
    };
  }
}

async function generateTranscriptionToolCall(
  args: CodexJsonObject | null,
): Promise<CodexJsonObject> {
  if (!args) {
    throw new Error('OpenReelio transcription_generate requires object arguments.');
  }

  const sequenceAudio = args.sequenceAudio === true;
  const assetId = sequenceAudio
    ? (getString(args, 'assetId')?.trim() ?? 'sequence-audio')
    : getRequiredStringArg(args, 'assetId', 'transcription_generate');
  const language = getString(args, 'language')?.trim() || 'auto';
  const transcriptionStatus = await readTranscriptionStatus();
  const modelResult = normalizeWhisperModelName(
    getString(args, 'model'),
    selectDefaultWhisperModel(transcriptionStatus),
  );
  if (!modelResult.valid) {
    return {
      status: 'error',
      assetId,
      message: modelResult.message,
    };
  }

  const model = modelResult.model;
  const translate = typeof args.translate === 'boolean' ? args.translate : false;
  const asyncJob = args.async === true;
  const sequenceId = getString(args, 'sequenceId')?.trim() || null;
  const trackId = getString(args, 'trackId')?.trim() || null;
  const clipId = getString(args, 'clipId')?.trim() || null;
  let clipMapping: ClipTimeMapping | null = null;
  let clipMappingNotes: CodexJsonObject[] = [];

  if (clipId && !sequenceAudio) {
    const state = await readProjectState();
    const mappingResolution = findActiveClipTimeMapping(state, {
      clipId,
      sequenceId,
      trackId,
      assetId,
    });
    clipMapping = mappingResolution.mapping;
    clipMappingNotes = mappingResolution.notes;
    if (!clipMapping) {
      return {
        status: 'error',
        assetId,
        clipId,
        activeSequenceId: state.activeSequenceId,
        message:
          'Could not find the requested clip on the active timeline or with the provided clipId, sequenceId, trackId, and assetId.',
      };
    }
  }

  if (transcriptionStatus && !transcriptionStatus.featureAvailable) {
    return {
      status: 'error',
      assetId,
      message:
        'Whisper transcription is not available in this OpenReelio build. Rebuild with the whisper feature enabled or use an AI provider transcript fallback.',
      modelHint: buildTranscriptionModelHint(model),
    };
  }
  if (transcriptionStatus) {
    const modelStatus = transcriptionStatus.models.find((candidate) => candidate.id === model);
    if (!modelStatus?.installed) {
      return {
        status: 'error',
        assetId,
        model,
        message: `Whisper model '${model}' is not installed. Add ${WHISPER_MODEL_FILES[model]} to ${transcriptionStatus.modelsDir} or choose an installed model.`,
        modelHint: {
          ...buildTranscriptionModelHint(model),
          modelsDir: transcriptionStatus.modelsDir,
          installedModels: transcriptionStatus.models
            .filter((candidate) => candidate.installed)
            .map((candidate) => candidate.id),
        },
      };
    }
  } else {
    const transcriptionAvailable = await readTranscriptionAvailability();
    if (!transcriptionAvailable) {
      return {
        status: 'error',
        assetId,
        message:
          'Whisper transcription is not available in this OpenReelio build. Rebuild with the whisper feature enabled or use an AI provider transcript fallback.',
        modelHint: buildTranscriptionModelHint(model),
      };
    }
  }

  const options: TranscriptionOptionsDto = {
    language,
    translate,
    model,
  };

  if (asyncJob) {
    if (sequenceAudio) {
      return {
        status: 'error',
        assetId,
        sequenceId,
        model,
        message: 'Async transcription jobs currently support asset transcription only.',
        modelHint: buildTranscriptionModelHint(model),
      };
    }

    const jobResult = await commands.submitTranscriptionJob(assetId, options);
    if (jobResult.status === 'error') {
      return {
        status: 'error',
        assetId,
        model,
        message: String(jobResult.error),
        modelHint: buildTranscriptionModelHint(model),
      };
    }

    return {
      status: 'ok',
      mode: 'async',
      assetId,
      jobId: jobResult.data,
      options,
      modelHint: buildTranscriptionModelHint(model),
      message:
        'Transcription job submitted. Listen for OpenReelio job completion before importing generated captions.',
    };
  }

  const transcriptionResult = sequenceAudio
    ? await commands.transcribeSequence(sequenceId, options)
    : await commands.transcribeAsset(assetId, options);
  if (transcriptionResult.status === 'error') {
    return {
      status: 'error',
      assetId,
      model,
      message: String(transcriptionResult.error),
      modelHint: buildTranscriptionModelHint(model),
    };
  }

  const response = buildTranscriptionResponse(
    assetId,
    model,
    options,
    transcriptionResult.data,
    clipMapping,
  );
  if (clipMappingNotes.length > 0) {
    response.targeting = clipMappingNotes;
  }
  if (sequenceAudio) {
    response.sequenceAudio = true;
    response.sequenceId = sequenceId;
    response.importHint =
      'Use captionSegments as ImportGeneratedCaptions.segments for the target sequence. Timings are already timeline-relative.';
  }
  return response;
}

function buildTranscriptionResponse(
  assetId: string,
  model: string,
  options: TranscriptionOptionsDto,
  transcription: TranscriptionResultDto,
  clipMapping: ClipTimeMapping | null,
): CodexJsonObject {
  const captionSegments = transcription.segments
    .map((segment) => ({
      startSec: segment.startTime,
      endSec: segment.endTime,
      text: segment.text.trim(),
    }))
    .filter((segment) => segment.text.length > 0 && segment.endSec > segment.startSec);
  const fullText = truncateFullText(transcription.fullText);
  const response: CodexJsonObject = {
    status: 'ok',
    mode: 'sync',
    assetId,
    model,
    language: transcription.language,
    durationSec: transcription.duration,
    segmentCount: captionSegments.length,
    ...fullText,
    captionSegments,
    importHint:
      'Use captionSegments as ImportGeneratedCaptions.segments for full-asset captions. Use timelineCaptionSegments instead when a clipMapping is present.',
    modelHint: buildTranscriptionModelHint(model),
    options,
  };

  if (clipMapping) {
    const timelineCaptionSegments = mapCaptionSegmentsToClipTimeline(captionSegments, clipMapping);
    response.clipMapping = clipMapping as unknown as CodexJsonObject;
    response.timelineSegmentCount = timelineCaptionSegments.length;
    response.skippedTimelineSegmentCount = captionSegments.length - timelineCaptionSegments.length;
    response.timelineCaptionSegments = timelineCaptionSegments as unknown as CodexJsonObject[];
    response.importHint =
      'Use timelineCaptionSegments as ImportGeneratedCaptions.segments when creating subtitles for this timeline clip.';
  }

  return response;
}

function mapCaptionSegmentsToClipTimeline(
  segments: CaptionSegmentForImport[],
  mapping: ClipTimeMapping,
): CaptionSegmentForImport[] {
  const speed =
    Number.isFinite(mapping.speed) && Math.abs(mapping.speed) > 0 ? Math.abs(mapping.speed) : 1;

  return segments
    .map((segment): CaptionSegmentForImport | null => {
      const sourceStartSec = Math.max(segment.startSec, mapping.sourceInSec);
      const sourceEndSec = Math.min(segment.endSec, mapping.sourceOutSec);
      if (sourceEndSec <= sourceStartSec) {
        return null;
      }

      const timelineStartSec = mapping.reverse
        ? mapping.timelineInSec + (mapping.sourceOutSec - sourceEndSec) / speed
        : mapping.timelineInSec + (sourceStartSec - mapping.sourceInSec) / speed;
      const timelineEndSec = mapping.reverse
        ? mapping.timelineInSec + (mapping.sourceOutSec - sourceStartSec) / speed
        : mapping.timelineInSec + (sourceEndSec - mapping.sourceInSec) / speed;
      const startSec = Math.max(mapping.timelineInSec, timelineStartSec);
      const endSec = Math.min(mapping.timelineOutSec, timelineEndSec);
      if (endSec <= startSec) {
        return null;
      }

      return {
        startSec,
        endSec,
        text: segment.text,
        partial: sourceStartSec > segment.startSec || sourceEndSec < segment.endSec,
        sourceStartSec,
        sourceEndSec,
      };
    })
    .filter((segment): segment is CaptionSegmentForImport => segment !== null);
}

function findClipTimeMapping(
  state: ProjectStateDto,
  filters: {
    clipId: string;
    sequenceId: string | null;
    trackId: string | null;
    assetId: string;
  },
): ClipTimeMapping | null {
  for (const sequence of state.sequences) {
    const sequenceObject = asObject(sequence) ?? {};
    const sequenceId = getString(sequenceObject, 'id');
    if (!sequenceId || (filters.sequenceId && sequenceId !== filters.sequenceId)) {
      continue;
    }

    const tracks = Array.isArray(sequenceObject.tracks) ? sequenceObject.tracks : [];
    for (const track of tracks) {
      const trackObject = asObject(track) ?? {};
      const trackId = getString(trackObject, 'id');
      if (!trackId || (filters.trackId && trackId !== filters.trackId)) {
        continue;
      }

      const clips = Array.isArray(trackObject.clips) ? trackObject.clips : [];
      for (const clip of clips) {
        const clipObject = asObject(clip) ?? {};
        if (getString(clipObject, 'id') !== filters.clipId) {
          continue;
        }

        const assetId = getString(clipObject, 'assetId');
        if (!assetId || assetId !== filters.assetId) {
          continue;
        }

        const place = asObject(clipObject.place) ?? {};
        const range = asObject(clipObject.range) ?? {};
        const timelineInSec = asFiniteNumber(place.timelineInSec);
        const durationSec = asFiniteNumber(place.durationSec);
        const sourceInSec = asFiniteNumber(range.sourceInSec);
        const sourceOutSec = asFiniteNumber(range.sourceOutSec);
        if (
          timelineInSec === null ||
          durationSec === null ||
          sourceInSec === null ||
          sourceOutSec === null
        ) {
          return null;
        }

        return {
          sequenceId,
          trackId,
          clipId: filters.clipId,
          assetId,
          timelineInSec,
          timelineOutSec: timelineInSec + durationSec,
          durationSec,
          sourceInSec,
          sourceOutSec,
          speed: asFiniteNumber(clipObject.speed) ?? 1,
          reverse: clipObject.reverse === true,
        };
      }
    }
  }

  return null;
}

function findActiveClipTimeMapping(
  state: ProjectStateDto,
  filters: {
    clipId: string;
    sequenceId: string | null;
    trackId: string | null;
    assetId: string;
  },
): { mapping: ClipTimeMapping | null; notes: CodexJsonObject[] } {
  const notes: CodexJsonObject[] = [];
  if (state.activeSequenceId) {
    const activeMapping = findClipTimeMapping(state, {
      ...filters,
      sequenceId: state.activeSequenceId,
      trackId: null,
    });
    if (activeMapping) {
      if (filters.sequenceId !== state.activeSequenceId) {
        notes.push({
          type: 'active_sequence_defaulted',
          tool: 'transcription_generate',
          previousSequenceId: filters.sequenceId,
          sequenceId: activeMapping.sequenceId,
          reason: 'Clip-based transcription mapping defaults to the active timeline.',
        });
      }
      if (filters.trackId && filters.trackId !== activeMapping.trackId) {
        notes.push({
          type: 'clip_track_resolved',
          tool: 'transcription_generate',
          clipId: filters.clipId,
          previousTrackId: filters.trackId,
          trackId: activeMapping.trackId,
          reason: 'The clip was found on the active timeline track.',
        });
      }
      return { mapping: activeMapping, notes };
    }
  }

  return { mapping: findClipTimeMapping(state, filters), notes };
}

async function resolveClipReadTarget(
  args: CodexJsonObject,
  toolName: 'clip_analyze' | 'clip_describe',
): Promise<{ sequenceId: string; trackId: string; clipId: string; notes: CodexJsonObject[] }> {
  const requestedSequenceId = getString(args, 'sequenceId')?.trim() || null;
  const requestedTrackId = getString(args, 'trackId')?.trim() || null;
  const clipId = getRequiredStringArg(args, 'clipId', toolName);
  const state = await readOptionalProjectState();

  if (state?.activeSequenceId) {
    const activeSequence = findSequenceById(state, state.activeSequenceId);
    const activeLocation = activeSequence
      ? findClipLocationInSequence(activeSequence, clipId)
      : null;
    if (activeLocation) {
      const notes: CodexJsonObject[] = [];
      if (requestedSequenceId !== state.activeSequenceId) {
        notes.push({
          type: 'active_sequence_defaulted',
          tool: toolName,
          previousSequenceId: requestedSequenceId,
          sequenceId: state.activeSequenceId,
          reason: 'Clip analysis defaults to the active OpenReelio timeline.',
        });
      }
      if (requestedTrackId && requestedTrackId !== activeLocation.track.id) {
        notes.push({
          type: 'clip_track_resolved',
          tool: toolName,
          clipId,
          previousTrackId: requestedTrackId,
          trackId: activeLocation.track.id,
          reason: 'The clip was found on the active timeline track.',
        });
      }

      return {
        sequenceId: state.activeSequenceId,
        trackId: activeLocation.track.id,
        clipId,
        notes,
      };
    }
  }

  return {
    sequenceId: requestedSequenceId ?? getRequiredStringArg(args, 'sequenceId', toolName),
    trackId: requestedTrackId ?? getRequiredStringArg(args, 'trackId', toolName),
    clipId,
    notes: [],
  };
}

function normalizeClipAnalysisOptions(
  args: CodexJsonObject,
  toolName = 'clip_analyze',
): ClipAnalysisOptions {
  const rawMode = getString(args, 'mode');
  const mode = rawMode === 'representative' || rawMode === 'dense' ? rawMode : 'dense';
  const targetIntervalSec = getFiniteNonNegativeNumberArg(args, 'targetIntervalSec', toolName);
  const maxSamples = getFiniteNonNegativeNumberArg(args, 'maxSamples', toolName);
  const rangeStartSec = getFiniteNonNegativeNumberArg(args, 'rangeStartSec', toolName);
  const rangeEndSec = getFiniteNonNegativeNumberArg(args, 'rangeEndSec', toolName);

  return {
    mode,
    ...(targetIntervalSec !== undefined ? { targetIntervalSec } : {}),
    ...(maxSamples !== undefined ? { maxSamples: Math.max(1, Math.trunc(maxSamples)) } : {}),
    includeEdges: typeof args.includeEdges === 'boolean' ? args.includeEdges : true,
    ...(rangeStartSec !== undefined ? { rangeStartSec } : {}),
    ...(rangeEndSec !== undefined ? { rangeEndSec } : {}),
    forceRefresh: args.forceRefresh === true,
  };
}

function normalizeClipPerceptionOptions(args: CodexJsonObject): ClipPerceptionOptions {
  const rawDetail = getString(args, 'detail');
  const detail =
    rawDetail === 'auto' || rawDetail === 'high' || rawDetail === 'low' ? rawDetail : 'low';
  const maxFrames = getFiniteNonNegativeNumberArg(args, 'maxFrames', 'clip_describe');
  const provider = getString(args, 'provider')?.trim();
  const model = getString(args, 'model')?.trim();

  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    detail,
    ...(maxFrames !== undefined ? { maxFrames: Math.max(1, Math.trunc(maxFrames)) } : {}),
    reuseSourceAnalysis:
      typeof args.reuseSourceAnalysis === 'boolean' ? args.reuseSourceAnalysis : true,
    allowCloud: args.allowCloud === true,
    forceRefresh: args.forceRefresh === true,
    includeContactSheet: args.includeContactSheet === true,
  };
}

async function analyzeClipToolCall(args: CodexJsonObject | null): Promise<CodexJsonObject> {
  if (!args) {
    throw new Error('OpenReelio clip_analyze requires object arguments.');
  }

  const target = await resolveClipReadTarget(args, 'clip_analyze');
  const options = normalizeClipAnalysisOptions(args);

  try {
    const response = await invoke<ClipAnalysisResponse>('sample_clip_frames', {
      sequenceId: target.sequenceId,
      trackId: target.trackId,
      clipId: target.clipId,
      options,
    });
    return {
      status: 'ok',
      source: response.source,
      fingerprint: response.bundle.fingerprint,
      sequenceId: response.bundle.sequenceId,
      trackId: response.bundle.trackId,
      clipId: response.bundle.clipId,
      assetId: response.bundle.assetId,
      sampleCount: response.bundle.samples.length,
      readySampleCount: response.bundle.samples.filter(
        (sample) => sample.extractionStatus === 'ready',
      ).length,
      quality: response.bundle.quality,
      samples: response.bundle.samples,
      mapping: response.bundle.mapping,
      errors: response.bundle.errors,
      targeting: target.notes.length > 0 ? target.notes : undefined,
      bundle: response.bundle as unknown as CodexJsonObject,
    };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function describeClipToolCall(args: CodexJsonObject | null): Promise<CodexJsonObject> {
  if (!args) {
    throw new Error('OpenReelio clip_describe requires object arguments.');
  }

  const target = await resolveClipReadTarget(args, 'clip_describe');
  const analysisOptions = normalizeClipAnalysisOptions(args, 'clip_describe');
  const perceptionOptions = normalizeClipPerceptionOptions(args);

  try {
    const response = await invoke<ClipPerceptionResponse>('describe_timeline_clip', {
      sequenceId: target.sequenceId,
      trackId: target.trackId,
      clipId: target.clipId,
      analysisOptions,
      perceptionOptions,
    });
    return {
      status: 'ok',
      source: response.source,
      perceptionFingerprint: response.bundle.perceptionFingerprint,
      clipFingerprint: response.bundle.clipFingerprint,
      sequenceId: response.bundle.sequenceId,
      trackId: response.bundle.trackId,
      clipId: response.bundle.clipId,
      assetId: response.bundle.assetId,
      observationCount: response.bundle.observations.length,
      observations: response.bundle.observations,
      quality: response.bundle.quality,
      errors: response.bundle.errors,
      targeting: target.notes.length > 0 ? target.notes : undefined,
      bundle: response.bundle as unknown as CodexJsonObject,
    };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeSemanticTemporalAction(value: unknown): SemanticTemporalEditAction {
  return value === 'highlight' ||
    value === 'remove' ||
    value === 'marker' ||
    value === 'addText' ||
    value === 'blur'
    ? value
    : 'blur';
}

function normalizeSemanticEditPlanOptions(args: CodexJsonObject): SemanticTemporalEditPlanOptions {
  const paddingSec = getFiniteNonNegativeNumberArg(args, 'paddingSec', 'semantic_edit_plan');
  const mergeGapSec = getFiniteNonNegativeNumberArg(args, 'mergeGapSec', 'semantic_edit_plan');
  const minConfidence = getFiniteNonNegativeNumberArg(args, 'minConfidence', 'semantic_edit_plan');
  const maxRanges = getFiniteNonNegativeNumberArg(args, 'maxRanges', 'semantic_edit_plan');
  const effectStrength = getFiniteNumberArg(args, 'effectStrength', 'semantic_edit_plan');
  const spatialTimeToleranceSec = getFiniteNonNegativeNumberArg(
    args,
    'spatialTimeToleranceSec',
    'semantic_edit_plan',
  );
  const text = getString(args, 'text')?.trim();

  return {
    ...(paddingSec !== undefined ? { paddingSec } : {}),
    ...(mergeGapSec !== undefined ? { mergeGapSec } : {}),
    ...(minConfidence !== undefined ? { minConfidence } : {}),
    ...(maxRanges !== undefined ? { maxRanges: Math.max(1, Math.trunc(maxRanges)) } : {}),
    ...(text ? { text } : {}),
    ...(effectStrength !== undefined ? { effectStrength } : {}),
    includeCommandDrafts:
      typeof args.includeCommandDrafts === 'boolean' ? args.includeCommandDrafts : true,
    ...(spatialTimeToleranceSec !== undefined ? { spatialTimeToleranceSec } : {}),
    includeSpatialTargets:
      typeof args.includeSpatialTargets === 'boolean' ? args.includeSpatialTargets : true,
  };
}

async function planSemanticEditToolCall(args: CodexJsonObject | null): Promise<CodexJsonObject> {
  if (!args) {
    throw new Error('OpenReelio semantic_edit_plan requires object arguments.');
  }

  const perceptionFingerprint = getRequiredStringArg(
    args,
    'perceptionFingerprint',
    'semantic_edit_plan',
  );
  const query = getRequiredStringArg(args, 'query', 'semantic_edit_plan');
  const action = normalizeSemanticTemporalAction(args.action);
  const options = normalizeSemanticEditPlanOptions(args);

  try {
    const plan = await invoke<SemanticTemporalEditPlan>('plan_semantic_clip_edit', {
      perceptionFingerprint,
      query,
      action,
      options,
    });
    return {
      status: 'ok',
      plan: plan as unknown as CodexJsonObject,
      planId: plan.planId,
      rangeCount: plan.ranges.length,
      ranges: plan.ranges as unknown as CodexJsonObject[],
      quality: plan.quality,
      summary: plan.summary,
    };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
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

  const result = await runProjectBackendMutation(
    'externalAgentStockMediaImport',
    () =>
      invoke<StockMediaImportResult>('import_stock_media_asset', {
        sourceUrl,
        name,
        assetType,
        provider,
        license,
        licenseAck,
        durationSec,
        tags,
        providerUrl,
      }),
    {
      refreshProjectState: false,
      markDirty: false,
      timeoutMs: EXTERNAL_AGENT_MUTATION_TIMEOUT_MS,
    },
  );
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
    editingDefaults: activeSequence ? buildTimelineEditingDefaults(activeSequence) : null,
    sequences: state.sequences.map(summarizeSequence),
  };
}

function buildTimelineEditingDefaults(
  sequence: ProjectStateDto['sequences'][number],
): CodexJsonObject {
  return {
    targetSequenceId: sequence.id,
    targetSequenceName: sequence.name,
    targetSequenceRule:
      'Implicit edit requests target this active sequence. Do not place edits in inactive sequences unless the user explicitly switches the active timeline first.',
    visualLayerOrder:
      'Visual tracks are front-to-back: tracks[0] is the top/front layer; larger indexes render lower/behind. Audio track order does not affect visual stacking.',
    createTrackDefaults:
      'For text, subtitles, captions, callouts, B-roll overlays, and other visual overlays, create video/overlay/caption tracks at position 0. Audio tracks may be appended at the end.',
    recommendedTracks: buildRecommendedTimelineTracks(sequence),
  };
}

function buildRecommendedTimelineTracks(
  sequence: ProjectStateDto['sequences'][number],
): CodexJsonObject {
  const textTrack = chooseTextOverlayTrack(sequence);
  const captionTrack = chooseCaptionTrack(sequence);
  const mainVideoTrack = chooseMainMediaVideoTrack(sequence);
  const audioTrack = chooseAudioTrack(sequence);

  return {
    mainVideoTrackId: mainVideoTrack?.track.id ?? null,
    textOverlayTrackId: textTrack?.track.id ?? null,
    captionTrackId: captionTrack?.track.id ?? null,
    audioTrackId: audioTrack?.track.id ?? null,
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
    tracks: tracks.map((track, index) => {
      const trackObject = asObject(track) ?? {};
      const clips = Array.isArray(trackObject.clips) ? trackObject.clips : [];
      return {
        id: trackObject.id,
        name: trackObject.name,
        index,
        visualLayer: VISUAL_TRACK_KINDS.has(String(trackObject.kind))
          ? index === 0
            ? 'top/front'
            : `below ${index} visual track(s) in array order`
          : null,
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

function findSequenceById(
  state: ProjectStateDto | null,
  sequenceId: string | null | undefined,
): ProjectStateDto['sequences'][number] | null {
  if (!state || !sequenceId) {
    return null;
  }

  return state.sequences.find((sequence) => sequence.id === sequenceId) ?? null;
}

function getTrackWithIndex(
  sequence: ProjectStateDto['sequences'][number],
  trackId: string | null | undefined,
): TrackWithIndex | null {
  if (!trackId) {
    return null;
  }

  const index = sequence.tracks.findIndex((track) => track.id === trackId);
  if (index < 0) {
    return null;
  }

  return { track: sequence.tracks[index], index };
}

function findClipLocationInSequence(
  sequence: ProjectStateDto['sequences'][number],
  clipId: string,
): TrackWithIndex | null {
  for (const [index, track] of sequence.tracks.entries()) {
    if (track.clips.some((clip) => clip.id === clipId)) {
      return { track, index };
    }
  }

  return null;
}

function isUsableTrack(track: ProjectStateDto['sequences'][number]['tracks'][number]): boolean {
  return track.locked !== true && track.muted !== true && track.visible !== false;
}

function isTextOverlayTrack(
  track: ProjectStateDto['sequences'][number]['tracks'][number],
): boolean {
  return TEXT_OVERLAY_TRACK_KINDS.has(track.kind) && isUsableTrack(track);
}

function chooseTextOverlayTrack(
  sequence: ProjectStateDto['sequences'][number],
): TrackWithIndex | null {
  const candidates = sequence.tracks
    .map((track, index) => ({ track, index }))
    .filter((candidate) => isTextOverlayTrack(candidate.track));

  if (candidates.length === 0) {
    return null;
  }

  return candidates[0];
}

function chooseCaptionTrack(sequence: ProjectStateDto['sequences'][number]): TrackWithIndex | null {
  return (
    sequence.tracks
      .map((track, index) => ({ track, index }))
      .find((candidate) => candidate.track.kind === 'caption' && isUsableTrack(candidate.track)) ??
    null
  );
}

function chooseMainMediaVideoTrack(
  sequence: ProjectStateDto['sequences'][number],
): TrackWithIndex | null {
  const candidates = sequence.tracks
    .map((track, index) => ({ track, index }))
    .filter((candidate) => candidate.track.kind === 'video' && isUsableTrack(candidate.track));

  if (candidates.length === 0) {
    return null;
  }

  return (
    candidates.find((candidate) => candidate.track.isBaseTrack === true) ??
    candidates[candidates.length - 1]
  );
}

function chooseAudioTrack(sequence: ProjectStateDto['sequences'][number]): TrackWithIndex | null {
  return (
    sequence.tracks
      .map((track, index) => ({ track, index }))
      .find((candidate) => candidate.track.kind === 'audio' && candidate.track.locked !== true) ??
    null
  );
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

async function readAnnotationToolCall(args: CodexJsonObject | null): Promise<CodexJsonObject> {
  const assetId = getString(args, 'assetId')?.trim();
  if (!assetId) {
    return {
      status: 'error',
      message: 'assetId is required.',
    };
  }

  try {
    const result = await commands.getAnnotation(assetId);
    if (result.status === 'error') {
      return {
        status: 'error',
        assetId,
        message: String(result.error),
      };
    }

    return {
      status: 'ok',
      assetId,
      analysisStatus: result.data.status,
      annotation: result.data.annotation,
    };
  } catch (error) {
    return {
      status: 'error',
      assetId,
      message: error instanceof Error ? error.message : String(error),
    };
  }
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

function normalizeCreateTrackLayering(
  commandType: string,
  payload: CodexJsonObject,
  notes: CodexJsonObject[],
): void {
  if (commandType !== 'CreateTrack') {
    return;
  }

  const kind = getString(payload, 'kind')?.trim().toLowerCase();
  if (!kind || !VISUAL_TRACK_KINDS.has(kind)) {
    return;
  }

  if (payload.position === 0) {
    return;
  }

  const previousPosition = payload.position ?? null;
  payload.position = 0;
  notes.push({
    type: 'visual_track_position_defaulted',
    commandType,
    previousPosition,
    position: 0,
    reason: 'Visual/text/caption tracks must be created at the front/top layer.',
  });
}

function normalizeActiveSequenceTarget(
  commandType: string,
  payload: CodexJsonObject,
  tokenRecord: ContextTokenRecord,
  notes: CodexJsonObject[],
): void {
  if (!ACTIVE_TIMELINE_SCOPED_COMMAND_TYPES.has(commandType) || !tokenRecord.activeSequenceId) {
    return;
  }

  const previousSequenceId = getString(payload, 'sequenceId')?.trim() || null;
  if (previousSequenceId === tokenRecord.activeSequenceId) {
    return;
  }

  payload.sequenceId = tokenRecord.activeSequenceId;
  notes.push({
    type: 'active_sequence_defaulted',
    commandType,
    previousSequenceId,
    sequenceId: tokenRecord.activeSequenceId,
    reason: 'Implicit timeline edits target the active OpenReelio timeline.',
  });
}

function normalizeClipTargetLocation(
  commandType: string,
  payload: CodexJsonObject,
  state: ProjectStateDto | null,
  notes: CodexJsonObject[],
): void {
  if (!CLIP_TARGET_COMMAND_TYPES.has(commandType)) {
    return;
  }

  const sequenceId = getString(payload, 'sequenceId')?.trim() || null;
  const clipId = getString(payload, 'clipId')?.trim() || null;
  const sequence = findSequenceById(state, sequenceId);
  if (!sequence || !clipId) {
    return;
  }

  const location = findClipLocationInSequence(sequence, clipId);
  if (!location) {
    return;
  }

  const previousTrackId = getString(payload, 'trackId')?.trim() || null;
  if (previousTrackId === location.track.id) {
    return;
  }

  payload.trackId = location.track.id;
  notes.push({
    type: 'clip_track_resolved',
    commandType,
    clipId,
    previousTrackId,
    trackId: location.track.id,
    reason: 'The clip was found on the active timeline track before mutation.',
  });
}

function normalizeTextAndCaptionTrackTarget(
  commandType: string,
  payload: CodexJsonObject,
  state: ProjectStateDto | null,
  notes: CodexJsonObject[],
): void {
  const sequenceId = getString(payload, 'sequenceId')?.trim() || null;
  const sequence = findSequenceById(state, sequenceId);
  if (!sequence) {
    return;
  }

  const currentTrackId = getString(payload, 'trackId')?.trim() || null;
  const currentTrack = getTrackWithIndex(sequence, currentTrackId);

  if (TEXT_OVERLAY_COMMAND_TYPES.has(commandType)) {
    const targetTrack = chooseTextOverlayTrack(sequence);
    if (!targetTrack) {
      return;
    }

    if (
      currentTrack &&
      isTextOverlayTrack(currentTrack.track) &&
      currentTrack.index <= targetTrack.index
    ) {
      return;
    }

    payload.trackId = targetTrack.track.id;
    notes.push({
      type: 'text_overlay_track_defaulted',
      commandType,
      previousTrackId: currentTrackId,
      trackId: targetTrack.track.id,
      reason: 'Editable text must be placed on the top/front visual layer so it is visible.',
    });
    return;
  }

  if (!CAPTION_TRACK_COMMAND_TYPES.has(commandType)) {
    return;
  }

  const targetTrack = chooseCaptionTrack(sequence);
  if (!targetTrack) {
    return;
  }

  if (currentTrack?.track.kind === 'caption' && currentTrack.index <= targetTrack.index) {
    return;
  }

  payload.trackId = targetTrack.track.id;
  notes.push({
    type: 'caption_track_defaulted',
    commandType,
    previousTrackId: currentTrackId,
    trackId: targetTrack.track.id,
    reason: 'Generated captions must target a caption track on the top/front visual layer.',
  });
}

function normalizePrimitiveMediaTrackTarget(
  commandType: string,
  payload: CodexJsonObject,
  state: ProjectStateDto | null,
  notes: CodexJsonObject[],
): void {
  if (!PRIMITIVE_MEDIA_INSERT_COMMAND_TYPES.has(commandType)) {
    return;
  }

  const sequenceId = getString(payload, 'sequenceId')?.trim() || null;
  const assetId = getString(payload, 'assetId')?.trim() || null;
  const sequence = findSequenceById(state, sequenceId);
  const asset = state?.assets.find((candidate) => candidate.id === assetId) ?? null;
  if (!sequence || !asset) {
    return;
  }

  const currentTrackId = getString(payload, 'trackId')?.trim() || null;
  const currentTrack = getTrackWithIndex(sequence, currentTrackId);
  const expectsAudioTrack = asset.kind === 'audio';
  const currentTrackMatches = expectsAudioTrack
    ? currentTrack?.track.kind === 'audio' && currentTrack.track.locked !== true
    : currentTrack?.track.kind === 'video' && isUsableTrack(currentTrack.track);

  if (currentTrackMatches) {
    return;
  }

  const fallbackTrack = expectsAudioTrack
    ? chooseAudioTrack(sequence)
    : chooseMainMediaVideoTrack(sequence);
  if (!fallbackTrack) {
    return;
  }

  payload.trackId = fallbackTrack.track.id;
  notes.push({
    type: expectsAudioTrack ? 'audio_track_defaulted' : 'main_video_track_defaulted',
    commandType,
    previousTrackId: currentTrackId,
    trackId: fallbackTrack.track.id,
    reason: expectsAudioTrack
      ? 'Audio assets must target an unlocked audio track.'
      : 'Raw media inserts must use a video track for preview compatibility; text and captions use separate top visual layers.',
  });
}

function commandNeedsProjectStateForTargeting(
  commandType: string,
  payload: CodexJsonObject,
): boolean {
  return (
    PRIMITIVE_MEDIA_INSERT_COMMAND_TYPES.has(commandType) ||
    TEXT_OVERLAY_COMMAND_TYPES.has(commandType) ||
    CAPTION_TRACK_COMMAND_TYPES.has(commandType) ||
    (CLIP_TARGET_COMMAND_TYPES.has(commandType) && Boolean(getString(payload, 'clipId')?.trim()))
  );
}

async function normalizeCommandPayloadForExternalMutation(
  commandType: string,
  payload: CodexJsonObject,
  tokenRecord: ContextTokenRecord,
): Promise<TimelineTargetNormalization> {
  const normalizedPayload: CodexJsonObject = { ...payload };
  const notes: CodexJsonObject[] = [];

  normalizeActiveSequenceTarget(commandType, normalizedPayload, tokenRecord, notes);
  normalizeCreateTrackLayering(commandType, normalizedPayload, notes);

  const state = commandNeedsProjectStateForTargeting(commandType, normalizedPayload)
    ? await readOptionalProjectState()
    : null;
  normalizePrimitiveMediaTrackTarget(commandType, normalizedPayload, state, notes);
  normalizeClipTargetLocation(commandType, normalizedPayload, state, notes);
  normalizeTextAndCaptionTrackTarget(commandType, normalizedPayload, state, notes);

  return { payload: normalizedPayload, notes };
}

function planRequiresProjectStateForTargeting(plan: AgentPlan): boolean {
  return plan.steps.some((step) => {
    const params = asObject(step.params);
    return params ? commandNeedsProjectStateForTargeting(step.toolName, params) : false;
  });
}

function normalizeAgentPlanForExternalMutation(
  plan: AgentPlan,
  tokenRecord: ContextTokenRecord,
  state: ProjectStateDto | null,
): { plan: AgentPlan; notes: CodexJsonObject[] } {
  const notes: CodexJsonObject[] = [];
  const steps = plan.steps.map((step) => {
    const params = asObject(step.params) ?? {};
    const normalizedParams: CodexJsonObject = { ...params };
    normalizeActiveSequenceTarget(step.toolName, normalizedParams, tokenRecord, notes);
    normalizeCreateTrackLayering(step.toolName, normalizedParams, notes);
    normalizePrimitiveMediaTrackTarget(step.toolName, normalizedParams, state, notes);
    normalizeClipTargetLocation(step.toolName, normalizedParams, state, notes);
    normalizeTextAndCaptionTrackTarget(step.toolName, normalizedParams, state, notes);

    return {
      ...step,
      params: normalizedParams as AgentPlan['steps'][number]['params'],
    };
  });

  return {
    plan: {
      ...plan,
      steps,
    },
    notes,
  };
}

function validateCreateSequencePlanBoundary(
  plan: AgentPlan,
): { valid: true } | { valid: false; message: string } {
  const createSequenceStep = plan.steps.find((step) => step.toolName === 'CreateSequence');
  if (!createSequenceStep) {
    return { valid: true };
  }

  const hasAdditionalTimelineMutation = plan.steps.some(
    (step) =>
      step.id !== createSequenceStep.id && ACTIVE_TIMELINE_SCOPED_COMMAND_TYPES.has(step.toolName),
  );
  if (!hasAdditionalTimelineMutation) {
    return { valid: true };
  }

  return {
    valid: false,
    message: `Plan step '${createSequenceStep.id}' creates a new sequence. Create the sequence first, read openreelio.timeline_snapshot again, then apply timeline edits to the newly active sequence with fresh track IDs.`,
  };
}

async function normalizeMediaInsertTarget(
  input: {
    sequenceId: string;
    trackId: string;
    assetId: string;
    audioOnly: boolean;
  },
  tokenRecord: ContextTokenRecord,
): Promise<MediaInsertTargetNormalization> {
  const notes: CodexJsonObject[] = [];
  let sequenceId = input.sequenceId;
  let trackId = input.trackId;
  let state: ProjectStateDto | null = null;

  if (tokenRecord.activeSequenceId && sequenceId !== tokenRecord.activeSequenceId) {
    notes.push({
      type: 'active_sequence_defaulted',
      commandType: 'MediaInsert',
      previousSequenceId: sequenceId,
      sequenceId: tokenRecord.activeSequenceId,
      reason: 'Implicit media placement targets the active OpenReelio timeline.',
    });
    sequenceId = tokenRecord.activeSequenceId;
    state = await readOptionalProjectState();
  }

  state = state ?? (await readOptionalProjectState());
  const sequence = findSequenceById(state, sequenceId);
  if (!sequence) {
    return { sequenceId, trackId, notes };
  }

  const assetKind = state?.assets.find((asset) => asset.id === input.assetId)?.kind ?? null;
  const expectsAudioTrack = input.audioOnly || assetKind === 'audio';
  const currentTrack = getTrackWithIndex(sequence, trackId);
  const currentTrackMatches = expectsAudioTrack
    ? currentTrack?.track.kind === 'audio' && currentTrack.track.locked !== true
    : currentTrack?.track.kind === 'video' && isUsableTrack(currentTrack.track);

  if (currentTrackMatches) {
    return { sequenceId, trackId, notes };
  }

  const fallbackTrack = expectsAudioTrack
    ? chooseAudioTrack(sequence)
    : chooseMainMediaVideoTrack(sequence);
  if (!fallbackTrack) {
    return { sequenceId, trackId, notes };
  }

  notes.push({
    type: expectsAudioTrack ? 'audio_track_defaulted' : 'main_video_track_defaulted',
    commandType: 'MediaInsert',
    previousTrackId: trackId,
    trackId: fallbackTrack.track.id,
    reason: expectsAudioTrack
      ? 'Audio media must target an unlocked audio track.'
      : 'Primary media placement targets the base visible video track; overlays/text use top visual tracks.',
  });
  trackId = fallbackTrack.track.id;

  return { sequenceId, trackId, notes };
}

function validateContextToken(
  context: OpenReelioCodexToolContext,
  token: string | null,
): { valid: true; record: ContextTokenRecord } | { valid: false; message: string } {
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
      message:
        'OpenReelio command_execute rejected a missing or stale contextToken. Read openreelio.project_state or openreelio.timeline_snapshot again and retry with the new contextToken.',
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
      message:
        'OpenReelio command_execute rejected an expired contextToken. Read openreelio.project_state or openreelio.timeline_snapshot again and retry with the new contextToken.',
    };
  }

  return { valid: true, record };
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
      CreateTrack: {
        required: ['sequenceId', 'kind', 'name'],
        optional: ['position'],
        note: 'Use kind video or overlay for editable text clips. Visual track order is front-to-back, so use position 0 for text, captions, B-roll overlays, and any visual layer that must appear above the base video. Audio tracks can be appended.',
      },
      SetCaptionTrackLanguage: {
        required: ['sequenceId', 'trackId', 'language'],
        note: 'Use this for caption tracks only. Language should be a BCP-47-ish code such as en, ko, ja, zh, es, or en-us.',
      },
      InsertClip: {
        required: ['sequenceId', 'trackId', 'assetId', 'timelineStart'],
        optional: ['sourceIn', 'sourceOut'],
        note: 'Raw InsertClip is a primitive command and does not auto-create linked audio. Use openreelio.media_insert for normal asset placement so video stays visible and linked audio stays in sync.',
      },
      ImportGeneratedCaptions: {
        required: ['sequenceId', 'trackId', 'segments'],
        optional: ['style', 'position', 'replaceExisting'],
        segmentShape: { startSec: 'number', endSec: 'number', text: 'string' },
        styleShape:
          'Caption style may include fontFamily, fontSize, fontWeight, bold, italic, underline, color, opacity, backgroundColor, backgroundPadding, outlineColor, outlineWidth, shadowColor, shadowOffsetX, shadowOffsetY, shadowBlur, alignment, lineHeight, and letterSpacing.',
        positionShape:
          'Caption position supports preset top/center/bottom or custom xPercent/yPercent.',
        note: 'Use this for AI/STT transcript segments so generated captions are imported atomically and remain undoable as one command.',
      },
      transcriptionGenerate: {
        tool: 'openreelio.transcription_generate',
        required: [],
        optional: [
          'sequenceAudio',
          'sequenceId',
          'assetId',
          'language',
          'model',
          'translate',
          'clipId',
          'trackId',
          'async',
        ],
        note: 'Use this read-only tool before ImportGeneratedCaptions when subtitles should come from source audio. Set sequenceAudio=true for the edited timeline mix, or pass clipId plus sequenceId/trackId to receive timelineCaptionSegments aligned to a timeline clip.',
      },
      AddTextClip: {
        required: ['sequenceId', 'trackId', 'timelineIn', 'duration', 'textData'],
        textDataShape:
          'TextClipData includes content, style(fontFamily/fontSize/fontWeight/color/backgroundColor/backgroundPadding/alignment/bold/italic/underline/lineHeight/letterSpacing), position(x/y 0..1), shadow(color/offsetX/offsetY/blur), outline(color/width), rotation, and opacity.',
        presetHints:
          'Production presets supported by UI/agent/CLI include title, centered-title, epic-title, chapter-title, lower-third, lower-third-news, lower-third-name-role, subtitle, callout, callout-stat, credits, credit-line, logo-bug, social-handle, quote, watermark, and countdown.',
        note: 'Text clips must be placed on a top/front video or overlay track above the base video. The Codex bridge will correct below-base text tracks when possible. Use SetClipTransform after creation when scale or anchor must be exact.',
      },
      UpdateTextClip: {
        required: ['sequenceId', 'trackId', 'clipId', 'textData'],
        note: 'Send the full updated TextClipData so style, position, shadow, outline, rotation, and opacity remain deterministic.',
      },
      SetClipTransform: {
        required: ['sequenceId', 'trackId', 'clipId', 'transform'],
        transformShape:
          'transform includes position{x,y}, scale{x,y}, rotationDeg, and anchor{x,y}; text clips use this for preview drag/resize/rotate parity.',
      },
      SetClipMotionKeyframes: {
        required: ['sequenceId', 'trackId', 'clipId', 'keyframes'],
        keyframeShape:
          'keyframes is an array of {timeOffset, transform, interpolation}; transform uses position{x,y}, scale{x,y}, rotationDeg, anchor{x,y}; interpolation is "linear", "hold", or bezier control points.',
        note: 'Use this for editable clip motion such as zoom in, zoom out, and Ken Burns presets. Times are seconds relative to the clip start.',
      },
      SetClipSpeed: {
        required: ['sequenceId', 'trackId', 'clipId', 'speed'],
        speedShape:
          'speed is a positive multiplier where 1 is 100%, 0.5 is 50% slow motion, and 2 is 200%; optional reverse preserves or sets reverse playback.',
        note: 'Use this for constant-speed edits. Rate-stretch UI also resolves to this command after deriving speed from the source duration and stretched timeline duration.',
      },
      SetClipSlowMotionInterpolation: {
        required: ['sequenceId', 'trackId', 'clipId', 'interpolation'],
        interpolationValues: ['nearest', 'frameBlend', 'motionCompensated'],
        note: 'Use this to choose slow-motion quality for clips or speed ramps below real time. nearest preserves legacy frame duplication, frameBlend blends frames, and motionCompensated uses motion interpolation during export.',
      },
      ReverseClip: {
        required: ['sequenceId', 'trackId', 'clipId'],
        note: 'Toggles reverse playback for the clip while preserving constant speed.',
      },
      CreateFreezeFrame: {
        required: ['sequenceId', 'trackId', 'clipId', 'playheadSec'],
        optional: ['durationSec'],
        note: 'Creates a freeze-frame segment from the clip at the requested timeline playhead time.',
      },
      SetTimeRemap: {
        required: ['sequenceId', 'trackId', 'clipId', 'timeRemap'],
        timeRemapShape:
          'timeRemap.keyframes is an ordered array of {timelineTime, sourceTime, interpolation}; timelineTime is seconds relative to clip start and sourceTime is absolute source media seconds.',
        note: 'Use this for speed ramps and editable variable-speed curves. The last timelineTime becomes the clip timeline duration.',
      },
      ClearTimeRemap: {
        required: ['sequenceId', 'trackId', 'clipId'],
        note: 'Removes a variable-speed curve and returns the clip to constant-speed playback.',
      },
    },
    payloadFormat: {
      commandType: 'PascalCase OpenReelio backend command type',
      payload: 'CamelCase JSON object matching the selected command type',
      contextToken:
        'Fresh mutation contextToken returned by project_state, timeline_snapshot, assets_list, or selection_read',
      mutationTool:
        'Use openreelio.media_insert for asset placement; use openreelio.command_execute for primitive single-command edits.',
      mediaMutationTool: 'openreelio.media_insert',
      commandMutationTool: 'openreelio.command_execute',
    },
    rules: [
      'Read project_state or timeline_snapshot before using IDs and before every mutation.',
      'Pass the returned contextToken to media_insert, plan_apply, or command_execute.',
      'When the user says the timeline/current edit/this part without naming another sequence, use the activeSequenceId from the latest timeline_snapshot or selection_read.',
      'Visual tracks are ordered front-to-back: tracks[0] is top/front. Create visual overlay/text/caption tracks at position 0 so they render above the base video.',
      'Use media_insert instead of raw InsertClip when placing video, image, or audio assets on the timeline.',
      'Never edit .openreelio state files directly.',
      'command_execute prompts the user for approval and persists through the OpenReelio command log.',
      'Workspace filesystem commands are intentionally not exposed through command_execute.',
    ],
    mediaWorkflows: {
      timelinePlacement: [
        'Read timeline_snapshot and assets_list to copy exact sequence, track, and asset IDs.',
        'Use activeSequenceId as the target sequence unless the user explicitly switches to another sequence.',
        'Choose the base visible video track for primary video/image assets, a top/front overlay track for visual overlays, and an audio track for audio assets.',
        'Call openreelio.media_insert with timelineStart and optional sourceIn/sourceOut.',
        'Do not put a video asset on an audio track unless audioOnly=true is intentional; that creates an audio-only clip and will not show in preview.',
        'For video assets, let autoExtractLinkedAudio default to true so the matching audio clip is created, linked, and the source video clip is muted.',
      ],
      highlightSfxPlacement: [
        'Read timeline_snapshot to identify candidate highlight clips, then call clip_analyze or clip_describe on the specific clip before selecting precise SFX timings.',
        'Use dense clip_analyze with a small targetIntervalSec for short highlight clips so frame samples are indexed inside the clip instead of inferred from the whole timeline.',
        'Use clip_describe when visual semantics matter, then place imported SFX on dedicated audio tracks with media_insert and sourceIn/sourceOut trims.',
        'Do not spread one SFX across every cut when the user asks for the highlight clip itself; constrain placements to the selected clip-local timeline range.',
      ],
    },
    analysisWorkflows: {
      clipPrecision: [
        'Use clip_analyze(sequenceId, trackId, clipId, mode="dense") for indexed clip-local frame samples, timeline/source mapping, extraction status, and sample image paths.',
        'Use clip_describe after clip_analyze when an edit depends on visual content, object presence, faces, text, motion beats, or highlight evidence.',
        'Use semantic_edit_plan with the perceptionFingerprint from clip_describe to derive target ranges, confidence, command drafts, and optional spatial AddMask drafts.',
      ],
      semanticVisualEdits: [
        'For blur/highlight/remove/marker/addText requests, first gather clip-local evidence with clip_describe.',
        'Call semantic_edit_plan with a concrete query such as logo, face, text, product, chart, or screen.',
        'Validate and apply returned commandDrafts through plan_validate and plan_apply, resolving IDs from earlier split/effect steps when a draft references an isolated clip or effect.',
      ],
    },
    textWorkflows: {
      editableOverlay: [
        'Read timeline_snapshot to find active sequence, existing text clips, and usable video/overlay tracks.',
        'Read annotation_read for overlapping source assets when placement should avoid faces, objects, or OCR text.',
        'CreateTrack(kind="video" or "overlay", position=0) when there is no unlocked non-overlapping text track above the media.',
        'AddTextClip with complete TextClipData for content, typography, color, background, shadow, outline, position, rotation, and opacity.',
        'Use production text presets for common work: credits for end cards, logo-bug for channel marks, social-handle for creator IDs, lower-third-name-role for interviews, and callout-stat for numeric emphasis.',
        'SetClipTransform for exact preview drag/resize/rotate parity using normalized position, scale, rotationDeg, and anchor.',
        'SetClipMotionKeyframes for editable text or media motion presets such as zoom in, zoom out, and Ken Burns.',
      ],
      speedAndTime: [
        'Use SetClipSpeed for constant 25%, 50%, 100%, 200%, or 400% speed changes.',
        'Use SetClipSlowMotionInterpolation to choose nearest, frameBlend, or motionCompensated quality for slow-motion clips.',
        'Use ReverseClip to toggle reverse, and CreateFreezeFrame for playhead-based freeze-frame segments.',
        'Use SetTimeRemap for speed ramps with timeline/source keyframes, then ClearTimeRemap when returning to constant speed.',
      ],
      timedSubtitles: [
        'Call openreelio.transcription_status first and explain missing model installation before attempting automatic subtitles.',
        'If no model is installed and the user approves a download, call openreelio.transcription_install_model before transcription_generate.',
        'After transcription_install_model returns, refresh project_state or timeline_snapshot before any mutation because older contextTokens are intentionally invalidated.',
        'Call openreelio.transcription_generate(assetId, language="auto", model="auto") for speech-to-text segments before creating generated subtitles.',
        'For edited timeline audio, call openreelio.transcription_generate(sequenceAudio=true, sequenceId, language="auto", model="auto"); returned captionSegments are already timeline-relative.',
        'When captioning an edited timeline clip, pass clipId with sequenceId and trackId, then use timelineCaptionSegments for ImportGeneratedCaptions.',
        'Use ImportGeneratedCaptions for AI transcript segments or CreateCaption/UpdateCaption for individual caption lines.',
        'Use caption style/position metadata for subtitle readability instead of editable overlay text when the user wants semantic subtitles.',
      ],
      placementDefaults: {
        subtitle:
          'Bottom center around y=0.85 with outline/shadow unless it covers important visual content.',
        title: 'Center or upper third depending on the shot composition.',
        lowerThird: 'Lower-left or lower-center with enough safe margin and readable contrast.',
        creditBrand:
          'Credits, credit lines, logo bugs, social handles, quote, and watermark presets preserve their template position unless the user asks for automatic placement.',
      },
    },
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

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getString(input: CodexJsonObject | null | undefined, key: string): string | null {
  const value = input?.[key];
  return typeof value === 'string' ? value : null;
}

function getRequiredStringArg(input: CodexJsonObject, key: string, toolName: string): string {
  const value = getString(input, key)?.trim();
  if (!value) {
    throw new Error(`OpenReelio ${toolName} requires ${key}.`);
  }
  return value;
}

function getFiniteNonNegativeNumberArg(
  input: CodexJsonObject,
  key: string,
  toolName: string,
  required = false,
): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`OpenReelio ${toolName} requires ${key}.`);
    }
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`OpenReelio ${toolName} requires ${key} to be a finite non-negative number.`);
  }

  return value;
}

function getFiniteNumberArg(
  input: CodexJsonObject,
  key: string,
  toolName: string,
  required = false,
): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`OpenReelio ${toolName} requires ${key}.`);
    }
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`OpenReelio ${toolName} requires ${key} to be a finite number.`);
  }

  return value;
}

function getFirstProperty(input: CodexJsonObject, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      return input[key];
    }
  }

  return undefined;
}
