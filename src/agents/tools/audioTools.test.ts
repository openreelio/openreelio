import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { globalToolRegistry } from '../ToolRegistry';
import { executeAgentCommand } from './commandExecutor';
import { getAudioToolNames, registerAudioTools, unregisterAudioTools } from './audioTools';

const mocks = vi.hoisted(() => ({
  useProjectStore: {
    getState: vi.fn(),
  },
}));

vi.mock('./commandExecutor', () => ({
  executeAgentCommand: vi.fn(),
}));

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: mocks.useProjectStore,
}));

describe('audioTools', () => {
  beforeEach(() => {
    globalToolRegistry.clear();
    vi.clearAllMocks();
    mocks.useProjectStore.getState.mockReturnValue({
      sequences: new Map([
        [
          'seq-1',
          {
            id: 'seq-1',
            tracks: [{ id: 'A1', clips: [{ id: 'clip-1' }] }],
          },
        ],
      ]),
    });
    registerAudioTools();
  });

  afterEach(() => {
    unregisterAudioTools();
  });

  it('should register volume tools', () => {
    expect(getAudioToolNames()).toContain('adjust_volume');
  });

  it('adjust_volume should use SetTrackVolume when clipId is omitted', async () => {
    vi.mocked(executeAgentCommand).mockResolvedValue({
      opId: 'op-1',
      changes: [],
      createdIds: [],
      deletedIds: [],
    });

    const result = await globalToolRegistry.execute('adjust_volume', {
      sequenceId: 'seq-1',
      trackId: 'A1',
      volume: 50,
    });

    expect(result.success).toBe(true);
    expect(executeAgentCommand).toHaveBeenCalledWith('SetTrackVolume', {
      sequenceId: 'seq-1',
      trackId: 'A1',
      volume: 0.5,
    });
  });

  it('adjust_volume should keep using SetClipAudio when clipId is provided', async () => {
    vi.mocked(executeAgentCommand).mockResolvedValue({
      opId: 'op-2',
      changes: [],
      createdIds: [],
      deletedIds: [],
    });

    const result = await globalToolRegistry.execute('adjust_volume', {
      sequenceId: 'seq-1',
      trackId: 'A1',
      clipId: 'clip-1',
      volume: 50,
    });

    expect(result.success).toBe(true);
    expect(executeAgentCommand).toHaveBeenCalledWith('SetClipAudio', {
      sequenceId: 'seq-1',
      trackId: 'A1',
      clipId: 'clip-1',
      volumeDb: expect.closeTo(-6.0206, 4),
      muted: false,
    });
  });

  it('normalize_audio should add loudness_normalize with export parameter names', async () => {
    vi.mocked(executeAgentCommand).mockResolvedValue({
      opId: 'op-3',
      changes: [],
      createdIds: ['effect-1'],
      deletedIds: [],
    });

    const result = await globalToolRegistry.execute('normalize_audio', {
      sequenceId: 'seq-1',
      trackId: 'A1',
      clipId: 'clip-1',
      targetLufs: -16,
      targetLra: 8,
      truePeak: -2,
      printFormat: 'json',
    });

    expect(result.success).toBe(true);
    expect(executeAgentCommand).toHaveBeenCalledWith('AddEffect', {
      sequenceId: 'seq-1',
      trackId: 'A1',
      clipId: 'clip-1',
      effectType: 'loudness_normalize',
      params: {
        target_lufs: -16,
        target_lra: 8,
        target_tp: -2,
        print_format: 'json',
      },
    });
  });
});
