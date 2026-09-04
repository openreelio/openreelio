import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import {
  commands,
  type AgentPlan,
  type AgentPlanResult,
  type ClipAnalysisOptions,
  type ClipAnalysisResponse,
  type ClipPerceptionOptions,
  type ClipPerceptionResponse,
  type InspectionSummary,
  type PlanRiskLevel,
  type ProjectInfo,
  type ProjectStateDto,
  type RenderLifecycleEvent,
  type SemanticTemporalEditAction,
  type SemanticTemporalEditPlan,
  type SemanticTemporalEditPlanOptions,
  type StockMediaImportResult,
  type StockMediaSearchResult,
  type TimelineFrameProbeRequestDto,
  type TimeRange,
  type TranscriptionOptionsDto,
  type TranscriptionResultDto,
  type TranscriptionStatusDto,
  type VerifySequenceRequestDto,
} from '@/bindings';
import type { RenderCompleteEvent } from '@/components/features/export/types';

import { hasActiveTimeRemap, type TimeRemapCurve } from '@/types';
import { TEXT_PRESETS } from '@/data/textPresets';
import type { ExternalAgentApprovalDecisionProvider, ExternalAgentApprovalRequest } from '../types';
import { isCodexDynamicToolCallOutputTextItem } from './CodexAppServerClient';
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
  runtimeId: 'codex' | 'claude_code';
  sessionId: string;
  sessionKnown?: boolean;
  approvalDecisionProvider?: ExternalAgentApprovalDecisionProvider;
  /**
   * Host-assigned id of the single tool call being served, when the host has
   * one. It is what lets a cancelled call reach the work it started — a draft
   * render keeps encoding otherwise.
   */
  callId?: string;
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
  'SetSequenceFormat',
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

/**
 * Commands whose `sequenceId` is rewritten to the active timeline, and which a
 * plan may therefore not mix with a `CreateSequence` step.
 *
 * `SetSequenceFormat` is deliberately absent: it is the one command that
 * legitimately targets a sequence other than the active one — setting the
 * format of the sequence a plan just created — and its backend payload already
 * resolves the active sequence itself when `sequenceId` is omitted. Listing it
 * here made `[CreateSequence, SetSequenceFormat]` a refused plan and overwrote
 * an explicit `sequenceId` with the active one.
 */
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
  /**
   * Whether the clip has an active time remap (variable-speed) curve. When
   * true, source times cannot be mapped to the timeline with a constant-speed
   * formula, so caption mapping must be skipped in favor of sequence
   * transcription.
   */
  hasActiveTimeRemap: boolean;
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
        'Project asset ID whose audio should be transcribed when sequenceAudio is false. Source-asset transcription returns SOURCE-relative times (0-based to the asset) that are NOT safe as direct timeline caption times; pass clipId (with sequenceId/trackId) so the returned timelineCaptionSegments are mapped to timeline time before ImportGeneratedCaptions.',
    },
    sequenceAudio: {
      type: 'boolean',
      description:
        'Set true to transcribe the audible audio mix of an edited sequence instead of one source asset. Sequence audio returns TIMELINE-relative segment times that pass straight to ImportGeneratedCaptions; this is the default path for captioning.',
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
        'Optional timeline clip ID. Provide with assetId when source-relative segments must be mapped onto a placed clip: returned timelineCaptionSegments are clamped to the clip source range and remapped from source time to timeline time. Omit it for sequenceAudio, whose segments are already timeline-relative.',
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

const FRAME_EXTRACT_SCHEMA: CodexJsonObject = {
  type: 'object',
  properties: {
    time: {
      type: 'number',
      description: 'Timeline time in seconds for a single still.',
    },
    times: {
      type: 'array',
      items: { type: 'number' },
      description:
        'Timeline times in seconds: one still each, or the cells of a contact sheet when grid is set.',
    },
    grid: {
      type: 'string',
      description:
        "Contact sheet layout as COLSxROWS, or 'auto' to size it from the samples. A sheet is ONE image, so it is the cheap way to look at many moments. 'auto' needs a sampler or times to size itself; with between, pass an explicit COLSxROWS.",
    },
    between: {
      type: 'array',
      items: { type: 'number' },
      description:
        '[start, end] seconds a grid samples uniformly. Requires grid, and with between the grid must be an explicit COLSxROWS. Uniform sampling lands on no edit event, so prefer an event sampler when one fits.',
    },
    cellWidth: {
      type: 'integer',
      minimum: 64,
      maximum: 1024,
      description:
        'Contact sheet cell width in pixels; raise it when reading burned-in text. Requires grid.',
    },
    cellHeight: {
      type: 'integer',
      minimum: 64,
      maximum: 1024,
      description: 'Contact sheet cell height in pixels. Requires grid.',
    },
    labelCells: {
      type: 'boolean',
      description:
        "Burn each cell's index and timecode into the contact sheet. Requires grid. On a fileRange sheet the burnt-in timecode is the timeline second the cell shows, not the file offset; the file offset is still reported as cells[].fileSec.",
    },
    mode: {
      type: 'string',
      enum: ['composite', 'fast'],
      description:
        "'composite' (default) renders the whole stack — captions, text, transforms, blends — exactly as export does; 'fast' is the cheap topmost-clip-only look that shows none of the edit.",
    },
    maxWidth: {
      type: 'integer',
      minimum: 1,
      maximum: 3840,
      description: 'Maximum output width in pixels. Aspect ratio is preserved and never upscaled.',
    },
    file: {
      type: 'string',
      description:
        'Rendered video inside the project directory to read instead of the timeline, such as the outputPath returned by render_proxy. Times are relative to the file and cells map back as fileSec. Pass fileRange alongside it to use the samplers on the render.',
    },
    fileRange: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: { type: 'number', minimum: 0 },
      description:
        'The timeline range [start, end] the file covers — the start and end render_proxy reported. With a sampler this is what makes samplers work on a render: they read the timeline over this range and every time is translated into the file, so each frame and cell carries fileSec, timelineSec and its reason, and any sample the file does not hold is dropped and counted as sampler.droppedOutsideFile. Without a sampler it is only recorded as source.timelineRange; time, times and between stay file-relative either way. Only with file.',
    },
    atCuts: {
      type: 'boolean',
      description: 'Sample both sides of every cut.',
    },
    atTransitions: {
      type: 'boolean',
      description: 'Sample the start, cut and end of every two-input transition.',
    },
    atCaptions: {
      type: 'boolean',
      description: 'Sample the middle of every caption and text span.',
    },
    atMarkers: {
      type: 'boolean',
      description: 'Sample every sequence marker.',
    },
    perShot: {
      type: 'boolean',
      description: 'Sample the middle of every shot the export draws — the coverage sweep.',
    },
    around: {
      type: 'number',
      minimum: 0,
      description: 'Sample a window centred on this timeline time, in seconds.',
    },
    span: {
      type: 'number',
      exclusiveMinimum: 0,
      description: 'Half-width of the around window in seconds.',
    },
    aroundCount: {
      type: 'integer',
      minimum: 1,
      description: 'Number of samples the around window produces.',
    },
    ranges: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['startSec', 'endSec'],
        properties: {
          startSec: {
            type: 'number',
            minimum: 0,
            description: 'Range start in timeline seconds.',
          },
          endSec: {
            type: 'number',
            minimum: 0,
            description: 'Range end in timeline seconds.',
          },
        },
        additionalProperties: false,
      },
      description:
        "The preferred way to look at what you changed: the affectedRanges a plan_apply or command_execute result returned, handed straight back. The sampler looks at each range's start, its cuts, its middle and its end. Cannot be combined with affected, time, times, between, file, or another sampler.",
    },
    affected: {
      type: 'boolean',
      description:
        "Sample exactly the timeline ranges the last applied edit changed, read from the hand-off that edit recorded. Prefer ranges when the apply result handed you affectedRanges. Errors when no edit recorded a hand-off; fall back to atCuts: true, grid: 'auto', or around: <edited time>, span: 1, grid: 'auto'.",
    },
    afterOp: {
      type: 'string',
      description:
        'With affected: true, refuse a hand-off that does not end at this op id, so an edit the user made after yours cannot be read as your own. Pass the last operationId the apply result returned.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      description:
        'Largest number of sampler times to keep. At most 12 separate stills come back inline, so pass grid for anything wider.',
    },
  },
  additionalProperties: false,
};

