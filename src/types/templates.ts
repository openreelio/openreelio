/**
 * Motion Graphics Template Types
 *
 * Types for templated motion graphics including lower thirds,
 * title cards, callouts, and end screens.
 *
 * These types match the Rust types in src-tauri/src/core/template/motion_graphics.rs.
 */

import type { ShapeLayerData } from './shapes';

// =============================================================================
// Template Categories
// =============================================================================

/** Template category for organization */
export type TemplateCategory =
  | 'lowerThird'    // Name/title overlays
  | 'titleCard'     // Full-screen titles
  | 'callout'       // Annotation boxes
  | 'endScreen'     // Call-to-action overlays
  | 'transition'    // Animated transitions
  | 'custom';       // User-defined

// =============================================================================
// Parameter Types
// =============================================================================

/** Template parameter type definitions */
export type TemplateParamType =
  | { type: 'text'; default: string; maxLength?: number; placeholder: string }
  | { type: 'color'; default: string; label: string }
  | { type: 'number'; default: number; min: number; max: number; step: number; label: string }
  | { type: 'toggle'; default: boolean; label: string }
  | { type: 'choice'; default: string; options: string[]; label: string };

/** Template parameter definition */
export interface TemplateParam {
  /** Unique parameter ID within template */
  id: string;
  /** Display name */
  name: string;
  /** Parameter type and constraints */
  paramType: TemplateParamType;
  /** UI organization group */
  group?: string;
}

// =============================================================================
// Template Elements
// =============================================================================

/** Text clip data for text elements in templates */
export interface TemplateTextClipData {
  /** Text content to display */
  content: string;
  /** Font family name */
  fontFamily: string;
  /** Font size in points */
  fontSize: number;
  /** Text color as hex string */
  color: string;
  /** Optional background color */
  backgroundColor?: string;
  /** Text alignment */
  alignment: 'left' | 'center' | 'right';
  /** Bold weight */
  bold: boolean;
  /** Italic style */
  italic: boolean;
  /** Horizontal position (0.0-1.0) */
  positionX: number;
  /** Vertical position (0.0-1.0) */
  positionY: number;
  /** Opacity (0.0-1.0) */
  opacity: number;
}

/** Template element (shape or text) */
export type TemplateElement =
  | { type: 'shape'; id: string; data: ShapeLayerData; bindings: Record<string, string> }
  | { type: 'text'; id: string; data: TemplateTextClipData; bindings: Record<string, string> };

// =============================================================================
// Template Definition
// =============================================================================

/** Complete motion graphics template */
export interface MotionGraphicsTemplate {
  /** Unique template ID */
  id: string;
  /** Display name */
  name: string;
  /** Description */
  description: string;
  /** Template category */
  category: TemplateCategory;
  /** Template version */
  version: string;
  /** Author/creator */
  author?: string;
  /** Customizable parameters */
  parameters: TemplateParam[];
  /** Template elements (shapes, text) */
  elements: TemplateElement[];
  /** Default duration in seconds */
  defaultDuration: number;
  /** Thumbnail/preview path */
  thumbnail?: string;
  /** Tags for search */
  tags: string[];
}

// =============================================================================
// Template Instance
// =============================================================================

/** Template parameter value */
export type TemplateValue =
  | { type: 'text'; value: string }
  | { type: 'color'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean };

/** Instance of a template with customized values */
export interface TemplateInstance {
  /** Reference to the template ID */
  templateId: string;
  /** Customized parameter values */
  values: Record<string, TemplateValue>;
  /** Instance duration in seconds */
  duration: number;
}

// =============================================================================
// Template Library
// =============================================================================

/** Collection of templates */
export interface TemplateLibrary {
  /** All templates in the library */
  templates: MotionGraphicsTemplate[];
}

// =============================================================================
// Helper Functions
// =============================================================================

/** Get default value for a parameter */
export function getParamDefault(param: TemplateParam): TemplateValue {
  switch (param.paramType.type) {
    case 'text':
      return { type: 'text', value: param.paramType.default };
    case 'color':
      return { type: 'color', value: param.paramType.default };
    case 'number':
      return { type: 'number', value: param.paramType.default };
    case 'toggle':
      return { type: 'boolean', value: param.paramType.default };
    case 'choice':
      return { type: 'text', value: param.paramType.default };
  }
}

/** Create template instance with defaults */
export function createTemplateInstance(
  template: MotionGraphicsTemplate
): TemplateInstance {
  const values: Record<string, TemplateValue> = {};

  for (const param of template.parameters) {
    values[param.id] = getParamDefault(param);
  }

  return {
    templateId: template.id,
    values,
    duration: template.defaultDuration,
  };
}

/** Get value from instance */
export function getInstanceValue(
  instance: TemplateInstance,
  paramId: string
): TemplateValue | undefined {
  return instance.values[paramId];
}

/** Get text value from instance */
export function getTextValue(
  instance: TemplateInstance,
  paramId: string
): string | undefined {
  const val = instance.values[paramId];
  if (val?.type === 'text') return val.value;
  return undefined;
}

