/**
 * Text Presets Data Tests
 *
 * TDD: Tests for text preset data, categories, and converter functions.
 */

import { describe, it, expect } from 'vitest';
import {
  TEXT_PRESETS,
  getPresetById,
  getPresetByKey,
  getPresetsByCategory,
  presetToTextClipData,
  type TextPresetCategory,
} from './textPresets';
import textPresetManifest from './textPresets.manifest.json';

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
        'credit',
        'brand',
        'creative',
      ];

      TEXT_PRESETS.forEach((preset) => {
        expect(validCategories).toContain(preset.category);
      });
    });

    it('should include a production-sized preset library', () => {
      expect(TEXT_PRESETS.length).toBeGreaterThanOrEqual(12);
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
      // `label` is anchored top-left, so smart placement must treat it as a
      // corner annotation rather than relocating it to the lower third.
      expect(ids).toContain('label');
    });

    it('should assign creative presets correctly', () => {
      const creatives = TEXT_PRESETS.filter((p) => p.category === 'creative');
      const ids = creatives.map((p) => p.id);
      expect(ids).toContain('quote');
      expect(ids).toContain('tech-style');
      expect(ids).toContain('watermark');
    });

    it('should assign credit and brand presets correctly', () => {
      const credits = TEXT_PRESETS.filter((p) => p.category === 'credit');
      const brands = TEXT_PRESETS.filter((p) => p.category === 'brand');
      expect(credits.length).toBeGreaterThan(0);
      expect(brands.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // getPresetsByCategory
  // ===========================================================================

  describe('getPresetsByCategory', () => {
    it.each<TextPresetCategory>([
      'lower-third',
      'title',
      'subtitle',
      'callout',
      'credit',
      'brand',
      'creative',
    ])('should return correct presets for %s', (category) => {
      const presets = getPresetsByCategory(category);
      const expected = TEXT_PRESETS.filter((p) => p.category === category);
      expect(presets).toEqual(expected);
      expect(presets.every((p) => p.category === category)).toBe(true);
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

  // ===========================================================================
  // Rust core registry parity
  // ===========================================================================

  describe('core registry parity', () => {
    // The manifest is generated from src-tauri/src/core/style/text_presets.rs,
    // which is what the CLI, MCP, and the AddTextClip `preset` field read. When
    // this catalog and that registry disagree, an agent is told about presets
    // the backend rejects — the exact bug this pairing exists to prevent.
    const REGENERATE_HINT =
      'Update src-tauri/src/core/style/text_presets.rs, then run: ' +
      'cargo test -p openreelio --lib regenerate_text_preset_manifest -- --ignored';

    const manifestById = new Map(textPresetManifest.map((entry) => [entry.id, entry]));

    it('should cover exactly the presets the core registry defines', () => {
      const uiIds = TEXT_PRESETS.map((preset) => preset.id).sort();
      const coreIds = textPresetManifest.map((entry) => entry.id).sort();
      expect(uiIds, REGENERATE_HINT).toEqual(coreIds);
    });

    it.each(TEXT_PRESETS.map((preset) => [preset.id, preset] as const))(
      'should match the core registry for %s',
      (id, preset) => {
        const entry = manifestById.get(id);
        expect(entry, REGENERATE_HINT).toBeDefined();
        if (!entry) return;

        expect(entry.kind).toBe('text');
        expect(preset.name).toBe(entry.name);
        expect(preset.description).toBe(entry.description);
        expect(preset.category).toBe(entry.category);
        expect(preset.aliases ?? []).toEqual(entry.aliases);
        expect(preset.defaultDurationSec).toBe(entry.defaultDurationSec);
        expect(preset.defaultContent).toBe(entry.clip.content);

        // fontWeight is derived from `bold` on the Rust side rather than stored
        // here, so it is checked against the derivation instead of compared.
        const { fontWeight, ...style } = entry.clip.style as Record<string, unknown> & {
          fontWeight: number;
        };
        expect(fontWeight).toBe(preset.style.bold ? 700 : 400);
        expect(presetToTextClipData(preset, entry.clip.content)).toEqual({
          ...entry.clip,
          style,
        });
      },
    );

    it('should accept the separator spellings the core normalizer accepts', () => {
      // normalize_pack_id in src-tauri/src/core/style/mod.rs collapses runs of
      // whitespace or underscores onto one hyphen, exactly as
      // normalizeTextPresetKey does. Both halves must take the same keys, or a
      // spelling the app resolves is a hard error on the CLI.
      ['lower  third', 'lower\tthird', 'lower _ third', 'lower__third', 'Lower  Third'].forEach(
        (key) => {
          expect(getPresetByKey(key)?.id, key).toBe('lower-third');
        },
      );
    });

    it('should resolve every core alias to the same preset', () => {
      textPresetManifest.forEach((entry) => {
        entry.aliases.forEach((alias) => {
          expect(getPresetByKey(alias)?.id, `alias ${alias}`).toBe(entry.id);
        });
        expect(getPresetByKey(entry.id)?.id).toBe(entry.id);
        expect(getPresetByKey(entry.name)?.id).toBe(entry.id);
      });
    });
  });
});