/**
 * Longest range the bridge will draft-render in one call, in seconds.
 *
 * A range render is uncancellable from the agent's side once it is running and
 * blocks the tool call until it finishes, so an unbounded request is an
 * unbounded stall. Five minutes of timeline is far more than any "does this
 * motion read?" question needs.
 *
 * The same bound is enforced in Rust as
 * `core::render::cache::MAX_AGENT_RENDER_RANGE_SEC`, which is the authority: it
 * applies to every surface that renders into the agent render directory,
 * including this one. This copy exists so the refusal is an argument error the
 * agent reads before a render is started, and the two must be changed together.
 */
const RENDER_PROXY_MAX_RANGE_SEC = 300;

const RENDER_PROXY_SCHEMA: CodexJsonObject = {
  type: 'object',
  required: ['start', 'end'],
  properties: {
    start: {
      type: 'number',
      minimum: 0,
      description: 'Range start in timeline seconds. Must be non-negative and below end.',
    },
    end: {
      type: 'number',
      minimum: 0,
      description: `Range end in timeline seconds. The range must be at most ${RENDER_PROXY_MAX_RANGE_SEC}s long; render a narrower window and look at that.`,
    },
    preset: {
      type: 'string',
      enum: ['proxy_480p', 'mp4_draft'],
      description:
        'Render preset id, MP4 either way. Defaults to proxy_480p: a CRF 30 ultrafast draft fitted to the sequence canvas (short edge at most 480) at the sequence frame rate, so vertical stays vertical. mp4_draft is a fixed 1280x720 at 30 fps draft; pass it only when the exact 720p30 frame matters.',
    },
  },
  additionalProperties: false,
};

