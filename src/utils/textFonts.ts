/**
 * Families compiled into the app and the CLI, so burn-in never depends on the
 * host having them installed.
 *
 * Offered first in every font picker because they are the only ones guaranteed
 * to render the same in the preview and in the exported file. Mirrors
 * `BUNDLED_FONTS` in `src-tauri/src/core/text/bundled_fonts.rs`; a family listed
 * here that is not compiled in there just falls back to a host font, which is
 * the behaviour for any other unbundled family.
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

export const DEFAULT_TEXT_FONT_FAMILIES = [
  ...BUNDLED_TEXT_FONT_FAMILIES,
  'Arial',
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