/** Get color value from instance */
export function getColorValue(
  instance: TemplateInstance,
  paramId: string
): string | undefined {
  const val = instance.values[paramId];
  if (val?.type === 'color') return val.value;
  return undefined;
}

/** Get number value from instance */
export function getNumberValue(
  instance: TemplateInstance,
  paramId: string
): number | undefined {
  const val = instance.values[paramId];
  if (val?.type === 'number') return val.value;
  return undefined;
}

/** Get boolean value from instance */
export function getBooleanValue(
  instance: TemplateInstance,
  paramId: string
): boolean | undefined {
  const val = instance.values[paramId];
  if (val?.type === 'boolean') return val.value;
  return undefined;
}

/** Filter templates by category */
export function filterByCategory(
  templates: MotionGraphicsTemplate[],
  category: TemplateCategory
): MotionGraphicsTemplate[] {
  return templates.filter(t => t.category === category);
}

/** Search templates by name, description, or tags */
export function searchTemplates(
  templates: MotionGraphicsTemplate[],
  query: string
): MotionGraphicsTemplate[] {
  const lowerQuery = query.toLowerCase();
  return templates.filter(t =>
    t.name.toLowerCase().includes(lowerQuery) ||
    t.description.toLowerCase().includes(lowerQuery) ||
    t.tags.some(tag => tag.toLowerCase().includes(lowerQuery))
  );
}

// =============================================================================
// Built-in Template Definitions
// =============================================================================

/** Simple lower third template */
export const LOWER_THIRD_SIMPLE: MotionGraphicsTemplate = {
  id: 'lower_third_simple',
  name: 'Simple Lower Third',
  description: 'Clean lower third with name and title',
  category: 'lowerThird',
  version: '1.0.0',
  parameters: [
    {
      id: 'primary_text',
      name: 'Name',
      paramType: { type: 'text', default: 'John Smith', placeholder: 'Enter name' },
      group: 'Content',
    },
    {
      id: 'secondary_text',
      name: 'Title',
      paramType: { type: 'text', default: 'CEO, Acme Corp', placeholder: 'Enter title' },
      group: 'Content',
    },
    {
      id: 'bg_color',
      name: 'Background',
      paramType: { type: 'color', default: '#000000CC', label: 'Background Color' },
      group: 'Style',
    },
    {
      id: 'text_color',
      name: 'Text Color',
      paramType: { type: 'color', default: '#FFFFFF', label: 'Text Color' },
      group: 'Style',
    },
    {
      id: 'accent_color',
      name: 'Accent',
      paramType: { type: 'color', default: '#FF6600', label: 'Accent Color' },
      group: 'Style',
    },
  ],
  elements: [],  // Elements defined at runtime
  defaultDuration: 5,
  tags: ['lower third', 'name', 'title', 'simple'],
};

/** Centered title card template */
export const TITLE_CARD_CENTERED: MotionGraphicsTemplate = {
  id: 'title_card_centered',
  name: 'Centered Title Card',
  description: 'Full-screen centered title with subtitle',
  category: 'titleCard',
  version: '1.0.0',
  parameters: [
    {
      id: 'title',
      name: 'Title',
      paramType: { type: 'text', default: 'Chapter One', placeholder: 'Enter title' },
      group: 'Content',
    },
    {
      id: 'subtitle',
      name: 'Subtitle',
      paramType: { type: 'text', default: 'The Beginning', placeholder: 'Enter subtitle' },
      group: 'Content',
    },
    {
      id: 'bg_opacity',
      name: 'Background Opacity',
      paramType: { type: 'number', default: 0.7, min: 0, max: 1, step: 0.1, label: 'Opacity' },
      group: 'Style',
    },
  ],
  elements: [],
  defaultDuration: 4,
  tags: ['title', 'chapter', 'centered', 'full screen'],
};

/** End screen subscribe template */
export const END_SCREEN_SUBSCRIBE: MotionGraphicsTemplate = {
  id: 'end_screen_subscribe',
  name: 'Subscribe End Screen',
  description: 'Call-to-action end screen with subscribe button',
  category: 'endScreen',
  version: '1.0.0',
  parameters: [
    {
      id: 'channel_name',
      name: 'Channel Name',
      paramType: { type: 'text', default: 'My Channel', placeholder: 'Your channel name' },
      group: 'Content',
    },
    {
      id: 'cta_text',
      name: 'Call to Action',
      paramType: { type: 'text', default: 'Subscribe for more content!', placeholder: 'CTA message' },
      group: 'Content',
    },
    {
      id: 'button_color',
      name: 'Button Color',
      paramType: { type: 'color', default: '#FF0000', label: 'Subscribe Button' },
      group: 'Style',
    },
  ],
  elements: [],
  defaultDuration: 10,
  tags: ['end screen', 'subscribe', 'youtube', 'cta'],
};

/** All built-in templates */
export const BUILTIN_TEMPLATES: MotionGraphicsTemplate[] = [
  LOWER_THIRD_SIMPLE,
  TITLE_CARD_CENTERED,
  END_SCREEN_SUBSCRIBE,
];

/** Create library with built-in templates */
export function createBuiltinLibrary(): TemplateLibrary {
  return { templates: [...BUILTIN_TEMPLATES] };
}
