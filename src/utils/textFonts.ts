export const DEFAULT_TEXT_FONT_FAMILIES = [
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
  'Montserrat',
  'Poppins',
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
