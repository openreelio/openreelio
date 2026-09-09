/**
 * Families compiled into the app and the CLI, so burn-in never depends on the
 * host having them installed.
 *
 * Offered first in every font picker because they are the only ones that render
 * the same in the *exported file* on every machine. That guarantee is about the
 * export path only: the live preview draws text with the webview's own fonts,
 * and these faces are not registered as `@font-face` yet, so a preview can wrap
 * differently from the burn-in. Mirrors `BUNDLED_FONTS` in
 * `src-tauri/src/core/text/bundled_fonts.rs`; a family listed here that is not
 * compiled in there just falls back to a host font, which is the behaviour for
 * any other unbundled family.
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
 * `src-tauri/src/core/text/bundled_fonts.rs`. Naming a bundled face rather than
 * an unshipped one ('Arial', historically) means a fresh clip stores the family
 * that actually renders it.
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
