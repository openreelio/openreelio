/**
 * Schemas Index
 *
 * Exports all schema definitions for validation.
 */

export {
  // Timeline command schemas
  InsertClipSchema,
  SplitClipSchema,
  TrimClipSchema,
  MoveClipSchema,
  DeleteClipSchema,
  // Track command schemas
  AddTrackSchema,
  DeleteTrackSchema,
  MuteTrackSchema,
  // Effect command schemas
  AddEffectSchema,
  UpdateEffectSchema,
  RemoveEffectSchema,
  // Transition command schemas
  AddTransitionSchema,
  // Keyframe command schemas
  AddKeyframeSchema,
  UpdateKeyframeSchema,
  DeleteKeyframeSchema,
  // Caption command schemas
  AddCaptionSchema,
  UpdateCaptionSchema,
  // Export command schemas
  ExportVideoSchema,
  // Union schemas
  EditCommandSchema,
  EditScriptSchema,
  // Enum schemas
  TrackType,
  EffectType,
  TransitionType,
  EasingType,
  RiskLevel,
  RequirementType,
  // Helper schemas
  RequirementSchema,
  RiskAssessmentSchema,
  // Validation helpers
  validateEditScript,
  validateCommand,
  getAllCommandTypes,
  getCommandSchema,
  // Types
  type InsertClipCommand,
  type SplitClipCommand,
  type TrimClipCommand,
  type MoveClipCommand,
  type DeleteClipCommand,
  type AddTrackCommand,
  type DeleteTrackCommand,
  type MuteTrackCommand,
  type AddEffectCommand,
  type UpdateEffectCommand,
  type RemoveEffectCommand,
  type AddTransitionCommand,
  type AddKeyframeCommand,
  type UpdateKeyframeCommand,
  type DeleteKeyframeCommand,
  type AddCaptionCommand,
  type UpdateCaptionCommand,
  type ExportVideoCommand,
  type EditCommand,
  type EditScript,
  type Requirement,
  type RiskAssessment,
} from './commandSchemas';
