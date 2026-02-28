/**
 * Unit tests for editing tools (Phase A + Phase B):
 * Phase A: add_track, remove_track, rename_track, change_clip_speed, freeze_frame
 * Phase B: ripple_edit, roll_edit, slip_edit, slide_edit
 *
 * Mocks only the external boundary (Tauri IPC via commandExecutor) and
 * storeAccessor for timeline snapshot access (compound tools).
 */

import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from 'vitest';
import { globalToolRegistry, type AgentContext } from '@/agents';
import { registerEditingTools, unregisterEditingTools } from './editingTools';

// Mock the IPC boundary
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock projectStore for executeAgentCommand
vi.mock('@/stores/projectStore', () => ({
  useProjectStore: {
    getState: vi.fn(() => ({
      isLoaded: true,
      meta: { id: 'project-1', name: 'Test' },
      executeCommand: vi.fn().mockResolvedValue({ opId: 'op-1', success: true }),
    })),
  },
}));

// Mock storeAccessor for timeline snapshot access (compound tools need this)
vi.mock('./storeAccessor', () => ({
  getTimelineSnapshot: vi.fn(),
  findWorkspaceFile: vi.fn(),
}));

import { useProjectStore } from '@/stores/projectStore';
import { getTimelineSnapshot } from './storeAccessor';

const CTX: AgentContext = { projectId: 'project-1', sequenceId: 'seq-1' };

function getMockExecuteCommand() {
  return (useProjectStore.getState as any)().executeCommand as ReturnType<typeof vi.fn>;
}

