/**
 * Workspace Store Tests
 */

import {
  cleanupWorkspaceEventListeners,
  setupWorkspaceEventListeners,
  useWorkspaceStore,
} from './workspaceStore';

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

const gatewayMocks = vi.hoisted(() => ({
  scanWorkspaceFromBackend: vi.fn(),
  fetchWorkspaceTreeFromBackend: vi.fn(),
  createFolderInBackend: vi.fn(),
  renameFileInBackend: vi.fn(),
  moveFileInBackend: vi.fn(),
  deleteFileInBackend: vi.fn(),
}));

vi.mock('@/services/workspaceGateway', () => gatewayMocks);

import { listen } from '@tauri-apps/api/event';
import type { FileTreeEntry, WorkspaceScanResult } from '@/types';

const mockListen = vi.mocked(listen);

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  await cleanupWorkspaceEventListeners();
  useWorkspaceStore.getState().reset();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('workspaceStore', () => {
  describe('initial state', () => {
    it('should have empty file tree', () => {
      const state = useWorkspaceStore.getState();
      expect(state.fileTree).toEqual([]);
      expect(state.isScanning).toBe(false);
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
        autoRegisteredFiles: 3,
      };

      gatewayMocks.scanWorkspaceFromBackend.mockResolvedValueOnce(scanResult);
      gatewayMocks.fetchWorkspaceTreeFromBackend.mockResolvedValueOnce([]);

      const promise = useWorkspaceStore.getState().scanWorkspace();

      await promise;

      const state = useWorkspaceStore.getState();
      expect(state.isScanning).toBe(false);
      expect(state.scanResult).toEqual(scanResult);
    });

    it('should handle scan errors', async () => {
      gatewayMocks.scanWorkspaceFromBackend.mockRejectedValueOnce('Scan failed: permission denied');

      await useWorkspaceStore.getState().scanWorkspace();

      const state = useWorkspaceStore.getState();
      expect(state.isScanning).toBe(false);
      expect(state.error).toBe('Scan failed: permission denied');
    });

    it('should reject malformed scan payloads defensively', async () => {
      gatewayMocks.scanWorkspaceFromBackend.mockRejectedValueOnce(
        new Error('Invalid workspace scan result payload: totalFiles: Expected number, received string'),
      );

      await useWorkspaceStore.getState().scanWorkspace();

      expect(useWorkspaceStore.getState().error).toContain('Invalid workspace scan result payload');
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

      gatewayMocks.fetchWorkspaceTreeFromBackend.mockResolvedValueOnce(tree);

      await useWorkspaceStore.getState().refreshTree();

      const state = useWorkspaceStore.getState();
      expect(state.fileTree).toEqual(tree);
      expect(state.error).toBeNull();
    });

    it('should handle refresh errors', async () => {
      gatewayMocks.fetchWorkspaceTreeFromBackend.mockRejectedValueOnce('No project open');

      await useWorkspaceStore.getState().refreshTree();

      const state = useWorkspaceStore.getState();
      expect(state.error).toBe('No project open');
    });

    it('should keep latest tree when responses arrive out of order', async () => {
      const firstTree: FileTreeEntry[] = [
        {
          relativePath: 'old',
          name: 'old',
          isDirectory: true,
          children: [],
        },
      ];
      const secondTree: FileTreeEntry[] = [
        {
          relativePath: 'new',
          name: 'new',
          isDirectory: true,
          children: [],
        },
      ];

      const first = createDeferred<FileTreeEntry[]>();
      const second = createDeferred<FileTreeEntry[]>();

      let callCount = 0;
      gatewayMocks.fetchWorkspaceTreeFromBackend.mockImplementation(async () => {
        callCount += 1;
        return callCount === 1 ? first.promise : second.promise;
      });

      const refreshA = useWorkspaceStore.getState().refreshTree();
      const refreshB = useWorkspaceStore.getState().refreshTree();

      second.resolve(secondTree);
      await refreshB;
      first.resolve(firstTree);
      await refreshA;

      expect(useWorkspaceStore.getState().fileTree).toEqual(secondTree);
    });
  });

  describe('createFolder', () => {
    it('should call gateway and refresh tree on success', async () => {
      const tree: FileTreeEntry[] = [
        {
          relativePath: 'new-folder',
          name: 'new-folder',
          isDirectory: true,
          children: [],
        },
      ];

      gatewayMocks.createFolderInBackend.mockResolvedValueOnce(undefined);
      gatewayMocks.fetchWorkspaceTreeFromBackend.mockResolvedValueOnce(tree);

      await useWorkspaceStore.getState().createFolder('new-folder');

      expect(gatewayMocks.createFolderInBackend).toHaveBeenCalledWith('new-folder');
      expect(useWorkspaceStore.getState().fileTree).toEqual(tree);
    });

    it('should set error and rethrow on failure', async () => {
      gatewayMocks.createFolderInBackend.mockRejectedValueOnce(new Error('Folder exists'));

      await expect(useWorkspaceStore.getState().createFolder('existing')).rejects.toThrow(
        'Folder exists',
      );
      expect(useWorkspaceStore.getState().error).toBe('Folder exists');
    });
  });

  describe('renameFile', () => {
    it('should call gateway and refresh tree on success', async () => {
      const tree: FileTreeEntry[] = [
        {
          relativePath: 'renamed.mp4',
          name: 'renamed.mp4',
          isDirectory: false,
          kind: 'video',
          fileSize: 1024,
          children: [],
        },
      ];

      gatewayMocks.renameFileInBackend.mockResolvedValueOnce(undefined);
      gatewayMocks.fetchWorkspaceTreeFromBackend.mockResolvedValueOnce(tree);

      await useWorkspaceStore.getState().renameFile('old.mp4', 'renamed.mp4');

      expect(gatewayMocks.renameFileInBackend).toHaveBeenCalledWith('old.mp4', 'renamed.mp4');
      expect(useWorkspaceStore.getState().fileTree).toEqual(tree);
    });

    it('should set error and rethrow on failure', async () => {
      gatewayMocks.renameFileInBackend.mockRejectedValueOnce(new Error('File not found'));

      await expect(
        useWorkspaceStore.getState().renameFile('missing.mp4', 'new.mp4'),
      ).rejects.toThrow('File not found');
      expect(useWorkspaceStore.getState().error).toBe('File not found');
    });
  });

  describe('moveFile', () => {
    it('should call gateway and refresh tree on success', async () => {
      const tree: FileTreeEntry[] = [
        {
          relativePath: 'dest',
          name: 'dest',
          isDirectory: true,
          children: [
            {
              relativePath: 'dest/clip.mp4',
              name: 'clip.mp4',
              isDirectory: false,
              kind: 'video',
              fileSize: 2048,
              children: [],
            },
          ],
        },
      ];

      gatewayMocks.moveFileInBackend.mockResolvedValueOnce(undefined);
      gatewayMocks.fetchWorkspaceTreeFromBackend.mockResolvedValueOnce(tree);

      await useWorkspaceStore.getState().moveFile('clip.mp4', 'dest');

      expect(gatewayMocks.moveFileInBackend).toHaveBeenCalledWith('clip.mp4', 'dest');
      expect(useWorkspaceStore.getState().fileTree).toEqual(tree);
    });

    it('should set error and rethrow on failure', async () => {
      gatewayMocks.moveFileInBackend.mockRejectedValueOnce(new Error('Destination invalid'));

      await expect(
        useWorkspaceStore.getState().moveFile('clip.mp4', 'bad-dest'),
      ).rejects.toThrow('Destination invalid');
      expect(useWorkspaceStore.getState().error).toBe('Destination invalid');
    });
  });

  describe('deleteFile', () => {
    it('should call gateway and refresh tree on success', async () => {
      gatewayMocks.deleteFileInBackend.mockResolvedValueOnce(undefined);
      gatewayMocks.fetchWorkspaceTreeFromBackend.mockResolvedValueOnce([]);

      await useWorkspaceStore.getState().deleteFile('old-clip.mp4');

      expect(gatewayMocks.deleteFileInBackend).toHaveBeenCalledWith('old-clip.mp4');
      expect(useWorkspaceStore.getState().fileTree).toEqual([]);
    });

    it('should set error and rethrow on failure', async () => {
      gatewayMocks.deleteFileInBackend.mockRejectedValueOnce(new Error('Permission denied'));

      await expect(useWorkspaceStore.getState().deleteFile('protected.mp4')).rejects.toThrow(
        'Permission denied',
      );
      expect(useWorkspaceStore.getState().error).toBe('Permission denied');
    });
  });

  describe('event listeners', () => {
    it('should coalesce refreshes and ignore invalid watcher payloads', async () => {
      vi.useFakeTimers();

      gatewayMocks.fetchWorkspaceTreeFromBackend.mockResolvedValue([]);
      await setupWorkspaceEventListeners();

      const fileAddedHandler = mockListen.mock.calls.find(
        (call) => call[0] === 'workspace:file-added',
      )?.[1];
      expect(fileAddedHandler).toBeDefined();

      fileAddedHandler?.({ payload: { relativePath: '../escape.mp4', kind: 'video' } } as never);
      fileAddedHandler?.({ payload: { relativePath: 'footage/clip.mp4', kind: 'video' } } as never);
      fileAddedHandler?.({ payload: { relativePath: 'footage/clip.mp4', kind: 'video' } } as never);

      expect(gatewayMocks.fetchWorkspaceTreeFromBackend).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(150);
      expect(gatewayMocks.fetchWorkspaceTreeFromBackend).toHaveBeenCalledTimes(1);

      await cleanupWorkspaceEventListeners();
      expect(useWorkspaceStore.getState().isWatching).toBe(false);
    });
  });

  describe('reset', () => {
    it('should reset to initial state', async () => {
      const scanResult: WorkspaceScanResult = {
        totalFiles: 5,
        newFiles: 3,
        removedFiles: 0,
        registeredFiles: 2,
        autoRegisteredFiles: 3,
      };

      gatewayMocks.scanWorkspaceFromBackend.mockResolvedValueOnce(scanResult);
      gatewayMocks.fetchWorkspaceTreeFromBackend.mockResolvedValueOnce([]);

      await useWorkspaceStore.getState().scanWorkspace();

      // Reset
      useWorkspaceStore.getState().reset();

      const state = useWorkspaceStore.getState();
      expect(state.fileTree).toEqual([]);
      expect(state.isScanning).toBe(false);
      expect(state.scanResult).toBeNull();
      expect(state.error).toBeNull();
    });
  });
});
