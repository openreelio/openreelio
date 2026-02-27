import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useProjectStore } from '@/stores/projectStore';
import { executeAgentCommand } from './commandExecutor';

type ExecuteCommandFn = ReturnType<typeof useProjectStore.getState>['executeCommand'];

describe('executeAgentCommand', () => {
  const baseMeta = {
    id: 'project-1',
    name: 'Test Project',
    path: '/tmp/test.orio',
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({
      isLoaded: false,
      meta: null,
      activeSequenceId: null,
    });
  });

  it('should throw descriptive error when no project is loaded', async () => {
    await expect(
      executeAgentCommand('MoveClip', {
        sequenceId: 'seq_001',
        clipId: 'clip_001',
        newTimelineIn: 10,
      }),
    ).rejects.toThrow('no project is loaded');
  });

  it('should use project store executor when project is loaded', async () => {
    const mockExecuteCommand = vi.fn().mockResolvedValue({ opId: 'op_store', success: true });
    useProjectStore.setState({
      isLoaded: true,
      meta: baseMeta,
      activeSequenceId: null,
      executeCommand: mockExecuteCommand as unknown as ExecuteCommandFn,
    });

    const result = await executeAgentCommand('MoveClip', {
      sequenceId: 'seq_001',
      trackId: 'track_001',
      clipId: 'clip_001',
      newTimelineIn: 12,
    });

    expect(result).toEqual({ opId: 'op_store', success: true });
    expect(mockExecuteCommand).toHaveBeenCalledWith({
      type: 'MoveClip',
      payload: {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        newTimelineIn: 12,
      },
    });
  });

  it('should include command type in error message', async () => {
    await expect(
      executeAgentCommand('SplitClip', { clipId: 'c1', splitTime: 5 }),
    ).rejects.toThrow('SplitClip');
  });
});
