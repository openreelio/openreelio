import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_TEXT_FONT_FAMILIES,
  DEFAULT_TEXT_FONT_FAMILY,
  DEFAULT_TEXT_FONT_FAMILIES,
  PLACEHOLDER_FONT_FAMILY_ALIASES,
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

/**
 * Families the Rust registry lets a style name, in registry order, deduplicated.
 *
 * `FaceRole::Fallback` entries are skipped. Those faces are compiled in and
 * embedded, but they are reached per glyph through the export's font chain and
 * cover one script apiece - the bundled emoji face draws no Latin at all - so
 * offering one in the picker would let a caption be set in a typeface that
 * renders its words as notdef boxes.
 */
function rustTextFamilies(): string[] {
  const source = readBundledFontsSource();
  const families: string[] = [];

  for (const match of source.matchAll(/bundled_font!\(([^)]*)\)/g)) {
    const args = match[1];
    if (args.includes('FaceRole::Fallback')) {
      continue;
    }

    const family = args.match(/"([^"]+)"/)?.[1];
    if (family && !families.includes(family)) {
      families.push(family);
    }
  }

  return families;
}

/**
 * The placeholder aliases the Rust registry carries, in declaration order.
 *
 * `DEFAULT_BUNDLED_FAMILY` appears as an identifier rather than a literal in
 * the table, so it is substituted here the same way the compiler would.
 */
function rustPlaceholderAliases(): Array<[string, string]> {
  const source = readBundledFontsSource();
  const table = source.match(
    /const PLACEHOLDER_FAMILY_ALIASES: &\[\(&str, &str\)\] = &\[([\s\S]*?)\];/,
  )?.[1];
  if (!table) {
    return [];
  }

  const defaultFamily = source.match(/pub const DEFAULT_BUNDLED_FAMILY: &str = "([^"]+)";/)?.[1];

  return [...table.matchAll(/\(\s*"([^"]+)"\s*,\s*([^)]+?)\s*\)/g)].map((match) => {
    const target = match[2].trim();
    const literal = target.match(/^"([^"]+)"$/)?.[1];
    return [
      match[1],
      literal ?? (target === 'DEFAULT_BUNDLED_FAMILY' ? (defaultFamily ?? '') : target),
    ];
  });
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
    it('should list exactly the families the Rust registry lets a style name', () => {
      const rustFamilies = rustTextFamilies();

      expect(
        rustFamilies.length,
        `${SYNC_HINT} No bundled_font! entries were parsed.`,
      ).toBeGreaterThan(0);
      expect(BUNDLED_TEXT_FONT_FAMILIES, SYNC_HINT).toEqual(rustFamilies);
    });

    it('should default to the family the Rust registry defaults to', () => {
      expect(DEFAULT_TEXT_FONT_FAMILY, SYNC_HINT).toBe(rustDefaultFamily());
    });

    it('should not offer a fallback-only face as a typeface', () => {
      // The emoji face is compiled in and embedded, but it is reached per
      // glyph by the export's font chain. A picker offering it would let a
      // caption be set in a face that draws none of its letters.
      const match = readBundledFontsSource().match(
        /pub const EMOJI_FALLBACK_FAMILY: &str = "([^"]+)";/,
      );
      expect(match?.[1], SYNC_HINT).toBeTruthy();
      expect(BUNDLED_TEXT_FONT_FAMILIES, SYNC_HINT).not.toContain(match?.[1]);
      expect(DEFAULT_TEXT_FONT_FAMILIES, SYNC_HINT).not.toContain(match?.[1]);
    });

    it('should mirror the placeholder aliases the exporter resolves before embedding', () => {
      // The preview resolves a stored family through this table before it draws
      // (`resolvePreviewFontFamily`), so an alias here that the exporter does
      // not have — or the reverse — is a caption drafted in one typeface and
      // shipped in another.
      const rustAliases = rustPlaceholderAliases();

      expect(rustAliases.length, `${SYNC_HINT} No alias entries were parsed.`).toBeGreaterThan(0);
      expect(
        PLACEHOLDER_FONT_FAMILY_ALIASES.map(([a, b]) => [a, b]),
        SYNC_HINT,
      ).toEqual(rustAliases);
    });

    it('should alias only onto families the exporter actually ships', () => {
      for (const [placeholder, bundled] of PLACEHOLDER_FONT_FAMILY_ALIASES) {
        expect(BUNDLED_TEXT_FONT_FAMILIES, SYNC_HINT).toContain(bundled);
        // A family we ship needs no alias, and aliasing one away would override
        // a deliberate pick.
        expect(BUNDLED_TEXT_FONT_FAMILIES, SYNC_HINT).not.toContain(placeholder);
      }
    });

    it('should offer every bundled family ahead of the host suggestions', () => {
      expect(DEFAULT_TEXT_FONT_FAMILIES.slice(0, BUNDLED_TEXT_FONT_FAMILIES.length)).toEqual(
        BUNDLED_TEXT_FONT_FAMILIES,
      );
    });
  });
});