const VERIFY_SCHEMA: CodexJsonObject = {
  type: 'object',
  properties: {
    file: {
      type: 'string',
      description:
        'Rendered video inside the project to measure, such as the outputPath render_proxy returned. Without it only the structural checks run and FFmpeg is never invoked. Measured times are file-relative and are compared against timeline times, so this should be a render of the whole sequence from timeline zero.',
    },
    structuralOnly: {
      type: 'boolean',
      description: 'Run the structural checks only and never touch FFmpeg.',
    },
    checks: {
      type: 'array',
      items: { type: 'string' },
      description: 'Run only these check ids, as report.checks names them.',
    },
    skip: {
      type: 'array',
      items: { type: 'string' },
      description: 'Skip these check ids.',
    },
    targetLufs: {
      type: 'number',
      description: 'Integrated loudness target in LUFS. Needs file.',
    },
    maxTruePeak: {
      type: 'number',
      description: 'Highest acceptable true peak in dBTP. Needs file.',
    },
    durationToleranceSec: {
      type: 'number',
      description: 'Divergence tolerated between the rendered file and the sequence, in seconds.',
    },
    failOn: {
      type: 'string',
      description:
        "Lowest severity that fails the run: 'info', 'warning', 'error' (the default) or 'critical'.",
    },
    timeoutSec: {
      type: 'integer',
      minimum: 1,
      description: 'Timeout for the rendered-file measurement pass, in seconds.',
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
      "Read a concise snapshot of the active OpenReelio timeline, tracks, clips, markers, and current sequence, plus each sequence's where-to-look signals: durationSec, outputDurationSec, fps, canvas, cuts, editPoints, transitions, captionSpans, textSpans, and inspectionHints.",
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
      'Generate speech-to-text transcript segments. With sequenceAudio=true, returns TIMELINE-relative segments that pass straight to ImportGeneratedCaptions (default captioning path). With assetId, returns SOURCE-relative segments that are not safe as direct timeline caption times; pass clipId (with sequenceId/trackId) to also get timelineCaptionSegments remapped onto the placed clip.',
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
      'Read preview/playback state and which media inspection paths the OpenReelio bridge exposes.',
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'frame_extract',
    description:
      'Look at the edit. Returns pictures of the composited timeline — captions, text, transforms and blends, exactly what export produces — as stills or one labelled contact sheet, plus the JSON that maps every cell back to its timecode and the reason it was sampled. Do not compute the times yourself: pass the affectedRanges an apply returned as ranges, or use affected, atCuts, atTransitions, atCaptions, atMarkers, perShot, or around. At most 12 separate stills come back inline; a contact sheet is one image.',
    inputSchema: FRAME_EXTRACT_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'render_proxy',
    description:
      'Render a fast draft of one timeline range into the project cache and wait for it to finish. Use it only for motion and pacing questions a still cannot answer, then inspect the returned outputPath with openreelio.frame_extract. Full-quality renders are for delivery, not for checking work.',
    inputSchema: RENDER_PROXY_SCHEMA,
  },
  {
    namespace: 'openreelio',
    name: 'verify',
    description:
      'Judge the edit by the deterministic QC rules every OpenReelio surface applies — the same report `openreelio-cli verify` prints. Structural checks always run; the rendered measurements (black, freeze, silence, EBU R128 loudness, true peak) need a file inside the project, such as the outputPath render_proxy returned. exitCode 0 means the report passed, 1 that the failOn threshold was breached and there is something to fix, 2 that the tool could not run and the verdict is incomplete. Every violation carries the timeRange to look at with frame_extract, and an auto-fixable one carries a suggestedFix EditScript ready for plan_apply.',
    inputSchema: VERIFY_SCHEMA,
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
    'Look at the edit before you report on it:',
    "- After every openreelio.plan_apply or openreelio.command_execute, look at the picture before you say what changed: hand the affectedRanges the result returned straight to openreelio.frame_extract as ranges: <affectedRanges>, grid: 'auto', labelCells: true.",
    "- When a result carried no affectedRanges, ask the probe to read the hand-off itself with affected: true, grid: 'auto', labelCells: true, pinned to your own edit with afterOp: <the result's last operationId>. If affected reports no recorded hand-off, sample the seconds you edited instead: atCuts: true, grid: 'auto', or around: <edited time>, span: 1, grid: 'auto'.",
    "- For caption or text edits, inspect with atCaptions: true, grid: 'auto', cellWidth: 640 so the burned-in words are legible.",
    "- Before finishing a task, sweep the whole cut once with perShot: true, grid: 'auto', limit: 24.",
    "- Do not compute inspection times yourself. frame_extract samples the edit's own events (ranges, affected, atCuts, atTransitions, atCaptions, atMarkers, perShot, around); uniform between sampling lands on no event and is for whole-timeline overviews only.",
    "- cellWidth, cellHeight, labelCells and between only apply to a contact sheet and are rejected without grid. grid: 'auto' sizes itself from a sampler or times, so between always needs an explicit grid such as '4x3'.",
    '- frame_extract shows the composited edit by default. Only pass mode: "fast" when you deliberately want the raw footage without captions, text or effects.',
    `- Use openreelio.render_proxy only for motion or pacing questions a still cannot answer, and keep the range under ${RENDER_PROXY_MAX_RANGE_SEC}s (the same cap the backend enforces). Then inspect its outputPath with openreelio.frame_extract { file: outputPath, between: [0, durationSec], grid: '4x3', labelCells: true }, which sweeps the whole draft and always has something to show. When the rendered range contains cuts, captions or transitions, judge those instead: add fileRange: [start, start + durationSec] — the start you asked for and the duration the render reported — with a sampler such as atCuts, atCaptions, atTransitions or perShot and grid: 'auto'. fileRange is what lets the samplers read a rendered file, and every cell then carries both fileSec and timelineSec; a sampler over a range holding no such event errors rather than returning an empty sheet.`,
    '- Never claim a cut, caption, overlay, or transition looks right without having extracted a frame that shows it.',
    '- Before you report a task done, run openreelio.verify with no arguments for the structural checks, and after an openreelio.render_proxy run openreelio.verify { file: outputPath } so the black, freeze, silence, loudness and true-peak measurements run too.',
    "- Read the verify exitCode: 0 passed, 1 means a check failed and there is something to fix before reporting done, 2 means verify itself could not run — report that as a tool problem, never as a clean edit. Look at a violation's timeRange with openreelio.frame_extract { ranges: <the violation timeRanges>, grid: 'auto', labelCells: true }, and apply a suggestedFix through openreelio.plan_apply only after reviewing it.",
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
        return toolResponse(await buildTimelineSnapshot(await readProjectState(), context));
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
        return toolResponse(await buildPreviewDescription(context));
      case 'frame_extract': {
        const result = await extractFramesToolCall(toolCall.arguments);
        return toolResponseWithImages(result.value, result.images, result.value.status === 'ok');
      }
      case 'render_proxy': {
        const result = await renderProxyToolCall(toolCall.arguments, context);
        return toolResponse(result, result.status === 'ok');
      }
      case 'verify': {
        const result = await verifyToolCall(toolCall.arguments, context);
        return toolResponse(result, result.status === 'ok');
      }
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

/**
 * One picture a tool produced, in the raw form MCP carries it: base64 bytes
 * with no `data:` URI prefix, plus their media type.
 */
export interface OpenReelioToolCallImage {
  data: string;
  mimeType: string;
}

/**
 * Result of invoking an OpenReelio dynamic tool via {@link executeOpenReelioAgentToolCall}.
 *
 * `text` is a JSON-encoded payload suitable for an MCP `tools/call` text result;
 * `isError` mirrors the tool's failure state. `images` carries any pictures the
 * tool produced as separate content blocks — they must never be folded into
 * `text`, because a base64 blob in a text field is unreadable to the model and
 * costs a fortune in tokens.
 */
export interface OpenReelioAgentToolCallResult {
  text: string;
  isError: boolean;
  images?: OpenReelioToolCallImage[];
}

/**
 * Input for {@link executeOpenReelioAgentToolCall}.
 */
export interface ExecuteOpenReelioAgentToolCallInput {
  /** Bare OpenReelio tool name (e.g. `project_state`). */
  toolName: string;
  /** Raw tool arguments as received from the agent runtime. */
  args: unknown;
  /** Session context identifying the project, cwd, and approval provider. */
  context: OpenReelioCodexToolContext;
}

// Monotonic request id for synthesized dynamic-tool-call requests. The value is
// only used to correlate a single call within the shared Codex handler, so a
// process-local counter is sufficient.
let openReelioAgentToolCallRequestId = 0;

/**
 * Runtime-agnostic entry point that reuses the Codex dynamic-tool handler for
 * any external-agent backend (Codex, Claude Code, ...).
 *
 * It synthesizes an `item/tool/call` request from a bare tool name plus
 * arguments, dispatches it through {@link handleOpenReelioCodexDynamicToolCall},
 * and flattens the structured response into `{ text, isError }`.
 */
export async function executeOpenReelioAgentToolCall(
  input: ExecuteOpenReelioAgentToolCallInput,
): Promise<OpenReelioAgentToolCallResult> {
  const args = asObject(input.args) ?? {};
  const request: CodexAppServerRequest = {
    id: (openReelioAgentToolCallRequestId += 1),
    method: 'item/tool/call',
    params: {
      tool: input.toolName,
      arguments: args,
    },
  };

  const response = await handleOpenReelioCodexDynamicToolCall(request, input.context);
  if (!response) {
    return {
      text: JSON.stringify({ status: 'error', message: 'unknown tool' }),
      isError: true,
    };
  }

  const images = collectToolCallResponseImages(response);

  return {
    text: flattenToolCallResponseText(response),
    isError: !response.success,
    ...(images.length > 0 ? { images } : {}),
  };
}

/**
 * Collapse a dynamic-tool response's TEXT content items into a single payload.
 *
 * Image items are skipped outright rather than JSON-stringified: they are
 * carried separately by {@link collectToolCallResponseImages}, and serialising a
 * `data:` URL here would inline a base64 blob into the model's text context.
 */
function flattenToolCallResponseText(response: CodexDynamicToolCallResponse): string {
  return response.contentItems
    .filter(isCodexDynamicToolCallOutputTextItem)
    .map((item) => item.text)
    .join('\n');
}

/**
 * Recover the raw base64 blocks behind a response's `inputImage` data URLs, so
 * an MCP host that speaks `{ type: "image", data, mimeType }` can carry them.
 * An item whose URL is not a base64 data URL is dropped: there is nothing to
 * hand an MCP client, and its paths are already named in the text payload.
 */
function collectToolCallResponseImages(
  response: CodexDynamicToolCallResponse,
): OpenReelioToolCallImage[] {
  const images: OpenReelioToolCallImage[] = [];
  for (const item of response.contentItems) {
    if (isCodexDynamicToolCallOutputTextItem(item)) {
      continue;
    }
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(item.imageUrl);
    if (!match) {
      continue;
    }
    images.push({ mimeType: match[1], data: match[2] });
  }
  return images;
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

/**
 * Name a bridge tool the way the host making the call names it.
 *
 * Codex calls the dotted dynamic-tool id; Claude only ever sees the loopback
 * MCP server's prefixed name. A pointer written in the other host's spelling
 * names a tool the agent cannot call, so every id the bridge hands back is
 * spelled for its own caller.
 */
function toolIdFor(runtimeId: OpenReelioCodexToolContext['runtimeId'], name: string): string {
  return runtimeId === 'claude_code' ? `mcp__openreelio__${name}` : `openreelio.${name}`;
}

async function buildPreviewDescription(
  context: OpenReelioCodexToolContext,
): Promise<CodexJsonObject> {
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
      frameExtraction: toolIdFor(context.runtimeId, 'frame_extract'),
      rangeRender: toolIdFor(context.runtimeId, 'render_proxy'),
      transcriptAccess: transcriptionAvailable,
      waveformAccess: false,
      message: `Use ${toolIdFor(context.runtimeId, 'frame_extract')} to actually see the composited edit as stills or a contact sheet, ${toolIdFor(context.runtimeId, 'render_proxy')} for a draft of a range when motion matters, ${toolIdFor(context.runtimeId, 'clip_analyze')} for indexed frame samples, ${toolIdFor(context.runtimeId, 'clip_describe')} for semantic clip-local frame evidence, and ${toolIdFor(context.runtimeId, 'transcription_generate')} for speech-to-text subtitle timing. Waveform inspection is not exposed through this bridge yet.`,
    },
  };
}

/** Outcome of a `frame_extract` call: the JSON to show, and the pictures to attach. */
interface FrameExtractToolCallResult {
  value: CodexJsonObject & { status: string };
  images: OpenReelioToolCallImage[];
}

/**
 * Timeline frame probe: the bridge's eyes on the composited edit.
 *
 * Always asks for the bytes inline — the whole point is that the model sees the
 * frame, not a path it cannot open — and returns the probe's own report
 * verbatim so the timecodes and sampler reasons match the CLI's.
 */
async function extractFramesToolCall(
  args: CodexJsonObject | null,
): Promise<FrameExtractToolCallResult> {
  const request = buildFrameProbeRequest(args ?? {});

  const result = await commands.extractTimelineFrames(request);
  if (result.status === 'error') {
    return {
      value: { status: 'error', message: result.error },
      images: [],
    };
  }

  const images: OpenReelioToolCallImage[] = [];
  const references: CodexJsonObject[] = [];
  for (const image of result.data.images) {
    references.push({ path: image.path, mimeType: image.mimeType });
    if (image.data) {
      images.push({ data: image.data, mimeType: image.mimeType });
    }
  }

  return {
    value: {
      status: 'ok',
      imageCount: images.length,
      images: references,
      payload: stripInlineImageBytes(result.data.payload),
    },
    images,
  };
}

/** Translate tool arguments into the frame-probe request DTO. */
function buildFrameProbeRequest(args: CodexJsonObject): TimelineFrameProbeRequestDto {
  const between = readNumberArrayArg(args, 'between', 'frame_extract');
  if (between && between.length !== 2) {
    throw new Error('OpenReelio frame_extract requires between to be [start, end].');
  }
  const fileRange = readNumberArrayArg(args, 'fileRange', 'frame_extract');
  const file = getString(args, 'file')?.trim() || null;
  if (fileRange && fileRange.length !== 2) {
    throw new Error('OpenReelio frame_extract requires fileRange to be [start, end].');
  }
  // The probe enforces both of these too, and its refusals are the authority.
  // They are restated here so a malformed hand-back is an argument error the
  // model reads in the same turn, before an IPC round trip and before a cache
  // directory has been reserved for a request that cannot run.
  if (fileRange && !file) {
    throw new Error(
      'OpenReelio frame_extract fileRange declares which timeline seconds a rendered file covers, so it only means something with file.',
    );
  }
  if (fileRange && fileRange[0] >= fileRange[1]) {
    throw new Error(
      `OpenReelio frame_extract requires fileRange start (${fileRange[0]}) to be before its end (${fileRange[1]}).`,
    );
  }

  return {
    time: getFiniteNumberArg(args, 'time', 'frame_extract') ?? null,
    times: readNumberArrayArg(args, 'times', 'frame_extract'),
    grid: getString(args, 'grid')?.trim() || null,
    between,
    cellWidth: getFiniteNonNegativeNumberArg(args, 'cellWidth', 'frame_extract') ?? null,
    cellHeight: getFiniteNonNegativeNumberArg(args, 'cellHeight', 'frame_extract') ?? null,
    labelCells: args.labelCells === true,
    mode: getString(args, 'mode')?.trim() || null,
    maxWidth: getFiniteNonNegativeNumberArg(args, 'maxWidth', 'frame_extract') ?? null,
    file,
    fileRange,
    atCuts: args.atCuts === true,
    atTransitions: args.atTransitions === true,
    atCaptions: args.atCaptions === true,
    atMarkers: args.atMarkers === true,
    perShot: args.perShot === true,
    around: getFiniteNumberArg(args, 'around', 'frame_extract') ?? null,
    span: getFiniteNonNegativeNumberArg(args, 'span', 'frame_extract') ?? null,
    aroundCount: getFiniteNonNegativeNumberArg(args, 'aroundCount', 'frame_extract') ?? null,
    ranges: readFrameProbeRanges(args, 'frame_extract'),
    affected: args.affected === true,
    afterOp: getString(args, 'afterOp')?.trim() || null,
    limit: getFiniteNonNegativeNumberArg(args, 'limit', 'frame_extract') ?? null,
    // The bridge exists to put the picture in front of the model; a path alone
    // is unreadable to it.
    inline: true,
  };
}

/**
 * Read the `ranges` sampler argument: the `affectedRanges` an apply handed back,
 * passed through to the probe unchanged.
 *
 * Shape is checked here rather than left to the probe so a malformed hand-back
 * fails with the field name in the message instead of an IPC-level rejection.
 */
function readFrameProbeRanges(args: CodexJsonObject, toolName: string): TimeRange[] | null {
  const value = args.ranges;
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `OpenReelio ${toolName} requires ranges to be a non-empty array of { startSec, endSec }.`,
    );
  }

  return value.map((entry) => {
    const range = asObject(entry);
    const startSec = range ? asFiniteNumber(range.startSec) : null;
    const endSec = range ? asFiniteNumber(range.endSec) : null;
    if (startSec === null || endSec === null) {
      throw new Error(
        `OpenReelio ${toolName} requires every ranges entry to be { startSec, endSec } in seconds.`,
      );
    }
    return { startSec, endSec };
  });
}

