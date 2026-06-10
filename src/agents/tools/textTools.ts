/**
 * Text Tools
 *
 * Agent-facing tools for creating, inspecting, styling, transforming, and
 * removing timeline text clips through the command log.
 */

import { globalToolRegistry, type AgentContext, type ToolDefinition } from '../ToolRegistry';
import { commands, type AssetAnnotation } from '@/bindings';
import {
  TEXT_PRESETS,
  getPresetByKey,
  presetToTextClipData,
  type TextPreset,
} from '@/data/textPresets';
import { createLogger } from '@/services/logger';
import { executeAgentCommand } from './commandExecutor';
import { useProjectStore } from '@/stores/projectStore';
import {
  createTextClipData,
  isTextClip,
  type Clip,
  type CommandResult,
  type Effect,
  type Sequence,
  type TextClipAlignment,
  type TextClipData,
  type TextOutline,
  type TextPosition,
  type TextShadow,
  type TextStyle,
  type Track,
  type Transform,
} from '@/types';
import {
  annotationToTextPlacementObstacles,
  parseTextPlacementOptions,
  resolveSmartTextPlacement,
  shouldAutoPlaceText,
  type ExistingTextPlacement,
  type TextPlacementDecision,
  type TextPlacementObstacle,
} from './textPlacement';

const logger = createLogger('TextTools');

const TEXT_TOOL_NAMES = [
  'list_text_clips',
  'add_text_clip',
  'update_text_clip',
  'set_text_transform',
  'delete_text_clip',
] as const;

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

type TextPlacementPresetName = 'default' | 'title' | 'lower_third' | 'subtitle' | 'callout';

const AGENT_TEXT_PRESET_VALUES = Array.from(
  new Set(['default', ...TEXT_PRESETS.flatMap((preset) => [preset.id, ...(preset.aliases ?? [])])]),
);

const TEXT_STYLE_PARAMETER_PROPERTIES = {
  fontFamily: { type: 'string', description: 'Font family name' },
  fontSize: { type: 'number', description: 'Font size in pixels' },
  fontWeight: { type: 'number', description: 'Numeric font weight, 100 to 900' },
  color: { type: 'string', description: 'Text color hex with optional alpha' },
  backgroundColor: {
    type: ['string', 'null'],
    description: 'Background color hex with optional alpha, or null to remove it',
  },
  backgroundPadding: { type: 'number', description: 'Background padding in pixels' },
  clearBackground: { type: 'boolean', description: 'Remove the text background fill' },
  alignment: {
    type: 'string',
    description: 'Text alignment',
    enum: ['left', 'center', 'right'],
  },
  bold: { type: 'boolean', description: 'Enable bold styling' },
  italic: { type: 'boolean', description: 'Enable italic styling' },
  underline: { type: 'boolean', description: 'Enable underline styling' },
  lineHeight: { type: 'number', description: 'Line-height multiplier' },
  letterSpacing: { type: 'number', description: 'Letter spacing in pixels' },
} satisfies NonNullable<ToolDefinition['parameters']['properties']>;

const TEXT_POSITION_PARAMETER_PROPERTIES = {
  x: { type: 'number', description: 'Normalized text X position, 0 to 1' },
  y: { type: 'number', description: 'Normalized text Y position, 0 to 1' },
  xPercent: { type: 'number', description: 'Text X position as percent from left' },
  yPercent: { type: 'number', description: 'Text Y position as percent from top' },
} satisfies NonNullable<ToolDefinition['parameters']['properties']>;

const TEXT_EFFECT_PARAMETER_PROPERTIES = {
  shadowColor: { type: 'string', description: 'Shadow color hex with optional alpha' },
  shadowOffsetX: { type: 'number', description: 'Shadow horizontal offset in pixels' },
  shadowOffsetY: { type: 'number', description: 'Shadow vertical offset in pixels' },
  shadowBlur: { type: 'number', description: 'Shadow blur radius in pixels' },
  clearShadow: { type: 'boolean', description: 'Remove the text shadow' },
  outlineColor: { type: 'string', description: 'Outline color hex with optional alpha' },
  outlineWidth: { type: 'number', description: 'Outline width in pixels' },
  clearOutline: { type: 'boolean', description: 'Remove the text outline' },
  rotation: { type: 'number', description: 'Text data rotation in degrees' },
  opacity: { type: 'number', description: 'Text opacity from 0 to 1' },
} satisfies NonNullable<ToolDefinition['parameters']['properties']>;

const TEXT_TRANSFORM_PARAMETER_PROPERTIES = {
  transformX: { type: 'number', description: 'Normalized transform X position, 0 to 1' },
  transformY: { type: 'number', description: 'Normalized transform Y position, 0 to 1' },
  scaleX: { type: 'number', description: 'Horizontal scale multiplier' },
  scaleY: { type: 'number', description: 'Vertical scale multiplier' },
  rotationDeg: { type: 'number', description: 'Transform rotation in degrees' },
  anchorX: { type: 'number', description: 'Normalized transform anchor X, 0 to 1' },
  anchorY: { type: 'number', description: 'Normalized transform anchor Y, 0 to 1' },
} satisfies NonNullable<ToolDefinition['parameters']['properties']>;

const TEXT_AUTO_PLACEMENT_PARAMETER_PROPERTIES = {
  autoPlacement: {
    type: 'boolean',
    description:
      'Automatically select a safe preview position using timeline context and available faces/objects/OCR annotations',
  },
  placement: {
    type: ['string', 'object', 'boolean'],
    description:
      'Placement intent or options. String values: default, title, subtitle, lower_third, callout. False disables auto-placement.',
  },
  placementIntent: {
    type: 'string',
    description: 'Placement intent: default, title, subtitle, lower_third, callout',
  },
  safeMargin: {
    type: 'number',
    description: 'Normalized safe-area margin for automatic placement, 0.02 to 0.2',
  },
  avoidFaces: { type: 'boolean', description: 'Avoid detected face boxes when auto-placing' },
  avoidObjects: { type: 'boolean', description: 'Avoid detected object boxes when auto-placing' },
  avoidText: {
    type: 'boolean',
    description: 'Avoid detected OCR text and existing editable text clips when auto-placing',
  },
} satisfies NonNullable<ToolDefinition['parameters']['properties']>;

