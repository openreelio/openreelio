import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { globalToolRegistry } from '../ToolRegistry';
import { executeAgentCommand } from './commandExecutor';
import { getEffectToolNames, registerEffectTools, unregisterEffectTools } from './effectTools';

vi.mock('./commandExecutor', () => ({
  executeAgentCommand: vi.fn(),
}));

describe('effectTools', () => {
  beforeEach(() => {
    globalToolRegistry.clear();
    vi.clearAllMocks();
    registerEffectTools();
  });

  afterEach(() => {
    unregisterEffectTools();
  });

  it('should register mask tools for spatial effect refinement', () => {
    const names = getEffectToolNames();

    expect(names).toContain('add_mask');
    expect(names).toContain('update_mask');
    expect(names).toContain('remove_mask');
  });

  it('add_mask should execute the AddMask command with shape payload', async () => {
    vi.mocked(executeAgentCommand).mockResolvedValue({
      opId: 'op-1',
      changes: [],
      createdIds: ['mask-1'],
      deletedIds: [],
    });

    const result = await globalToolRegistry.execute('add_mask', {
      sequenceId: 'seq-1',
      trackId: 'V1',
      clipId: 'clip-1',
      effectId: 'effect-1',
      shape: {
        type: 'rectangle',
        x: 0.5,
        y: 0.5,
        width: 0.3,
        height: 0.2,
        cornerRadius: 0.02,
        rotation: 0,
      },
      name: 'Semantic mask: logo',
      feather: 0.08,
      inverted: false,
      keyframes: [
        {
          timeOffset: 0,
          shape: {
            type: 'rectangle',
            x: 0.5,
            y: 0.5,
            width: 0.3,
            height: 0.2,
            cornerRadius: 0.02,
            rotation: 0,
          },
          easing: 'linear',
        },
      ],
      trackingSourceId: 'tracking-effect-1',
    });

    expect(result.success).toBe(true);
    expect(executeAgentCommand).toHaveBeenCalledWith('AddMask', {
      sequenceId: 'seq-1',
      trackId: 'V1',
      clipId: 'clip-1',
      effectId: 'effect-1',
      shape: {
        type: 'rectangle',
        x: 0.5,
        y: 0.5,
        width: 0.3,
        height: 0.2,
        cornerRadius: 0.02,
        rotation: 0,
      },
      name: 'Semantic mask: logo',
      feather: 0.08,
      inverted: false,
      keyframes: [
        {
          timeOffset: 0,
          shape: {
            type: 'rectangle',
            x: 0.5,
            y: 0.5,
            width: 0.3,
            height: 0.2,
            cornerRadius: 0.02,
            rotation: 0,
          },
          easing: 'linear',
        },
      ],
      trackingSourceId: 'tracking-effect-1',
    });
  });

  it('update_mask should execute the UpdateMask command with provided fields only', async () => {
    vi.mocked(executeAgentCommand).mockResolvedValue({
      opId: 'op-2',
      changes: [],
      createdIds: [],
      deletedIds: [],
    });

    const result = await globalToolRegistry.execute('update_mask', {
      effectId: 'effect-1',
      maskId: 'mask-1',
      feather: 0.12,
      enabled: true,
      keyframes: [
        {
          timeOffset: 0.5,
          shape: {
            type: 'ellipse',
            x: 0.4,
            y: 0.45,
            radiusX: 0.1,
            radiusY: 0.08,
            rotation: 0,
          },
          easing: 'linear',
        },
      ],
      trackingSourceId: 'tracking-effect-2',
    });

    expect(result.success).toBe(true);
    expect(executeAgentCommand).toHaveBeenCalledWith('UpdateMask', {
      effectId: 'effect-1',
      maskId: 'mask-1',
      feather: 0.12,
      enabled: true,
      keyframes: [
        {
          timeOffset: 0.5,
          shape: {
            type: 'ellipse',
            x: 0.4,
            y: 0.45,
            radiusX: 0.1,
            radiusY: 0.08,
            rotation: 0,
          },
          easing: 'linear',
        },
      ],
      trackingSourceId: 'tracking-effect-2',
    });
  });
});