function readNumberArrayArg(args: CodexJsonObject, key: string, toolName: string): number[] | null {
  const value = args[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'number')) {
    throw new Error(`OpenReelio ${toolName} requires ${key} to be an array of numbers.`);
  }
  return value as number[];
}

/**
 * Read an argument that names ids, rejecting a malformed one here so the
 * message carries the field name rather than surfacing as an IPC rejection.
 */
function readStringArrayArg(args: CodexJsonObject, key: string, toolName: string): string[] | null {
  const value = args[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`OpenReelio ${toolName} requires ${key} to be an array of strings.`);
  }
  return value as string[];
}

/**
 * Drop any inline image bytes from a probe report before it is serialised as
 * text. The report names paths rather than bytes today, so this is a guard
 * rather than a transformation: an image block is recognised by carrying both a
 * `mimeType` and a `data` string, and only that `data` is removed.
 */
function stripInlineImageBytes(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripInlineImageBytes);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const source = value as Record<string, unknown>;
  const stripped: Record<string, unknown> = {};
  const isImageBlock = typeof source.mimeType === 'string' && typeof source.data === 'string';
  for (const [key, entry] of Object.entries(source)) {
    if (isImageBlock && key === 'data') {
      continue;
    }
    stripped[key] = stripInlineImageBytes(entry);
  }
  return stripped;
}

/**
 * How long the bridge waits for a draft render before giving up and cancelling
 * the job. A range draft is minutes at worst; anything longer is a stuck
 * encoder, and leaving the agent blocked on it helps nobody.
 */
const RENDER_PROXY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The budget for a Claude session, kept under the loopback MCP server's own
 * `tools/call` timeout for `render_proxy` (900s; 300s for every other tool).
 *
 * Past that point the backend answers Claude with a timeout error and discards
 * whatever the frontend eventually says, so a longer wait here would not buy
 * the agent an answer — it would only hide the outcome behind a response nobody
 * reads. The 90s margin covers the round trip between the frontend giving up
 * and the backend receiving the answer.
 */
const RENDER_PROXY_MCP_TIMEOUT_MS = 13.5 * 60 * 1000;

/** The wait budget for the runtime this call came from. */
function resolveRenderProxyTimeoutMs(context: OpenReelioCodexToolContext): number {
  return context.runtimeId === 'claude_code'
    ? RENDER_PROXY_MCP_TIMEOUT_MS
    : RENDER_PROXY_TIMEOUT_MS;
}

/**
 * Preset id the tool documents and sends, matching the CLI's `--proxy`
 * shorthand: a CRF 30 ultrafast draft fitted to the sequence canvas.
 *
 * The desktop render path serves this id itself, so nothing is substituted and
 * a vertical sequence is drafted vertical rather than letterboxed into 720p.
 */
const RENDER_PROXY_DEFAULT_PRESET = 'proxy_480p';

/**
 * Presets the bridge will draft with. Both write MP4, which is what makes the
 * hard-coded `.mp4` output extension correct for either one.
 */
const RENDER_PROXY_ALLOWED_PRESETS = new Set([RENDER_PROXY_DEFAULT_PRESET, 'mp4_draft']);

/** The draft presets, quoted, for a rejection the agent can act on. */
function describeAllowedRenderPresets(): string {
  return [...RENDER_PROXY_ALLOWED_PRESETS].map((id) => `'${id}'`).join(' or ');
}

/** Terminal state of a range render, as the bridge reports it. */
interface RenderProxyOutcome {
  status: 'ok' | 'failed' | 'cancelled' | 'timeout';
  outputPath?: string;
  durationSec?: number;
  fileSize?: number;
  encodingTimeSec?: number;
  message?: string;
}

/** Distinguishes one bridge render from the next within a millisecond. */
let renderProxyOutputSequence = 0;

/**
 * Draft renders currently blocking a tool call, keyed by the host's call id.
 *
 * A render outlives the agent's interest in it: when the host abandons the
 * `tools/call` (its timeout, or the user stopping the session), the encoder is
 * still running and the only way to stop it is `cancel_render`. The bridge
 * cancel path reaches it through this registry.
 */
