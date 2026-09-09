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

interface CssFontFace {
  family: string;
  weight: number;
  src: string;
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

describe('previewFonts', () => {
  describe('cssFontShorthand', () => {
    it('should quote a multi-word family so the shorthand parses', () => {
      // Unquoted, `48px TikTok Sans` is not a valid `font` shorthand: the
      // canvas discards the whole assignment and stays on `10px sans-serif`.
      expect(cssFontShorthand({ fontFamily: 'Bebas Neue', fontSizePx: 48, fontWeight: 400 })).toBe(
        '400 48px "Bebas Neue"',
      );
    });

    it('should produce a shorthand a canvas actually accepts for a multi-word family', () => {
      const context = document.createElement('canvas').getContext('2d');
      // jsdom without `canvas` installed has no 2D context; the parse check is
      // the point of this test, so it is skipped rather than faked when the
      // environment cannot make one.
      if (!context) {
        return;
      }

      const before = context.font;
      context.font = cssFontShorthand({
        fontFamily: 'Archivo Black',
        fontSizePx: 32,
        fontWeight: 700,
      });

      expect(context.font).not.toBe(before);
      expect(context.font).toContain('32px');
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

    it('should fall back to a drawable size when the style carries a broken one', () => {
      // A zero or NaN size invalidates the whole shorthand, which is the exact
      // silent failure this helper exists to remove.
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

    it('should point every declared face at a font file that exists', () => {
      // The URLs are relative to the stylesheet and reach out of `src/` into
      // the crate's font directory, so a moved file breaks the preview and
      // nothing else.
      for (const face of cssFontFaces()) {
        const resolved = path.resolve(path.dirname(BUNDLED_FONTS_CSS), face.src);
        expect(fs.existsSync(resolved), `${face.family} @ ${face.weight}: ${face.src}`).toBe(true);
      }
    });

    it('should register the bold face for every family the exporter compiles one in for', () => {
      // Without its own `@font-face` the browser synthesizes a bold from the
      // regular outlines while the export embeds a drawn one, so a bold caption
      // is the case where the draft and the file disagree most visibly.
      const rustSource = fs.readFileSync(
        path.resolve(process.cwd(), 'src-tauri/src/core/text/bundled_fonts.rs'),
        'utf8',
      );
      const rustBoldFamilies = [
        ...new Set(
          [...rustSource.matchAll(/bundled_font!\(\s*"([^"]+)",\s*"([^"]+)-Bold"/g)].map(
            (match) => match[1],
          ),
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
