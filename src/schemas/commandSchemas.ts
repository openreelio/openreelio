/**
 * Command Schemas
 *
 * Zod-based schemas for AI command validation.
 * Enables type-safe command generation and validation for AI-driven editing.
 *
 * Based on AI_AUTOMATION_ROADMAP.md Phase 2.
 *
 * @module schemas/commandSchemas
 */

import { z } from 'zod';

// =============================================================================
// Base Type Schemas
// =============================================================================

/**
 * UUID string schema for identifiers
 */
const UuidId = z.string().uuid().describe('Unique identifier (UUID format)');

/**
 * Non-negative time value in seconds
 */
const TimeSec = z.number().nonnegative().describe('Time in seconds (non-negative)');

/**
 * Clip identifier
 */
const ClipId = UuidId.describe('Unique clip identifier');

/**
 * Track identifier
 */
const TrackId = UuidId.describe('Unique track identifier');

/**
 * Asset identifier
 */
const AssetId = UuidId.describe('Unique asset identifier');

/**
 * Effect identifier
 */
const EffectId = UuidId.describe('Unique effect identifier');

/**
 * Keyframe identifier
 */
const KeyframeId = UuidId.describe('Unique keyframe identifier');

/**
 * Caption identifier
 */
const CaptionId = UuidId.describe('Unique caption identifier');

// =============================================================================
// Enum Schemas
// =============================================================================

/**
 * Track types
 */
export const TrackType = z.enum(['video', 'audio']);
export type TrackType = z.infer<typeof TrackType>;

/**
 * Available effect types
 */
export const EffectType = z.enum([
  // Color effects
  'brightness',
  'contrast',
  'saturation',
  'hue',
  'color_balance',
  'color_wheels',
  'gamma',
  'levels',
  'curves',
  'lut',
  // Transform effects
  'crop',
  'flip',
  'mirror',
  'rotate',
  // Blur/Sharpen
  'gaussian_blur',
  'box_blur',
  'motion_blur',
  'radial_blur',
  'sharpen',
  'unsharp_mask',
  // Stylize
  'vignette',
  'glow',
  'film_grain',
  'chromatic_aberration',
  'noise',
  'pixelate',
  'posterize',
  // Transitions
  'cross_dissolve',
  'fade',
  'wipe',
  'slide',
  'zoom',
  // Audio
  'volume',
  'gain',
  'eq_band',
  'compressor',
  'limiter',
  'noise_reduction',
  'reverb',
  'delay',
  // Text
  'text_overlay',
  'subtitle',
  // AI
  'background_removal',
  'auto_reframe',
  'face_blur',
  'object_tracking',
  // Keying/Compositing
  'chroma_key',
  'luma_key',
  'hsl_qualifier',
  // Compositing
  'blend_mode',
  'opacity',
  // Audio normalization
  'loudness_normalize',
]);
export type EffectType = z.infer<typeof EffectType>;

/**
 * Available transition types
 */
export const TransitionType = z.enum([
  'crossfade',
  'dissolve',
  'wipe',
  'slide',
  'zoom',
  'iris',
  'push',
  'fade',
]);
export type TransitionType = z.infer<typeof TransitionType>;

/**
 * Available easing types
 */
export const EasingType = z.enum([
  'linear',
  'easeIn',
  'easeOut',
  'easeInOut',
  'cubicBezier',
  'spring',
]);
export type EasingType = z.infer<typeof EasingType>;

/**
 * Risk levels for EditScript
 */
export const RiskLevel = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevel>;

/**
 * Requirement types
 */
export const RequirementType = z.enum(['asset', 'track', 'clip']);
export type RequirementType = z.infer<typeof RequirementType>;

// =============================================================================
// Timeline Command Schemas
// =============================================================================

/**
 * InsertClip - Add asset to timeline
 */