const inflightRenderCancellations = new Map<string, () => void>();

/**
 * Cancel the draft render blocking `callId`, if one is in flight.
 *
 * Returns whether a render was found, so the caller can tell a cancelled
 * render from a call that was only waiting on approval.
 */
export function cancelInflightAgentRender(callId: string): boolean {
  const cancel = inflightRenderCancellations.get(callId);
  if (!cancel) {
    return false;
  }
  cancel();
  return true;
}

/**
 * Render one timeline range to a draft file inside the project and wait for it.
 *
 * The output lands in the project's own cache directory, which is both an
 * allowed export root and inside the directory `frame_extract --file` confines
 * to — so the render the agent just made is a render it can immediately look at.
 */
async function renderProxyToolCall(
  args: CodexJsonObject | null,
  context: OpenReelioCodexToolContext,
): Promise<CodexJsonObject> {
  // Armed before the first await: the host's own `tools/call` clock started
  // when the call arrived, so every second spent reading project state is a
  // second off this budget. Deriving the render timeout from a deadline fixed
  // here keeps the total wait inside it however slow the preamble is.
  const budgetMs = resolveRenderProxyTimeoutMs(context);
  const deadlineAt = Date.now() + budgetMs;

  if (!args) {
    throw new Error('OpenReelio render_proxy requires object arguments.');
  }

  const start = getFiniteNonNegativeNumberArg(args, 'start', 'render_proxy', true) ?? 0;
  const end = getFiniteNonNegativeNumberArg(args, 'end', 'render_proxy', true) ?? 0;
  if (end <= start) {
    return {
      status: 'error',
      message: `OpenReelio render_proxy requires end (${end}) to be greater than start (${start}).`,
    };
  }
  if (end - start > RENDER_PROXY_MAX_RANGE_SEC) {
    return {
      status: 'error',
      message: `OpenReelio render_proxy renders at most ${RENDER_PROXY_MAX_RANGE_SEC}s in one call, and this range is ${Math.round(
        end - start,
      )}s. Render a narrower window around the moment in question, or look at stills with frame_extract instead.`,
    };
  }

  const preset = getString(args, 'preset')?.trim() || RENDER_PROXY_DEFAULT_PRESET;
  if (!RENDER_PROXY_ALLOWED_PRESETS.has(preset)) {
    return {
      status: 'error',
      message: `OpenReelio render_proxy renders drafts only: pass ${describeAllowedRenderPresets()}, not '${preset}'. Full-quality presets are for delivery, not for checking work.`,
    };
  }

  const [projectInfo, projectState] = await Promise.all([
    readOptionalProjectInfo(),
    readOptionalProjectState(),
  ]);
  const projectPath = projectInfo?.path?.trim();
  if (!projectPath) {
    return {
      status: 'error',
      message:
        'OpenReelio render_proxy needs an open project with a directory on disk. Read openreelio.project_state first.',
    };
  }

  const sequenceId = projectState?.activeSequenceId;
  if (!sequenceId) {
    return {
      status: 'error',
      message:
        'OpenReelio render_proxy needs an active sequence. Read openreelio.timeline_snapshot first.',
    };
  }

  const outputPath = buildAgentRenderOutputPath(projectPath);
  const callId = context.callId ?? null;
  const render = await startRangeRenderAndWait({
    sequenceId,
    outputPath,
    preset,
    start,
    end,
    deadlineAt,
    budgetMs,
    registerCancellation: callId
      ? (cancel) => {
          inflightRenderCancellations.set(callId, cancel);
          return () => inflightRenderCancellations.delete(callId);
        }
      : undefined,
  });

  // The file only exists when the encoder finished; naming a path the render
  // never wrote invites the agent to point frame_extract at nothing.
  const producedFile = render.outcome.status === 'ok';
  // fileRange has to describe the file that was actually written, not the range
  // that was asked for. A draft render routinely lands a frame short of its
  // request, and every timelineSec the samplers report is offset by whatever
  // this declaration gets wrong.
  const renderedDurationSec = render.outcome.durationSec ?? end - start;
  const fileRangeEnd = roundSeconds(start + renderedDurationSec);

  return {
    status: render.outcome.status,
    jobId: render.jobId,
    sequenceId,
    preset,
    start,
    end,
    ...(producedFile ? { outputPath: render.outcome.outputPath ?? outputPath } : {}),
    durationSec: render.outcome.durationSec,
    fileSize: render.outcome.fileSize,
    encodingTimeSec: render.outcome.encodingTimeSec,
    message: render.outcome.message,
    nextStep: producedFile
      ? `Look at the render: ${toolIdFor(
          context.runtimeId,
          'frame_extract',
        )} { file: outputPath, between: [0, ${roundSeconds(
          renderedDurationSec,
        )}], grid: '4x3', labelCells: true } sweeps the whole draft and always has something to show. When the range you rendered contains cuts, captions or transitions, judge those instead by adding fileRange: [${roundSeconds(
          start,
        )}, ${fileRangeEnd}] with a sampler — atCuts, atCaptions, atTransitions or perShot — and grid: 'auto'; fileRange says which timeline seconds this file holds, so the samplers read the timeline over them and every cell carries both fileSec and timelineSec. A sampler over a range with no such event errors rather than returning an empty sheet. Then measure it: ${toolIdFor(
          context.runtimeId,
          'verify',
        )} { file: outputPath }.`
      : undefined,
  };
}

