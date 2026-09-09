/**
 * Preview Font Resolution
 *
 * One place for the two things every live-preview text surface has to get right
 * before it can claim to be drafting what the export will burn in:
 *
 * 1. **Which family.** The backend maps a placeholder family onto a bundled
 *    face before it embeds anything (`resolve_placeholder_alias` in
 *    `src-tauri/src/core/text/bundled_fonts.rs`). A preview that skipped that
 *    step drew a projected-in-'Arial' caption in the host's Arial while the
 *    export burned it in TikTok Sans.
 * 2. **A font string the browser accepts.** The canvas `font` property takes
 *    the CSS `font` *shorthand*, whose family component is an identifier
 *    sequence or a string. `24px TikTok Sans` parses as far as `TikTok`, fails,
 *    and is discarded whole — leaving the context on its `10px sans-serif`
 *    default with no error anywhere. Every multi-word bundled family (six of
 *    the eight, including the default) hit that.
 *
 * The three canvas surfaces that draw or measure text — `textRenderer`,
 * `TimelinePreviewPlayer`'s caption pass and `transformOverlayGeometry` — all
 * built that string by hand and drifted; the overlay measuring in one font
 * while the renderer drew in another is how selection handles end up somewhere
 * other than the glyphs. They share [`cssFontShorthand`] now.
 *
 * None of this makes the draft pixel-identical to the export: it still does not
 * word-wrap, and its metrics are the browser's rather than libass'. It makes
 * the draft use the *same faces*, which is the difference between "roughly
 * where the caption goes" and "a different typeface than you will ship".
 * `PreviewDraftBadge` is what says so on screen.
 *
 * TODO(preview-parity): the export composites colour emoji from the bundled
 * Fluent pack (`src-tauri/emoji/`, 1595 PNGs behind a `manifest.json`), while
 * the draft draws the host's colour emoji font — close, but not the same
 * artwork. Reaching the pack from the WebView means resolving a Tauri resource
 * path and converting it per glyph through `convertFileSrc`, which only works
 * inside the packaged app and would have to degrade for the browser dev server
 * and the test environment. That is a feature, not a cleanup, so the draft
 * keeps the host emoji for now; the badge already says the draft is a draft.
 */

import {
  BUNDLED_TEXT_FONT_FAMILIES,
  DEFAULT_TEXT_FONT_FAMILY,
  PLACEHOLDER_FONT_FAMILY_ALIASES,
} from './textFonts';

/** A face `src/styles/bundledFonts.css` registers with the WebView. */
export interface BundledPreviewFontFace {
  /** Family name, exactly as the Rust registry and a stored style spell it. */
  readonly family: string;
  /** Weight the `@font-face` block declares. */
  readonly weight: number;
}

/**
 * Every face the preview stylesheet registers, in registry order.
 *
 * A hand-kept mirror of `src/styles/bundledFonts.css`, which cannot be read at
 * runtime: `previewFonts.test.ts` parses that stylesheet and fails when the two
 * disagree, so a face added to the CSS and not here (or the reverse) cannot
 * quietly leave [`ensureBundledPreviewFontsLoaded`] waiting on nothing.
 *
 * A family with no bold entry is one the exporter ships in a single weight; the
 * browser synthesizes a bold for it exactly as libass does.
 */
export const BUNDLED_PREVIEW_FONT_FACES: readonly BundledPreviewFontFace[] = [
  { family: 'TikTok Sans', weight: 400 },
  { family: 'TikTok Sans', weight: 700 },
  { family: 'Montserrat', weight: 400 },
  { family: 'Montserrat', weight: 700 },
  { family: 'Anton', weight: 400 },
  { family: 'Archivo Black', weight: 400 },
  { family: 'Bebas Neue', weight: 400 },
  { family: 'Poppins', weight: 400 },
  { family: 'Poppins', weight: 700 },
  { family: 'Bangers', weight: 400 },
  { family: 'Luckiest Guy', weight: 400 },
];

/**
 * Lookup key for a family name.
 *
 * Mirrors `lookup_key` in `bundled_fonts.rs`: presets, imported projects and
 * hand-typed style edits disagree about casing and spacing ('Bebas Neue',
 * 'bebasneue', 'BEBAS  NEUE'), and the backend resolves all three onto the same
 * face. A preview that matched only the exact string would draw one of them in
 * a host font and the other two in the bundled face.
 */
function fontLookupKey(family: string): string {
  return family.replace(/\s+/g, '').toLowerCase();
}

const BUNDLED_FAMILY_BY_KEY = new Map(
  BUNDLED_TEXT_FONT_FAMILIES.map((family) => [fontLookupKey(family), family]),
);

const PLACEHOLDER_ALIAS_BY_KEY = new Map(
  PLACEHOLDER_FONT_FAMILY_ALIASES.map(([placeholder, bundled]) => [
    fontLookupKey(placeholder),
    bundled,
  ]),
);

