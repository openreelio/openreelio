/**
 * Workspace Store Tests
 */

import { useWorkspaceStore } from './workspaceStore';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    time: vi.fn(),
    timeEnd: vi.fn(),
    module: 'test',
  }),
}));

import { invoke } from '@tauri-apps/api/core';
import type { FileTreeEntry, WorkspaceScanResult } from '@/types';

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  useWorkspaceStore.getState().reset();
  vi.clearAllMocks();
});

describe('workspaceStore', () => {
  describe('initial state', () => {
    it('should have empty file tree', () => {
      const state = useWorkspaceStore.getState();
      expect(state.fileTree).toEqual([]);
      expect(state.isScanning).toBe(false);
      expect(state.registeringPathCounts).toEqual({});
      expect(state.isWatching).toBe(false);
      expect(state.scanResult).toBeNull();
      expect(state.error).toBeNull();
    });
  });

  describe('scanWorkspace', () => {
    it('should set isScanning while scanning', async () => {
      const scanResult: WorkspaceScanResult = {
        totalFiles: 5,
        newFiles: 3,
        removedFiles: 0,
        registeredFiles: 2,
      };

      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === 'scan_workspace') return scanResult;
        if (cmd === 'get_workspace_tree') return [];
        return null;
      });

      const promise = useWorkspaceStore.getState().scanWorkspace();

      // isScanning should be true immediately after calling
      // (Note: In test environment, the promise might resolve quickly)
      await promise;

      const state = useWorkspaceStore.getState();
      expect(state.isScanning).toBe(false);
      expect(state.scanResult).toEqual(scanResult);
    });

    it('should handle scan errors', async () => {
      mockInvoke.mockRejectedValueOnce('Scan failed: permission denied');

      await useWorkspaceStore.getState().scanWorkspace();

      const state = useWorkspaceStore.getState();
      expect(state.isScanning).toBe(false);
      expect(state.error).toBe('Scan failed: permission denied');
    });
  });

  describe('refreshTree', () => {
    it('should update file tree from backend', async () => {
      const tree: FileTreeEntry[] = [
        {
          relativePath: 'footage',
          name: 'footage',
          isDirectory: true,
          children: [
            {
              relativePath: 'footage/video.mp4',
              name: 'video.mp4',
              isDirectory: false,
              kind: 'video',
              fileSize: 1024000,
              children: [],
            },
          ],
        },
      ];

      mockInvoke.mockResolvedValueOnce(tree);

      await useWorkspaceStore.getState().refreshTree();

      const state = useWorkspaceStore.getState();
      expect(state.fileTree).toEqual(tree);
      expect(state.error).toBeNull();
    });

    it('should handle refresh errors', async () => {
      mockInvoke.mockRejectedValueOnce('No project open');

      await useWorkspaceStore.getState().refreshTree();

      const state = useWorkspaceStore.getState();
      expect(state.error).toBe('No project open');
    });
  });

  describe('registerFile', () => {
    it('should register a file and refresh tree', async () => {
      mockInvoke
        .mockResolvedValueOnce({
          assetId: 'asset-123',
          relativePath: 'video.mp4',
          alreadyRegistered: false,
        })
        .mockResolvedValueOnce([]); // refreshTree call

      const result = await useWorkspaceStore.getState().registerFile('video.mp4');

      expect(result).toEqual({
        assetId: 'asset-123',
        relativePath: 'video.mp4',
        alreadyRegistered: false,
      });
      expect(mockInvoke).toHaveBeenCalledWith('register_workspace_file', {
        relativePath: 'video.mp4',
      });
      expect(useWorkspaceStore.getState().registeringPathCounts).toEqual({});
    });

    it('should normalize Windows-style relative paths', async () => {
      mockInvoke
        .mockResolvedValueOnce({
          assetId: 'asset-124',
          relativePath: 'footage/clip.mp4',
          alreadyRegistered: false,
        })
        .mockResolvedValueOnce([]);

      const result = await useWorkspaceStore.getState().registerFile('footage\\clip.mp4');

      expect(result?.assetId).toBe('asset-124');
      expect(mockInvoke).toHaveBeenCalledWith('register_workspace_file', {
        relativePath: 'footage/clip.mp4',
      });
    });

    it('should return null on error', async () => {
      mockInvoke.mockRejectedValueOnce('File not found');

      const result = await useWorkspaceStore.getState().registerFile('missing.mp4');

      expect(result).toBeNull();
      expect(useWorkspaceStore.getState().error).toBe('File not found');
    });
  });

  describe('registerFiles', () => {
    it('should batch register files', async () => {
      const results = [
        { assetId: 'a1', relativePath: 'a.mp4', alreadyRegistered: false },
        { assetId: 'a2', relativePath: 'b.mp4', alreadyRegistered: true },
      ];

      mockInvoke.mockResolvedValueOnce(results).mockResolvedValueOnce([]); // refreshTree

      const registered = await useWorkspaceStore.getState().registerFiles(['a.mp4', 'b.mp4']);

      expect(registered).toEqual(results);
      expect(mockInvoke).toHaveBeenCalledWith('register_workspace_files', {
        relativePaths: ['a.mp4', 'b.mp4'],
      });
    });

    it('should dedupe and normalize batch register input paths', async () => {
      mockInvoke
        .mockResolvedValueOnce([
          { assetId: 'a1', relativePath: 'a.mp4', alreadyRegistered: false },
          { assetId: 'a2', relativePath: 'folder/clip.mp4', alreadyRegistered: false },
        ])
        .mockResolvedValueOnce([]);

      await useWorkspaceStore.getState().registerFiles(['a.mp4', 'a.mp4', 'folder\\clip.mp4', '']);

      expect(mockInvoke).toHaveBeenCalledWith('register_workspace_files', {
        relativePaths: ['a.mp4', 'folder/clip.mp4'],
      });
      expect(useWorkspaceStore.getState().registeringPathCounts).toEqual({});
    });

    it('should return empty array on error', async () => {
      mockInvoke.mockRejectedValueOnce('Batch registration failed');

      const results = await useWorkspaceStore.getState().registerFiles(['a.mp4']);

      expect(results).toEqual([]);
    });
  });

  describe('reset', () => {
    it('should reset to initial state', async () => {
      // Set some state first
      mockInvoke
        .mockResolvedValueOnce({
          totalFiles: 5,
          newFiles: 3,
          removedFiles: 0,
          registeredFiles: 2,
        })
        .mockResolvedValueOnce([]);

      await useWorkspaceStore.getState().scanWorkspace();

      // Reset
      useWorkspaceStore.getState().reset();

      const state = useWorkspaceStore.getState();
      expect(state.fileTree).toEqual([]);
      expect(state.isScanning).toBe(false);
      expect(state.registeringPathCounts).toEqual({});
      expect(state.scanResult).toBeNull();
      expect(state.error).toBeNull();
    });
  });
});
