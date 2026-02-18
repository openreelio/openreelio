import { describe, it, expect } from 'vitest';
import {
  collectStepValueReferences,
  getValueAtReferencePath,
  isStepValueReference,
  normalizeReferencesForValidation,
  resolveStepValueReferences,
} from './stepReferences';

describe('stepReferences', () => {
  it('detects and collects nested step references', () => {
    const args = {
      assetId: { $fromStep: 'step-1', $path: 'data.assetId' },
      style: {
        color: 'white',
        fallbackClipId: { $fromStep: 'step-2', $path: 'data.clipId' },
      },
    };

    const references = collectStepValueReferences(args);
    expect(references).toHaveLength(2);
    expect(references[0]?.sourcePath).toBe('$.assetId');
    expect(references[1]?.sourcePath).toBe('$.style.fallbackClipId');
  });

  it('resolves references against prior step results', () => {
    const args = {
      assetId: { $fromStep: 'step-1', $path: 'data.assetId' },
      clipName: { $fromStep: 'step-1', $path: 'data.name', $default: 'fallback-name' },
    };

    const result = resolveStepValueReferences(args, (reference) => {
      if (reference.$path === 'data.assetId') {
        return { ok: true as const, value: 'asset-123' };
      }
      return { ok: false as const, reason: 'missing path' };
    });

    expect(result.errors).toHaveLength(1);
    expect(result.value).toMatchObject({ assetId: 'asset-123', clipName: undefined });
    expect(result.referencedStepIds).toEqual(['step-1']);
  });

  it('normalizes references into schema-compatible placeholders for validation', () => {
    const args = {
      assetId: { $fromStep: 'step-1', $path: 'data.assetId' },
      timelineStart: { $fromStep: 'step-1', $path: 'data.startTime' },
      shouldMute: { $fromStep: 'step-2', $path: 'data.muted' },
    };

    const schema = {
      type: 'object',
      properties: {
        assetId: { type: 'string' },
        timelineStart: { type: 'number' },
        shouldMute: { type: 'boolean' },
      },
    };

    const normalized = normalizeReferencesForValidation(args, schema) as Record<string, unknown>;

    expect(normalized.assetId).toBe('ref:step-1.data.assetId');
    expect(normalized.timelineStart).toBe(0);
    expect(normalized.shouldMute).toBe(false);
  });

  it('reads values from dot and bracket paths', () => {
    const source = {
      data: {
        assets: [{ id: 'asset-1' }],
      },
    };

    const match = getValueAtReferencePath(source, 'data.assets[0].id');
    expect(match).toEqual({ found: true, value: 'asset-1' });
    expect(getValueAtReferencePath(source, 'data.assets[2].id')).toEqual({ found: false });
  });

  it('validates reference shape strictly', () => {
    expect(isStepValueReference({ $fromStep: 'step-1', $path: 'data.assetId' })).toBe(true);
    expect(isStepValueReference({ $fromStep: '', $path: 'data.assetId' })).toBe(false);
    expect(isStepValueReference({ $fromStep: 'step-1' })).toBe(false);
  });
});