interface ResolvedTextClip {
  sequence: Sequence;
  track: Track;
  clip: Clip;
  textData: TextClipData;
}

function getProjectState(): ReturnType<typeof useProjectStore.getState> {
  return useProjectStore.getState();
}

function resolveSequenceId(args: Record<string, unknown>, context: AgentContext): string {
  const explicit = typeof args.sequenceId === 'string' ? args.sequenceId.trim() : '';
  if (explicit) {
    return explicit;
  }

  const contextual = typeof context.sequenceId === 'string' ? context.sequenceId.trim() : '';
  if (contextual) {
    return contextual;
  }

  const activeSequenceId = getProjectState().activeSequenceId;
  if (activeSequenceId) {
    return activeSequenceId;
  }

  throw new Error('No sequenceId was provided and no active sequence is loaded.');
}

function getSequence(sequenceId: string): Sequence {
  const sequence = getProjectState().sequences.get(sequenceId);
  if (!sequence) {
    throw new Error(`Sequence '${sequenceId}' not found.`);
  }

  return sequence;
}

function isTextTrack(track: Track): boolean {
  return track.kind === 'video' || track.kind === 'overlay';
}

function trackHasOverlap(track: Track, timelineIn: number, duration: number): boolean {
  const end = timelineIn + duration;
  return track.clips.some((clip) => {
    const clipStart = clip.place.timelineInSec;
    const clipEnd = clip.place.timelineInSec + clip.place.durationSec;
    return timelineIn < clipEnd && end > clipStart;
  });
}

function getNextVideoTrackName(sequence: Sequence): string {
  let highest = 0;
  for (const track of sequence.tracks) {
    if (track.kind !== 'video') {
      continue;
    }

    if (track.name.trim() === 'Video') {
      highest = Math.max(highest, 1);
      continue;
    }

    const match = /^Video\s+(\d+)$/.exec(track.name.trim());
    if (match) {
      highest = Math.max(highest, Number.parseInt(match[1], 10));
    }
  }

  return `Video ${highest + 1}`;
}

function getDefaultVideoTrackInsertPosition(sequence: Sequence): number {
  let firstVideoIndex = -1;
  let firstLowerLaneIndex = -1;

  sequence.tracks.forEach((track, index) => {
    if (firstVideoIndex === -1 && track.kind === 'video') {
      firstVideoIndex = index;
    }

    if (firstLowerLaneIndex === -1 && (track.kind === 'caption' || track.kind === 'audio')) {
      firstLowerLaneIndex = index;
    }
  });

  if (firstVideoIndex !== -1) {
    return firstVideoIndex;
  }

  return firstLowerLaneIndex !== -1 ? firstLowerLaneIndex : sequence.tracks.length;
}

async function ensureTextTrack(
  sequenceId: string,
  sequence: Sequence,
  timelineIn: number,
  duration: number,
  explicitTrackId?: string,
): Promise<{ trackId: string; createdTrack: boolean }> {
  if (explicitTrackId) {
    const explicitTrack = sequence.tracks.find((track) => track.id === explicitTrackId);
    if (!explicitTrack) {
      throw new Error(`Track '${explicitTrackId}' not found in sequence '${sequenceId}'.`);
    }

    if (!isTextTrack(explicitTrack)) {
      throw new Error(`Track '${explicitTrackId}' is not a video or overlay track.`);
    }

    if (explicitTrack.locked) {
      throw new Error(`Track '${explicitTrackId}' is locked.`);
    }

    if (trackHasOverlap(explicitTrack, timelineIn, duration)) {
      throw new Error(`Track '${explicitTrackId}' already has a clip in the requested time range.`);
    }

    return { trackId: explicitTrackId, createdTrack: false };
  }

  const availableTrack = sequence.tracks.find(
    (track) =>
      track.kind === 'video' &&
      !track.locked &&
      track.visible !== false &&
      !trackHasOverlap(track, timelineIn, duration),
  );
  if (availableTrack) {
    return { trackId: availableTrack.id, createdTrack: false };
  }

  const createTrackResult = await executeAgentCommand('CreateTrack', {
    sequenceId,
    kind: 'video',
    name: getNextVideoTrackName(sequence),
    position: getDefaultVideoTrackInsertPosition(sequence),
  });

  const trackId = createTrackResult.createdIds[0];
  if (!trackId) {
    throw new Error('Text track could not be created.');
  }

  return { trackId, createdTrack: true };
}

function getTextEffect(clip: Clip): Effect | null {
  const effects = getProjectState().effects;
  for (const effectId of clip.effects) {
    const effect = effects.get(effectId);
    if (effect?.effectType === 'text_overlay') {
      return effect;
    }
  }

  return null;
}

function getStringParam(effect: Effect | null, key: string, fallback: string): string {
  const value = effect?.params[key];
  return typeof value === 'string' ? value : fallback;
}