export const InsertClipSchema = z.object({
  commandType: z.literal('InsertClip'),
  params: z.object({
    trackId: TrackId,
    assetId: AssetId,
    timelineStart: TimeSec,
    sourceIn: TimeSec.optional().default(0),
    sourceOut: TimeSec.optional(),
  }).refine(
    (data) => data.sourceOut === undefined || data.sourceOut > (data.sourceIn ?? 0),
    { message: 'sourceOut must be greater than sourceIn' }
  ),
});
export type InsertClipCommand = z.infer<typeof InsertClipSchema>;

/**
 * SplitClip - Split clip at specified time
 */
export const SplitClipSchema = z.object({
  commandType: z.literal('SplitClip'),
  params: z.object({
    clipId: ClipId,
    atTimelineSec: TimeSec,
  }),
});
export type SplitClipCommand = z.infer<typeof SplitClipSchema>;

/**
 * TrimClip - Adjust in/out points
 */
export const TrimClipSchema = z.object({
  commandType: z.literal('TrimClip'),
  params: z.object({
    clipId: ClipId,
    newSourceIn: TimeSec.optional(),
    newSourceOut: TimeSec.optional(),
    newTimelineIn: TimeSec.optional(),
  }),
});
export type TrimClipCommand = z.infer<typeof TrimClipSchema>;

/**
 * MoveClip - Reposition clip on timeline
 */
export const MoveClipSchema = z.object({
  commandType: z.literal('MoveClip'),
  params: z.object({
    clipId: ClipId,
    newTimelineIn: TimeSec,
    newTrackId: TrackId.optional(),
  }),
});
export type MoveClipCommand = z.infer<typeof MoveClipSchema>;

/**
 * DeleteClip - Remove clip from timeline
 */
export const DeleteClipSchema = z.object({
  commandType: z.literal('DeleteClip'),
  params: z.object({
    clipId: ClipId,
  }),
});
export type DeleteClipCommand = z.infer<typeof DeleteClipSchema>;

// =============================================================================
// Track Command Schemas
// =============================================================================

/**
 * AddTrack - Create a new track
 */
export const AddTrackSchema = z.object({
  commandType: z.literal('AddTrack'),
  params: z.object({
    type: TrackType,
    name: z.string().optional(),
  }),
});
export type AddTrackCommand = z.infer<typeof AddTrackSchema>;

/**
 * DeleteTrack - Remove a track
 */
export const DeleteTrackSchema = z.object({
  commandType: z.literal('DeleteTrack'),
  params: z.object({
    trackId: TrackId,
  }),
});
export type DeleteTrackCommand = z.infer<typeof DeleteTrackSchema>;

/**
 * MuteTrack - Toggle mute state
 */
export const MuteTrackSchema = z.object({
  commandType: z.literal('MuteTrack'),
  params: z.object({
    trackId: TrackId,
    muted: z.boolean(),
  }),
});
export type MuteTrackCommand = z.infer<typeof MuteTrackSchema>;

// =============================================================================
// Effect Command Schemas
// =============================================================================

/**
 * Effect parameter value schema - allows numbers, strings, booleans, and hex colors
 */
const EffectParamValue = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.array(z.number()),
]);

/**
 * Effect parameters record - enforces valid parameter types
 */
const EffectParamsRecord = z.record(z.string(), EffectParamValue);

/**
 * AddEffect - Apply effect to clip
 */
export const AddEffectSchema = z.object({
  commandType: z.literal('AddEffect'),
  params: z.object({
    clipId: ClipId,
    effectType: EffectType,
    params: EffectParamsRecord,
  }),
});
export type AddEffectCommand = z.infer<typeof AddEffectSchema>;

/**
 * UpdateEffect - Modify effect parameters
 */
export const UpdateEffectSchema = z.object({
  commandType: z.literal('UpdateEffect'),
  params: z.object({
    clipId: ClipId,
    effectId: EffectId,
    params: EffectParamsRecord,
  }),
});
export type UpdateEffectCommand = z.infer<typeof UpdateEffectSchema>;

/**
 * RemoveEffect - Delete effect from clip
 */
export const RemoveEffectSchema = z.object({
  commandType: z.literal('RemoveEffect'),
  params: z.object({
    clipId: ClipId,
    effectId: EffectId,
  }),
});
export type RemoveEffectCommand = z.infer<typeof RemoveEffectSchema>;

