/**
 * Unit tests for extended editing tools (Phase A):
 * add_track, remove_track, rename_track, change_clip_speed, freeze_frame
 *
 * Mocks only the external boundary (Tauri IPC via commandExecutor).
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

import { useProjectStore } from '@/stores/projectStore';

const CTX: AgentContext = { projectId: 'project-1', sequenceId: 'seq-1' };

function getMockExecuteCommand() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      executeCommand: vi.fn().mockResolvedValue({ opId: 'op-1', success: true, createdIds: ['track-new'] }),
    } as unknown as ReturnType<typeof useProjectStore.getState>);
  });

  describe('add_track', () => {
    it('should be registered with category track', () => {
      const tool = globalToolRegistry.get('add_track');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('track');
    });

    it('should call CreateTrack command', async () => {
      const tool = globalToolRegistry.get('add_track');
      const result = await tool!.handler(
        { sequenceId: 'seq-1', kind: 'video', name: 'V3' },
        CTX,
      );

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
      const result = await tool!.handler(
        { sequenceId: 'seq-1', trackId: 'track-1' },
        CTX,
      );

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
        executeCommand: vi.fn().mockRejectedValue(new Error('Cannot remove track: track contains clips')),
      } as unknown as ReturnType<typeof useProjectStore.getState>);

      const tool = globalToolRegistry.get('remove_track');
      const result = await tool!.handler(
        { sequenceId: 'seq-1', trackId: 'track-1' },
        CTX,
      );

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

    it('should call SetClipTransform with speed and reverse', async () => {
      const tool = globalToolRegistry.get('change_clip_speed');
      const result = await tool!.handler(
        { sequenceId: 'seq-1', trackId: 'track-1', clipId: 'clip-1', speed: 2.0, reverse: false },
        CTX,
      );

      expect(result.success).toBe(true);
      const mockExec = getMockExecuteCommand();
      expect(mockExec).toHaveBeenCalledWith({
        type: 'SetClipTransform',
        payload: expect.objectContaining({ clipId: 'clip-1', speed: 2.0, reverse: false }),
      });
    });

    it('should reject speed outside 0.1-10.0 range', async () => {
      const tool = globalToolRegistry.get('change_clip_speed');
      const result = await tool!.handler(
        { sequenceId: 'seq-1', trackId: 'track-1', clipId: 'clip-1', speed: 0 },
        CTX,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Speed must be between 0.1 and 10.0');
    });
  });

  describe('freeze_frame', () => {
    it('should be registered with category clip', () => {
      const tool = globalToolRegistry.get('freeze_frame');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('clip');
    });

    it('should call SplitClip as first step of freeze', async () => {
      const tool = globalToolRegistry.get('freeze_frame');
      const result = await tool!.handler(
        { sequenceId: 'seq-1', trackId: 'track-1', clipId: 'clip-1', frameTime: 3.5, duration: 2.0 },
        CTX,
      );

      expect(result.success).toBe(true);
      const mockExec = getMockExecuteCommand();
      expect(mockExec).toHaveBeenCalledWith({
        type: 'SplitClip',
        payload: expect.objectContaining({ clipId: 'clip-1', splitTime: 3.5 }),
      });
    });
  });
});