function getNumberParam(effect: Effect | null, key: string, fallback: number): number {
  const value = effect?.params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function getBooleanParam(effect: Effect | null, key: string, fallback: boolean): boolean {
  const value = effect?.params[key];
  return typeof value === 'boolean' ? value : fallback;
}

function clampFinite(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function isIdentityTransform(transform: Transform): boolean {
  return (
    Math.abs(transform.position.x - 0.5) < 0.0001 &&
    Math.abs(transform.position.y - 0.5) < 0.0001 &&
    Math.abs(transform.scale.x - 1) < 0.0001 &&
    Math.abs(transform.scale.y - 1) < 0.0001 &&
    Math.abs(transform.rotationDeg) < 0.0001 &&
    Math.abs(transform.anchor.x - 0.5) < 0.0001 &&
    Math.abs(transform.anchor.y - 0.5) < 0.0001
  );
}

function effectiveTextOpacity(textOpacity: number, clipOpacity: number): number {
  const normalizedTextOpacity = clampFinite(textOpacity, 0, 1, 1);
  const normalizedClipOpacity = clampFinite(clipOpacity, 0, 1, 1);

  if (Math.abs(normalizedTextOpacity - normalizedClipOpacity) < 0.001) {
    return normalizedTextOpacity;
  }

  return normalizedTextOpacity * normalizedClipOpacity;
}

function parseEffectTextData(clip: Clip): TextClipData {
  const fallback = createTextClipData(clip.label?.replace(/^Text:\s*/, '') || 'Text');
  const effect = getTextEffect(clip);
  const hasCustomTransform = !isIdentityTransform(clip.transform);

  const shadowColor = effect?.params.shadow_color;
  const outlineColor = effect?.params.outline_color;
  const outlineWidth = effect?.params.outline_width;
  const backgroundColor = effect?.params.background_color;
  const effectOpacity = getNumberParam(effect, 'opacity', fallback.opacity);

  return {
    content: getStringParam(effect, 'text', fallback.content),
    style: {
      fontFamily: getStringParam(effect, 'font_family', fallback.style.fontFamily),
      fontSize: getNumberParam(effect, 'font_size', fallback.style.fontSize),
      fontWeight: getNumberParam(effect, 'font_weight', fallback.style.fontWeight ?? 400),
      color: getStringParam(effect, 'color', fallback.style.color),
      backgroundColor: typeof backgroundColor === 'string' ? backgroundColor : undefined,
      backgroundPadding: getNumberParam(
        effect,
        'background_padding',
        fallback.style.backgroundPadding,
      ),
      alignment: normalizeAlignment(getStringParam(effect, 'alignment', fallback.style.alignment)),
      bold: getBooleanParam(effect, 'bold', fallback.style.bold),
      italic: getBooleanParam(effect, 'italic', fallback.style.italic),
      underline: getBooleanParam(effect, 'underline', fallback.style.underline),
      lineHeight: getNumberParam(effect, 'line_height', fallback.style.lineHeight),
      letterSpacing: getNumberParam(effect, 'letter_spacing', fallback.style.letterSpacing),
    },
    position: {
      x: hasCustomTransform
        ? clampFinite(
            clip.transform.position.x,
            0,
            1,
            getNumberParam(effect, 'x', fallback.position.x),
          )
        : getNumberParam(effect, 'x', fallback.position.x),
      y: hasCustomTransform
        ? clampFinite(
            clip.transform.position.y,
            0,
            1,
            getNumberParam(effect, 'y', fallback.position.y),
          )
        : getNumberParam(effect, 'y', fallback.position.y),
    },
    shadow:
      typeof shadowColor === 'string'
        ? {
            color: shadowColor,
            offsetX: getNumberParam(effect, 'shadow_x', 2),
            offsetY: getNumberParam(effect, 'shadow_y', 2),
            blur: getNumberParam(effect, 'shadow_blur', 0),
          }
        : undefined,
    outline:
      typeof outlineColor === 'string'
        ? {
            color: outlineColor,
            width: typeof outlineWidth === 'number' ? outlineWidth : 2,
          }
        : undefined,
    rotation:
      hasCustomTransform && Number.isFinite(clip.transform.rotationDeg)
        ? clip.transform.rotationDeg
        : getNumberParam(effect, 'rotation', fallback.rotation),
    opacity: effectiveTextOpacity(effectOpacity, clip.opacity),
  };
}

function resolveTextClip(
  sequenceId: string,
  clipId: string,
  explicitTrackId?: string,
): ResolvedTextClip {
  const sequence = getSequence(sequenceId);
  const tracks = explicitTrackId
    ? sequence.tracks.filter((track) => track.id === explicitTrackId)
    : sequence.tracks;

  for (const track of tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (!clip) {
      continue;
    }

    if (!isTextClip(clip.assetId)) {
      throw new Error(`Clip '${clipId}' is not a text clip.`);
    }

    return {
      sequence,
      track,
      clip,
      textData: parseEffectTextData(clip),
    };
  }

  if (explicitTrackId) {
    throw new Error(`Text clip '${clipId}' was not found on track '${explicitTrackId}'.`);
  }

  throw new Error(`Text clip '${clipId}' was not found in sequence '${sequenceId}'.`);
}

function normalizeAlignment(value: unknown): TextClipAlignment {
  return value === 'left' || value === 'right' || value === 'center' ? value : 'center';
}

function requireFiniteNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < min || numberValue > max) {
    throw new Error(`${field} must be a finite number between ${min} and ${max}.`);
  }

  return numberValue;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean.`);
  }

  return value;
}

function normalizeHexColor(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string' || !HEX_COLOR_PATTERN.test(value.trim())) {
    throw new Error(`${field} must be a hex color (#RGB, #RGBA, #RRGGBB, or #RRGGBBAA).`);
  }

  return value.trim().toUpperCase();
}

