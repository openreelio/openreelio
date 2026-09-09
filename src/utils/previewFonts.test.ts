import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_PREVIEW_FONT_FACES,
  cssFontShorthand,
  resolvePreviewFontFamily,
} from './previewFonts';
import { BUNDLED_TEXT_FONT_FAMILIES, DEFAULT_TEXT_FONT_FAMILY } from './textFonts';

/**
 * Feature: caption preview draft draws in the fonts the export embeds
 *
 * These are the two decisions every preview text surface makes before it draws:
 * which family, and how to spell it into a font string. Both used to be made
 * three times over, by hand, in three files that disagreed.
 */

const BUNDLED_FONTS_CSS = path.resolve(process.cwd(), 'src/styles/bundledFonts.css');
const BUNDLED_FONTS_RS = path.resolve(process.cwd(), 'src-tauri/src/core/text/bundled_fonts.rs');

interface CssFontFace {
  family: string;
  weight: number;
  src: string;
}

interface RustFontFace {
  family: string;
  weight: number;
  /** `file_name` from the macro — the TTF basename, without its extension. */
  fileName: string;
}

/**
 * Parses the `@font-face` blocks the preview stylesheet declares.
 *
 * The stylesheet is what actually registers the faces with the WebView, and it
 * is not reachable from a jsdom test any other way: nothing here imports CSS,
 * and jsdom would not fetch the font files if it did. Reading the source is how
 * a face declared in one place and not the other gets caught.
 */
function cssFontFaces(): CssFontFace[] {
  const source = fs.readFileSync(BUNDLED_FONTS_CSS, 'utf8');
  const faces: CssFontFace[] = [];

  for (const block of source.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = block[1];
    const family = body.match(/font-family:\s*'([^']+)'/)?.[1];
    const weight = body.match(/font-weight:\s*(\d+)/)?.[1];
    const src = body.match(/url\('([^']+)'\)/)?.[1];

    if (family && weight && src) {
      faces.push({ family, weight: Number(weight), src });
    }
  }

  return faces;
}

/**
 * Parses the text faces `bundled_fonts.rs` compiles into the export binary.
 *
 * The Rust registry is the side that decides which file a family at a weight
 * burns in as, so it is what the stylesheet has to be pinned against: a
 * `@font-face` that declares `font-weight: 700` while pointing at the Regular
 * TTF passes a file-exists check and still draws the draft in the wrong face.
 *
 * `FaceRole::Fallback` entries are skipped. They are reached per glyph, never
 * named by a style, and `bundledFonts.css` deliberately does not register them.
 */
function rustFontFaces(): RustFontFace[] {
  const source = fs.readFileSync(BUNDLED_FONTS_RS, 'utf8');
  const faces: RustFontFace[] = [];

  for (const call of source.matchAll(
    /bundled_font!\(\s*"([^"]+)",\s*"([^"]+)",\s*"[^"]+"(?:\s*,\s*FaceRole::(\w+))?\s*,?\s*\)/g,
  )) {
    const [, family, fileName, role] = call;
    if (role !== undefined && role !== 'Text') {
      continue;
    }

    faces.push({ family, weight: fileName.endsWith('-Bold') ? 700 : 400, fileName });
  }

  return faces;
}