// =============================================================================
// Transition Command Schemas
// =============================================================================

/**
 * AddTransition - Add transition between clips
 */
export const AddTransitionSchema = z.object({
  commandType: z.literal('AddTransition'),
  params: z.object({
    clipAId: ClipId,
    clipBId: ClipId,
    type: TransitionType,
    duration: TimeSec.positive(),
  }),
});
export type AddTransitionCommand = z.infer<typeof AddTransitionSchema>;

// =============================================================================
// Keyframe Command Schemas
// =============================================================================

/**
 * AddKeyframe - Create keyframe at time
 */
export const AddKeyframeSchema = z.object({
  commandType: z.literal('AddKeyframe'),
  params: z.object({
    clipId: ClipId,
    paramPath: z.string().min(1).describe('Parameter path, e.g., "effects.0.brightness"'),
    time: TimeSec,
    value: z.unknown(),
    easing: EasingType.optional().default('linear'),
  }),
});
export type AddKeyframeCommand = z.infer<typeof AddKeyframeSchema>;

/**
 * UpdateKeyframe - Modify keyframe
 */
export const UpdateKeyframeSchema = z.object({
  commandType: z.literal('UpdateKeyframe'),
  params: z.object({
    keyframeId: KeyframeId,
    value: z.unknown().optional(),
    time: TimeSec.optional(),
    easing: EasingType.optional(),
  }),
});
export type UpdateKeyframeCommand = z.infer<typeof UpdateKeyframeSchema>;

/**
 * DeleteKeyframe - Remove keyframe
 */
export const DeleteKeyframeSchema = z.object({
  commandType: z.literal('DeleteKeyframe'),
  params: z.object({
    keyframeId: KeyframeId,
  }),
});
export type DeleteKeyframeCommand = z.infer<typeof DeleteKeyframeSchema>;

// =============================================================================
// Caption Command Schemas
// =============================================================================

/**
 * Caption style properties (validated subset of CSS properties)
 */
export const CaptionStyleSchema = z.object({
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
  fontWeight: z.union([z.number(), z.string()]).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/, 'Invalid hex color').optional(),
  backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/, 'Invalid hex color').optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(),
  verticalAlign: z.enum(['top', 'middle', 'bottom']).optional(),
  textShadow: z.string().optional(),
  opacity: z.number().min(0).max(1).optional(),
}).passthrough(); // Allow additional CSS properties

/**
 * AddCaption - Create caption
 */
export const AddCaptionSchema = z.object({
  commandType: z.literal('AddCaption'),
  params: z.object({
    trackId: TrackId,
    text: z.string().min(1),
    startTime: TimeSec,
    endTime: TimeSec,
    style: CaptionStyleSchema.optional(),
  }).refine(
    (data) => data.endTime > data.startTime,
    { message: 'endTime must be greater than startTime' }
  ),
});
export type AddCaptionCommand = z.infer<typeof AddCaptionSchema>;

/**
 * UpdateCaption - Modify caption
 */
export const UpdateCaptionSchema = z.object({
  commandType: z.literal('UpdateCaption'),
  params: z.object({
    captionId: CaptionId,
    text: z.string().optional(),
    style: z.record(z.string(), z.any()).optional(),
  }),
});
export type UpdateCaptionCommand = z.infer<typeof UpdateCaptionSchema>;

// =============================================================================
// Export Command Schemas
// =============================================================================

/**
 * ExportVideo - Render and export video
 */
export const ExportVideoSchema = z.object({
  commandType: z.literal('ExportVideo'),
  params: z.object({
    preset: z.string().min(1),
    outputPath: z.string().min(1),
    range: z
      .object({
        start: TimeSec,
        end: TimeSec,
      })
      .refine(
        (data) => data.end > data.start,
        { message: 'Export range end must be greater than start' }
      )
      .optional(),
  }),
});
export type ExportVideoCommand = z.infer<typeof ExportVideoSchema>;

// =============================================================================
// Union of All Commands
// =============================================================================