function objectArg(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mergeTextStyle(base: TextStyle, args: Record<string, unknown>): TextStyle {
  const styleArg = objectArg(args.style) ?? {};
  const get = (key: string): unknown =>
    Object.prototype.hasOwnProperty.call(args, key) ? args[key] : styleArg[key];

  const fontFamily = get('fontFamily');
  const color = normalizeHexColor(get('color'), 'color');
  const backgroundColorValue = get('backgroundColor');
  const backgroundColor =
    args.clearBackground === true || backgroundColorValue === null
      ? null
      : normalizeHexColor(backgroundColorValue, 'backgroundColor');
  const alignment = get('alignment');

  if (fontFamily !== undefined && (typeof fontFamily !== 'string' || !fontFamily.trim())) {
    throw new Error('fontFamily must be a non-empty string.');
  }

  if (alignment !== undefined && !['left', 'center', 'right'].includes(String(alignment))) {
    throw new Error('alignment must be left, center, or right.');
  }

  return {
    ...base,
    ...(typeof fontFamily === 'string' ? { fontFamily: fontFamily.trim() } : {}),
    ...(requireFiniteNumber(get('fontSize'), 'fontSize', 1, 500) !== undefined
      ? { fontSize: requireFiniteNumber(get('fontSize'), 'fontSize', 1, 500)! }
      : {}),
    ...(requireFiniteNumber(get('fontWeight'), 'fontWeight', 100, 900) !== undefined
      ? { fontWeight: Math.round(requireFiniteNumber(get('fontWeight'), 'fontWeight', 100, 900)!) }
      : {}),
    ...(color ? { color } : {}),
    ...(backgroundColor === null
      ? { backgroundColor: undefined }
      : backgroundColor
        ? { backgroundColor }
        : {}),
    ...(requireFiniteNumber(get('backgroundPadding'), 'backgroundPadding', 0, 500) !== undefined
      ? {
          backgroundPadding: Math.round(
            requireFiniteNumber(get('backgroundPadding'), 'backgroundPadding', 0, 500)!,
          ),
        }
      : {}),
    ...(alignment !== undefined ? { alignment: alignment as TextClipAlignment } : {}),
    ...(optionalBoolean(get('bold'), 'bold') !== undefined
      ? { bold: optionalBoolean(get('bold'), 'bold')! }
      : {}),
    ...(optionalBoolean(get('italic'), 'italic') !== undefined
      ? { italic: optionalBoolean(get('italic'), 'italic')! }
      : {}),
    ...(optionalBoolean(get('underline'), 'underline') !== undefined
      ? { underline: optionalBoolean(get('underline'), 'underline')! }
      : {}),
    ...(requireFiniteNumber(get('lineHeight'), 'lineHeight', 0.1, 10) !== undefined
      ? { lineHeight: requireFiniteNumber(get('lineHeight'), 'lineHeight', 0.1, 10)! }
      : {}),
    ...(requireFiniteNumber(get('letterSpacing'), 'letterSpacing', -500, 500) !== undefined
      ? {
          letterSpacing: Math.round(
            requireFiniteNumber(get('letterSpacing'), 'letterSpacing', -500, 500)!,
          ),
        }
      : {}),
  };
}

function parsePositionObject(value: Record<string, unknown>): TextPosition | undefined {
  const xPercent = requireFiniteNumber(value.xPercent, 'position.xPercent', 0, 100);
  const yPercent = requireFiniteNumber(value.yPercent, 'position.yPercent', 0, 100);
  if (xPercent !== undefined && yPercent !== undefined) {
    return { x: xPercent / 100, y: yPercent / 100 };
  }

  const x = requireFiniteNumber(value.x, 'position.x', 0, 1);
  const y = requireFiniteNumber(value.y, 'position.y', 0, 1);
  if (x !== undefined && y !== undefined) {
    return { x, y };
  }

  return undefined;
}

function mergeTextPosition(base: TextPosition, args: Record<string, unknown>): TextPosition {
  const positionArg = args.position;

  if (typeof positionArg === 'string') {
    switch (positionArg) {
      case 'top':
        return { x: 0.5, y: 0.15 };
      case 'center':
        return { x: 0.5, y: 0.5 };
      case 'bottom':
        return { x: 0.5, y: 0.85 };
      case 'lower_third':
        return { x: 0.5, y: 0.8 };
      default:
        throw new Error('position must be top, center, bottom, lower_third, or an object.');
    }
  }

  const objectPosition = objectArg(positionArg);
  if (objectPosition) {
    const parsed = parsePositionObject(objectPosition);
    if (parsed) {
      return parsed;
    }
  }

  const xPercent = requireFiniteNumber(args.xPercent, 'xPercent', 0, 100);
  const yPercent = requireFiniteNumber(args.yPercent, 'yPercent', 0, 100);
  if (xPercent !== undefined && yPercent !== undefined) {
    return { x: xPercent / 100, y: yPercent / 100 };
  }

  const x = requireFiniteNumber(args.x, 'x', 0, 1);
  const y = requireFiniteNumber(args.y, 'y', 0, 1);
  if (x !== undefined && y !== undefined) {
    return { x, y };
  }

  return base;
}

function mergeTextShadow(
  base: TextShadow | undefined,
  args: Record<string, unknown>,
): TextShadow | undefined {
  if (args.clearShadow === true || args.shadow === null) {
    return undefined;
  }

  const shadowArg = objectArg(args.shadow) ?? {};
  const get = (key: string): unknown =>
    Object.prototype.hasOwnProperty.call(args, key) ? args[key] : shadowArg[key];
  const hasShadowUpdate = [
    'shadow',
    'shadowColor',
    'shadowOffsetX',
    'shadowOffsetY',
    'shadowBlur',
  ].some((key) => Object.prototype.hasOwnProperty.call(args, key));

  if (!hasShadowUpdate && Object.keys(shadowArg).length === 0) {
    return base;
  }

  return {
    color:
      normalizeHexColor(args.shadowColor ?? shadowArg.color, 'shadowColor') ??
      base?.color ??
      '#000000',
    offsetX:
      requireFiniteNumber(get('offsetX') ?? get('shadowOffsetX'), 'shadowOffsetX', -500, 500) ??
      base?.offsetX ??
      2,
    offsetY:
      requireFiniteNumber(get('offsetY') ?? get('shadowOffsetY'), 'shadowOffsetY', -500, 500) ??
      base?.offsetY ??
      2,
    blur:
      requireFiniteNumber(get('blur') ?? get('shadowBlur'), 'shadowBlur', 0, 500) ??
      base?.blur ??
      0,
  };
}

function mergeTextOutline(
  base: TextOutline | undefined,
  args: Record<string, unknown>,
): TextOutline | undefined {
  if (args.clearOutline === true || args.outline === null) {
    return undefined;
  }

  const outlineArg = objectArg(args.outline) ?? {};
  const get = (key: string): unknown =>
    Object.prototype.hasOwnProperty.call(args, key) ? args[key] : outlineArg[key];
  const hasOutlineUpdate = ['outline', 'outlineColor', 'outlineWidth'].some((key) =>
    Object.prototype.hasOwnProperty.call(args, key),
  );

  if (!hasOutlineUpdate && Object.keys(outlineArg).length === 0) {
    return base;
  }

  return {
    color:
      normalizeHexColor(args.outlineColor ?? outlineArg.color, 'outlineColor') ??
      base?.color ??
      '#000000',
    width:
      requireFiniteNumber(get('width') ?? get('outlineWidth'), 'outlineWidth', 0, 50) ??
      base?.width ??
      2,
  };
}

function textDataFromPreset(preset: TextPreset | null, content: string): TextClipData {
  if (preset) {
    return presetToTextClipData(preset, content);
  }

  return createTextClipData(content);
}

function resolveTextPreset(value: unknown): TextPreset | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const preset = getPresetByKey(value);
  if (preset) {
    return preset;
  }

  if (value.trim().toLowerCase() === 'default') {
    return null;
  }

  throw new Error(
    `preset must be default or one of: ${TEXT_PRESETS.map((presetItem) => presetItem.id).join(', ')}.`,
  );
}

