/**
 * Text Presets Data Tests
 *
 * TDD: Tests for text preset data, categories, and converter functions.
 */

import { describe, it, expect } from 'vitest';
import {
  TEXT_PRESETS,
  getPresetById,
  getPresetsByCategory,
  presetToTextClipData,
  type TextPresetCategory,
} from './textPresets';

// =============================================================================
// Tests
// =============================================================================

describe('textPresets', () => {
  // ===========================================================================
  // Data Integrity
  // ===========================================================================

  describe('data integrity', () => {
    it('should have all presets with unique IDs', () => {
      const ids = TEXT_PRESETS.map((p) => p.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should have a category assigned to every preset', () => {
      TEXT_PRESETS.forEach((preset) => {
        expect(preset.category).toBeDefined();
        expect(typeof preset.category).toBe('string');
      });
    });

    it('should have valid categories for all presets', () => {
      const validCategories: TextPresetCategory[] = [
        'lower-third',
        'title',
        'subtitle',
        'callout',
        'creative',
      ];

      TEXT_PRESETS.forEach((preset) => {
        expect(validCategories).toContain(preset.category);
      });
    });

    it('should have 12 presets', () => {
      expect(TEXT_PRESETS.length).toBe(12);
    });
  });

  // ===========================================================================
  // Category Assignments
  // ===========================================================================

  describe('category assignments', () => {
    it('should assign lower-third presets correctly', () => {
      const lowerThirds = TEXT_PRESETS.filter((p) => p.category === 'lower-third');
      const ids = lowerThirds.map((p) => p.id);
      expect(ids).toContain('lower-third');
      expect(ids).toContain('lower-third-minimal');
      expect(ids).toContain('label');
    });

    it('should assign title presets correctly', () => {
      const titles = TEXT_PRESETS.filter((p) => p.category === 'title');
      const ids = titles.map((p) => p.id);
      expect(ids).toContain('centered-title');
      expect(ids).toContain('epic-title');
    });

    it('should assign subtitle presets correctly', () => {
      const subtitles = TEXT_PRESETS.filter((p) => p.category === 'subtitle');
      const ids = subtitles.map((p) => p.id);
      expect(ids).toContain('subtitle');
      expect(ids).toContain('subtitle-outline');
    });

    it('should assign callout presets correctly', () => {
      const callouts = TEXT_PRESETS.filter((p) => p.category === 'callout');
      const ids = callouts.map((p) => p.id);
      expect(ids).toContain('callout');
      expect(ids).toContain('countdown');
    });

    it('should assign creative presets correctly', () => {
      const creatives = TEXT_PRESETS.filter((p) => p.category === 'creative');
      const ids = creatives.map((p) => p.id);
      expect(ids).toContain('quote');
      expect(ids).toContain('tech-style');
      expect(ids).toContain('watermark');
    });
  });

  // ===========================================================================
  // getPresetsByCategory
  // ===========================================================================

  describe('getPresetsByCategory', () => {
    it('should return correct presets for lower-third', () => {
      const presets = getPresetsByCategory('lower-third');
      expect(presets.length).toBe(3);
      expect(presets.every((p) => p.category === 'lower-third')).toBe(true);
    });

    it('should return correct presets for title', () => {
      const presets = getPresetsByCategory('title');
      expect(presets.length).toBe(2);
      expect(presets.every((p) => p.category === 'title')).toBe(true);
    });

    it('should return correct presets for subtitle', () => {
      const presets = getPresetsByCategory('subtitle');
      expect(presets.length).toBe(2);
      expect(presets.every((p) => p.category === 'subtitle')).toBe(true);
    });

    it('should return correct presets for callout', () => {
      const presets = getPresetsByCategory('callout');
      expect(presets.length).toBe(2);
      expect(presets.every((p) => p.category === 'callout')).toBe(true);
    });

    it('should return correct presets for creative', () => {
      const presets = getPresetsByCategory('creative');
      expect(presets.length).toBe(3);
      expect(presets.every((p) => p.category === 'creative')).toBe(true);
    });
  });

  // ===========================================================================
  // getPresetById
  // ===========================================================================

  describe('getPresetById', () => {
    it('should return the correct preset', () => {
      const preset = getPresetById('centered-title');
      expect(preset).toBeDefined();
      expect(preset!.name).toBe('Centered Title');
    });

    it('should return undefined for unknown ID', () => {
      const preset = getPresetById('nonexistent');
      expect(preset).toBeUndefined();
    });
  });

  // ===========================================================================
  // presetToTextClipData
  // ===========================================================================

  describe('presetToTextClipData', () => {
    it('should convert preset to TextClipData with provided content', () => {
      const preset = getPresetById('centered-title')!;
      const clipData = presetToTextClipData(preset, 'Hello World');

      expect(clipData.content).toBe('Hello World');
      expect(clipData.style).toEqual(preset.style);
      expect(clipData.position).toEqual(preset.position);
      expect(clipData.rotation).toBe(preset.rotation);
      expect(clipData.opacity).toBe(preset.opacity);
    });

    it('should include shadow when preset has shadow', () => {
      const preset = getPresetById('lower-third')!;
      expect(preset.shadow).toBeDefined();

      const clipData = presetToTextClipData(preset, 'Name');
      expect(clipData.shadow).toEqual(preset.shadow);
    });

    it('should include outline when preset has outline', () => {
      const preset = getPresetById('subtitle-outline')!;
      expect(preset.outline).toBeDefined();

      const clipData = presetToTextClipData(preset, 'Subtitle');
      expect(clipData.outline).toEqual(preset.outline);
    });

    it('should not include shadow when preset has no shadow', () => {
      const preset = getPresetById('watermark')!;
      expect(preset.shadow).toBeUndefined();

      const clipData = presetToTextClipData(preset, 'Brand');
      expect(clipData.shadow).toBeUndefined();
    });

    it('should preserve all style properties', () => {
      const preset = getPresetById('tech-style')!;
      const clipData = presetToTextClipData(preset, 'Code');

      expect(clipData.style.fontFamily).toBe('Courier New');
      expect(clipData.style.color).toBe('#00FF00');
      expect(clipData.style.fontSize).toBe(36);
    });
  });
});
