/**
 * Workspace Store Tests
 *
 * Feature: reporting the files a scan could not measure
 *
 * The backend leaves a workspace file unregistered when no probe could be
 * launched for it: it stays on disk and in the tree, but is not an asset, so
 * nothing in the app can put it on a timeline. The store is the only place that
 * sees that count, so it is the place that has to keep it visible and act on the
 * one event that can change it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkspaceScanResult } from '@/types';

const gateway = vi.hoisted(() => ({
  scanWorkspaceFromBackend: vi.fn(),
  fetchWorkspaceTreeFromBackend: vi.fn(),
  importExternalFilesToWorkspaceFromBackend: vi.fn(),
}));

vi.mock('@/services/workspaceGateway', () => ({
  scanWorkspaceFromBackend: gateway.scanWorkspaceFromBackend,
  fetchWorkspaceTreeFromBackend: gateway.fetchWorkspaceTreeFromBackend,
  createFolderInBackend: vi.fn(),
  renameFileInBackend: vi.fn(),
  moveFileInBackend: vi.fn(),
  deleteFileInBackend: vi.fn(),
  importExternalFilesToWorkspaceFromBackend: gateway.importExternalFilesToWorkspaceFromBackend,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));

import { useWorkspaceStore } from './workspaceStore';

function scanResult(overrides: Partial<WorkspaceScanResult> = {}): WorkspaceScanResult {
  return {
    totalFiles: 3,
    newFiles: 3,
    removedFiles: 0,
    registeredFiles: 0,
    autoRegisteredFiles: 3,
    skippedFiles: 0,
    ...overrides,
  };
}

describe('workspaceStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.getState().reset();
    gateway.fetchWorkspaceTreeFromBackend.mockResolvedValue([]);
  });

  it('should warn about the files it could not measure when a scan skips some', async () => {
    gateway.scanWorkspaceFromBackend.mockResolvedValue(
      scanResult({ autoRegisteredFiles: 1, skippedFiles: 2 }),
    );

    await useWorkspaceStore.getState().scanWorkspace();

    const warning = useWorkspaceStore.getState().scanWarning;
    expect(warning).toContain('2 files');
    expect(warning).toContain('FFprobe could not be launched');
  });

  it('should leave no warning when the scan measured everything', async () => {
    gateway.scanWorkspaceFromBackend.mockResolvedValue(scanResult({ skippedFiles: 0 }));

    await useWorkspaceStore.getState().scanWorkspace();

    expect(useWorkspaceStore.getState().scanWarning).toBeNull();
  });

  it('should clear a previous warning once a later scan measures everything', async () => {
    gateway.scanWorkspaceFromBackend.mockResolvedValueOnce(scanResult({ skippedFiles: 2 }));
    await useWorkspaceStore.getState().scanWorkspace();
    expect(useWorkspaceStore.getState().scanWarning).not.toBeNull();

    gateway.scanWorkspaceFromBackend.mockResolvedValueOnce(scanResult({ skippedFiles: 0 }));
    await useWorkspaceStore.getState().scanWorkspace();

    expect(useWorkspaceStore.getState().scanWarning).toBeNull();
  });

  it('should re-scan when FFmpeg becomes available and the last scan left files unmeasured', async () => {
    gateway.scanWorkspaceFromBackend.mockResolvedValueOnce(scanResult({ skippedFiles: 2 }));
    await useWorkspaceStore.getState().scanWorkspace();

    gateway.scanWorkspaceFromBackend.mockResolvedValueOnce(
      scanResult({ autoRegisteredFiles: 3, skippedFiles: 0 }),
    );
    await useWorkspaceStore.getState().rescanUnmeasuredFiles();

    expect(gateway.scanWorkspaceFromBackend).toHaveBeenCalledTimes(2);
    expect(useWorkspaceStore.getState().scanWarning).toBeNull();
  });

  it('should not re-scan when nothing was left unmeasured', async () => {
    gateway.scanWorkspaceFromBackend.mockResolvedValue(scanResult({ skippedFiles: 0 }));
    await useWorkspaceStore.getState().scanWorkspace();

    await useWorkspaceStore.getState().rescanUnmeasuredFiles();

    // A whole-workspace scan is not worth spending on an event that says
    // nothing about the workspace's contents.
    expect(gateway.scanWorkspaceFromBackend).toHaveBeenCalledTimes(1);
  });

  it('should not re-scan before any scan has run', async () => {
    await useWorkspaceStore.getState().rescanUnmeasuredFiles();

    expect(gateway.scanWorkspaceFromBackend).not.toHaveBeenCalled();
  });

  it('should return the result rather than throw when a drop imported nothing', async () => {
    // Every entry in `failedFiles` already carries the backend's reason for
    // that file. Throwing would replace all of them with one generic error, and
    // the explorer would have nothing specific left to show.
    gateway.importExternalFilesToWorkspaceFromBackend.mockResolvedValue({
      importedFiles: [],
      failedFiles: [
        { sourcePath: '/drop/unreachable.mp4', message: "'unreachable.mp4' was copied but ..." },
      ],
    });

    const result = await useWorkspaceStore
      .getState()
      .importExternalFiles(['/drop/unreachable.mp4']);

    expect(result.failedFiles).toHaveLength(1);
  });

  it('should re-scan when FFmpeg becomes available and a drop left files unregistered', async () => {
    // A drop's leftovers never reach `scanResult.skippedFiles` - that counts
    // what a scan left out - so a guard reading only the scan would strand the
    // dropped file until the user scanned by hand.
    gateway.importExternalFilesToWorkspaceFromBackend.mockResolvedValue({
      importedFiles: [],
      failedFiles: [
        { sourcePath: '/drop/unreachable.mp4', message: "'unreachable.mp4' was copied but ..." },
      ],
    });
    await useWorkspaceStore.getState().importExternalFiles(['/drop/unreachable.mp4']);

    gateway.scanWorkspaceFromBackend.mockResolvedValue(
      scanResult({ autoRegisteredFiles: 1, skippedFiles: 0 }),
    );
    await useWorkspaceStore.getState().rescanUnmeasuredFiles();

    expect(gateway.scanWorkspaceFromBackend).toHaveBeenCalledTimes(1);

    // The scan was the retry those files were waiting for, so the next event
    // must not scan the whole workspace all over again.
    await useWorkspaceStore.getState().rescanUnmeasuredFiles();
    expect(gateway.scanWorkspaceFromBackend).toHaveBeenCalledTimes(1);
  });
});