describe('previewFonts', () => {
  describe('cssFontShorthand', () => {
    it('should quote a multi-word family', () => {
      // Not because it has to: `48px Bebas Neue` is a valid shorthand, an
      // identifier *sequence* being one of the two family syntaxes. It is
      // quoted because one form for every name is what keeps the three
      // surfaces that build this string from drifting apart again.
      expect(cssFontShorthand({ fontFamily: 'Bebas Neue', fontSizePx: 48, fontWeight: 400 })).toBe(
        '400 48px "Bebas Neue"',
      );
    });

    it('should quote a family an identifier sequence cannot spell', () => {
      // These are the names quoting is actually load-bearing for, and a family
      // name arrives straight out of a style a user, an imported project or an
      // agent wrote, so none of them can be ruled out: a leading digit and a
      // CSS-wide keyword are both invalid unquoted, and punctuation would end
      // the family component early.
      expect(cssFontShorthand({ fontFamily: '4Real Display', fontSizePx: 12 })).toBe(
        '12px "4Real Display"',
      );
      expect(cssFontShorthand({ fontFamily: 'inherit', fontSizePx: 12 })).toBe('12px "inherit"');
      expect(cssFontShorthand({ fontFamily: 'Comic, Sans', fontSizePx: 12 })).toBe(
        '12px "Comic, Sans"',
      );
    });

    it('should work for a single-word family', () => {
      expect(cssFontShorthand({ fontFamily: 'Anton', fontSizePx: 24, fontWeight: 400 })).toBe(
        '400 24px "Anton"',
      );
    });

    it('should include the italic keyword and the weight in shorthand order', () => {
      expect(
        cssFontShorthand({
          fontFamily: 'Poppins',
          fontSizePx: 18,
          fontWeight: 700,
          italic: true,
        }),
      ).toBe('italic 700 18px "Poppins"');
    });

    it('should omit the weight when the style does not carry one', () => {
      expect(cssFontShorthand({ fontFamily: 'Anton', fontSizePx: 18 })).toBe('18px "Anton"');
    });

    it('should resolve the family before writing it out', () => {
      expect(cssFontShorthand({ fontFamily: 'Arial', fontSizePx: 20, fontWeight: 400 })).toBe(
        `400 20px "${DEFAULT_TEXT_FONT_FAMILY}"`,
      );
    });

    it('should escape a quote in a family name rather than ending the string early', () => {
      // A family name comes straight out of a style a user or an agent wrote.
      expect(cssFontShorthand({ fontFamily: 'My "Font"', fontSizePx: 12 })).toBe(
        '12px "My \\"Font\\""',
      );
    });

    it('should clamp a weight the shorthand would not accept', () => {
      // A numeric `font-weight` outside 100-900 invalidates the declaration,
      // and the browser drops the whole shorthand rather than the one bad
      // component — the same failure mode a broken size has.
      expect(cssFontShorthand({ fontFamily: 'Anton', fontSizePx: 24, fontWeight: 0 })).toBe(
        '100 24px "Anton"',
      );
      expect(cssFontShorthand({ fontFamily: 'Anton', fontSizePx: 24, fontWeight: -400 })).toBe(
        '100 24px "Anton"',
      );
      expect(cssFontShorthand({ fontFamily: 'Anton', fontSizePx: 24, fontWeight: 1500 })).toBe(
        '900 24px "Anton"',
      );
    });

    it('should pass a weight inside the accepted range through untouched', () => {
      expect(cssFontShorthand({ fontFamily: 'Anton', fontSizePx: 24, fontWeight: 100 })).toBe(
        '100 24px "Anton"',
      );
      expect(cssFontShorthand({ fontFamily: 'Anton', fontSizePx: 24, fontWeight: 900 })).toBe(
        '900 24px "Anton"',
      );
    });

    it('should fall back to a drawable size when the style carries a broken one', () => {
      // A NaN size spells `NaNpx` and invalidates the whole shorthand; a zero
      // one parses and then draws nothing. Neither is what the style meant.
      expect(cssFontShorthand({ fontFamily: 'Anton', fontSizePx: Number.NaN })).toBe('1px "Anton"');
      expect(cssFontShorthand({ fontFamily: 'Anton', fontSizePx: 0 })).toBe('1px "Anton"');
    });
  });

  describe('resolvePreviewFontFamily', () => {
    it('should map the Arial placeholder onto the bundled family the export substitutes', () => {
      expect(resolvePreviewFontFamily('Arial')).toBe(DEFAULT_TEXT_FONT_FAMILY);
      expect(resolvePreviewFontFamily('  arial ')).toBe(DEFAULT_TEXT_FONT_FAMILY);
    });

    it('should leave a bundled family unchanged', () => {
      for (const family of BUNDLED_TEXT_FONT_FAMILIES) {
        expect(resolvePreviewFontFamily(family)).toBe(family);
      }
    });

    it('should normalize a bundled family to the spelling the stylesheet declares', () => {
      // Presets and imported projects disagree about casing and spacing, and
      // the export resolves all of them onto the same face. A preview matching
      // only the exact string would draw one spelling in a host font.
      expect(resolvePreviewFontFamily('bebasneue')).toBe('Bebas Neue');
      expect(resolvePreviewFontFamily('BEBAS  NEUE')).toBe('Bebas Neue');
    });

    it('should leave a host family the user deliberately picked unchanged', () => {
      // Export renders these through libass' host font provider, so the draft
      // resolving them against the host is the matching behaviour.
      for (const family of ['Helvetica', 'Georgia', 'Impact', 'Comic Sans MS']) {
        expect(resolvePreviewFontFamily(family)).toBe(family);
      }
    });

    it('should fall back to the default family when no family is stored', () => {
      expect(resolvePreviewFontFamily('')).toBe(DEFAULT_TEXT_FONT_FAMILY);
      expect(resolvePreviewFontFamily('   ')).toBe(DEFAULT_TEXT_FONT_FAMILY);
      expect(resolvePreviewFontFamily(null)).toBe(DEFAULT_TEXT_FONT_FAMILY);
      expect(resolvePreviewFontFamily(undefined)).toBe(DEFAULT_TEXT_FONT_FAMILY);
    });
  });

  describe('stylesheet parity', () => {
    it('should declare a @font-face for every family the picker offers as bundled', () => {
      const declared = new Set(cssFontFaces().map((face) => face.family));

      expect(declared.size).toBeGreaterThan(0);
      for (const family of BUNDLED_TEXT_FONT_FAMILIES) {
        expect(
          declared.has(family),
          `src/styles/bundledFonts.css declares no face for ${family}, so the preview ` +
            'would draw it in a host font while the export embeds the bundled one.',
        ).toBe(true);
      }
    });

    it('should keep the face list in step with the stylesheet', () => {
      const fromCss = cssFontFaces().map((face) => ({
        family: face.family,
        weight: face.weight,
      }));

      expect(fromCss).toEqual([...BUNDLED_PREVIEW_FONT_FACES]);
    });

    it('should point every declared face at the exact file the exporter embeds', () => {
      // The URLs are relative to the stylesheet and reach out of `src/` into
      // the crate's font directory, so a moved file breaks the preview and
      // nothing else. Existence alone is not enough, though: a bold face whose
      // `src` pointed at the Regular TTF would satisfy it and still draw the
      // draft in a face the export does not use, so the basename is pinned to
      // the registry entry for that family and weight.
      const rustFaces = rustFontFaces();
      expect(rustFaces.length).toBeGreaterThan(0);

      for (const face of cssFontFaces()) {
        const label = `${face.family} @ ${face.weight}: ${face.src}`;
        const resolved = path.resolve(path.dirname(BUNDLED_FONTS_CSS), face.src);
        expect(fs.existsSync(resolved), label).toBe(true);

        const rustFace = rustFaces.find(
          (candidate) => candidate.family === face.family && candidate.weight === face.weight,
        );
        expect(
          rustFace,
          `${label} — bundled_fonts.rs compiles in no such family at that weight.`,
        ).toBeDefined();
        expect(path.basename(face.src), label).toBe(`${rustFace?.fileName}.ttf`);
      }
    });

    it('should register the bold face for every family the exporter compiles one in for', () => {
      // Without its own `@font-face` the browser synthesizes a bold from the
      // regular outlines while the export embeds a drawn one, so a bold caption
      // is the case where the draft and the file disagree most visibly.
      const rustBoldFamilies = [
        ...new Set(
          rustFontFaces()
            .filter((face) => face.weight === 700)
            .map((face) => face.family),
        ),
      ];

      expect(rustBoldFamilies.length).toBeGreaterThan(0);
      expect(
        cssFontFaces()
          .filter((face) => face.weight === 700)
          .map((face) => face.family),
      ).toEqual(rustBoldFamilies);
    });
  });
});
