import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '@/stores/projectStore';
import { executeAgentCommand } from './commandExecutor';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);
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

  it('falls back to direct invoke when project is not loaded', async () => {
    mockInvoke.mockResolvedValueOnce({ opId: 'op_ipc', success: true });

    const result = await executeAgentCommand('MoveClip', {
      sequenceId: 'seq_001',
      trackId: 'track_001',
      clipId: 'clip_001',
      newTimelineIn: 10,
    });

    expect(result).toEqual({ opId: 'op_ipc', success: true });
    expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
      commandType: 'MoveClip',
      payload: {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        newTimelineIn: 10,
      },
    });
  });

  it('uses project store executor when project is loaded even without active sequence', async () => {
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
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
