import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { globalToolRegistry } from '@/agents';
import { createToolRegistryAdapter } from '@/agents/engine/adapters/tools/ToolRegistryAdapter';
import { registerCaptionTools, unregisterCaptionTools } from './captionTools';
import {
  normalizeMetaToolArgsForValidation,
  registerMetaTools,
  unregisterMetaTools,
} from './metaTools';

describe('metaTools', () => {
  beforeEach(() => {
    globalToolRegistry.clear();
    registerCaptionTools();
    registerMetaTools();
  });

  afterEach(() => {
    unregisterMetaTools();
    unregisterCaptionTools();
    globalToolRegistry.clear();
  });

  it('should allow auto_transcribe without requiring sequenceId', () => {
    const adapter = createToolRegistryAdapter(globalToolRegistry);

    const valid = adapter.validateArgs('text', {
      action: 'auto_transcribe',
      assetId: 'asset-1',
    });
    const invalid = adapter.validateArgs('text', {
      action: 'add_caption',
      text: 'Hello world',
      startTime: 0,
      endTime: 1,
    });

    expect(valid.valid).toBe(true);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.some((error) => error.includes('sequenceId'))).toBe(true);
  });

  it('accepts safe action aliases when validating meta-tool calls', () => {
    const adapter = createToolRegistryAdapter(globalToolRegistry);

    const aliased = adapter.validateArgs('text', {
      action: 'add_subtitle',
      text: 'Hello world',
      startTime: 0,
      endTime: 1,
    });

    expect(aliased.valid).toBe(false);
    expect(aliased.errors.some((error) => error.includes('sequenceId'))).toBe(true);
  });

  it('normalizes asset discovery query aliases for validation', () => {
    const normalized = normalizeMetaToolArgsForValidation('query', 'find_assets_for_script', {
      query: 'city rain scene',
      type: 'video',
      limit: 7,
    });

    expect(normalized).toEqual({
      query: 'city rain scene',
      type: 'video',
      scriptText: 'city rain scene',
      assetType: 'video',
      count: 7,
    });
  });

  it('normalizes stock media query aliases for validation', () => {
    const normalized = normalizeMetaToolArgsForValidation('query', 'search_stock_media', {
      query: 'funny whoosh',
      assetType: 'audio',
      limit: 4,
    });

    expect(normalized).toEqual({
      query: 'funny whoosh',
      assetType: 'audio',
      type: 'audio',
      count: 4,
    });
  });
});
