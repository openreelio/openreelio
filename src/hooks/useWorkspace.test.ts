/**
 * useWorkspace Hook Tests
 */

import { renderHook } from '@testing-library/react';
import { useWorkspace } from './useWorkspace';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { FileTreeEntry } from '@/types';

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

// Mock project store
vi.mock('@/stores', () => ({
  useProjectStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        meta: { path: '/test/project' },
        loadProject: vi.fn(),
      }),
    {
      getState: () => ({
        meta: { path: '/test/project' },
        loadProject: vi.fn(),
      }),
    },
  ),
  useWorkspaceStore: vi.fn(),
}));

const sampleTree: FileTreeEntry[] = [
  {
    relativePath: 'footage',
    name: 'footage',
    isDirectory: true,
    children: [
      {
        relativePath: 'footage/interview.mp4',
        name: 'interview.mp4',
        isDirectory: false,
        kind: 'video',
        fileSize: 1024000,
        assetId: 'asset-1',
        children: [],
      },
      {
        relativePath: 'footage/broll.mp4',
        name: 'broll.mp4',
        isDirectory: false,
        kind: 'video',
        fileSize: 2048000,
        children: [],
      },
    ],
  },
  {
    relativePath: 'audio',
    name: 'audio',
    isDirectory: true,
    children: [
      {
        relativePath: 'audio/bgm.wav',
        name: 'bgm.wav',
        isDirectory: false,
        kind: 'audio',
        fileSize: 512000,
        children: [],
      },
    ],
  },
  {
    relativePath: 'logo.png',
    name: 'logo.png',
    isDirectory: false,
    kind: 'image',
    fileSize: 32000,
    assetId: 'asset-2',
    children: [],
  },
];

beforeEach(() => {
  useWorkspaceStore.setState({
    fileTree: sampleTree,
    isScanning: false,
    isWatching: false,
    scanResult: null,
    error: null,
  });
});

describe('useWorkspace', () => {
  it('should return file tree from store', () => {
    const { result } = renderHook(() => useWorkspace());

    expect(result.current.fileTree).toEqual(sampleTree);
    expect(result.current.isScanning).toBe(false);
  });

  it('should check if file is registered', () => {
    const { result } = renderHook(() => useWorkspace());

    expect(result.current.isFileRegistered('footage/interview.mp4')).toBe(true);
    expect(result.current.isFileRegistered('footage/broll.mp4')).toBe(false);
    expect(result.current.isFileRegistered('logo.png')).toBe(true);
    expect(result.current.isFileRegistered('nonexistent.mp4')).toBe(false);
  });

  it('should find files by name', () => {
    const { result } = renderHook(() => useWorkspace());

    const videos = result.current.findFileByName('interview');
    expect(videos).toHaveLength(1);
    expect(videos[0].name).toBe('interview.mp4');

    const mp4s = result.current.findFileByName('.mp4');
    expect(mp4s).toHaveLength(2); // interview.mp4 and broll.mp4
  });

  it('should find files by kind', () => {
    const { result } = renderHook(() => useWorkspace());

    const videos = result.current.findFilesByKind('video');
    expect(videos).toHaveLength(2);

    const audio = result.current.findFilesByKind('audio');
    expect(audio).toHaveLength(1);
    expect(audio[0].name).toBe('bgm.wav');

    const images = result.current.findFilesByKind('image');
    expect(images).toHaveLength(1);
    expect(images[0].name).toBe('logo.png');
  });

  it('should get unregistered files', () => {
    const { result } = renderHook(() => useWorkspace());

    const unregistered = result.current.getUnregisteredFiles();
    expect(unregistered).toHaveLength(2);
    expect(unregistered.map((f) => f.name).sort()).toEqual(['bgm.wav', 'broll.mp4']);
  });
});
