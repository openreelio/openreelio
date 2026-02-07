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
export type TextPresetCategory = 'lower-third' | 'title' | 'subtitle' | 'callout' | 'creative';

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
      backgroundColor: 'rgba(0,0,0,0.7)',
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
      backgroundColor: 'rgba(0,0,0,0.6)',
      backgroundPadding: 8,
    },
    position: { x: 0.5, y: 0.9 },
    rotation: 0,
    opacity: 1.0,
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
      backgroundColor: 'rgba(0,0,0,0.8)',
      backgroundPadding: 10,
    },
    position: { x: 0.05, y: 0.05 },
    rotation: 0,
    opacity: 1.0,
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
    style: preset.style,
    position: preset.position,
    shadow: preset.shadow,
    outline: preset.outline,
    rotation: preset.rotation,
    opacity: preset.opacity,
  };
}

export default TEXT_PRESETS;