/** Round a duration to the two decimals a timecode hint is worth. */
function roundSeconds(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

/** Build the cache path a bridge-initiated render writes to. */
function buildAgentRenderOutputPath(projectPath: string): string {
  const separator = projectPath.includes('\\') && !projectPath.includes('/') ? '\\' : '/';
  const root = projectPath.replace(/[\\/]+$/, '');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  renderProxyOutputSequence += 1;
  return [
    root,
    '.openreelio',
    'cache',
    'renders',
    'agent',
    `proxy-${stamp}-${renderProxyOutputSequence}.mp4`,
  ].join(separator);
}

interface RangeRenderRequest {
  sequenceId: string;
  outputPath: string;
  preset: string;
  start: number;
  end: number;
  /** Wall-clock instant the wait must end by, fixed before the call's first await. */
  deadlineAt: number;
  /** The full budget the deadline was derived from, for the timeout message. */
  budgetMs: number;
  /**
   * Publish a cancel hook for as long as the render is in flight, and return
   * the function that withdraws it.
   */
  registerCancellation?: (cancel: () => void) => () => void;
}

/**
 * Start a range render and resolve once it reaches a terminal state.
 *
 * The desktop render registry is cancel-only — there is no status to poll — so
 * completion is observed through events. Both subscriptions are established
 * before the render is started, and a terminal event that arrives before the
 * job id is known is buffered rather than lost.
 *
 * `render-complete` carries the measurements worth reporting; `render-lifecycle`
 * is what separates a failure from a cancellation, which the flat
 * `render-error` event cannot do.
 */
async function startRangeRenderAndWait(
  request: RangeRenderRequest,
): Promise<{ jobId: string | null; outcome: RenderProxyOutcome }> {
  const buffered = new Map<string, RenderProxyOutcome>();
  let jobId: string | null = null;
  let settle: ((outcome: RenderProxyOutcome) => void) | null = null;
  const terminal = new Promise<RenderProxyOutcome>((resolve) => {
    settle = resolve;
  });

  const deliver = (eventJobId: string, outcome: RenderProxyOutcome): void => {
    if (jobId === null) {
      if (!buffered.has(eventJobId)) {
        buffered.set(eventJobId, outcome);
      }
      return;
    }
    if (eventJobId === jobId) {
      settle?.(outcome);
    }
  };

  // The host can abandon the call while the encoder runs; `cancelled` is the
  // hook it pulls, and it settles the wait the same way a cancel event would.
  let cancelled = false;
  let requestCancel: (() => void) | null = null;
  const abandoned = new Promise<'cancelled'>((resolve) => {
    requestCancel = () => {
      cancelled = true;
      resolve('cancelled');
    };
  });

  // Registered one at a time inside the try: a second `listen` that rejects
  // must still detach the first, and `finally` is what guarantees that.
  const unlisteners: UnlistenFn[] = [];
  const withdrawCancellation = request.registerCancellation?.(() => requestCancel?.());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    unlisteners.push(
      await listen<RenderCompleteEvent>('render-complete', (event) => {
        deliver(event.payload.jobId, {
          status: 'ok',
          outputPath: event.payload.outputPath,
          durationSec: event.payload.durationSec,
          fileSize: event.payload.fileSize,
          encodingTimeSec: event.payload.encodingTimeSec,
        });
      }),
    );
    unlisteners.push(
      await listen<RenderLifecycleEvent>('render-lifecycle', (event) => {
        const { state } = event.payload;
        if (state !== 'failed' && state !== 'cancelled') {
          return;
        }
        deliver(event.payload.jobId, {
          status: state,
          message: event.payload.message ?? undefined,
        });
      }),
    );

    const started = await commands.renderRange(
      request.sequenceId,
      request.outputPath,
      request.preset,
      null,
      request.start,
      request.end,
    );
    if (started.status === 'error') {
      return { jobId: null, outcome: { status: 'failed', message: started.error } };
    }

    jobId = started.data.jobId;
    const early = buffered.get(jobId);
    if (early) {
      return { jobId, outcome: early };
    }
    if (cancelled) {
      // The host gave up while the job was still being started, so the job id
      // only became cancellable now.
      return { jobId, outcome: cancelRunningRender(jobId) };
    }

    const timeout = new Promise<'timeout'>((resolve) => {
      // Derived from the deadline rather than the budget: the preamble already
      // spent part of it, and the host's clock does not restart here.
      timer = setTimeout(() => resolve('timeout'), Math.max(0, request.deadlineAt - Date.now()));
    });
    const settled = await Promise.race([terminal, timeout, abandoned]);
    if (settled === 'cancelled') {
      return { jobId, outcome: cancelRunningRender(jobId) };
    }
    if (settled === 'timeout') {
      // Fire-and-forget: the agent is already out of time, so it gets its
      // answer now rather than after another backend round trip.
      void commands.cancelRender(jobId);
      return {
        jobId,
        outcome: {
          status: 'timeout',
          message: `The range render did not finish within ${Math.round(
            request.budgetMs / 1000,
          )}s and was cancelled. Render a shorter range.`,
        },
      };
    }
    return { jobId, outcome: settled };
  } finally {
    clearTimeout(timer);
    withdrawCancellation?.();
    for (const unlisten of unlisteners) {
      unlisten();
    }
  }
}

/**
 * Ask the backend to stop a running render without waiting for it to confirm.
 *
 * The caller has already decided what to answer; awaiting the cancellation
 * would only delay that answer behind a round trip whose result changes
 * nothing.
 */
function cancelRunningRender(jobId: string): RenderProxyOutcome {
  void commands.cancelRender(jobId);
  return {
    status: 'cancelled',
    message: 'The draft render was cancelled before it finished.',
  };
}

/**
 * Largest number of violation ranges the `verify` hand-off spells out.
 *
 * The pointer exists to be handed straight back to the frame probe, and a
 * contact sheet of every finding in a long report is neither readable nor
 * cheap. Past this many, the report itself is where the rest is read.
 */
const VERIFY_NEXT_STEP_MAX_RANGES = 8;

/** One violation window, as the QC report spells it. */
interface VerifyViolationRange {
  startSec: number;
  endSec: number;
}

/** What a verify report offers the agent to act on next. */
interface VerifyFindings {
  ranges: VerifyViolationRange[];
  totalRanges: number;
  hasSuggestedFix: boolean;
}

/**
 * Deterministic QC over the edit, and over a render when one is named.
 *
 * The report travels back verbatim so the checks, violations and suggested
 * fixes an agent reasons over are the ones the CLI and MCP surfaces print, and
 * `exitCode` is kept alongside as the one-glance verdict a loop branches on:
 * `2` is the tool failing rather than the edit, so only that one is reported as
 * a failed tool call.
 */
async function verifyToolCall(
  args: CodexJsonObject | null,
  context: OpenReelioCodexToolContext,
): Promise<CodexJsonObject> {
  const result = await commands.verifySequence(buildVerifyRequest(args ?? {}));
  if (result.status === 'error') {
    return { status: 'error', message: result.error };
  }

  const { payload, exitCode } = result.data;
  return {
    status: exitCode === 2 ? 'error' : 'ok',
    exitCode,
    passed: exitCode === 0,
    report: payload,
    nextStep: buildVerifyNextStep(payload, exitCode, context.runtimeId),
  };
}

/** Translate tool arguments into the verify request DTO. */
function buildVerifyRequest(args: CodexJsonObject): VerifySequenceRequestDto {
  return {
    file: getString(args, 'file')?.trim() || null,
    structuralOnly: args.structuralOnly === true,
    checks: readStringArrayArg(args, 'checks', 'verify'),
    skip: readStringArrayArg(args, 'skip', 'verify'),
    targetLufs: getFiniteNumberArg(args, 'targetLufs', 'verify') ?? null,
    maxTruePeak: getFiniteNumberArg(args, 'maxTruePeak', 'verify') ?? null,
    durationToleranceSec:
      getFiniteNonNegativeNumberArg(args, 'durationToleranceSec', 'verify') ?? null,
    failOn: getString(args, 'failOn')?.trim() || null,
    timeoutSec: getFiniteNonNegativeNumberArg(args, 'timeoutSec', 'verify') ?? null,
  };
}

/**
 * Tell the agent where to look now that the report is in.
 *
 * A verdict an agent cannot act on is a verdict it will paraphrase instead of
 * fixing, so the windows the checks flagged are inlined as a frame-probe
 * request it can hand straight back, and an auto-fixable finding is named with
 * the tool that applies it. `ranges` stands alone as a sampler, so the request
 * spelled here is one the probe accepts.
 */
function buildVerifyNextStep(
  payload: unknown,
  exitCode: number,
  runtimeId: OpenReelioCodexToolContext['runtimeId'],
): string | undefined {
  const findings = collectVerifyFindings(payload);
  const steps: string[] = [];

  if (findings.ranges.length > 0) {
    const truncated =
      findings.totalRanges > findings.ranges.length
        ? ` Only the first ${findings.ranges.length} of ${findings.totalRanges} flagged ranges are listed; read report.checks for the rest.`
        : '';
    steps.push(
      `Look at what the report flagged: ${toolIdFor(
        runtimeId,
        'frame_extract',
      )} { ranges: ${JSON.stringify(findings.ranges)}, grid: 'auto', labelCells: true }.${truncated}`,
    );
  }

  if (findings.hasSuggestedFix) {
    steps.push(
      `A violation carries an executable suggestedFix EditScript: review it against what you see, then apply it with ${toolIdFor(
        runtimeId,
        'plan_apply',
      )}.`,
    );
  }

  if (steps.length === 0) {
    return exitCode === 2
      ? 'The run did not complete, so this is not a verdict on the edit. Read report.errors and report the tool problem.'
      : undefined;
  }

  return steps.join(' ');
}

/**
 * Gather the windows and fixes a report offers, wherever it puts them.
 *
 * Violations are read from every check as well as from a top-level list, so a
 * report that groups them either way yields the same hand-off, and identical
 * windows are collapsed rather than sampled twice.
 */