function placementIntentForPreset(preset: TextPreset | null): TextPlacementPresetName {
  switch (preset?.category) {
    case 'title':
      return 'title';
    case 'lower-third':
      return 'lower_third';
    case 'subtitle':
      return 'subtitle';
    case 'callout':
      return 'callout';
    default:
      return 'default';
  }
}

function hasExplicitPlacementControl(args: Record<string, unknown>): boolean {
  return (
    args.autoPlacement !== undefined ||
    args.placement !== undefined ||
    args.placementIntent !== undefined ||
    args.intent !== undefined
  );
}

function shouldPreserveTemplatePlacement(preset: TextPreset | null): boolean {
  return (
    preset?.category === 'credit' || preset?.category === 'brand' || preset?.category === 'creative'
  );
}

function buildTextData(base: TextClipData, args: Record<string, unknown>): TextClipData {
  const text = args.text ?? args.content;
  if (text !== undefined && (typeof text !== 'string' || text.trim().length === 0)) {
    throw new Error('text must be a non-empty string.');
  }

  const next: TextClipData = {
    ...base,
    content: typeof text === 'string' ? text.trim() : base.content,
    style: mergeTextStyle(base.style, args),
    position: mergeTextPosition(base.position, args),
    shadow: mergeTextShadow(base.shadow, args),
    outline: mergeTextOutline(base.outline, args),
    rotation: requireFiniteNumber(args.rotation, 'rotation', -3600, 3600) ?? base.rotation,
    opacity: requireFiniteNumber(args.opacity, 'opacity', 0, 1) ?? base.opacity,
  };

  if (!next.content.trim()) {
    throw new Error('text content cannot be empty.');
  }

  return next;
}

function mergeTransform(base: Transform, args: Record<string, unknown>): Transform | null {
  const transformArg = objectArg(args.transform) ?? {};
  const get = (key: string): unknown =>
    Object.prototype.hasOwnProperty.call(args, key) ? args[key] : transformArg[key];
  const positionArg = objectArg(transformArg.position);
  const scaleArg = objectArg(transformArg.scale);
  const anchorArg = objectArg(transformArg.anchor);

  const hasTransformUpdate =
    Object.keys(transformArg).length > 0 ||
    [
      'transform',
      'transformX',
      'transformY',
      'scaleX',
      'scaleY',
      'rotationDeg',
      'anchorX',
      'anchorY',
    ].some((key) => Object.prototype.hasOwnProperty.call(args, key));
  if (!hasTransformUpdate) {
    return null;
  }

  const positionX =
    requireFiniteNumber(get('transformX') ?? positionArg?.x, 'transform.position.x', 0, 1) ??
    base.position.x;
  const positionY =
    requireFiniteNumber(get('transformY') ?? positionArg?.y, 'transform.position.y', 0, 1) ??
    base.position.y;
  const scaleX =
    requireFiniteNumber(get('scaleX') ?? scaleArg?.x, 'transform.scale.x', 0.01, 100) ??
    base.scale.x;
  const scaleY =
    requireFiniteNumber(get('scaleY') ?? scaleArg?.y, 'transform.scale.y', 0.01, 100) ??
    base.scale.y;
  const anchorX =
    requireFiniteNumber(get('anchorX') ?? anchorArg?.x, 'transform.anchor.x', 0, 1) ??
    base.anchor.x;
  const anchorY =
    requireFiniteNumber(get('anchorY') ?? anchorArg?.y, 'transform.anchor.y', 0, 1) ??
    base.anchor.y;
  const rotationDeg =
    requireFiniteNumber(
      get('rotationDeg') ?? get('rotation'),
      'transform.rotationDeg',
      -3600,
      3600,
    ) ?? base.rotationDeg;

  return {
    position: { x: positionX, y: positionY },
    scale: { x: scaleX, y: scaleY },
    rotationDeg,
    anchor: { x: anchorX, y: anchorY },
  };
}

async function rollbackCreatedTextClip(
  sequenceId: string,
  trackId: string,
  clipId: string | undefined,
  createdTrack: boolean,
): Promise<void> {
  if (clipId) {
    await executeAgentCommand('RemoveTextClip', { sequenceId, trackId, clipId });
  }

  if (createdTrack) {
    await executeAgentCommand('DeleteTrack', { sequenceId, trackId });
  }
}

