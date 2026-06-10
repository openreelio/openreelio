/**
 * Text Presets Data
 *
 * Pre-configured text styles for common video text use cases.
 * Used by TextPresetPicker component in TextInspector.
 *
 * @module data/textPresets
 */

import type { TextStyle, TextPosition, TextShadow, TextOutline, TextClipData } from '@/types';

// =============================================================================
// Types
// =============================================================================

/** Categories for grouping text presets */
export type TextPresetCategory =
  | 'lower-third'
  | 'title'
  | 'subtitle'
  | 'callout'
  | 'credit'
  | 'brand'
  | 'creative';

export interface TextPreset {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Description */
  description: string;
  /** Category for filtering */
  category: TextPresetCategory;
  /** Text styling */
  style: TextStyle;
  /** Position on canvas */
  position: TextPosition;
  /** Optional shadow */
  shadow?: TextShadow;
  /** Optional outline */
  outline?: TextOutline;
  /** Rotation angle */
  rotation: number;
  /** Opacity */
  opacity: number;
  /** Suggested starter text for this production template */
  defaultContent?: string;
  /** Suggested clip duration in seconds */
  defaultDurationSec?: number;
  /** Agent/user aliases that resolve to this preset */
  aliases?: string[];
}

// =============================================================================
// Text Presets
// =============================================================================