function collectVerifyFindings(payload: unknown): VerifyFindings {
  const report = asObject(payload);
  const violations: CodexJsonObject[] = [...readViolationList(report?.violations)];
  for (const check of Array.isArray(report?.checks) ? report.checks : []) {
    violations.push(...readViolationList(asObject(check)?.violations));
  }

  const ranges: VerifyViolationRange[] = [];
  const seen = new Set<string>();
  let hasSuggestedFix = false;
  for (const violation of violations) {
    if (violation.suggestedFix !== undefined && violation.suggestedFix !== null) {
      hasSuggestedFix = true;
    }

    const timeRange = asObject(violation.timeRange);
    const startSec = timeRange ? asFiniteNumber(timeRange.startSec) : null;
    const endSec = timeRange ? asFiniteNumber(timeRange.endSec) : null;
    if (startSec === null || endSec === null) {
      continue;
    }

    const range = { startSec: roundSeconds(startSec), endSec: roundSeconds(endSec) };
    const key = `${range.startSec}:${range.endSec}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ranges.push(range);
  }

  return {
    ranges: ranges.slice(0, VERIFY_NEXT_STEP_MAX_RANGES),
    totalRanges: ranges.length,
    hasSuggestedFix,
  };
}

/** Read a report field that should hold violation objects, tolerating anything else. */
function readViolationList(value: unknown): CodexJsonObject[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => asObject(entry))
    .filter((entry): entry is CodexJsonObject => entry !== null);
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
    affectedRanges: readAffectedRanges(execution.result),
    nextStep: buildInspectionNextStep(execution.result, context.runtimeId),
    targeting: payloadNormalization.notes.length > 0 ? payloadNormalization.notes : undefined,
    refresh,
  };
}

/**
 * Surface the timeline ranges an apply reports it changed, when it reports any.
 *
 * The desktop plan executor does not carry them yet — that is a backend
 * follow-up — so their absence is normal and must not be mistaken for "the edit
 * changed nothing".
 */
function readAffectedRanges(result: AgentPlanResult): unknown[] | undefined {
  const ranges = (result as unknown as Record<string, unknown>).affectedRanges;
  return Array.isArray(ranges) && ranges.length > 0 ? ranges : undefined;
}

/**
 * The op this apply ended at, which `afterOp` pins the hand-off to.
 *
 * `operationIds` is the executor's own ordered list, so it is read first; the
 * per-step ids are the fallback for a result that only reports them there.
 */
function readLastOperationId(result: AgentPlanResult): string | undefined {
  for (let index = result.operationIds.length - 1; index >= 0; index -= 1) {
    const operationId = result.operationIds[index]?.trim();
    if (operationId) {
      return operationId;
    }
  }

  for (let index = result.stepResults.length - 1; index >= 0; index -= 1) {
    const operationId = result.stepResults[index]?.operationId?.trim();
    if (operationId) {
      return operationId;
    }
  }

  return undefined;
}

/**
 * Tell the agent where to look now that the edit is applied.
 *
 * When the apply reported the ranges it touched, they are inlined so the agent
 * can hand them straight back rather than re-deriving them — and `afterOp` is
 * offered alongside `affected` so a user edit landing in between cannot be
 * mistaken for this one. The fallback is spelled out as a request the frame
 * probe accepts: `between` is rejected without an explicit `COLSxROWS` grid, so
 * the recovery path an agent reads under pressure must not name it.
 */
function buildInspectionNextStep(
  result: AgentPlanResult,
  runtimeId: OpenReelioCodexToolContext['runtimeId'],
): string | undefined {
  if (!result.success) {
    return undefined;
  }
  const tool = toolIdFor(runtimeId, 'frame_extract');
  const editedSeconds =
    "sample the edited seconds instead: { atCuts: true, grid: 'auto' }, or { around: <edited time>, span: 1, grid: 'auto' }.";

  const ranges = readAffectedRanges(result);
  if (!ranges) {
    return `Look at what changed: ${tool} { affected: true, grid: 'auto', labelCells: true }. If no hand-off is recorded, ${editedSeconds}`;
  }

  const operationId = readLastOperationId(result);
  const handOff = operationId
    ? ` Or let the probe read the hand-off itself: { affected: true, afterOp: '${operationId}', grid: 'auto', labelCells: true }.`
    : '';

  return `Look at what changed: ${tool} { ranges: ${JSON.stringify(ranges)}, grid: 'auto', labelCells: true }.${handOff} If neither is accepted, ${editedSeconds}`;
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
    affectedRanges: readAffectedRanges(execution.result),
    nextStep: buildInspectionNextStep(execution.result, context.runtimeId),
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
    response.clipMapping = clipMapping as unknown as CodexJsonObject;

    if (clipMapping.hasActiveTimeRemap) {
      // The clip has an active time remap curve, so source times cannot be
      // mapped to the timeline with the constant-speed formula. Skip timeline
      // mapping (mirrors the Phase 1 add_captions_from_transcription guard) and
      // direct the caller to use sequence transcription instead.
      response.timelineMappingSkipped = true;
      response.timelineMappingSkippedReason =
        `Clip '${clipMapping.clipId}' has an active time remap curve, so source times cannot be mapped ` +
        'with a constant-speed formula. Use sequence transcription (transcribe the timeline) to obtain ' +
        'timeline-relative segments instead.';
      response.importHint = response.timelineMappingSkippedReason;
    } else {
      const timelineCaptionSegments = mapCaptionSegmentsToClipTimeline(
        captionSegments,
        clipMapping,
      );
      response.timelineSegmentCount = timelineCaptionSegments.length;
      response.skippedTimelineSegmentCount =
        captionSegments.length - timelineCaptionSegments.length;
      response.timelineCaptionSegments = timelineCaptionSegments as unknown as CodexJsonObject[];
      response.importHint =
        'Use timelineCaptionSegments as ImportGeneratedCaptions.segments when creating subtitles for this timeline clip.';
    }
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

/**
 * Parse a raw clip `timeRemap` value from project state into a TimeRemapCurve.
 * Only the keyframe count is required for active-remap detection, so unknown
 * keyframe entries are preserved structurally rather than fully validated.
 */
function parseTimeRemapCurve(value: unknown): TimeRemapCurve | null {
  const remapObject = asObject(value);
  if (!remapObject) {
    return null;
  }

  const keyframes = remapObject.keyframes;
  if (!Array.isArray(keyframes)) {
    return null;
  }

  return { keyframes } as TimeRemapCurve;
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
          hasActiveTimeRemap: hasActiveTimeRemap({
            timeRemap: parseTimeRemapCurve(clipObject.timeRemap),
          }),
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

async function buildTimelineSnapshot(
  state: ProjectStateDto,
  context: OpenReelioCodexToolContext,
): Promise<CodexJsonObject> {
  const activeSequence = state.sequences.find((sequence) => sequence.id === state.activeSequenceId);
  const contextToken = issueContextToken(context, state, 'timeline_snapshot');
  const inspections = await readSequenceInspections(state);
  return {
    contextToken: contextToken.token,
    contextTokenExpiresAt: contextToken.issuedAt + CONTEXT_TOKEN_TTL_MS,
    available: true,
    activeSequenceId: state.activeSequenceId,
    activeSequence: activeSequence ? summarizeSequence(activeSequence, inspections) : null,
    editingDefaults: activeSequence ? buildTimelineEditingDefaults(activeSequence) : null,
    sequences: state.sequences.map((sequence) => summarizeSequence(sequence, inspections)),
  };
}

/**
 * The where-to-look signals for one sequence, or why they are missing.
 *
 * A snapshot whose inspection call failed is still worth returning — the
 * structural half is what an agent needs to name tracks and clips — so the
 * failure travels as a note beside it rather than as a thrown error or, worse,
 * as invented numbers.
 */
type SequenceInspectionResult =
  | { readonly summary: InspectionSummary }
  | { readonly unavailable: string };

/** Inspection results by sequence id. */
type SequenceInspectionMap = ReadonlyMap<string, SequenceInspectionResult>;

/**
 * Read the core's inspection summary for every sequence in the snapshot.
 *
 * The signals are derived once in Rust (`timeline::inspection`), the same
 * function `openreelio-cli timeline info` and the MCP snapshot call, so the
 * bridge only fetches them. Recomputing cut times or transition spans here
 * would be a second implementation that could disagree with the render.
 */
async function readSequenceInspections(state: ProjectStateDto): Promise<SequenceInspectionMap> {
  const sequenceIds = state.sequences
    .map((sequence) => sequence.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  const entries = await Promise.all(
    sequenceIds.map(async (id): Promise<[string, SequenceInspectionResult]> => {
      try {
        const result = await commands.sequenceInspectionSummary(id);
        return [
          id,
          result.status === 'ok'
            ? { summary: result.data }
            : { unavailable: describeInspectionFailure(result.error) },
        ];
      } catch (error) {
        return [id, { unavailable: describeInspectionFailure(error) }];
      }
    }),
  );

  return new Map(entries);
}

/**
 * Render an inspection failure as a sentence an agent can act on.
 *
 * The generated bindings hand back whatever the IPC rejected with — a plain
 * string from the backend's own `Err`, an `Error` when the transport itself
 * failed — and either has to survive JSON as readable text.
 */
function describeInspectionFailure(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'The sequence inspection summary could not be read.';
}

/**
 * Merge one sequence's inspection signals into its summary.
 *
 * Every value is passed through from the core summary untouched. When the call
 * failed, `inspectionUnavailable` carries the reason and no signal field is
 * emitted, so a missing field never reads as "there is nothing there".
 */
function summarizeInspection(
  sequenceId: unknown,
  inspections: SequenceInspectionMap | undefined,
): CodexJsonObject {
  if (!inspections) {
    return {};
  }
  const entry = typeof sequenceId === 'string' ? inspections.get(sequenceId) : undefined;
  if (!entry) {
    return { inspectionUnavailable: 'No inspection summary was read for this sequence.' };
  }
  if ('unavailable' in entry) {
    return { inspectionUnavailable: entry.unavailable };
  }

  const summary = entry.summary;
  return {
    durationSec: summary.durationSec,
    outputDurationSec: summary.outputDurationSec,
    fps: summary.fps,
    fpsRatio: summary.fpsRatio,
    canvas: summary.canvas,
    cuts: summary.cuts,
    editPoints: summary.editPoints,
    markers: summary.markers,
    transitions: summary.transitions,
    captionSpans: summary.captionSpans,
    textSpans: summary.textSpans,
    inspectionHints: summary.inspectionHints,
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

/**
 * Structural summary of one sequence, plus the core's where-to-look signals
 * when `inspections` carries them.
 */
function summarizeSequence(
  sequence: unknown,
  inspections?: SequenceInspectionMap,
): CodexJsonObject {
  const sequenceObject = asObject(sequence) ?? {};
  const tracks = Array.isArray(sequenceObject.tracks) ? sequenceObject.tracks : [];
  return {
    id: sequenceObject.id,
    name: sequenceObject.name,
    trackCount: tracks.length,
    markerCount: Array.isArray(sequenceObject.markers) ? sequenceObject.markers.length : 0,
    ...summarizeInspection(sequenceObject.id, inspections),
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

/**
 * Every text preset spelling this bridge accepts: ids first, then aliases.
 *
 * Read from the catalog rather than restated, because a hint that names a
 * preset the parser rejects is worse than no hint at all.
 */
function textPresetKeys(): string[] {
  return [
    ...TEXT_PRESETS.map((preset) => preset.id),
    ...TEXT_PRESETS.flatMap((preset) => preset.aliases ?? []),
  ];
}

/**
 * Text preset ids whose anchor is part of the template, not a suggestion.
 *
 * Smart placement moves a title, lower third, subtitle, or callout. Everything
 * else was placed deliberately by the preset, so the category decides this
 * rather than a hand-kept list of ids.
 */
function templatePlacementTextPresetIds(): string[] {
  return TEXT_PRESETS.filter((preset) =>
    ['credit', 'brand', 'creative'].includes(preset.category),
  ).map((preset) => preset.id);
}

/** One line per text preset: what it is for, and how long it usually runs. */
function textPresetCatalog(): string[] {
  return TEXT_PRESETS.map(
    (preset) =>
      `${preset.id} (${preset.category}, ~${preset.defaultDurationSec ?? 3}s): ${preset.description}`,
  );
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
        note: 'Use this read-only tool before ImportGeneratedCaptions. Set sequenceAudio=true (default captioning path) for the edited timeline mix; its captionSegments are TIMELINE-relative and pass straight to ImportGeneratedCaptions. assetId transcription is SOURCE-relative (0-based to the asset) and is not safe as direct timeline caption times; pass clipId plus sequenceId/trackId to receive timelineCaptionSegments remapped onto a timeline clip.',
      },
      AddTextClip: {
        required: ['sequenceId', 'trackId', 'timelineIn', 'duration'],
        optional: ['preset', 'textData'],
        textDataShape:
          'TextClipData includes content, style(fontFamily/fontSize/fontWeight/color/backgroundColor/backgroundPadding/alignment/bold/italic/underline/lineHeight/letterSpacing), position(x/y 0..1), shadow(color/offsetX/offsetY/blur), outline(color/width), rotation, and opacity.',
        presetHints: textPresetKeys(),
        presetShape:
          'preset names a curated text preset that supplies the whole TextClipData; textData then carries only what overrides it, commonly just content, and may be omitted entirely. Every id and alias listed here is accepted. Nested layers merge key by key, so {"style":{"bold":false}} or {"shadow":{"offsetX":2}} keeps everything else the preset chose.',
        presetCatalog: textPresetCatalog(),
        note: 'Either preset or textData must be present: without a preset, textData is required and must be complete. Text clips must be placed on a top/front video or overlay track above the base video. The Codex bridge will correct below-base text tracks when possible. Use SetClipTransform after creation when scale or anchor must be exact.',
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
        'AddTextClip with a preset id, or with a complete TextClipData for content, typography, color, background, shadow, outline, position, rotation, and opacity when no preset fits.',
        'Prefer preset plus a content override over hand-assembled typography; presetCatalog under payloadHints.AddTextClip says what each id is for.',
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
        'Prefer openreelio.transcription_generate(sequenceAudio=true, sequenceId, language="auto", model="auto") as the default captioning path; returned captionSegments are TIMELINE-relative and pass straight to ImportGeneratedCaptions.',
        'Use openreelio.transcription_generate(assetId, language="auto", model="auto") for source-asset analysis only; its segments are SOURCE-relative (0-based to the asset) and must not be used as direct timeline caption times. Pass clipId to map them onto the placed clip instead.',
        'When captioning an edited timeline clip, pass clipId with sequenceId and trackId, then use timelineCaptionSegments for ImportGeneratedCaptions.',
        'Use ImportGeneratedCaptions for AI transcript segments or CreateCaption/UpdateCaption for individual caption lines.',
        'Use caption style/position metadata for subtitle readability instead of editable overlay text when the user wants semantic subtitles.',
      ],
      placementDefaults: {
        subtitle:
          'Bottom center around y=0.85 with outline/shadow unless it covers important visual content.',
        title: 'Center or upper third depending on the shot composition.',
        lowerThird: 'Lower-left or lower-center with enough safe margin and readable contrast.',
        creditBrand: `These presets preserve their template position unless the user asks for automatic placement: ${templatePlacementTextPresetIds().join(', ')}.`,
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

/**
 * Build a dynamic-tool response that carries pictures alongside its JSON.
 *
 * Images come first here, which is the order Codex renders them in, and each is
 * a `data:` URL because that is the only image form the Codex app-server
 * dynamic-tool protocol accepts. The Claude path does not inherit that order:
 * the loopback MCP wrapper rebuilds the result as one text block followed by
 * the image blocks, so on that host the text leads. `value` must already be
 * free of base64 bytes either way: the picture travels once, as a picture.
 */
function toolResponseWithImages(
  value: unknown,
  images: readonly OpenReelioToolCallImage[],
  success = true,
): CodexDynamicToolCallResponse {
  return {
    contentItems: [
      ...images.map((image) => ({
        type: 'inputImage' as const,
        imageUrl: `data:${image.mimeType};base64,${image.data}`,
      })),
      {
        type: 'inputText' as const,
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