async function rollbackAppliedCommands(appliedCount: number): Promise<boolean> {
  const undo = (getProjectState() as { undo?: () => Promise<{ success: boolean }> }).undo;
  if (!undo) {
    return false;
  }

  for (let index = 0; index < appliedCount; index += 1) {
    let result: { success: boolean };
    try {
      result = await undo();
    } catch {
      return false;
    }

    if (!result.success) {
      return false;
    }
  }

  return true;
}

function serializeTextClip(resolved: ResolvedTextClip): Record<string, unknown> {
  return {
    sequenceId: resolved.sequence.id,
    trackId: resolved.track.id,
    clipId: resolved.clip.id,
    timelineIn: resolved.clip.place.timelineInSec,
    duration: resolved.clip.place.durationSec,
    label: resolved.clip.label ?? null,
    textData: resolved.textData,
    transform: resolved.clip.transform,
    opacity: resolved.clip.opacity,
  };
}

function rangesOverlap(start: number, duration: number, clip: Clip): boolean {
  const end = start + duration;
  const clipStart = clip.place.timelineInSec;
  const clipEnd = clipStart + clip.place.durationSec;
  return start < clipEnd && end > clipStart;
}

function resolveSourceTimeAtTimeline(clip: Clip, timelineTime: number): number {
  const clipStart = clip.place.timelineInSec;
  const clipEnd = clipStart + clip.place.durationSec;
  const clampedTimeline = clampFinite(timelineTime, clipStart, clipEnd, clipStart);
  const localOffset = Math.max(0, clampedTimeline - clipStart) * Math.max(0.01, clip.speed || 1);
  if (clip.reverse) {
    return Math.max(clip.range.sourceInSec, clip.range.sourceOutSec - localOffset);
  }

  return Math.min(clip.range.sourceOutSec, clip.range.sourceInSec + localOffset);
}

async function readAnnotationForPlacement(
  assetId: string,
  cache: Map<string, AssetAnnotation | null>,
): Promise<AssetAnnotation | null> {
  if (cache.has(assetId)) {
    return cache.get(assetId) ?? null;
  }

  try {
    const result = await commands.getAnnotation(assetId);
    const annotation = result.status === 'ok' ? result.data.annotation : null;
    cache.set(assetId, annotation);
    return annotation;
  } catch (error) {
    logger.debug('Text auto-placement could not read annotation', {
      assetId,
      error: error instanceof Error ? error.message : String(error),
    });
    cache.set(assetId, null);
    return null;
  }
}

async function collectPlacementObstacles(
  sequence: Sequence,
  timelineIn: number,
  duration: number,
): Promise<TextPlacementObstacle[]> {
  const midpoint = timelineIn + duration / 2;
  const toleranceSec = Math.max(0.75, Math.min(3, duration / 2 + 0.25));
  const annotationCache = new Map<string, AssetAnnotation | null>();
  const obstacles: TextPlacementObstacle[] = [];

  for (const track of sequence.tracks) {
    if (track.visible === false) {
      continue;
    }

    if (track.kind !== 'video' && track.kind !== 'overlay') {
      continue;
    }

    for (const clip of track.clips) {
      if (
        clip.enabled === false ||
        !rangesOverlap(timelineIn, duration, clip) ||
        isTextClip(clip.assetId)
      ) {
        continue;
      }

      const annotation = await readAnnotationForPlacement(clip.assetId, annotationCache);
      const sourceTime = resolveSourceTimeAtTimeline(clip, midpoint);
      obstacles.push(...annotationToTextPlacementObstacles(annotation, sourceTime, toleranceSec));
    }
  }

  return obstacles;
}

function collectExistingTextPlacements(
  sequence: Sequence,
  timelineIn: number,
  duration: number,
  excludeClipId?: string,
): ExistingTextPlacement[] {
  const placements: ExistingTextPlacement[] = [];

  for (const track of sequence.tracks) {
    if (track.visible === false) {
      continue;
    }

    for (const clip of track.clips) {
      if (
        clip.enabled === false ||
        clip.id === excludeClipId ||
        !rangesOverlap(timelineIn, duration, clip) ||
        !isTextClip(clip.assetId)
      ) {
        continue;
      }

      placements.push({ textData: parseEffectTextData(clip), weight: 4 });
    }
  }

  return placements;
}

async function applyAutomaticTextPlacement(
  textData: TextClipData,
  args: Record<string, unknown>,
  options: {
    sequence: Sequence;
    timelineIn: number;
    duration: number;
    isCreate: boolean;
    preset?: TextPlacementPresetName;
    excludeClipId?: string;
  },
): Promise<{ textData: TextClipData; placement: TextPlacementDecision | null }> {
  if (!shouldAutoPlaceText(args, options.isCreate)) {
    return { textData, placement: null };
  }

  const placementArgs =
    args.placementIntent === undefined && args.intent === undefined && args.placement === undefined
      ? { ...args, placementIntent: options.preset }
      : args;
  const placementOptions = parseTextPlacementOptions(placementArgs);
  const [obstacles, existingText] = await Promise.all([
    collectPlacementObstacles(options.sequence, options.timelineIn, options.duration),
    Promise.resolve(
      collectExistingTextPlacements(
        options.sequence,
        options.timelineIn,
        options.duration,
        options.excludeClipId,
      ),
    ),
  ]);
  const decision = resolveSmartTextPlacement({
    textData,
    sequence: options.sequence,
    options: placementOptions,
    obstacles,
    existingText,
  });

  return {
    textData: {
      ...textData,
      position: decision.position,
    },
    placement: decision,
  };
}

