import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCaption } from './useCaption';
import { useProjectStore } from '@/stores/projectStore';
import type { Caption, CommandResult } from '@/types';

const sampleCaption: Caption = {
  id: 'cap_001',
  startSec: 2,
  endSec: 4,
  text: 'Hello world',
};

describe('useCaption', () => {
  const defaultExecuteCommand = useProjectStore.getState().executeCommand;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      useProjectStore.setState({
        activeSequenceId: null,
        executeCommand: defaultExecuteCommand,
      });
    });
  });

  it('should execute UpdateCaption through project command queue', async () => {
    const executeCommandMock = vi.fn(
      async (): Promise<CommandResult> => ({
        opId: 'op_update_caption',
        changes: [],
        createdIds: [],
        deletedIds: [],
      }),
    );

    useProjectStore.setState({
      activeSequenceId: 'seq_001',
      executeCommand: executeCommandMock,
    });

    const { result } = renderHook(() => useCaption());

    await act(async () => {
      await result.current.updateCaption('track_caption_1', sampleCaption);
    });

    expect(executeCommandMock).toHaveBeenCalledWith({
      type: 'UpdateCaption',
      payload: {
        sequenceId: 'seq_001',
        trackId: 'track_caption_1',
        captionId: 'cap_001',
        text: 'Hello world',
        startSec: 2,
        endSec: 4,
      },
    });
  });

  it('should execute CreateCaption and return created caption id', async () => {
    const executeCommandMock = vi.fn(
      async (): Promise<CommandResult> => ({
        opId: 'op_create_caption',
        changes: [],
        createdIds: ['cap_created_1'],
        deletedIds: [],
      }),
    );

    useProjectStore.setState({
      activeSequenceId: 'seq_001',
      executeCommand: executeCommandMock,
    });

    const { result } = renderHook(() => useCaption());

    let createdId: string | undefined;
    await act(async () => {
      createdId = await result.current.createCaption('track_caption_1', {
        text: 'Generated caption',
        startSec: 5,
        endSec: 7,
      });
    });

    expect(createdId).toBe('cap_created_1');
    expect(executeCommandMock).toHaveBeenCalledWith({
      type: 'CreateCaption',
      payload: {
        sequenceId: 'seq_001',
        trackId: 'track_caption_1',
        text: 'Generated caption',
        startSec: 5,
        endSec: 7,
      },
    });
  });

  it('should execute DeleteCaption through project command queue', async () => {
    const executeCommandMock = vi.fn(
      async (): Promise<CommandResult> => ({
        opId: 'op_delete_caption',
        changes: [],
        createdIds: [],
        deletedIds: ['cap_001'],
      }),
    );

    useProjectStore.setState({
      activeSequenceId: 'seq_001',
      executeCommand: executeCommandMock,
    });

    const { result } = renderHook(() => useCaption());

    await act(async () => {
      await result.current.deleteCaption('track_caption_1', 'cap_001');
    });

    expect(executeCommandMock).toHaveBeenCalledWith({
      type: 'DeleteCaption',
      payload: {
        sequenceId: 'seq_001',
        trackId: 'track_caption_1',
        captionId: 'cap_001',
      },
    });
  });

  it('should reject caption updates when active sequence is missing', async () => {
    useProjectStore.setState({
      activeSequenceId: null,
      executeCommand: vi.fn(),
    });

    const { result } = renderHook(() => useCaption());

    await act(async () => {
      await expect(result.current.updateCaption('track_caption_1', sampleCaption)).rejects.toThrow(
        'No active sequence',
      );
    });
  });
});
