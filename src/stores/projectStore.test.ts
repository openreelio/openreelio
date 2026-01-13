/**
 * Project Store Tests
 *
 * Tests for Zustand project store using TDD methodology.
 * Tests cover state management, Tauri IPC integration, and error handling.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from './projectStore';
import {
  createMockProjectMeta,
  createMockProjectState,
  mockTauriCommand,
  mockTauriCommands,
  mockTauriCommandError,
  getMockedInvoke,
  resetTauriMocks,
} from '@/test/mocks/tauri';

// =============================================================================
// Test Setup
// =============================================================================

describe('projectStore', () => {
  beforeEach(() => {
    // Reset mocks and store to initial state before each test
    resetTauriMocks();
    useProjectStore.setState({
      isLoaded: false,
      isLoading: false,
      isDirty: false,
      meta: null,
      assets: new Map(),
      sequences: new Map(),
      activeSequenceId: null,
      selectedAssetId: null,
      error: null,
    });
  });

  // ===========================================================================
  // Initial State Tests
  // ===========================================================================

  describe('initial state', () => {
    it('should have correct initial state', () => {
      const state = useProjectStore.getState();

      expect(state.isLoaded).toBe(false);
      expect(state.isLoading).toBe(false);
      expect(state.isDirty).toBe(false);
      expect(state.meta).toBeNull();
      expect(state.assets).toBeInstanceOf(Map);
      expect(state.assets.size).toBe(0);
      expect(state.sequences).toBeInstanceOf(Map);
      expect(state.sequences.size).toBe(0);
      expect(state.activeSequenceId).toBeNull();
      expect(state.error).toBeNull();
    });
  });

  // ===========================================================================
  // Project Loading Tests
  // ===========================================================================

  describe('loadProject', () => {
    it('should load project successfully', async () => {
      const mockMeta = createMockProjectMeta({
        name: 'My Project',
        path: '/path/to/project',
      });
      const mockState = createMockProjectState();

      mockTauriCommands({
        'open_project': mockMeta,
        'get_project_state': mockState,
      });

      const { loadProject } = useProjectStore.getState();
      await loadProject('/path/to/project');

      const state = useProjectStore.getState();
      expect(state.isLoaded).toBe(true);
      expect(state.isLoading).toBe(false);
      expect(state.meta).toEqual(mockMeta);
      expect(state.isDirty).toBe(false);
    });

    it('should set isLoading during load', async () => {
      const mockMeta = createMockProjectMeta();
      const mockState = createMockProjectState();

      // Create a delayed response to capture loading state
      const mockedInvoke = getMockedInvoke();
      let resolveCount = 0;
      let resolvers: Array<(value: unknown) => void> = [];

      mockedInvoke.mockImplementation(() => {
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      });

      const loadPromise = useProjectStore.getState().loadProject('/path/to/project');

      // Check loading state
      expect(useProjectStore.getState().isLoading).toBe(true);

      // Resolve both promises in order
      resolvers[0]?.(mockMeta);
      await Promise.resolve(); // let microtask queue process
      resolvers[1]?.(mockState);
      await loadPromise;

      expect(useProjectStore.getState().isLoading).toBe(false);
    });

    it('should handle load error', async () => {
      mockTauriCommandError('open_project', 'Project not found');

      const { loadProject } = useProjectStore.getState();

      await expect(loadProject('/invalid/path')).rejects.toThrow('Project not found');

      const state = useProjectStore.getState();
      expect(state.isLoaded).toBe(false);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBe('Project not found');
    });

    it('should call invoke with correct arguments', async () => {
      const mockMeta = createMockProjectMeta();
      const mockState = createMockProjectState();

      mockTauriCommands({
        'open_project': mockMeta,
        'get_project_state': mockState,
      });

      await useProjectStore.getState().loadProject('/my/project/path');

      expect(invoke).toHaveBeenCalledWith('open_project', { path: '/my/project/path' });
    });
  });

  // ===========================================================================
  // Project Creation Tests
  // ===========================================================================

  describe('createProject', () => {
    it('should create project successfully', async () => {
      const mockMeta = createMockProjectMeta({
        name: 'New Project',
        path: '/new/project/path',
      });

      mockTauriCommand('create_project', mockMeta);

      const { createProject } = useProjectStore.getState();
      await createProject('New Project', '/new/project/path');

      const state = useProjectStore.getState();
      expect(state.isLoaded).toBe(true);
      expect(state.meta?.name).toBe('New Project');
      expect(state.assets.size).toBe(0);
      expect(state.sequences.size).toBe(0);
    });

    it('should handle creation error', async () => {
      mockTauriCommandError('create_project', 'Permission denied');

      const { createProject } = useProjectStore.getState();

      await expect(createProject('Test', '/invalid')).rejects.toThrow('Permission denied');

      const state = useProjectStore.getState();
      expect(state.error).toBe('Permission denied');
    });

    it('should call invoke with correct arguments', async () => {
      mockTauriCommand('create_project', createMockProjectMeta());

      await useProjectStore.getState().createProject('My Project', '/path/to/new');

      expect(invoke).toHaveBeenCalledWith('create_project', {
        name: 'My Project',
        path: '/path/to/new',
      });
    });
  });

  // ===========================================================================
  // Project Save Tests
  // ===========================================================================

  describe('saveProject', () => {
    it('should save project successfully', async () => {
      // Setup loaded project state
      useProjectStore.setState({
        isLoaded: true,
        isDirty: true,
        meta: createMockProjectMeta(),
      });

      mockTauriCommand('save_project', undefined);

      const { saveProject } = useProjectStore.getState();
      await saveProject();

      const state = useProjectStore.getState();
      expect(state.isDirty).toBe(false);
    });

    it('should update modifiedAt timestamp on save', async () => {
      const originalDate = '2024-01-01T00:00:00Z';
      useProjectStore.setState({
        isLoaded: true,
        isDirty: true,
        meta: createMockProjectMeta({ modifiedAt: originalDate }),
      });

      mockTauriCommand('save_project', undefined);

      await useProjectStore.getState().saveProject();

      const state = useProjectStore.getState();
      expect(state.meta?.modifiedAt).not.toBe(originalDate);
    });

    it('should handle save error', async () => {
      useProjectStore.setState({
        isLoaded: true,
        isDirty: true,
        meta: createMockProjectMeta(),
      });

      mockTauriCommandError('save_project', 'Disk full');

      const { saveProject } = useProjectStore.getState();

      await expect(saveProject()).rejects.toThrow('Disk full');

      const state = useProjectStore.getState();
      expect(state.error).toBe('Disk full');
    });
  });

  // ===========================================================================
  // Project Close Tests
  // ===========================================================================

  describe('closeProject', () => {
    it('should reset state when closing project', () => {
      // Setup loaded project state
      useProjectStore.setState({
        isLoaded: true,
        isDirty: true,
        meta: createMockProjectMeta(),
        activeSequenceId: 'seq_001',
      });

      const { closeProject } = useProjectStore.getState();
      closeProject();

      const state = useProjectStore.getState();
      expect(state.isLoaded).toBe(false);
      expect(state.meta).toBeNull();
      expect(state.assets.size).toBe(0);
      expect(state.sequences.size).toBe(0);
      expect(state.activeSequenceId).toBeNull();
      expect(state.isDirty).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  // ===========================================================================
  // Asset Management Tests
  // ===========================================================================

  describe('importAsset', () => {
    it('should import asset successfully', async () => {
      const mockAssets = [{ id: 'asset_001', name: 'video.mp4', uri: '/path/to/video.mp4' }];

      mockTauriCommands({
        'import_asset': { assetId: 'asset_001', name: 'video.mp4' },
        'get_assets': mockAssets,
        'generate_asset_thumbnail': null,
      });

      const { importAsset } = useProjectStore.getState();
      const assetId = await importAsset('/path/to/video.mp4');

      expect(assetId).toBe('asset_001');
      expect(useProjectStore.getState().isDirty).toBe(true);
    });

    it('should call invoke with correct arguments', async () => {
      const mockAssets = [{ id: 'asset_001', name: 'video.mp4', uri: '/path/to/video.mp4' }];

      mockTauriCommands({
        'import_asset': { assetId: 'asset_001', name: 'video.mp4' },
        'get_assets': mockAssets,
        'generate_asset_thumbnail': null,
      });

      await useProjectStore.getState().importAsset('/path/to/video.mp4');

      expect(invoke).toHaveBeenCalledWith('import_asset', { uri: '/path/to/video.mp4' });
    });

    it('should handle import error', async () => {
      mockTauriCommandError('import_asset', 'File not found');

      const { importAsset } = useProjectStore.getState();

      await expect(importAsset('/invalid/path')).rejects.toThrow('File not found');

      expect(useProjectStore.getState().error).toBe('File not found');
    });
  });

  describe('removeAsset', () => {
    it('should remove asset successfully', async () => {
      // Setup state with an asset
      const assets = new Map();
      assets.set('asset_001', { id: 'asset_001', name: 'video.mp4' });
      useProjectStore.setState({ assets });

      mockTauriCommand('remove_asset', undefined);

      const { removeAsset } = useProjectStore.getState();
      await removeAsset('asset_001');

      const state = useProjectStore.getState();
      expect(state.assets.has('asset_001')).toBe(false);
      expect(state.isDirty).toBe(true);
    });

    it('should handle remove error', async () => {
      mockTauriCommandError('remove_asset', 'Asset in use');

      const { removeAsset } = useProjectStore.getState();

      await expect(removeAsset('asset_001')).rejects.toThrow('Asset in use');
    });
  });

  describe('getAsset', () => {
    it('should return asset by ID', () => {
      const assets = new Map();
      const testAsset = { id: 'asset_001', name: 'video.mp4' };
      assets.set('asset_001', testAsset);
      useProjectStore.setState({ assets });

      const { getAsset } = useProjectStore.getState();
      const asset = getAsset('asset_001');

      expect(asset).toEqual(testAsset);
    });

    it('should return undefined for non-existent asset', () => {
      const { getAsset } = useProjectStore.getState();
      const asset = getAsset('non_existent');

      expect(asset).toBeUndefined();
    });
  });

  // ===========================================================================
  // Sequence Management Tests
  // ===========================================================================

  describe('createSequence', () => {
    it('should create sequence successfully', async () => {
      mockTauriCommand('create_sequence', { id: 'seq_001' });

      const { createSequence } = useProjectStore.getState();
      const sequenceId = await createSequence('Main Sequence', 'youtube_1080');

      expect(sequenceId).toBe('seq_001');
      expect(useProjectStore.getState().isDirty).toBe(true);
    });

    it('should set as active sequence if none active', async () => {
      mockTauriCommand('create_sequence', { id: 'seq_001' });

      await useProjectStore.getState().createSequence('Main', 'youtube_1080');

      expect(useProjectStore.getState().activeSequenceId).toBe('seq_001');
    });

    it('should call invoke with correct arguments', async () => {
      mockTauriCommand('create_sequence', { id: 'seq_001' });

      await useProjectStore.getState().createSequence('My Sequence', 'youtube_4k');

      expect(invoke).toHaveBeenCalledWith('create_sequence', {
        name: 'My Sequence',
        format: 'youtube_4k',
      });
    });
  });

  describe('setActiveSequence', () => {
    it('should set active sequence if it exists', () => {
      const sequences = new Map();
      sequences.set('seq_001', { id: 'seq_001', name: 'Main' });
      useProjectStore.setState({ sequences });

      const { setActiveSequence } = useProjectStore.getState();
      setActiveSequence('seq_001');

      expect(useProjectStore.getState().activeSequenceId).toBe('seq_001');
    });

    it('should not set active sequence if it does not exist', () => {
      useProjectStore.setState({ activeSequenceId: 'seq_existing' });

      const { setActiveSequence } = useProjectStore.getState();
      setActiveSequence('seq_nonexistent');

      expect(useProjectStore.getState().activeSequenceId).toBe('seq_existing');
    });
  });

  describe('getActiveSequence', () => {
    it('should return active sequence', () => {
      const sequences = new Map();
      const testSequence = { id: 'seq_001', name: 'Main' };
      sequences.set('seq_001', testSequence);
      useProjectStore.setState({ sequences, activeSequenceId: 'seq_001' });

      const { getActiveSequence } = useProjectStore.getState();
      const sequence = getActiveSequence();

      expect(sequence).toEqual(testSequence);
    });

    it('should return undefined if no active sequence', () => {
      const { getActiveSequence } = useProjectStore.getState();
      const sequence = getActiveSequence();

      expect(sequence).toBeUndefined();
    });
  });

  // ===========================================================================
  // Command Execution Tests
  // ===========================================================================

  describe('executeCommand', () => {
    it('should execute command successfully', async () => {
      const mockResult = {
        opId: 'op_001',
        changes: [{ type: 'ClipCreated', clipId: 'clip_001' }],
        createdIds: ['clip_001'],
        deletedIds: [],
      };

      mockTauriCommand('execute_command', mockResult);

      const { executeCommand } = useProjectStore.getState();
      const result = await executeCommand({
        type: 'InsertClip',
        payload: { assetId: 'asset_001', trackId: 'track_001' },
      });

      expect(result).toEqual(mockResult);
      expect(useProjectStore.getState().isDirty).toBe(true);
    });

    it('should handle command error', async () => {
      mockTauriCommandError('execute_command', 'Invalid command');

      const { executeCommand } = useProjectStore.getState();

      await expect(
        executeCommand({ type: 'DeleteClip', payload: {} })
      ).rejects.toThrow('Invalid command');
    });
  });

  // ===========================================================================
  // Undo/Redo Tests
  // ===========================================================================

  describe('undo', () => {
    it('should undo successfully', async () => {
      mockTauriCommand('undo', undefined);

      const { undo } = useProjectStore.getState();
      await undo();

      expect(useProjectStore.getState().isDirty).toBe(true);
    });

    it('should handle undo error', async () => {
      mockTauriCommandError('undo', 'Nothing to undo');

      const { undo } = useProjectStore.getState();

      await expect(undo()).rejects.toThrow('Nothing to undo');
    });
  });

  describe('redo', () => {
    it('should redo successfully', async () => {
      const mockResult = { opId: 'op_001', changes: [], createdIds: [], deletedIds: [] };
      mockTauriCommand('redo', mockResult);

      const { redo } = useProjectStore.getState();
      const result = await redo();

      expect(result).toEqual(mockResult);
      expect(useProjectStore.getState().isDirty).toBe(true);
    });
  });

  describe('canUndo', () => {
    it('should return true when undo is available', async () => {
      mockTauriCommand('can_undo', true);

      const { canUndo } = useProjectStore.getState();
      const result = await canUndo();

      expect(result).toBe(true);
    });

    it('should return false when undo is not available', async () => {
      mockTauriCommand('can_undo', false);

      const { canUndo } = useProjectStore.getState();
      const result = await canUndo();

      expect(result).toBe(false);
    });

    it('should return false on error', async () => {
      mockTauriCommandError('can_undo', 'Some error');

      const { canUndo } = useProjectStore.getState();
      const result = await canUndo();

      expect(result).toBe(false);
    });
  });

  describe('canRedo', () => {
    it('should return true when redo is available', async () => {
      mockTauriCommand('can_redo', true);

      const { canRedo } = useProjectStore.getState();
      const result = await canRedo();

      expect(result).toBe(true);
    });

    it('should return false on error', async () => {
      mockTauriCommandError('can_redo', 'Some error');

      const { canRedo } = useProjectStore.getState();
      const result = await canRedo();

      expect(result).toBe(false);
    });
  });
});
