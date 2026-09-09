/**
 * Families compiled into the app and the CLI, so burn-in never depends on the
 * host having them installed.
 *
 * Offered first in every font picker because they are the only ones that render
 * the same in the *exported file* on every machine. That guarantee is about the
 * export path only: the live preview draws text with the webview's own fonts,
 * and these faces are not registered as `@font-face` yet, so a preview can wrap
 * differently from the burn-in.
 *
 * A hand-written mirror of `BUNDLED_FONTS` in
 * `src-tauri/src/core/text/bundled_fonts.rs`, which is the source of truth: it
 * is what the exporter actually compiles in. `textFonts.test.ts` reads that
 * file and fails when the two disagree, because a family listed here but not
 * compiled in there silently falls back to a host font — the opposite of the
 * guarantee this list advertises.
 *
 * TODO(preview-parity): register these faces as `@font-face` and mirror the
 * backend's placeholder alias so the preview draft matches the export.
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
