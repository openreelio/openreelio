import { describe, expect, it } from 'vitest';

import { getExportPreset, getPresetExtension } from './constants';

describe('export constants', () => {
  it('derives preset extensions from the preset container', () => {
    expect(getPresetExtension('webm_vp9')).toBe('webm');
    expect(getPresetExtension('prores')).toBe('mov');
  });

  it('throws when an unknown preset is requested', () => {
    expect(() => getExportPreset('missing-preset')).toThrow('Unknown export preset: missing-preset');
    expect(() => getPresetExtension('missing-preset')).toThrow(
      'Unknown export preset: missing-preset',
    );
  });
});