export const TEXT_PRESETS: TextPreset[] = [
  // -------------------------------------------------------------------------
  // Lower Thirds
  // -------------------------------------------------------------------------
  {
    id: 'lower-third',
    name: 'Lower Third',
    description: 'Classic lower third for names and titles',
    category: 'lower-third',
    style: {
      fontSize: 42,
      fontFamily: 'Arial',
      color: '#FFFFFF',
      bold: true,
      italic: false,
      underline: false,
      alignment: 'left',
      lineHeight: 1.2,
      letterSpacing: 1,
      backgroundColor: '#000000B3',
      backgroundPadding: 12,
    },
    position: { x: 0.08, y: 0.82 },
    shadow: {
      color: '#000000',
      offsetX: 2,
      offsetY: 2,
      blur: 4,
    },
    rotation: 0,
    opacity: 1.0,
    defaultContent: 'Speaker Name\nTitle or Role',
    defaultDurationSec: 5,
    aliases: ['lower_third', 'name_title', 'name-role'],
  },
  {
    id: 'lower-third-minimal',
    name: 'Lower Third Minimal',
    description: 'Clean minimal lower third',
    category: 'lower-third',
    style: {
      fontSize: 36,
      fontFamily: 'Helvetica',
      color: '#FFFFFF',
      bold: false,
      italic: false,
      underline: false,
      alignment: 'left',
      lineHeight: 1.3,
      letterSpacing: 2,
      backgroundPadding: 0,
    },
    position: { x: 0.05, y: 0.88 },
    outline: {
      color: '#000000',
      width: 1,
    },
    rotation: 0,
    opacity: 0.95,
    defaultContent: 'Speaker Name',
    defaultDurationSec: 4,
    aliases: ['minimal_lower_third', 'minimal-lower-third'],
  },
  {
    id: 'lower-third-news',
    name: 'News Lower Third',
    description: 'Broadcast-style lower third with a strong title band',
    category: 'lower-third',
    style: {
      fontSize: 40,
      fontFamily: 'Arial',
      color: '#FFFFFF',
      bold: true,
      italic: false,
      underline: false,
      alignment: 'left',
      lineHeight: 1.15,
      letterSpacing: 1,
      backgroundColor: '#123E7CCC',
      backgroundPadding: 14,
    },
    position: { x: 0.07, y: 0.78 },
    shadow: {
      color: '#00000080',
      offsetX: 1,
      offsetY: 2,
      blur: 3,
    },
    rotation: 0,
    opacity: 1,
    defaultContent: 'Breaking Story\nLocation',
    defaultDurationSec: 6,
    aliases: ['broadcast_lower_third', 'news-lower-third'],
  },
  {
    id: 'lower-third-name-role',
    name: 'Name + Role',
    description: 'Interview lower third with compact name and role styling',
    category: 'lower-third',
    style: {
      fontSize: 38,
      fontFamily: 'Helvetica',
      color: '#F8FAFC',
      bold: true,
      italic: false,
      underline: false,
      alignment: 'left',
      lineHeight: 1.25,
      letterSpacing: 1,
      backgroundColor: '#111827D9',
      backgroundPadding: 10,
    },
    position: { x: 0.08, y: 0.84 },
    outline: {
      color: '#00000066',
      width: 1,
    },
    rotation: 0,
    opacity: 1,
    defaultContent: 'Jane Doe\nCreative Director',
    defaultDurationSec: 5,
    aliases: ['interview_lower_third', 'speaker_id', 'name_role'],
  },

  // -------------------------------------------------------------------------
  // Centered Titles
  // -------------------------------------------------------------------------
  {
    id: 'centered-title',
    name: 'Centered Title',
    description: 'Bold centered title for intros',
    category: 'title',
    style: {
      fontSize: 72,
      fontFamily: 'Arial',
      color: '#FFFFFF',
      bold: true,
      italic: false,
      underline: false,
      alignment: 'center',
      lineHeight: 1.1,
      letterSpacing: 4,
      backgroundPadding: 0,
    },
    position: { x: 0.5, y: 0.5 },
    shadow: {
      color: '#000000',
      offsetX: 3,
      offsetY: 3,
      blur: 8,
    },
    rotation: 0,
    opacity: 1.0,
    defaultContent: 'Main Title',
    defaultDurationSec: 4,
    aliases: ['title'],
  },
  {
    id: 'epic-title',
    name: 'Epic Title',
    description: 'Large dramatic title for impact',
    category: 'title',
    style: {
      fontSize: 96,
      fontFamily: 'Impact',
      color: '#FFFFFF',
      bold: true,
      italic: false,
      underline: false,
      alignment: 'center',
      lineHeight: 1.0,
      letterSpacing: 6,
      backgroundPadding: 0,
    },
    position: { x: 0.5, y: 0.5 },
    shadow: {
      color: '#000000',
      offsetX: 4,
      offsetY: 4,
      blur: 12,
    },
    outline: {
      color: '#000000',
      width: 3,
    },
    rotation: 0,
    opacity: 1.0,
    defaultContent: 'Big Moment',
    defaultDurationSec: 3,
    aliases: ['impact_title', 'hero_title'],
  },
  {
    id: 'chapter-title',
    name: 'Chapter Title',
    description: 'Editorial chapter card with title and subtitle',
    category: 'title',
    style: {
      fontSize: 62,
      fontFamily: 'Georgia',
      color: '#F8FAFC',
      bold: true,
      italic: false,
      underline: false,
      alignment: 'center',
      lineHeight: 1.18,
      letterSpacing: 2,
      backgroundPadding: 0,
    },
    position: { x: 0.5, y: 0.45 },
    shadow: {
      color: '#00000099',
      offsetX: 2,
      offsetY: 3,
      blur: 8,
    },
    rotation: 0,
    opacity: 1,
    defaultContent: 'Chapter One\nThe Setup',
    defaultDurationSec: 5,
    aliases: ['chapter', 'chapter_card', 'section_title'],
  },
  {
    id: 'end-card-title',
    name: 'End Card',
    description: 'Centered end screen title for channels and credits',
    category: 'title',
    style: {
      fontSize: 58,
      fontFamily: 'Arial',
      color: '#FFFFFF',
      bold: true,
      italic: false,
      underline: false,
      alignment: 'center',
      lineHeight: 1.25,
      letterSpacing: 1,
      backgroundColor: '#111827CC',
      backgroundPadding: 18,
    },
    position: { x: 0.5, y: 0.5 },
    rotation: 0,
    opacity: 1,
    defaultContent: 'Thanks for Watching',
    defaultDurationSec: 6,
    aliases: ['end_card', 'outro_title'],
  },

  // -------------------------------------------------------------------------
  // Subtitles
  // -------------------------------------------------------------------------
  {
    id: 'subtitle',
    name: 'Subtitle',
    description: 'Standard subtitle/caption style',
    category: 'subtitle',
    style: {
      fontSize: 32,
      fontFamily: 'Arial',
      color: '#FFFFFF',
      bold: false,
      italic: false,
      underline: false,
      alignment: 'center',
      lineHeight: 1.4,
      letterSpacing: 0,
      backgroundColor: '#00000099',
      backgroundPadding: 8,
    },
    position: { x: 0.5, y: 0.9 },
    rotation: 0,
    opacity: 1.0,
    defaultContent: 'Subtitle text',
    defaultDurationSec: 3,
    aliases: ['caption', 'subtitles'],
  },
  {
    id: 'subtitle-outline',
    name: 'Subtitle Outline',
    description: 'Subtitle with outline (no background)',
    category: 'subtitle',
    style: {
      fontSize: 34,
      fontFamily: 'Arial',
      color: '#FFFFFF',
      bold: true,
      italic: false,
      underline: false,
      alignment: 'center',
      lineHeight: 1.4,
      letterSpacing: 0,
      backgroundPadding: 0,
    },
    position: { x: 0.5, y: 0.9 },
    outline: {
      color: '#000000',
      width: 2,
    },
    rotation: 0,
    opacity: 1.0,
    defaultContent: 'Subtitle text',
    defaultDurationSec: 3,
    aliases: ['outlined_subtitle', 'subtitle_outline'],
  },

  // -------------------------------------------------------------------------
  // Callouts
  // -------------------------------------------------------------------------
  {
    id: 'callout',
    name: 'Callout',
    description: 'Attention-grabbing callout text',
    category: 'callout',
    style: {
      fontSize: 48,
      fontFamily: 'Arial',
      color: '#FFD700',
      bold: true,
      italic: false,
      underline: false,
      alignment: 'center',
      lineHeight: 1.2,
      letterSpacing: 2,
      backgroundPadding: 0,
    },
    position: { x: 0.5, y: 0.35 },
    shadow: {
      color: '#000000',
      offsetX: 2,
      offsetY: 2,
      blur: 6,
    },
    outline: {
      color: '#000000',
      width: 2,
    },
    rotation: 0,
    opacity: 1.0,
    defaultContent: 'Key Point',
    defaultDurationSec: 3,
    aliases: ['callout', 'emphasis'],
  },
  {
    id: 'label',
    name: 'Label',
    description: 'Simple label for annotations',
    category: 'lower-third',
    style: {
      fontSize: 24,
      fontFamily: 'Arial',
      color: '#FFFFFF',
      bold: false,
      italic: false,
      underline: false,
      alignment: 'left',
      lineHeight: 1.3,
      letterSpacing: 0,
      backgroundColor: '#333333',
      backgroundPadding: 6,
    },
    position: { x: 0.1, y: 0.1 },
    rotation: 0,
    opacity: 0.9,
    defaultContent: 'Label',
    defaultDurationSec: 3,
    aliases: ['annotation_label', 'tag'],
  },
  {
    id: 'callout-stat',
    name: 'Stat Callout',
    description: 'Large numeric callout for data, prices, and milestones',
    category: 'callout',
    style: {
      fontSize: 82,
      fontFamily: 'Arial',
      color: '#38BDF8',
      bold: true,
      italic: false,
      underline: false,
      alignment: 'center',
      lineHeight: 1,
      letterSpacing: 1,
      backgroundPadding: 0,
    },
    position: { x: 0.5, y: 0.42 },
    shadow: {
      color: '#000000',
      offsetX: 3,
      offsetY: 4,
      blur: 8,
    },
    outline: {
      color: '#082F49',
      width: 2,
    },
    rotation: 0,
    opacity: 1,
    defaultContent: '42%',
    defaultDurationSec: 3,
    aliases: ['stat', 'number_callout', 'price_callout'],
  },
  {
    id: 'callout-warning',
    name: 'Warning Callout',
    description: 'High-contrast warning or safety note',
    category: 'callout',
    style: {
      fontSize: 46,
      fontFamily: 'Arial',
      color: '#111827',
      bold: true,
      italic: false,
      underline: false,
      alignment: 'center',
      lineHeight: 1.15,
      letterSpacing: 1,
      backgroundColor: '#FACC15E6',
      backgroundPadding: 14,
    },
    position: { x: 0.5, y: 0.22 },
    outline: {
      color: '#FFFFFF',
      width: 1,
    },
    rotation: 0,
    opacity: 1,
    defaultContent: 'Important',
    defaultDurationSec: 3,
    aliases: ['warning', 'important_callout'],
  },

  // -------------------------------------------------------------------------
  // Credits and Brand
  // -------------------------------------------------------------------------
  {
    id: 'credits-block',
    name: 'Credits Block',
    description: 'Centered credit block for ending cards',
    category: 'credit',
    style: {
      fontSize: 34,
      fontFamily: 'Georgia',
      color: '#F8FAFC',
      bold: false,
      italic: false,
      underline: false,
      alignment: 'center',
      lineHeight: 1.45,
      letterSpacing: 1,
      backgroundPadding: 0,
    },
    position: { x: 0.5, y: 0.52 },
    shadow: {
      color: '#000000AA',
      offsetX: 1,
      offsetY: 2,
      blur: 5,
    },
    rotation: 0,
    opacity: 1,
    defaultContent: 'Directed by\nJane Doe\n\nProduced by\nOpenReelio',
    defaultDurationSec: 8,
    aliases: ['credits', 'credit_block', 'end_credits'],
  },
  {
    id: 'credit-line',
    name: 'Credit Line',
    description: 'Small single-line attribution or source credit',
    category: 'credit',
    style: {
      fontSize: 24,
      fontFamily: 'Arial',
      color: '#E5E7EB',
      bold: false,
      italic: false,
      underline: false,
      alignment: 'right',
      lineHeight: 1.2,
      letterSpacing: 0,
      backgroundColor: '#00000080',
      backgroundPadding: 6,
    },
    position: { x: 0.94, y: 0.92 },
    rotation: 0,
    opacity: 0.9,
    defaultContent: 'Source: OpenReelio',
    defaultDurationSec: 5,
    aliases: ['source_credit', 'attribution'],
  },
  {
    id: 'logo-bug',
    name: 'Logo Bug',
    description: 'Subtle top-right brand bug or channel label',
    category: 'brand',
    style: {
      fontSize: 24,
      fontFamily: 'Arial',
      color: '#FFFFFF',
      bold: true,
      italic: false,
      underline: false,
      alignment: 'right',
      lineHeight: 1.15,
      letterSpacing: 1,
      backgroundColor: '#0F766ECC',
      backgroundPadding: 8,
    },
    position: { x: 0.94, y: 0.08 },
    rotation: 0,
    opacity: 0.85,
    defaultContent: 'OPEN',
    defaultDurationSec: 10,
    aliases: ['bug', 'channel_bug', 'brand_bug'],
  },
  {
    id: 'social-handle',
    name: 'Social Handle',
    description: 'Creator handle or social profile lower bug',
    category: 'brand',
    style: {
      fontSize: 30,
      fontFamily: 'Arial',
      color: '#FFFFFF',
      bold: true,
      italic: false,
      underline: false,
      alignment: 'left',
      lineHeight: 1.2,
      letterSpacing: 0,
      backgroundColor: '#7C3AEDCC',
      backgroundPadding: 10,
    },
    position: { x: 0.07, y: 0.91 },
    shadow: {
      color: '#00000099',
      offsetX: 1,
      offsetY: 2,
      blur: 4,
    },
    rotation: 0,
    opacity: 1,
    defaultContent: '@openreelio',
    defaultDurationSec: 5,
    aliases: ['handle', 'social', 'social_handle'],
  },

  // -------------------------------------------------------------------------
  // Creative Styles
  // -------------------------------------------------------------------------
  {
    id: 'quote',
    name: 'Quote',
    description: 'Elegant quote style with italics',
    category: 'creative',
    style: {
      fontSize: 42,
      fontFamily: 'Georgia',
      color: '#FFFFFF',
      bold: false,
      italic: true,
      underline: false,
      alignment: 'center',
      lineHeight: 1.6,
      letterSpacing: 1,
      backgroundPadding: 0,
    },
    position: { x: 0.5, y: 0.5 },
    shadow: {
      color: '#000000',
      offsetX: 1,
      offsetY: 1,
      blur: 3,
    },
    rotation: 0,
    opacity: 0.95,
    defaultContent: '"Pull quote goes here"',
    defaultDurationSec: 5,
    aliases: ['pull_quote', 'quote'],
  },
  {
    id: 'tech-style',
    name: 'Tech Style',
    description: 'Modern monospace tech aesthetic',
    category: 'creative',
    style: {
      fontSize: 36,
      fontFamily: 'Courier New',
      color: '#00FF00',
      bold: false,
      italic: false,
      underline: false,
      alignment: 'left',
      lineHeight: 1.4,
      letterSpacing: 0,
      backgroundColor: '#000000CC',
      backgroundPadding: 10,
    },
    position: { x: 0.05, y: 0.05 },
    rotation: 0,
    opacity: 1.0,
    defaultContent: 'SYSTEM READY',
    defaultDurationSec: 4,
    aliases: ['tech', 'terminal'],
  },
  {
    id: 'watermark',
    name: 'Watermark',
    description: 'Subtle watermark/branding text',
    category: 'creative',
    style: {
      fontSize: 24,
      fontFamily: 'Arial',
      color: '#FFFFFF',
      bold: false,
      italic: false,
      underline: false,
      alignment: 'right',
      lineHeight: 1.2,
      letterSpacing: 0,
      backgroundPadding: 0,
    },
    position: { x: 0.95, y: 0.95 },
    rotation: 0,
    opacity: 0.4,
    defaultContent: 'Brand',
    defaultDurationSec: 10,
    aliases: ['watermark'],
  },
  {
    id: 'countdown',
    name: 'Countdown',
    description: 'Bold countdown/timer style',
    category: 'callout',
    style: {
      fontSize: 120,
      fontFamily: 'Impact',
      color: '#FF0000',
      bold: true,
      italic: false,
      underline: false,
      alignment: 'center',
      lineHeight: 1.0,
      letterSpacing: 0,
      backgroundPadding: 0,
    },
    position: { x: 0.5, y: 0.5 },
    shadow: {
      color: '#000000',
      offsetX: 4,
      offsetY: 4,
      blur: 8,
    },
    outline: {
      color: '#FFFFFF',
      width: 4,
    },
    rotation: 0,
    opacity: 1.0,
    defaultContent: '3',
    defaultDurationSec: 1,
    aliases: ['timer', 'countdown'],
  },
];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get a preset by its ID.
 */
