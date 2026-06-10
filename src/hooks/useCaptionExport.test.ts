import { describe, expect, it } from 'vitest';
import type { Caption } from '@/types';
import { prepareCaptionsForExport } from './useCaptionExport';

function caption(overrides: Partial<Caption>): Caption {
  return {
    id: overrides.id ?? 'caption_1',
    startSec: overrides.startSec ?? 0,
    endSec: overrides.endSec ?? 1,
    text: overrides.text ?? 'Caption',
    speaker: overrides.speaker,
    styleOverride: overrides.styleOverride,
    positionOverride: overrides.positionOverride,
    metadata: overrides.metadata,
  };
}

describe('prepareCaptionsForExport', () => {
  it('should sort captions by timeline time before export', () => {
    const prepared = prepareCaptionsForExport([
      caption({ id: 'late', startSec: 4, endSec: 5, text: 'Second' }),
      caption({ id: 'early', startSec: 1, endSec: 2, text: 'First' }),
    ]);

    expect(prepared.map((item) => item.text)).toEqual(['First', 'Second']);
  });

  it('should strip style tags and normalize caption text safely', () => {
    const prepared = prepareCaptionsForExport([
      caption({
        text: '<i>Hello</i>\r\n<v Narrator>world</v>\n\n',
        speaker: 'Narrator',
      }),
    ]);

    expect(prepared).toEqual([
      {
        startSec: 0,
        endSec: 1,
        text: 'Hello\nworld',
        speaker: 'Narrator',
      },
    ]);
  });

  it('should drop captions with invalid timing or empty text', () => {
    const prepared = prepareCaptionsForExport([
      caption({ id: 'valid', startSec: 1, endSec: 2, text: 'Valid' }),
      caption({ id: 'empty', startSec: 2, endSec: 3, text: '   ' }),
      caption({ id: 'negative', startSec: -1, endSec: 1, text: 'Nope' }),
      caption({ id: 'inverted', startSec: 4, endSec: 3, text: 'Nope' }),
      caption({ id: 'nan', startSec: Number.NaN, endSec: 5, text: 'Nope' }),
    ]);

    expect(prepared).toEqual([
      {
        startSec: 1,
        endSec: 2,
        text: 'Valid',
        speaker: null,
      },
    ]);
  });
});
