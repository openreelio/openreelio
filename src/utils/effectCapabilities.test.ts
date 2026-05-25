import { describe, expect, it } from 'vitest';
import {
  buildEffectCapabilityRegistry,
  getEffectCapability,
  getEffectCapabilityBadge,
  type EffectCapabilityRecord,
} from './effectCapabilities';

const records: EffectCapabilityRecord[] = [
  {
    effectType: 'text_overlay',
    preview: 'supported',
    export: 'supported',
    renderCache: 'supported',
    ffmpegFilter: 'drawtext',
    exportReason: null,
    previewReason: null,
  },
  {
    effectType: 'brightness',
    preview: 'unsupported',
    export: 'supported',
    renderCache: 'supported',
    ffmpegFilter: 'eq',
    exportReason: null,
    previewReason: 'Preview renderer does not implement this effect yet.',
  },
  {
    effectType: 'background_removal',
    preview: 'unsupported',
    export: 'unsupported',
    renderCache: 'unsupported',
    ffmpegFilter: null,
    exportReason: 'Background removal must be baked before export.',
    previewReason: null,
  },
];

describe('effectCapabilities', () => {
  const registry = buildEffectCapabilityRegistry(records);

  it('should mark text overlay as supported in preview and export from registry data', () => {
    const capability = getEffectCapability('text_overlay', registry);

    expect(capability.preview).toBe('supported');
    expect(capability.export).toBe('supported');
    expect(capability.renderCache).toBe('supported');
    expect(getEffectCapabilityBadge('text_overlay', registry).label).toBe('Full');
  });

  it('should mark FFmpeg-only effects as export only from registry data', () => {
    const capability = getEffectCapability('brightness', registry);

    expect(capability.preview).toBe('unsupported');
    expect(capability.export).toBe('supported');
    expect(getEffectCapabilityBadge('brightness', registry).label).toBe('Export only');
  });

  it('should mark AI setup effects as not renderable from registry data', () => {
    const capability = getEffectCapability('background_removal', registry);

    expect(capability.preview).toBe('unsupported');
    expect(capability.export).toBe('unsupported');
    expect(capability.renderCache).toBe('unsupported');
    expect(getEffectCapabilityBadge('background_removal', registry).label).toBe('Setup only');
  });

  it('should mark unknown custom effects as needing an explicit renderer', () => {
    const capability = getEffectCapability({ custom: 'third_party_glitch' }, registry);

    expect(capability.export).toBe('unsupported');
    expect(capability.exportReason).toContain('explicit renderer');
  });
});