const TEXT_TOOLS: ToolDefinition[] = [
  {
    name: 'list_text_clips',
    description:
      'List timeline text overlay clips with full editable text data and transform state',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'Optional sequence ID. Defaults to active sequence.',
        },
      },
    },
    handler: async (args, context) => {
      try {
        const sequenceId = resolveSequenceId(args, context);
        const sequence = getSequence(sequenceId);
        const clips: Record<string, unknown>[] = [];

        for (const track of sequence.tracks) {
          for (const clip of track.clips) {
            if (isTextClip(clip.assetId)) {
              clips.push(
                serializeTextClip({ sequence, track, clip, textData: parseEffectTextData(clip) }),
              );
            }
          }
        }

        return { success: true, result: { sequenceId, count: clips.length, clips } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('list_text_clips failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'add_text_clip',
    description:
      'Create an editable on-video text overlay clip with full style, position, shadow, outline, and transform data; auto-creates a video text track when no usable track is provided',
    category: 'clip',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'Optional sequence ID. Defaults to active sequence.',
        },
        trackId: { type: 'string', description: 'Optional video or overlay track ID' },
        text: { type: 'string', description: 'Text content' },
        content: { type: 'string', description: 'Legacy alias for text content' },
        startTime: { type: 'number', description: 'Timeline start in seconds' },
        duration: { type: 'number', description: 'Duration in seconds' },
        endTime: { type: 'number', description: 'Optional end time in seconds' },
        preset: {
          type: 'string',
          enum: AGENT_TEXT_PRESET_VALUES,
          description:
            'Optional starter text preset. Supports preset IDs plus aliases such as title, lower_third, credits, logo_bug, and social_handle.',
        },
        style: { type: 'object', description: 'Text style overrides' },
        ...TEXT_STYLE_PARAMETER_PROPERTIES,
        position: {
          type: ['string', 'object'],
          description:
            'Text position preset (top, center, bottom, lower_third) or object with x/y 0..1 or xPercent/yPercent',
        },
        ...TEXT_POSITION_PARAMETER_PROPERTIES,
        shadow: { type: ['object', 'null'], description: 'Shadow object, or null to disable' },
        outline: { type: ['object', 'null'], description: 'Outline object, or null to disable' },
        ...TEXT_EFFECT_PARAMETER_PROPERTIES,
        transform: { type: 'object', description: 'Optional clip transform including scale' },
        ...TEXT_TRANSFORM_PARAMETER_PROPERTIES,
        ...TEXT_AUTO_PLACEMENT_PARAMETER_PROPERTIES,
      },
      required: ['startTime'],
    },
    handler: async (args, context) => {
      let createdClipId: string | undefined;
      let resolvedTrackId: string | undefined;
      let createdTrack = false;

      try {
        const sequenceId = resolveSequenceId(args, context);
        const sequence = getSequence(sequenceId);
        const rawText = args.text ?? args.content;
        const text = typeof rawText === 'string' ? rawText.trim() : '';
        if (!text) {
          throw new Error('text must be a non-empty string.');
        }

        const startTime = requireFiniteNumber(
          args.startTime,
          'startTime',
          0,
          Number.MAX_SAFE_INTEGER,
        );
        if (startTime === undefined) {
          throw new Error('startTime is required.');
        }

        const preset = resolveTextPreset(args.preset);
        const explicitDuration = requireFiniteNumber(
          args.duration,
          'duration',
          0.001,
          Number.MAX_SAFE_INTEGER,
        );
        const endTime = requireFiniteNumber(args.endTime, 'endTime', 0, Number.MAX_SAFE_INTEGER);
        const duration =
          explicitDuration ??
          (endTime !== undefined ? endTime - startTime : (preset?.defaultDurationSec ?? 4));
        if (!Number.isFinite(duration) || duration <= 0) {
          throw new Error('duration must be positive, or endTime must be greater than startTime.');
        }

        const placementIntent = placementIntentForPreset(preset);
        const placementArgs =
          shouldPreserveTemplatePlacement(preset) && !hasExplicitPlacementControl(args)
            ? { ...args, placement: false }
            : args;
        const placementResult = await applyAutomaticTextPlacement(
          buildTextData(textDataFromPreset(preset, text), args),
          placementArgs,
          {
            sequence,
            timelineIn: startTime,
            duration,
            isCreate: true,
            preset: placementIntent,
          },
        );
        const textData = placementResult.textData;
        const track = await ensureTextTrack(
          sequenceId,
          sequence,
          startTime,
          duration,
          typeof args.trackId === 'string' ? args.trackId : undefined,
        );
        resolvedTrackId = track.trackId;
        createdTrack = track.createdTrack;

        const addResult = await executeAgentCommand('AddTextClip', {
          sequenceId,
          trackId: resolvedTrackId,
          timelineIn: startTime,
          duration,
          textData,
        });
        createdClipId = addResult.createdIds[0];

        const transform = mergeTransform(
          {
            position: textData.position,
            scale: { x: 1, y: 1 },
            rotationDeg: textData.rotation,
            anchor: { x: 0.5, y: 0.5 },
          },
          args,
        );
        if (createdClipId && transform) {
          await executeAgentCommand('SetClipTransform', {
            sequenceId,
            trackId: resolvedTrackId,
            clipId: createdClipId,
            transform,
          });
        }

        return {
          success: true,
          result: {
            clipId: createdClipId,
            trackId: resolvedTrackId,
            createdTrack,
            presetId: preset?.id ?? 'default',
            textData,
            transform: transform ?? null,
            placement: placementResult.placement,
          },
        };
      } catch (error) {
        if (resolvedTrackId && (createdClipId || createdTrack)) {
          try {
            await rollbackCreatedTextClip(
              resolveSequenceId(args, context),
              resolvedTrackId,
              createdClipId,
              createdTrack,
            );
          } catch (rollbackError) {
            logger.error('add_text_clip rollback failed', { error: rollbackError });
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.error('add_text_clip failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'update_text_clip',
    description:
      'Update a text overlay clip content, style, position, effects, and optional transform',
    category: 'clip',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'Optional sequence ID. Defaults to active sequence.',
        },
        trackId: { type: 'string', description: 'Optional track ID' },
        clipId: { type: 'string', description: 'Text clip ID' },
        text: { type: 'string', description: 'New text content' },
        content: { type: 'string', description: 'Legacy alias for new text content' },
        style: { type: 'object', description: 'Text style overrides' },
        ...TEXT_STYLE_PARAMETER_PROPERTIES,
        position: {
          type: ['string', 'object'],
          description:
            'Text position preset (top, center, bottom, lower_third) or object with x/y 0..1 or xPercent/yPercent',
        },
        ...TEXT_POSITION_PARAMETER_PROPERTIES,
        shadow: { type: ['object', 'null'], description: 'Shadow object, or null to disable' },
        outline: { type: ['object', 'null'], description: 'Outline object, or null to disable' },
        ...TEXT_EFFECT_PARAMETER_PROPERTIES,
        transform: { type: 'object', description: 'Optional clip transform including scale' },
        ...TEXT_TRANSFORM_PARAMETER_PROPERTIES,
        ...TEXT_AUTO_PLACEMENT_PARAMETER_PROPERTIES,
      },
      required: ['clipId'],
    },
    handler: async (args, context) => {
      const appliedResults: CommandResult[] = [];
      try {
        const sequenceId = resolveSequenceId(args, context);
        const clipId = typeof args.clipId === 'string' ? args.clipId : '';
        if (!clipId) {
          throw new Error('clipId is required.');
        }

        const resolved = resolveTextClip(
          sequenceId,
          clipId,
          typeof args.trackId === 'string' ? args.trackId : undefined,
        );
        const placementResult = await applyAutomaticTextPlacement(
          buildTextData(resolved.textData, args),
          args,
          {
            sequence: resolved.sequence,
            timelineIn: resolved.clip.place.timelineInSec,
            duration: resolved.clip.place.durationSec,
            isCreate: false,
            excludeClipId: clipId,
          },
        );
        const nextTextData = placementResult.textData;
        const transform = mergeTransform(resolved.clip.transform, args);

        const updateResult = await executeAgentCommand('UpdateTextClip', {
          sequenceId,
          trackId: resolved.track.id,
          clipId,
          textData: nextTextData,
        });
        appliedResults.push(updateResult);

        if (transform) {
          const transformResult = await executeAgentCommand('SetClipTransform', {
            sequenceId,
            trackId: resolved.track.id,
            clipId,
            transform,
          });
          appliedResults.push(transformResult);
        }

        return {
          success: true,
          result: {
            clipId,
            trackId: resolved.track.id,
            textData: nextTextData,
            transform: transform ?? null,
            placement: placementResult.placement,
          },
        };
      } catch (error) {
        if (appliedResults.length > 0) {
          const rollbackSucceeded = await rollbackAppliedCommands(appliedResults.length);
          if (!rollbackSucceeded) {
            logger.error('update_text_clip rollback failed');
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.error('update_text_clip failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'set_text_transform',
    description: 'Move, scale, rotate, or change the anchor of a timeline text clip',
    category: 'clip',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'Optional sequence ID. Defaults to active sequence.',
        },
        trackId: { type: 'string', description: 'Optional track ID' },
        clipId: { type: 'string', description: 'Text clip ID' },
        transform: { type: 'object', description: 'Full or partial transform' },
        transformX: { type: 'number', description: 'Normalized X position, 0 to 1' },
        transformY: { type: 'number', description: 'Normalized Y position, 0 to 1' },
        scaleX: { type: 'number', description: 'Scale X multiplier' },
        scaleY: { type: 'number', description: 'Scale Y multiplier' },
        rotationDeg: { type: 'number', description: 'Rotation in degrees' },
        anchorX: { type: 'number', description: 'Normalized anchor X, 0 to 1' },
        anchorY: { type: 'number', description: 'Normalized anchor Y, 0 to 1' },
      },
      required: ['clipId'],
    },
    handler: async (args, context) => {
      try {
        const sequenceId = resolveSequenceId(args, context);
        const clipId = typeof args.clipId === 'string' ? args.clipId : '';
        if (!clipId) {
          throw new Error('clipId is required.');
        }

        const resolved = resolveTextClip(
          sequenceId,
          clipId,
          typeof args.trackId === 'string' ? args.trackId : undefined,
        );
        const transform = mergeTransform(resolved.clip.transform, args);
        if (!transform) {
          throw new Error('At least one transform field is required.');
        }

        const result = await executeAgentCommand('SetClipTransform', {
          sequenceId,
          trackId: resolved.track.id,
          clipId,
          transform,
        });

        return {
          success: true,
          result: {
            ...result,
            clipId,
            trackId: resolved.track.id,
            transform,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('set_text_transform failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'delete_text_clip',
    aliases: ['remove_text_clip'],
    description: 'Remove a timeline text overlay clip',
    category: 'clip',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'Optional sequence ID. Defaults to active sequence.',
        },
        trackId: { type: 'string', description: 'Optional track ID' },
        clipId: { type: 'string', description: 'Text clip ID' },
      },
      required: ['clipId'],
    },
    handler: async (args, context) => {
      try {
        const sequenceId = resolveSequenceId(args, context);
        const clipId = typeof args.clipId === 'string' ? args.clipId : '';
        if (!clipId) {
          throw new Error('clipId is required.');
        }

        const resolved = resolveTextClip(
          sequenceId,
          clipId,
          typeof args.trackId === 'string' ? args.trackId : undefined,
        );
        const result = await executeAgentCommand('RemoveTextClip', {
          sequenceId,
          trackId: resolved.track.id,
          clipId,
        });

        return { success: true, result: { ...result, clipId, trackId: resolved.track.id } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('delete_text_clip failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
];

export function registerTextTools(): void {
  for (const tool of TEXT_TOOLS) {
    globalToolRegistry.register(tool);
  }
}

export function unregisterTextTools(): void {
  for (const tool of TEXT_TOOLS) {
    globalToolRegistry.unregister(tool.name);
  }
}

export function getTextToolNames(): string[] {
  return [...TEXT_TOOL_NAMES];
}
