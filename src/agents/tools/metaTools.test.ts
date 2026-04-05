import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { globalToolRegistry } from '@/agents';
import { createToolRegistryAdapter } from '@/agents/engine/adapters/tools/ToolRegistryAdapter';
import { registerCaptionTools, unregisterCaptionTools } from './captionTools';
import { registerMetaTools, unregisterMetaTools } from './metaTools';

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
});