describe('editingTools — extended tools', () => {
  beforeAll(() => {
    registerEditingTools();
  });

  afterAll(() => {
    unregisterEditingTools();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useProjectStore.getState).mockReturnValue({
      isLoaded: true,
      meta: { id: 'project-1', name: 'Test' },
      executeCommand: vi
        .fn()
        .mockResolvedValue({ opId: 'op-1', success: true, createdIds: ['track-new'] }),
    } as unknown as ReturnType<typeof useProjectStore.getState>);
  });

  // ===========================================================================
  // Phase A: Atomic tools
  // ===========================================================================

  describe('add_track', () => {
    it('should be registered with category track', () => {
      const tool = globalToolRegistry.get('add_track');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('track');
    });

    it('should call CreateTrack command', async () => {
      const tool = globalToolRegistry.get('add_track');
      const result = await tool!.handler({ sequenceId: 'seq-1', kind: 'video', name: 'V3' }, CTX);

      expect(result.success).toBe(true);
      const mockExec = getMockExecuteCommand();
      expect(mockExec).toHaveBeenCalledWith({
        type: 'CreateTrack',
        payload: { sequenceId: 'seq-1', kind: 'video', name: 'V3' },
      });
    });
  });

  describe('remove_track', () => {
    it('should be registered with category track', () => {
      const tool = globalToolRegistry.get('remove_track');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('track');
    });

    it('should call RemoveTrack command', async () => {
      const tool = globalToolRegistry.get('remove_track');
      const result = await tool!.handler({ sequenceId: 'seq-1', trackId: 'track-1' }, CTX);

      expect(result.success).toBe(true);
      const mockExec = getMockExecuteCommand();
      expect(mockExec).toHaveBeenCalledWith({
        type: 'RemoveTrack',
        payload: { sequenceId: 'seq-1', trackId: 'track-1' },
      });
    });

    it('should return error when backend rejects removal', async () => {
      vi.mocked(useProjectStore.getState).mockReturnValue({
        isLoaded: true,
        meta: { id: 'project-1', name: 'Test' },
        executeCommand: vi
          .fn()
          .mockRejectedValue(new Error('Cannot remove track: track contains clips')),
      } as unknown as ReturnType<typeof useProjectStore.getState>);

      const tool = globalToolRegistry.get('remove_track');
      const result = await tool!.handler({ sequenceId: 'seq-1', trackId: 'track-1' }, CTX);

      expect(result.success).toBe(false);
      expect(result.error).toContain('track contains clips');
    });
  });

  describe('rename_track', () => {
    it('should be registered with category track', () => {
      const tool = globalToolRegistry.get('rename_track');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('track');
    });

    it('should call RenameTrack command with newName', async () => {
      const tool = globalToolRegistry.get('rename_track');
      const result = await tool!.handler(
        { sequenceId: 'seq-1', trackId: 'track-1', name: 'Interview Audio' },
        CTX,
      );

      expect(result.success).toBe(true);
      const mockExec = getMockExecuteCommand();
      expect(mockExec).toHaveBeenCalledWith({
        type: 'RenameTrack',
        payload: { sequenceId: 'seq-1', trackId: 'track-1', newName: 'Interview Audio' },
      });
    });
  });

  describe('change_clip_speed', () => {
    it('should be registered with category clip', () => {
      const tool = globalToolRegistry.get('change_clip_speed');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('clip');
    });

    it('should call SetClipSpeed with speed', async () => {
      const tool = globalToolRegistry.get('change_clip_speed');
      const result = await tool!.handler(
        { sequenceId: 'seq-1', trackId: 'track-1', clipId: 'clip-1', speed: 2.0, reverse: false },
        CTX,
      );

      expect(result.success).toBe(true);
      const mockExec = getMockExecuteCommand();
      expect(mockExec).toHaveBeenCalledWith({
        type: 'SetClipSpeed',
        payload: expect.objectContaining({ clipId: 'clip-1', speed: 2.0 }),
      });
    });

    it('should reject reverse playback until backend support is available', async () => {
      const tool = globalToolRegistry.get('change_clip_speed');
      const result = await tool!.handler(
        { sequenceId: 'seq-1', trackId: 'track-1', clipId: 'clip-1', speed: 2.0, reverse: true },
        CTX,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Reverse playback is not yet supported');
    });

    it('should reject speed outside 0.1-10.0 range', async () => {
      const tool = globalToolRegistry.get('change_clip_speed');
      const result = await tool!.handler(
        { sequenceId: 'seq-1', trackId: 'track-1', clipId: 'clip-1', speed: 0 },
        CTX,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('between 0.1 and 10.0');
    });
  });

  describe('freeze_frame', () => {
    it('should be registered with category clip', () => {
      const tool = globalToolRegistry.get('freeze_frame');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('clip');
    });

    it('should build a freeze segment and shift tail clip forward', async () => {
      vi.mocked(getTimelineSnapshot).mockReturnValue({
        stateVersion: 1,
        sequenceId: 'seq-1',
        sequenceName: 'Main',
        duration: 20,
        trackCount: 1,
        clipCount: 1,
        tracks: [
          {
            id: 'track-1',
            name: 'V1',
            kind: 'video',
            clipCount: 1,
            muted: false,
            locked: false,
            visible: true,
            volume: 1,
          },
        ],
        clips: [
          {
            id: 'clip-1',
            assetId: 'a1',
            trackId: 'track-1',
            timelineIn: 0,
            duration: 10,
            sourceIn: 0,
            sourceOut: 10,
            speed: 1,
            opacity: 1,
            hasEffects: false,
            effectCount: 0,
          },
        ],
        selectedClipIds: [],
        selectedTrackIds: [],
        playheadPosition: 0,
      });

      vi.mocked(useProjectStore.getState).mockReturnValue({
        isLoaded: true,
        meta: { id: 'project-1', name: 'Test' },
        executeCommand: vi
          .fn()
          .mockResolvedValueOnce({ opId: 'op-s1', createdIds: ['clip-freeze'] })
          .mockResolvedValueOnce({ opId: 'op-s2', createdIds: ['clip-tail'] })
          .mockResolvedValueOnce({ opId: 'op-s3', createdIds: [] })
          .mockResolvedValueOnce({ opId: 'op-s4', createdIds: [] }),
      } as unknown as ReturnType<typeof useProjectStore.getState>);

      const tool = globalToolRegistry.get('freeze_frame');
      const result = await tool!.handler(
        {
          sequenceId: 'seq-1',
          trackId: 'track-1',
          clipId: 'clip-1',
          frameTime: 3.5,
          duration: 2.0,
        },
        CTX,
      );

      expect(result.success).toBe(true);

      const mockExec = getMockExecuteCommand();
      expect(mockExec).toHaveBeenCalledTimes(4);
      expect(mockExec).toHaveBeenNthCalledWith(1, {
        type: 'SplitClip',
        payload: expect.objectContaining({ clipId: 'clip-1', splitTime: 3.5 }),
      });
      expect(mockExec).toHaveBeenNthCalledWith(2, {
        type: 'SplitClip',
        payload: expect.objectContaining({ clipId: 'clip-freeze', splitTime: 3.5 + 1 / 30 }),
      });

      const speedCall = mockExec.mock.calls[2][0] as { type: string; payload: { speed: number } };
      expect(speedCall.type).toBe('SetClipSpeed');
      expect(speedCall.payload.speed).toBeCloseTo(1 / 60, 6);

      const moveCall = mockExec.mock.calls[3][0] as {
        type: string;
        payload: { clipId: string; newTimelineIn: number };
      };
      expect(moveCall.type).toBe('MoveClip');
      expect(moveCall.payload.clipId).toBe('clip-tail');
      expect(moveCall.payload.newTimelineIn).toBeCloseTo(5.5, 6);
    });

    it('should accept clip-relative frameTime when clip starts later on timeline', async () => {
      vi.mocked(getTimelineSnapshot).mockReturnValue({
        stateVersion: 1,
        sequenceId: 'seq-1',
        sequenceName: 'Main',
        duration: 30,
        trackCount: 1,
        clipCount: 1,
        tracks: [
          {
            id: 'track-1',
            name: 'V1',
            kind: 'video',
            clipCount: 1,
            muted: false,
            locked: false,
            visible: true,
            volume: 1,
          },
        ],
        clips: [
          {
            id: 'clip-1',
            assetId: 'a1',
            trackId: 'track-1',
            timelineIn: 10,
            duration: 10,
            sourceIn: 0,
            sourceOut: 10,
            speed: 1,
            opacity: 1,
            hasEffects: false,
            effectCount: 0,
          },
        ],
        selectedClipIds: [],
        selectedTrackIds: [],
        playheadPosition: 0,
      });

      vi.mocked(useProjectStore.getState).mockReturnValue({
        isLoaded: true,
        meta: { id: 'project-1', name: 'Test' },
        executeCommand: vi
          .fn()
          .mockResolvedValueOnce({ opId: 'op-s1', createdIds: ['clip-freeze'] })
          .mockResolvedValueOnce({ opId: 'op-s2', createdIds: ['clip-tail'] })
          .mockResolvedValueOnce({ opId: 'op-s3', createdIds: [] })
          .mockResolvedValueOnce({ opId: 'op-s4', createdIds: [] }),
      } as unknown as ReturnType<typeof useProjectStore.getState>);

      const tool = globalToolRegistry.get('freeze_frame');
      const result = await tool!.handler(
        {
          sequenceId: 'seq-1',
          trackId: 'track-1',
          clipId: 'clip-1',
          frameTime: 1,
          duration: 2.0,
        },
        CTX,
      );

      expect(result.success).toBe(true);

      const mockExec = getMockExecuteCommand();
      expect(mockExec).toHaveBeenNthCalledWith(1, {
        type: 'SplitClip',
        payload: expect.objectContaining({ clipId: 'clip-1', splitTime: 11 }),
      });
    });

    it('should rollback previously applied commands when a later freeze step fails', async () => {
      vi.mocked(getTimelineSnapshot).mockReturnValue({
        stateVersion: 1,
        sequenceId: 'seq-1',
        sequenceName: 'Main',
        duration: 20,
        trackCount: 1,
        clipCount: 1,
        tracks: [
          {
            id: 'track-1',
            name: 'V1',
            kind: 'video',
            clipCount: 1,
            muted: false,
            locked: false,
            visible: true,
            volume: 1,
          },
        ],
        clips: [
          {
            id: 'clip-1',
            assetId: 'a1',
            trackId: 'track-1',
            timelineIn: 0,
            duration: 10,
            sourceIn: 0,
            sourceOut: 10,
            speed: 1,
            opacity: 1,
            hasEffects: false,
            effectCount: 0,
          },
        ],
        selectedClipIds: [],
        selectedTrackIds: [],
        playheadPosition: 0,
      });

      const executeCommand = vi
        .fn()
        .mockResolvedValueOnce({ opId: 'op-s1', createdIds: ['clip-freeze'] })
        .mockResolvedValueOnce({ opId: 'op-s2', createdIds: ['clip-tail'] })
        .mockResolvedValueOnce({ opId: 'op-s3', createdIds: [] })
        .mockRejectedValueOnce(new Error('Move failed due to overlap'));
      const undo = vi.fn().mockResolvedValue({ success: true, canUndo: true, canRedo: true });

      vi.mocked(useProjectStore.getState).mockReturnValue({
        isLoaded: true,
        meta: { id: 'project-1', name: 'Test' },
        executeCommand,
        undo,
      } as unknown as ReturnType<typeof useProjectStore.getState>);

      const tool = globalToolRegistry.get('freeze_frame');
      const result = await tool!.handler(
        {
          sequenceId: 'seq-1',
          trackId: 'track-1',
          clipId: 'clip-1',
          frameTime: 3.5,
          duration: 2.0,
        },
        CTX,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Move failed due to overlap');
      expect(undo).toHaveBeenCalledTimes(3);
    });

    it('should fail when split command does not return created IDs', async () => {
      vi.mocked(getTimelineSnapshot).mockReturnValue({
        stateVersion: 1,
        sequenceId: 'seq-1',
        sequenceName: 'Main',
        duration: 20,
        trackCount: 1,
        clipCount: 1,
        tracks: [
          {
            id: 'track-1',
            name: 'V1',
            kind: 'video',
            clipCount: 1,
            muted: false,
            locked: false,
            visible: true,
            volume: 1,
          },
        ],
        clips: [
          {
            id: 'clip-1',
            assetId: 'a1',
            trackId: 'track-1',
            timelineIn: 0,
            duration: 10,
            sourceIn: 0,
            sourceOut: 10,
            speed: 1,
            opacity: 1,
            hasEffects: false,
            effectCount: 0,
          },
        ],
        selectedClipIds: [],
        selectedTrackIds: [],
        playheadPosition: 0,
      });

      vi.mocked(useProjectStore.getState).mockReturnValue({
        isLoaded: true,
        meta: { id: 'project-1', name: 'Test' },
        executeCommand: vi.fn().mockResolvedValue({ opId: 'op-s1', createdIds: [] }),
      } as unknown as ReturnType<typeof useProjectStore.getState>);

      const tool = globalToolRegistry.get('freeze_frame');
      const result = await tool!.handler(
        {
          sequenceId: 'seq-1',
          trackId: 'track-1',
          clipId: 'clip-1',
          frameTime: 3.5,
          duration: 2.0,
        },
        CTX,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('did not return a created clip ID');
    });
  });

  // ===========================================================================
  // Phase B: Compound tools
  // ===========================================================================

  describe('ripple_edit', () => {
    it('should be registered with category clip', () => {
      const tool = globalToolRegistry.get('ripple_edit');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('clip');
    });

    it('should trim clip and shift subsequent clips', async () => {
      vi.mocked(getTimelineSnapshot).mockReturnValue({
        stateVersion: 1,
        sequenceId: 'seq-1',
        sequenceName: 'Main',
        duration: 30,
        trackCount: 1,
        clipCount: 3,
        tracks: [
          {
            id: 'track-1',
            name: 'V1',
            kind: 'video',
            clipCount: 3,
            muted: false,
            locked: false,
            visible: true,
            volume: 1,
          },
        ],
        clips: [
          {
            id: 'clip-1',
            assetId: 'a1',
            trackId: 'track-1',
            timelineIn: 0,
            duration: 10,
            sourceIn: 0,
            sourceOut: 10,
            speed: 1,
            opacity: 1,
            hasEffects: false,
            effectCount: 0,
          },
          {
            id: 'clip-2',
            assetId: 'a2',
            trackId: 'track-1',
            timelineIn: 10,
            duration: 5,
            sourceIn: 0,
            sourceOut: 5,
            speed: 1,
            opacity: 1,
            hasEffects: false,
            effectCount: 0,
          },
          {
            id: 'clip-3',
            assetId: 'a3',
            trackId: 'track-1',
            timelineIn: 15,
            duration: 5,
            sourceIn: 0,
            sourceOut: 5,
            speed: 1,
            opacity: 1,
            hasEffects: false,
            effectCount: 0,
          },
        ],
        selectedClipIds: [],
        selectedTrackIds: [],
        playheadPosition: 0,
      });

      const tool = globalToolRegistry.get('ripple_edit');
      const result = await tool!.handler(
        { sequenceId: 'seq-1', trackId: 'track-1', clipId: 'clip-1', trimEnd: 8 },
        CTX,
      );

      expect(result.success).toBe(true);
      const mockExec = getMockExecuteCommand();

      // Should trim the target clip
      expect(mockExec).toHaveBeenCalledWith({
        type: 'TrimClip',
        payload: expect.objectContaining({ clipId: 'clip-1', newSourceOut: 8 }),
      });

      // Should shift clip-2 (at 10) by delta of -2 to 8
      expect(mockExec).toHaveBeenCalledWith({
        type: 'MoveClip',
        payload: expect.objectContaining({ clipId: 'clip-2', newTimelineIn: 8 }),
      });

      // Should shift clip-3 (at 15) by delta of -2 to 13
      expect(mockExec).toHaveBeenCalledWith({
        type: 'MoveClip',
        payload: expect.objectContaining({ clipId: 'clip-3', newTimelineIn: 13 }),
      });

      // Total 3 calls: 1 trim + 2 moves
      expect(mockExec).toHaveBeenCalledTimes(3);
    });

    it('should return error when clip not found', async () => {
      vi.mocked(getTimelineSnapshot).mockReturnValue({
        stateVersion: 1,
        sequenceId: 'seq-1',
        sequenceName: 'Main',
        duration: 10,
        trackCount: 1,
        clipCount: 0,
        tracks: [
          {
            id: 'track-1',
            name: 'V1',
            kind: 'video',
            clipCount: 0,
            muted: false,
            locked: false,
            visible: true,
            volume: 1,
          },
        ],
        clips: [],
        selectedClipIds: [],
        selectedTrackIds: [],
        playheadPosition: 0,
      });

      const tool = globalToolRegistry.get('ripple_edit');
      const result = await tool!.handler(
        { sequenceId: 'seq-1', trackId: 'track-1', clipId: 'nonexistent', trimEnd: 5 },
        CTX,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('roll_edit', () => {
    it('should be registered with category clip', () => {
      const tool = globalToolRegistry.get('roll_edit');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('clip');
    });

    it('should trim left clip end and right clip start', async () => {
      vi.mocked(getTimelineSnapshot).mockReturnValue({
        stateVersion: 1,
        sequenceId: 'seq-1',
        sequenceName: 'Main',
        duration: 20,
        trackCount: 1,
        clipCount: 2,
        tracks: [
          {
            id: 'track-1',
            name: 'V1',
            kind: 'video',
            clipCount: 2,
            muted: false,
            locked: false,
            visible: true,
            volume: 1,
          },
        ],
        clips: [
          {
            id: 'clip-A',
            assetId: 'a1',
            trackId: 'track-1',
            timelineIn: 0,
            duration: 10,
            sourceIn: 0,
            sourceOut: 10,
            speed: 1,
            opacity: 1,
            hasEffects: false,
            effectCount: 0,
          },
          {
            id: 'clip-B',
            assetId: 'a2',
            trackId: 'track-1',
            timelineIn: 10,
            duration: 10,
            sourceIn: 0,
            sourceOut: 10,
            speed: 1,
            opacity: 1,
            hasEffects: false,
            effectCount: 0,
          },
        ],
        selectedClipIds: [],
        selectedTrackIds: [],
        playheadPosition: 10,
      });

      const tool = globalToolRegistry.get('roll_edit');
      const result = await tool!.handler(
        {
          sequenceId: 'seq-1',
          trackId: 'track-1',
          leftClipId: 'clip-A',
          rightClipId: 'clip-B',
          rollAmount: 2,
        },
        CTX,
      );

      expect(result.success).toBe(true);
      const mockExec = getMockExecuteCommand();

      // Left clip: extend source out by 2 (10 → 12)
      expect(mockExec).toHaveBeenCalledWith({
        type: 'TrimClip',
        payload: expect.objectContaining({ clipId: 'clip-A', newSourceOut: 12 }),
      });

      // Right clip: shrink source in by 2 (0 → 2), timeline in shifts (10 → 12)
      expect(mockExec).toHaveBeenCalledWith({
        type: 'TrimClip',
        payload: expect.objectContaining({ clipId: 'clip-B', newSourceIn: 2, newTimelineIn: 12 }),
      });
    });
  });

  describe('slip_edit', () => {
    it('should be registered with category clip', () => {
      const tool = globalToolRegistry.get('slip_edit');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('clip');
    });

    it('should adjust source in/out without changing timeline position', async () => {
      vi.mocked(getTimelineSnapshot).mockReturnValue({
        stateVersion: 1,
        sequenceId: 'seq-1',
        sequenceName: 'Main',
        duration: 10,
        trackCount: 1,
        clipCount: 1,
        tracks: [
          {
            id: 'track-1',
            name: 'V1',
            kind: 'video',
            clipCount: 1,
            muted: false,
            locked: false,
            visible: true,
            volume: 1,
          },
        ],
        clips: [
          {
            id: 'clip-1',
            assetId: 'a1',
            trackId: 'track-1',
            timelineIn: 5,
            duration: 10,
            sourceIn: 2,
            sourceOut: 12,
            speed: 1,
            opacity: 1,
            hasEffects: false,
            effectCount: 0,
          },
        ],
        selectedClipIds: [],
        selectedTrackIds: [],
        playheadPosition: 0,
      });

      const tool = globalToolRegistry.get('slip_edit');
      const result = await tool!.handler(
        { sequenceId: 'seq-1', trackId: 'track-1', clipId: 'clip-1', offsetSeconds: 3 },
        CTX,
      );

      expect(result.success).toBe(true);
      const mockExec = getMockExecuteCommand();

      // Source shifted by +3: sourceIn 2→5, sourceOut 12→15
      expect(mockExec).toHaveBeenCalledWith({
        type: 'TrimClip',
        payload: expect.objectContaining({
          clipId: 'clip-1',
          newSourceIn: 5,
          newSourceOut: 15,
        }),
      });
    });

    it('should reject slip that would move source in below 0', async () => {
      vi.mocked(getTimelineSnapshot).mockReturnValue({
        stateVersion: 1,
        sequenceId: 'seq-1',
        sequenceName: 'Main',
        duration: 10,
        trackCount: 1,
        clipCount: 1,
        tracks: [
          {
            id: 'track-1',
            name: 'V1',
            kind: 'video',
            clipCount: 1,
            muted: false,
            locked: false,
            visible: true,
            volume: 1,
          },
        ],
        clips: [
          {
            id: 'clip-1',
            assetId: 'a1',
            trackId: 'track-1',
            timelineIn: 0,
            duration: 5,
            sourceIn: 1,
            sourceOut: 6,
            speed: 1,
            opacity: 1,
            hasEffects: false,
            effectCount: 0,
          },
        ],
        selectedClipIds: [],
        selectedTrackIds: [],
        playheadPosition: 0,
      });

      const tool = globalToolRegistry.get('slip_edit');
      const result = await tool!.handler(
        { sequenceId: 'seq-1', trackId: 'track-1', clipId: 'clip-1', offsetSeconds: -5 },
        CTX,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('source in below 0');
    });
  });

  describe('slide_edit', () => {
    it('should be registered with category clip', () => {
      const tool = globalToolRegistry.get('slide_edit');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('clip');
    });

    it('should move clip and adjust neighbors', async () => {
      vi.mocked(getTimelineSnapshot).mockReturnValue({
        stateVersion: 1,
        sequenceId: 'seq-1',
        sequenceName: 'Main',
        duration: 30,
        trackCount: 1,
        clipCount: 3,
        tracks: [
          {
            id: 'track-1',
            name: 'V1',
            kind: 'video',
            clipCount: 3,
            muted: false,
            locked: false,
            visible: true,
            volume: 1,
          },
        ],
        clips: [
          {
            id: 'clip-prev',
            assetId: 'a1',
            trackId: 'track-1',
            timelineIn: 0,
            duration: 10,
            sourceIn: 0,
            sourceOut: 10,
            speed: 1,
            opacity: 1,
            hasEffects: false,
            effectCount: 0,
          },
          {
            id: 'clip-target',
            assetId: 'a2',
            trackId: 'track-1',
            timelineIn: 10,
            duration: 5,
            sourceIn: 0,
            sourceOut: 5,
            speed: 1,
            opacity: 1,
            hasEffects: false,
            effectCount: 0,
          },
          {
            id: 'clip-next',
            assetId: 'a3',
            trackId: 'track-1',
            timelineIn: 15,
            duration: 10,
            sourceIn: 0,
            sourceOut: 10,
            speed: 1,
            opacity: 1,
            hasEffects: false,
            effectCount: 0,
          },
        ],
        selectedClipIds: [],
        selectedTrackIds: [],
        playheadPosition: 0,
      });

      const tool = globalToolRegistry.get('slide_edit');
      const result = await tool!.handler(
        { sequenceId: 'seq-1', trackId: 'track-1', clipId: 'clip-target', slideAmount: 2 },
        CTX,
      );

      expect(result.success).toBe(true);
      const mockExec = getMockExecuteCommand();

      // 1. Move target clip by +2 (10 → 12)
      expect(mockExec).toHaveBeenCalledWith({
        type: 'MoveClip',
        payload: expect.objectContaining({ clipId: 'clip-target', newTimelineIn: 12 }),
      });

      // 2. Extend previous clip (sourceOut 10 → 12)
      expect(mockExec).toHaveBeenCalledWith({
        type: 'TrimClip',
        payload: expect.objectContaining({ clipId: 'clip-prev', newSourceOut: 12 }),
      });

      // 3. Trim next clip (sourceIn 0 → 2, timelineIn 15 → 17)
      expect(mockExec).toHaveBeenCalledWith({
        type: 'TrimClip',
        payload: expect.objectContaining({
          clipId: 'clip-next',
          newSourceIn: 2,
          newTimelineIn: 17,
        }),
      });

      // 3 total calls: move + 2 trims
      expect(mockExec).toHaveBeenCalledTimes(3);
    });

    it('should handle slide at track edges (no prev/next)', async () => {
      vi.mocked(getTimelineSnapshot).mockReturnValue({
        stateVersion: 1,
        sequenceId: 'seq-1',
        sequenceName: 'Main',
        duration: 10,
        trackCount: 1,
        clipCount: 1,
        tracks: [
          {
            id: 'track-1',
            name: 'V1',
            kind: 'video',
            clipCount: 1,
            muted: false,
            locked: false,
            visible: true,
            volume: 1,
          },
        ],
        clips: [
          {
            id: 'clip-only',
            assetId: 'a1',
            trackId: 'track-1',
            timelineIn: 0,
            duration: 10,
            sourceIn: 0,
            sourceOut: 10,
            speed: 1,
            opacity: 1,
            hasEffects: false,
            effectCount: 0,
          },
        ],
        selectedClipIds: [],
        selectedTrackIds: [],
        playheadPosition: 0,
      });

      const tool = globalToolRegistry.get('slide_edit');
      const result = await tool!.handler(
        { sequenceId: 'seq-1', trackId: 'track-1', clipId: 'clip-only', slideAmount: 3 },
        CTX,
      );

      expect(result.success).toBe(true);
      const mockExec = getMockExecuteCommand();

      // Only move, no neighbor adjustments
      expect(mockExec).toHaveBeenCalledTimes(1);
      expect(mockExec).toHaveBeenCalledWith({
        type: 'MoveClip',
        payload: expect.objectContaining({ clipId: 'clip-only', newTimelineIn: 3 }),
      });
    });
  });

  // ===========================================================================
  // Marker Tools
  // ===========================================================================

  describe('add_marker', () => {
    it('should be registered with category timeline', () => {
      const tool = globalToolRegistry.get('add_marker');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('timeline');
    });

    it('should call AddMarker command', async () => {
      const tool = globalToolRegistry.get('add_marker');
      const result = await tool!.handler(
        { sequenceId: 'seq-1', time: 5.0, label: 'Intro Start' },
        CTX,
      );

      expect(result.success).toBe(true);
      const mockExec = getMockExecuteCommand();
      expect(mockExec).toHaveBeenCalledWith({
        type: 'AddMarker',
        payload: expect.objectContaining({
          sequenceId: 'seq-1',
          timeSec: 5.0,
          label: 'Intro Start',
        }),
      });
    });

    it('should convert named color to RGBA object', async () => {
      const tool = globalToolRegistry.get('add_marker');
      const result = await tool!.handler(
        { sequenceId: 'seq-1', time: 5.0, label: 'Intro Start', color: 'red' },
        CTX,
      );

      expect(result.success).toBe(true);
      const mockExec = getMockExecuteCommand();
      expect(mockExec).toHaveBeenCalledWith({
        type: 'AddMarker',
        payload: expect.objectContaining({
          sequenceId: 'seq-1',
          timeSec: 5.0,
          label: 'Intro Start',
          color: { r: 1, g: 0, b: 0 },
        }),
      });
    });

    it('should reject invalid color input', async () => {
      const tool = globalToolRegistry.get('add_marker');
      const result = await tool!.handler(
        { sequenceId: 'seq-1', time: 5.0, label: 'Intro Start', color: 'unknown-color' },
        CTX,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid marker color');
      const mockExec = getMockExecuteCommand();
      expect(mockExec).not.toHaveBeenCalled();
    });
  });

  describe('remove_marker', () => {
    it('should be registered with category timeline', () => {
      const tool = globalToolRegistry.get('remove_marker');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('timeline');
    });

    it('should call RemoveMarker command', async () => {
      const tool = globalToolRegistry.get('remove_marker');
      const result = await tool!.handler({ sequenceId: 'seq-1', markerId: 'marker-1' }, CTX);

      expect(result.success).toBe(true);
      const mockExec = getMockExecuteCommand();
      expect(mockExec).toHaveBeenCalledWith({
        type: 'RemoveMarker',
        payload: { sequenceId: 'seq-1', markerId: 'marker-1' },
      });
    });
  });

  describe('list_markers', () => {
    it('should be registered with category analysis', () => {
      const tool = globalToolRegistry.get('list_markers');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('analysis');
    });
  });

  describe('navigate_to_marker', () => {
    it('should be registered with category analysis', () => {
      const tool = globalToolRegistry.get('navigate_to_marker');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('analysis');
    });

    it('should reject negative time', async () => {
      const tool = globalToolRegistry.get('navigate_to_marker');
      const result = await tool!.handler({ time: -1 }, CTX);
      expect(result.success).toBe(false);
      expect(result.error).toContain('non-negative');
    });
  });
});