/**
 * Returns the family the preview should draw a stored family name with.
 *
 * Mirrors what the export path resolves before it embeds a face, in the same
 * order:
 *
 * - a bundled family resolves to its canonical spelling, so the CSS
 *   `@font-face` rules — which are declared under the canonical name — match;
 * - a placeholder family ('Arial', the literal every default emitted before the
 *   defaults named a shipped face) resolves to the bundled family the exporter
 *   substitutes for it;
 * - anything else is a family the user deliberately picked, and is returned
 *   untouched so the host renders it — which is also what export does, through
 *   libass' host font provider;
 * - an empty or whitespace-only name resolves to the default family, matching
 *   the `font_family` fallback on both render paths.
 *
 * @param family - Family name as a caption or text style stores it.
 * @returns The family name to hand to CSS or to the canvas.
 */
export function resolvePreviewFontFamily(family: string | null | undefined): string {
  const trimmed = family?.trim() ?? '';
  if (trimmed.length === 0) {
    return DEFAULT_TEXT_FONT_FAMILY;
  }

  const key = fontLookupKey(trimmed);

  // Bundled first, and only then the alias table: a family that is itself
  // shipped is never a placeholder for another one.
  return BUNDLED_FAMILY_BY_KEY.get(key) ?? PLACEHOLDER_ALIAS_BY_KEY.get(key) ?? trimmed;
}

/**
 * Quotes a family name for a CSS `font-family` component.
 *
 * A quoted string is the only family syntax that survives a multi-word name in
 * the `font` shorthand. The escaping is not paranoia: a family name reaches
 * here straight from a style a user, an imported project or an agent wrote, and
 * an unescaped quote in one would terminate the string and turn the rest of the
 * shorthand into garbage the browser discards — the same silent failure this
 * function exists to remove.
 */
function quoteCssFontFamily(family: string): string {
  return `"${family.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The pieces of a text style a CSS `font` shorthand is built from. */
export interface PreviewFontShorthandInput {
  /** Family name as the style stores it; resolved before it is written out. */
  fontFamily: string | null | undefined;
  /** Rendered size in the target coordinate space, in pixels. */
  fontSizePx: number;
  /** Numeric CSS weight. Omitted from the shorthand when not given. */
  fontWeight?: number;
  /** Whether to emit the `italic` style keyword. */
  italic?: boolean;
}

/**
 * Builds a CSS `font` shorthand for a canvas 2D context.
 *
 * @param input - Family, size, weight and slant from the text or caption style.
 * @returns A shorthand the canvas accepts, with the family resolved and quoted.
 *
 * @example
 * cssFontShorthand({ fontFamily: 'Arial', fontSizePx: 48, fontWeight: 700 });
 * // 'bold' Arial is a placeholder, so this is `700 48px "TikTok Sans"`.
 */
export function cssFontShorthand(input: PreviewFontShorthandInput): string {
  const parts: string[] = [];

  if (input.italic) {
    parts.push('italic');
  }

  if (typeof input.fontWeight === 'number' && Number.isFinite(input.fontWeight)) {
    parts.push(String(Math.round(input.fontWeight)));
  }

  // A non-finite or non-positive size makes the whole shorthand invalid, which
  // is the failure this helper exists to prevent, so it is clamped rather than
  // passed through.
  const sizePx = Number.isFinite(input.fontSizePx) && input.fontSizePx > 0 ? input.fontSizePx : 1;

  parts.push(`${sizePx}px ${quoteCssFontFamily(resolvePreviewFontFamily(input.fontFamily))}`);

  return parts.join(' ');
}

let bundledFontsLoaded: Promise<void> | null = null;

/**
 * Asks the browser to load every bundled face, once per session.
 *
 * `@font-face` is lazy: the bytes are fetched the first time layout wants the
 * family. The DOM overlay gets a reflow when that lands, but a canvas does not
 * — `ctx.measureText` before the load returns fallback metrics, the frame is
 * drawn with them, and nothing redraws it. Loading up front is what keeps the
 * first caption frame from being the wrong one.
 *
 * Resolves (rather than rejecting) when the environment has no font loader or a
 * face fails: the draft is still drawn, just in a fallback face, and a preview
 * that threw here would take the player down with it.
 *
 * @returns A promise that settles when the faces are loaded or known unloadable.
 */
export function ensureBundledPreviewFontsLoaded(): Promise<void> {
  if (bundledFontsLoaded) {
    return bundledFontsLoaded;
  }

  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts || typeof fonts.load !== 'function') {
    bundledFontsLoaded = Promise.resolve();
    return bundledFontsLoaded;
  }

  bundledFontsLoaded = Promise.all(
    BUNDLED_PREVIEW_FONT_FACES.map((face) =>
      // The size is arbitrary — `load` matches a face, not a rendering — but the
      // shorthand still has to parse, so it goes through the same builder.
      fonts
        .load(
          cssFontShorthand({ fontFamily: face.family, fontSizePx: 16, fontWeight: face.weight }),
        )
        .catch(() => undefined),
    ),
  ).then(() => undefined);

  return bundledFontsLoaded;
}
