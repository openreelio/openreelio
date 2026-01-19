/**
 * useExportDialog Hook Tests
 *
 * TDD: RED phase - Tests written before implementation
 * Tests for export dialog state management and Tauri event handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useExportDialog } from './useExportDialog';

// Mock Tauri APIs
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockImplementation(() => Promise.resolve(() => {})),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';

// =============================================================================
// Tests
// =============================================================================

describe('useExportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Initial State Tests
  // ===========================================================================

  describe('initial state', () => {
    it('should initialize with default values', () => {
      const { result } = renderHook(() =>
        useExportDialog({
          isOpen: true,
          sequenceId: 'seq_001',
          sequenceName: 'Test Sequence',
        })
      );

      expect(result.current.selectedPreset).toBe('youtube_1080p');
      expect(result.current.outputPath).toBe('');
      expect(result.current.status.type).toBe('idle');
      expect(result.current.isExporting).toBe(false);
      expect(result.current.canExport).toBe(false);
    });

    it('should reset state when dialog opens', () => {
      const { result, rerender } = renderHook(
        ({ isOpen }) =>
          useExportDialog({
            isOpen,
            sequenceId: 'seq_001',
            sequenceName: 'Test Sequence',
          }),
        { initialProps: { isOpen: false } }
      );

      // Set some state
      act(() => {
        result.current.setSelectedPreset('prores');
        result.current.setOutputPath('/some/path.mp4');
      });

      // Close and reopen
      rerender({ isOpen: true });

      expect(result.current.selectedPreset).toBe('youtube_1080p');
      expect(result.current.outputPath).toBe('');
      expect(result.current.status.type).toBe('idle');
    });
  });

  // ===========================================================================
  // State Update Tests
  // ===========================================================================

  describe('state updates', () => {
    it('should update selected preset', () => {
      const { result } = renderHook(() =>
        useExportDialog({
          isOpen: true,
          sequenceId: 'seq_001',
          sequenceName: 'Test Sequence',
        })
      );

      act(() => {
        result.current.setSelectedPreset('webm_vp9');
      });

      expect(result.current.selectedPreset).toBe('webm_vp9');
    });

    it('should update output path', () => {
      const { result } = renderHook(() =>
        useExportDialog({
          isOpen: true,
          sequenceId: 'seq_001',
          sequenceName: 'Test Sequence',
        })
      );

      act(() => {
        result.current.setOutputPath('/path/to/output.mp4');
      });

      expect(result.current.outputPath).toBe('/path/to/output.mp4');
    });

    it('should enable export when output path is set', () => {
      const { result } = renderHook(() =>
        useExportDialog({
          isOpen: true,
          sequenceId: 'seq_001',
          sequenceName: 'Test Sequence',
        })
      );

      expect(result.current.canExport).toBe(false);

      act(() => {
        result.current.setOutputPath('/path/to/output.mp4');
      });

      expect(result.current.canExport).toBe(true);
    });

    it('should not enable export without sequence ID', () => {
      const { result } = renderHook(() =>
        useExportDialog({
          isOpen: true,
          sequenceId: null,
          sequenceName: 'Test Sequence',
        })
      );

      act(() => {
        result.current.setOutputPath('/path/to/output.mp4');
      });

      expect(result.current.canExport).toBe(false);
    });
  });

  // ===========================================================================
  // Browse Handler Tests
  // ===========================================================================

  describe('handleBrowse', () => {
    it('should call save dialog with correct default path', async () => {
      const mockSave = save as ReturnType<typeof vi.fn>;
      mockSave.mockResolvedValue('/selected/path.mp4');

      const { result } = renderHook(() =>
        useExportDialog({
          isOpen: true,
          sequenceId: 'seq_001',
          sequenceName: 'My Video',
        })
      );

      await act(async () => {
        await result.current.handleBrowse();
      });

      expect(mockSave).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: expect.stringContaining('My Video'),
          title: 'Export Video',
        })
      );
    });

    it('should update output path when file is selected', async () => {
      const mockSave = save as ReturnType<typeof vi.fn>;
      mockSave.mockResolvedValue('/selected/output.mp4');

      const { result } = renderHook(() =>
        useExportDialog({
          isOpen: true,
          sequenceId: 'seq_001',
          sequenceName: 'Test',
        })
      );

      await act(async () => {
        await result.current.handleBrowse();
      });

      expect(result.current.outputPath).toBe('/selected/output.mp4');
    });

    it('should not update output path when dialog is cancelled', async () => {
      const mockSave = save as ReturnType<typeof vi.fn>;
      mockSave.mockResolvedValue(null);

      const { result } = renderHook(() =>
        useExportDialog({
          isOpen: true,
          sequenceId: 'seq_001',
          sequenceName: 'Test',
        })
      );

      act(() => {
        result.current.setOutputPath('/existing/path.mp4');
      });

      await act(async () => {
        await result.current.handleBrowse();
      });

      expect(result.current.outputPath).toBe('/existing/path.mp4');
    });

    it('should use correct extension for webm preset', async () => {
      const mockSave = save as ReturnType<typeof vi.fn>;
      mockSave.mockResolvedValue('/output.webm');

      const { result } = renderHook(() =>
        useExportDialog({
          isOpen: true,
          sequenceId: 'seq_001',
          sequenceName: 'Test',
        })
      );

      act(() => {
        result.current.setSelectedPreset('webm_vp9');
      });

      await act(async () => {
        await result.current.handleBrowse();
      });

      expect(mockSave).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: 'Test.webm',
          filters: [{ name: 'Video', extensions: ['webm'] }],
        })
      );
    });
  });

  // ===========================================================================
  // Export Handler Tests
  // ===========================================================================

  describe('handleExport', () => {
    it('should set exporting status and call invoke', async () => {
      const mockInvoke = invoke as ReturnType<typeof vi.fn>;
      mockInvoke.mockResolvedValue({ jobId: 'job_123', status: 'started' });

      const { result } = renderHook(() =>
        useExportDialog({
          isOpen: true,
          sequenceId: 'seq_001',
          sequenceName: 'Test',
        })
      );

      act(() => {
        result.current.setOutputPath('/output.mp4');
      });

      await act(async () => {
        await result.current.handleExport();
      });

      expect(mockInvoke).toHaveBeenCalledWith('start_render', {
        sequenceId: 'seq_001',
        outputPath: '/output.mp4',
        preset: 'youtube_1080p',
      });
    });

    it('should not call invoke without output path', async () => {
      const mockInvoke = invoke as ReturnType<typeof vi.fn>;

      const { result } = renderHook(() =>
        useExportDialog({
          isOpen: true,
          sequenceId: 'seq_001',
          sequenceName: 'Test',
        })
      );

      await act(async () => {
        await result.current.handleExport();
      });

      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should handle immediate completion', async () => {
      const mockInvoke = invoke as ReturnType<typeof vi.fn>;
      mockInvoke.mockResolvedValue({
        jobId: 'job_123',
        outputPath: '/output.mp4',
        status: 'completed',
      });

      const { result } = renderHook(() =>
        useExportDialog({
          isOpen: true,
          sequenceId: 'seq_001',
          sequenceName: 'Test',
        })
      );

      act(() => {
        result.current.setOutputPath('/output.mp4');
      });

      await act(async () => {
        await result.current.handleExport();
      });

      expect(result.current.status.type).toBe('completed');
    });

    it('should handle export error', async () => {
      const mockInvoke = invoke as ReturnType<typeof vi.fn>;
      mockInvoke.mockRejectedValue(new Error('FFmpeg not found'));

      const { result } = renderHook(() =>
        useExportDialog({
          isOpen: true,
          sequenceId: 'seq_001',
          sequenceName: 'Test',
        })
      );

      act(() => {
        result.current.setOutputPath('/output.mp4');
      });

      await act(async () => {
        await result.current.handleExport();
      });

      expect(result.current.status.type).toBe('failed');
      if (result.current.status.type === 'failed') {
        expect(result.current.status.error).toBe('FFmpeg not found');
      }
    });
  });

  // ===========================================================================
  // Retry Handler Tests
  // ===========================================================================

  describe('handleRetry', () => {
    it('should reset status to idle', async () => {
      const mockInvoke = invoke as ReturnType<typeof vi.fn>;
      mockInvoke.mockRejectedValue(new Error('Export failed'));

      const { result } = renderHook(() =>
        useExportDialog({
          isOpen: true,
          sequenceId: 'seq_001',
          sequenceName: 'Test',
        })
      );

      act(() => {
        result.current.setOutputPath('/output.mp4');
      });

      await act(async () => {
        await result.current.handleExport();
      });

      expect(result.current.status.type).toBe('failed');

      act(() => {
        result.current.handleRetry();
      });

      expect(result.current.status.type).toBe('idle');
    });
  });

  // ===========================================================================
  // Computed Properties Tests
  // ===========================================================================

  describe('computed properties', () => {
    it('should compute isExporting correctly', async () => {
      const mockInvoke = invoke as ReturnType<typeof vi.fn>;
      // Return a promise that never resolves to keep in exporting state
      mockInvoke.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() =>
        useExportDialog({
          isOpen: true,
          sequenceId: 'seq_001',
          sequenceName: 'Test',
        })
      );

      expect(result.current.isExporting).toBe(false);

      act(() => {
        result.current.setOutputPath('/output.mp4');
      });

      // Start export (don't await since it never resolves)
      act(() => {
        void result.current.handleExport();
      });

      // Status should be set to exporting synchronously before invoke completes
      await waitFor(() => {
        expect(result.current.isExporting).toBe(true);
      });
    });

    it('should compute showSettings correctly', () => {
      const { result } = renderHook(() =>
        useExportDialog({
          isOpen: true,
          sequenceId: 'seq_001',
          sequenceName: 'Test',
        })
      );

      expect(result.current.showSettings).toBe(true);
    });
  });
});
