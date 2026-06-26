import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { globalToolRegistry, type ToolDefinition } from '@/agents';
import { createToolRegistryAdapter } from '@/agents/engine/adapters/tools/ToolRegistryAdapter';
import { registerCaptionTools, unregisterCaptionTools } from './captionTools';
import { registerTextTools, unregisterTextTools } from './textTools';
import {
  getVisibleMetaToolNames,
  normalizeMetaToolArgsForValidation,
  registerMetaTools,
  unregisterMetaTools,
} from './metaTools';
import { setFeatureFlag, resetFeatureFlags } from '@/config/featureFlags';

describe('metaTools', () => {
  beforeEach(() => {
    globalToolRegistry.clear();
    registerCaptionTools();
    registerTextTools();
    registerMetaTools();
  });

  afterEach(() => {
    unregisterMetaTools();
    unregisterTextTools();
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

  it('exposes rich editable text overlay fields through the text meta-tool schema', () => {
    const textTool = globalToolRegistry.get('text');
    const properties = textTool?.parameters.properties ?? {};

    expect(properties.clipId).toBeDefined();
    expect(properties.duration).toBeDefined();
    expect(properties.preset).toBeDefined();
    expect(properties.style).toBeDefined();
    expect(properties.fontWeight).toBeDefined();
    expect(properties.backgroundPadding).toBeDefined();
    expect(properties.alignment).toBeDefined();
    expect(properties.shadow).toBeDefined();
    expect(properties.outline).toBeDefined();
    expect(properties.clearShadow).toBeDefined();
    expect(properties.clearOutline).toBeDefined();
    expect(properties.transform).toBeDefined();
    expect(properties.transformX).toBeDefined();
    expect(properties.scaleX).toBeDefined();
    expect(properties.anchorX).toBeDefined();
    expect(properties.autoPlacement).toBeDefined();
    expect(properties.placementIntent).toBeDefined();
    expect(properties.safeMargin).toBeDefined();
  });

  it('routes get_caption_style through the text meta-tool', () => {
    const adapter = createToolRegistryAdapter(globalToolRegistry);

    const valid = adapter.validateArgs('text', {
      action: 'get_caption_style',
      sequenceId: 'seq-1',
    });

    expect(valid.valid).toBe(true);
    expect(globalToolRegistry.get('get_caption_style')).toBeDefined();
  });

  it('allows rich editable text creation without explicit sequenceId when context can supply it', () => {
    const adapter = createToolRegistryAdapter(globalToolRegistry);

    const valid = adapter.validateArgs('text', {
      action: 'create_title',
      text: 'Launch title',
      startTime: 0,
      duration: 3,
      preset: 'title',
      style: {
        fontFamily: 'Inter',
        fontSize: 72,
        fontWeight: 800,
        color: '#FFFFFF',
        alignment: 'center',
      },
      position: { x: 0.5, y: 0.2 },
      shadow: { color: '#00000099', offsetX: 2, offsetY: 4, blur: 8 },
      outline: { color: '#000000', width: 3 },
      transform: {
        position: { x: 0.5, y: 0.2 },
        scale: { x: 1.1, y: 1.1 },
        rotationDeg: -4,
        anchor: { x: 0.5, y: 0.5 },
      },
      autoPlacement: true,
      placementIntent: 'title',
    });

    expect(valid.valid).toBe(true);
  });

  it('allows nullable effect clears and transform aliases for editable text updates', () => {
    const adapter = createToolRegistryAdapter(globalToolRegistry);

    const valid = adapter.validateArgs('text', {
      action: 'move_text',
      clipId: 'clip-text-1',
      transformX: 0.45,
      transformY: 0.82,
      scaleX: 1.2,
      scaleY: 1.2,
      rotationDeg: 8,
    });
    const update = adapter.validateArgs('text', {
      action: 'modify_text',
      clipId: 'clip-text-1',
      shadow: null,
      outline: null,
      clearBackground: true,
    });

    expect(valid.valid).toBe(true);
    expect(update.valid).toBe(true);
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

  it('hides the generate meta-tool from the LLM surface when video generation is off', () => {
    resetFeatureFlags();

    const visible = getVisibleMetaToolNames();

    expect(visible).toEqual(['query', 'edit', 'audio', 'effects', 'text']);
    expect(visible).not.toContain('generate');
    expect(visible).not.toContain('execute_plan');
  });

  it('exposes the generate meta-tool when video generation is enabled', () => {
    setFeatureFlag('USE_VIDEO_GENERATION', true);

    try {
      const visible = getVisibleMetaToolNames();

      expect(visible).toContain('generate');
      // Legacy compatibility tools stay hidden regardless of the flag.
      expect(visible).not.toContain('execute_plan');
    } finally {
      resetFeatureFlags();
    }
  });

  it('forwards execution context from generate meta-tool to the underlying action', async () => {
    const captureContext = vi.fn().mockResolvedValue({
      success: true,
      result: { ok: true },
    });
    const timelineTool: ToolDefinition = {
      name: 'generate_timeline_media',
      description: 'Capture context',
      category: 'generation',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Prompt' },
        },
        required: ['prompt'],
      },
      handler: captureContext,
    };
    globalToolRegistry.register(timelineTool);

    const result = await globalToolRegistry.execute(
      'generate',
      {
        action: 'generate_timeline_media',
        prompt: 'Context-sensitive shot',
      },
      {
        sequenceId: 'seq-1',
        selectedTrackIds: ['track-1'],
        playheadPosition: 7,
      },
    );

    expect(result.success).toBe(true);
    expect(captureContext).toHaveBeenCalledWith(
      { prompt: 'Context-sensitive shot' },
      expect.objectContaining({
        sequenceId: 'seq-1',
        selectedTrackIds: ['track-1'],
        playheadPosition: 7,
      }),
    );
  });
});