export function getPresetById(id: string): TextPreset | undefined {
  return TEXT_PRESETS.find((p) => p.id === id);
}

/**
 * Normalize a user or agent supplied preset name to a reusable lookup key.
 */
export function normalizeTextPresetKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

/**
 * Resolve a preset by ID, display name, or declared alias.
 */
export function getPresetByKey(value: string): TextPreset | undefined {
  const key = normalizeTextPresetKey(value);
  return TEXT_PRESETS.find((preset) => {
    if (normalizeTextPresetKey(preset.id) === key) {
      return true;
    }

    if (normalizeTextPresetKey(preset.name) === key) {
      return true;
    }

    return preset.aliases?.some((alias) => normalizeTextPresetKey(alias) === key) ?? false;
  });
}

/**
 * Get presets by category.
 */
export function getPresetsByCategory(category: TextPresetCategory): TextPreset[] {
  return TEXT_PRESETS.filter((p) => p.category === category);
}

/**
 * Convert a TextPreset to TextClipData with provided content.
 */
export function presetToTextClipData(preset: TextPreset, content: string): TextClipData {
  return {
    content,
    style: { ...preset.style },
    position: { ...preset.position },
    shadow: preset.shadow ? { ...preset.shadow } : undefined,
    outline: preset.outline ? { ...preset.outline } : undefined,
    rotation: preset.rotation,
    opacity: preset.opacity,
  };
}

export default TEXT_PRESETS;