/**
 * Discriminated union of all edit commands
 */
export const EditCommandSchema = z.discriminatedUnion('commandType', [
  // Timeline commands
  InsertClipSchema,
  SplitClipSchema,
  TrimClipSchema,
  MoveClipSchema,
  DeleteClipSchema,
  // Track commands
  AddTrackSchema,
  DeleteTrackSchema,
  MuteTrackSchema,
  // Effect commands
  AddEffectSchema,
  UpdateEffectSchema,
  RemoveEffectSchema,
  // Transition commands
  AddTransitionSchema,
  // Keyframe commands
  AddKeyframeSchema,
  UpdateKeyframeSchema,
  DeleteKeyframeSchema,
  // Caption commands
  AddCaptionSchema,
  UpdateCaptionSchema,
  // Export commands
  ExportVideoSchema,
]);
export type EditCommand = z.infer<typeof EditCommandSchema>;

// =============================================================================
// Full EditScript Schema
// =============================================================================

/**
 * Requirement schema for EditScript
 */
export const RequirementSchema = z.object({
  type: RequirementType,
  id: z.string(),
  description: z.string().optional(),
});
export type Requirement = z.infer<typeof RequirementSchema>;

/**
 * Risk assessment schema
 */
export const RiskAssessmentSchema = z.object({
  level: RiskLevel,
  reasons: z.array(z.string()),
});
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

/**
 * Full EditScript schema for AI-generated edit commands
 */
export const EditScriptSchema = z.object({
  intent: z.string().min(1).describe("User's natural language request"),
  commands: z.array(EditCommandSchema).min(1),
  requires: z.array(RequirementSchema).default([]),
  qcRules: z.array(z.string()).default([]),
  risk: RiskAssessmentSchema,
  explanation: z.string(),
});
export type EditScript = z.infer<typeof EditScriptSchema>;

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validate an EditScript and return typed result or errors
 */
export function validateEditScript(
  input: unknown
): { success: true; data: EditScript } | { success: false; errors: string[] } {
  const result = EditScriptSchema.safeParse(input);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });

  return { success: false, errors };
}

/**
 * Validate a single command and return typed result or errors
 */
export function validateCommand(
  input: unknown
): { success: true; data: EditCommand } | { success: false; errors: string[] } {
  const result = EditCommandSchema.safeParse(input);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });

  return { success: false, errors };
}

/**
 * Get all command types
 */
export function getAllCommandTypes(): string[] {
  return [
    'InsertClip',
    'SplitClip',
    'TrimClip',
    'MoveClip',
    'DeleteClip',
    'AddTrack',
    'DeleteTrack',
    'MuteTrack',
    'AddEffect',
    'UpdateEffect',
    'RemoveEffect',
    'AddTransition',
    'AddKeyframe',
    'UpdateKeyframe',
    'DeleteKeyframe',
    'AddCaption',
    'UpdateCaption',
    'ExportVideo',
  ];
}

/**
 * Get schema for a specific command type
 */
export function getCommandSchema(commandType: string): z.ZodTypeAny | null {
  const schemas: Record<string, z.ZodTypeAny> = {
    InsertClip: InsertClipSchema,
    SplitClip: SplitClipSchema,
    TrimClip: TrimClipSchema,
    MoveClip: MoveClipSchema,
    DeleteClip: DeleteClipSchema,
    AddTrack: AddTrackSchema,
    DeleteTrack: DeleteTrackSchema,
    MuteTrack: MuteTrackSchema,
    AddEffect: AddEffectSchema,
    UpdateEffect: UpdateEffectSchema,
    RemoveEffect: RemoveEffectSchema,
    AddTransition: AddTransitionSchema,
    AddKeyframe: AddKeyframeSchema,
    UpdateKeyframe: UpdateKeyframeSchema,
    DeleteKeyframe: DeleteKeyframeSchema,
    AddCaption: AddCaptionSchema,
    UpdateCaption: UpdateCaptionSchema,
    ExportVideo: ExportVideoSchema,
  };

  return schemas[commandType] ?? null;
}
