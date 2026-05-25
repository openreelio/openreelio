import { describe, expect, it } from 'vitest';
import { DEFAULT_TEXT_FONT_FAMILIES, mergeTextFontFamilies } from './textFonts';

describe('textFonts', () => {
  it('should merge selected, system, and fallback fonts without duplicates', () => {
    expect(
      mergeTextFontFamilies(['Custom Sans'], ['Arial', 'Custom Sans'], DEFAULT_TEXT_FONT_FAMILIES),
    ).toEqual(expect.arrayContaining(['Custom Sans', 'Arial', 'Noto Sans KR']));
  });

  it('should preserve priority order when merging font families', () => {
    expect(mergeTextFontFamilies(['B'], ['A', 'B'], ['C'])).toEqual(['B', 'A', 'C']);
  });
});
