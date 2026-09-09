/**
 * Families compiled into the app and the CLI, so burn-in never depends on the
 * host having them installed.
 *
 * Offered first in every font picker because they are the only ones that render
 * the same in the *exported file* on every machine. `src/styles/bundledFonts.css`
 * registers the same files as `@font-face` so the live preview draws each of
 * them in the face the export embeds; the draft still lays text out with the
 * browser's rules rather than libass', so it can wrap differently, but it no
 * longer shows a different typeface.
 *
 * A hand-written mirror of `BUNDLED_FONTS` in
 * `src-tauri/src/core/text/bundled_fonts.rs`, which is the source of truth: it
 * is what the exporter actually compiles in. `textFonts.test.ts` reads that
 * file and fails when the two disagree, because a family listed here but not
 * compiled in there silently falls back to a host font — the opposite of the
 * guarantee this list advertises.
 */
export const BUNDLED_TEXT_FONT_FAMILIES = [
  'TikTok Sans',
  'Montserrat',
  'Anton',
  'Archivo Black',
  'Bebas Neue',
  'Poppins',
  'Bangers',
  'Luckiest Guy',
];

/**
 * Family a new caption or text clip carries when the user picked none.
 *
 * Mirrors `DEFAULT_TEXT_FONT_FAMILY` in
 * `src-tauri/src/core/text/bundled_fonts.rs`, which is the source of truth;
 * `textFonts.test.ts` pins the two together. Naming a bundled face rather than
 * an unshipped one ('Arial', historically) means a fresh clip stores the family
 * that actually renders it. Every "no font was picked" default on this side —
 * `DEFAULT_CAPTION_STYLE`, `DEFAULT_TEXT_STYLE`, the text preset catalog, the
 * caption track default — names this rather than a literal of its own.
 */
export const DEFAULT_TEXT_FONT_FAMILY = 'TikTok Sans';

/**
 * Families this codebase wrote as its own "no font was chosen" placeholder,
 * mapped onto the bundled face that renders them.
 *
 * A hand-written mirror of `PLACEHOLDER_FAMILY_ALIASES` in
 * `src-tauri/src/core/text/bundled_fonts.rs`, which is the source of truth;
 * `textFonts.test.ts` reads that file and fails when the two disagree.
 *
 * The preview needs its own copy because it has to resolve a family the same
 * way the exporter does *before* it draws: a caption stored with the historical
 * 'Arial' placeholder burns in as TikTok Sans, so a draft that took 'Arial'
 * literally would show the host's Arial for a caption that ships in a different
 * typeface. `resolvePreviewFontFamily` in `previewFonts.ts` is what applies it.
 *
 * Back-compat only, exactly as on the Rust side: every live default names
 * {@link DEFAULT_TEXT_FONT_FAMILY} directly, so only op logs written before
 * that change reach this table. Do not add a family a user can deliberately
 * pick — Helvetica, Georgia and Impact are choices, and aliasing one away would
 * silently override it.
 */
export const PLACEHOLDER_FONT_FAMILY_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['Arial', DEFAULT_TEXT_FONT_FAMILY],
];

export const DEFAULT_TEXT_FONT_FAMILIES = [
  ...BUNDLED_TEXT_FONT_FAMILIES,
  'Helvetica',
  'Verdana',
  'Inter',
  'Roboto',
  'Noto Sans',
  'Noto Sans KR',
  'Pretendard',
  'Apple SD Gothic Neo',
  'Malgun Gothic',
  'Nanum Gothic',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Impact',
  'Oswald',
];

export function mergeTextFontFamilies(
  ...groups: Array<Iterable<string | null | undefined> | null | undefined>
): string[] {
  const seen = new Set<string>();
  const families: string[] = [];

  for (const group of groups) {
    if (!group) {
      continue;
    }

    for (const rawFamily of group) {
      const family = rawFamily?.trim();
      if (!family || seen.has(family)) {
        continue;
      }

      seen.add(family);
      families.push(family);
    }
  }

  return families;
}
