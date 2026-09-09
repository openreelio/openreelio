import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_TEXT_FONT_FAMILIES,
  DEFAULT_TEXT_FONT_FAMILY,
  DEFAULT_TEXT_FONT_FAMILIES,
  mergeTextFontFamilies,
} from './textFonts';

/**
 * The Rust registry is the source of truth for what is compiled into the
 * binary; the constants in `textFonts.ts` are a hand-written copy of it, and a
 * copy with no guard is a copy that drifts. These tests read the registry
 * itself so a family added, removed or renamed on that side cannot quietly
 * leave the picker offering a face the exporter does not ship (or hiding one it
 * does).
 */
const BUNDLED_FONTS_RS = path.resolve(process.cwd(), 'src-tauri/src/core/text/bundled_fonts.rs');

const SYNC_HINT =
  'src/utils/textFonts.ts mirrors src-tauri/src/core/text/bundled_fonts.rs by hand; ' +
  'update the copy to match the registry.';

function readBundledFontsSource(): string {
  return fs.readFileSync(BUNDLED_FONTS_RS, 'utf8');
}

/** Families the Rust registry compiles in, in registry order, deduplicated. */
function rustBundledFamilies(): string[] {
  const source = readBundledFontsSource();
  const families: string[] = [];

  for (const match of source.matchAll(/bundled_font!\(\s*"([^"]+)"/g)) {
    const family = match[1];
    if (!families.includes(family)) {
      families.push(family);
    }
  }

  return families;
}

/** The family the Rust registry substitutes when nothing was picked. */
function rustDefaultFamily(): string {
  const source = readBundledFontsSource();
  const match = source.match(/pub const DEFAULT_BUNDLED_FAMILY: &str = "([^"]+)";/);
  return match?.[1] ?? '';
}

describe('textFonts', () => {
  it('should merge selected, system, and fallback fonts without duplicates', () => {
    expect(
      mergeTextFontFamilies(['Custom Sans'], ['Arial', 'Custom Sans'], DEFAULT_TEXT_FONT_FAMILIES),
    ).toEqual(expect.arrayContaining(['Custom Sans', 'Arial', 'Noto Sans KR']));
  });

  it('should preserve priority order when merging font families', () => {
    expect(mergeTextFontFamilies(['B'], ['A', 'B'], ['C'])).toEqual(['B', 'A', 'C']);
  });

  describe('Rust registry parity', () => {
    it('should list exactly the families the Rust registry compiles in', () => {
      const rustFamilies = rustBundledFamilies();

      expect(
        rustFamilies.length,
        `${SYNC_HINT} No bundled_font! entries were parsed.`,
      ).toBeGreaterThan(0);
      expect(BUNDLED_TEXT_FONT_FAMILIES, SYNC_HINT).toEqual(rustFamilies);
    });

    it('should default to the family the Rust registry defaults to', () => {
      expect(DEFAULT_TEXT_FONT_FAMILY, SYNC_HINT).toBe(rustDefaultFamily());
    });

    it('should offer every bundled family ahead of the host suggestions', () => {
      expect(DEFAULT_TEXT_FONT_FAMILIES.slice(0, BUNDLED_TEXT_FONT_FAMILIES.length)).toEqual(
        BUNDLED_TEXT_FONT_FAMILIES,
      );
    });
  });
});
