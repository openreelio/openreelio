import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTextClip } from './useTextClip';
import { useProjectStore } from '@/stores/projectStore';
import type { CommandResult, TextClipData } from '@/types';

const baseTextData: TextClipData = {
  content: 'Hello world',
  style: {
    fontFamily: 'Arial',
    fontSize: 48,
    color: '#FFFFFF',
    backgroundPadding: 10,
    alignment: 'center',
    bold: false,
    italic: false,
    underline: false,
    lineHeight: 1.2,
    letterSpacing: 0,
  },
  position: { x: 0.5, y: 0.5 },
  rotation: 0,
  opacity: 1,
};

describe('useTextClip', () => {
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

  it('should execute AddTextClip through project command queue', async () => {
    const executeCommandMock = vi.fn(
      async (): Promise<CommandResult> => ({
        opId: 'op_add_text',
        changes: [],
        createdIds: ['clip_text_1'],
        deletedIds: [],
      }),
    );

    useProjectStore.setState({
      activeSequenceId: 'seq_test_1',
      executeCommand: executeCommandMock,
    });

    const { result } = renderHook(() => useTextClip());

    let clipId: string | undefined;
    await act(async () => {
      clipId = await result.current.addTextClip({
        trackId: 'track_v1',
        timelineIn: 12,
        duration: 3,
        textData: baseTextData,
      });
    });

    expect(clipId).toBe('clip_text_1');
    expect(executeCommandMock).toHaveBeenCalledWith({
      type: 'AddTextClip',
      payload: {
        sequenceId: 'seq_test_1',
        trackId: 'track_v1',
        timelineIn: 12,
        duration: 3,
        textData: baseTextData,
      },
    });
  });

  it('should normalize rgb/rgba colors before sending command payload', async () => {
    const executeCommandMock = vi.fn(
      async (): Promise<CommandResult> => ({
        opId: 'op_add_text',
        changes: [],
        createdIds: ['clip_text_2'],
        deletedIds: [],
      }),
    );

    useProjectStore.setState({
      activeSequenceId: 'seq_test_2',
      executeCommand: executeCommandMock,
    });

    const { result } = renderHook(() => useTextClip());

    await act(async () => {
      await result.current.addTextClip({
        trackId: 'track_v1',
        timelineIn: 0,
        duration: 3,
        textData: {
          ...baseTextData,
          style: {
            ...baseTextData.style,
            color: 'rgb(255, 255, 255)',
            backgroundColor: 'rgba(0,0,0,0.7)',
          },
          shadow: {
            color: 'rgba(0, 0, 0, 0.5)',
            offsetX: 2,
            offsetY: 2,
            blur: 4,
          },
          outline: {
            color: 'rgb(255, 0, 0)',
            width: 2,
          },
        },
      });
    });

    expect(executeCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'AddTextClip',
        payload: expect.objectContaining({
          textData: expect.objectContaining({
            style: expect.objectContaining({
              color: '#FFFFFF',
              backgroundColor: '#000000B3',
            }),
            shadow: expect.objectContaining({
              color: '#00000080',
            }),
            outline: expect.objectContaining({
              color: '#FF0000',
            }),
          }),
        }),
      }),
    );
  });

  it('should throw when active sequence is missing', async () => {
    useProjectStore.setState({
      activeSequenceId: null,
      executeCommand: vi.fn(),
    });

    const { result } = renderHook(() => useTextClip());

    await act(async () => {
      await expect(
        result.current.addTextClip({
          trackId: 'track_v1',
          timelineIn: 0,
          duration: 3,
          textData: baseTextData,
        }),
      ).rejects.toThrow('No active sequence');
    });
  });
});
