/**
 * useHDRSettings Hook Tests
 *
 * TDD: RED phase - Writing tests first
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useHDRSettings } from './useHDRSettings';
import { DEFAULT_HDR_EXPORT, HDR10_EXPORT_PRESET } from '@/types/hdr';

// =============================================================================
// Mocks
// =============================================================================

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// =============================================================================
// Test Suite
// =============================================================================

describe('useHDRSettings', () => {
  const mockSequenceId = 'seq-123';

  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Initialization Tests
  // ===========================================================================

  describe('initialization', () => {
    it('should initialize with default SDR settings', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      expect(result.current.settings).toEqual(DEFAULT_HDR_EXPORT);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('should fetch existing settings when available', async () => {
      const mockSettings = {
        hdrMode: 'hdr10',
        maxCll: 1000,
        maxFall: 400,
        bitDepth: 10,
      };

      mockInvoke.mockResolvedValueOnce(mockSettings);

      const { result } = renderHook(() =>
        useHDRSettings({ sequenceId: mockSequenceId, fetchOnMount: true })
      );

      await waitFor(() => {
        expect(result.current.settings.hdrMode).toBe('hdr10');
      });

      expect(mockInvoke).toHaveBeenCalledWith('get_sequence_hdr_settings', {
        sequenceId: mockSequenceId,
      });
    });

    it('should handle fetch error gracefully', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Fetch failed'));

      const { result } = renderHook(() =>
        useHDRSettings({ sequenceId: mockSequenceId, fetchOnMount: true })
      );

      await waitFor(() => {
        expect(result.current.error).toBe('Fetch failed');
      });

      // Should fall back to defaults
      expect(result.current.settings).toEqual(DEFAULT_HDR_EXPORT);
    });
  });

  // ===========================================================================
  // HDR Mode Tests
  // ===========================================================================

  describe('setHdrMode', () => {
    it('should update HDR mode to hdr10', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.setHdrMode('hdr10');
      });

      expect(result.current.settings.hdrMode).toBe('hdr10');
    });

    it('should auto-set bitDepth to 10 when switching to HDR', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      expect(result.current.settings.bitDepth).toBe(8);

      act(() => {
        result.current.setHdrMode('hdr10');
      });

      expect(result.current.settings.bitDepth).toBe(10);
    });

    it('should update HDR mode to hlg', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.setHdrMode('hlg');
      });

      expect(result.current.settings.hdrMode).toBe('hlg');
    });

    it('should revert to SDR defaults when switching back to sdr', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      // First set to HDR10
      act(() => {
        result.current.setHdrMode('hdr10');
        result.current.setMaxCll(2000);
      });

      expect(result.current.settings.maxCll).toBe(2000);

      // Switch back to SDR
      act(() => {
        result.current.setHdrMode('sdr');
      });

      expect(result.current.settings.hdrMode).toBe('sdr');
      expect(result.current.settings.maxCll).toBeUndefined();
    });
  });

  // ===========================================================================
  // Luminance Settings Tests
  // ===========================================================================

  describe('luminance settings', () => {
    it('should update maxCll within valid range', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.setHdrMode('hdr10');
        result.current.setMaxCll(1500);
      });

      expect(result.current.settings.maxCll).toBe(1500);
    });

    it('should clamp maxCll to valid range', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.setHdrMode('hdr10');
        result.current.setMaxCll(15000); // Max is 10000
      });

      expect(result.current.settings.maxCll).toBe(10000);

      act(() => {
        result.current.setMaxCll(0); // Min is 1
      });

      expect(result.current.settings.maxCll).toBe(1);
    });

    it('should update maxFall within valid range', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.setHdrMode('hdr10');
        result.current.setMaxFall(600);
      });

      expect(result.current.settings.maxFall).toBe(600);
    });

    it('should clamp maxFall to valid range', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.setHdrMode('hdr10');
        result.current.setMaxFall(20000); // Max is 10000
      });

      expect(result.current.settings.maxFall).toBe(10000);
    });
  });

  // ===========================================================================
  // Bit Depth Tests
  // ===========================================================================

  describe('setBitDepth', () => {
    it('should update bit depth to valid value', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.setBitDepth(10);
      });

      expect(result.current.settings.bitDepth).toBe(10);
    });

    it('should accept 8, 10, and 12 bit depths', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => result.current.setBitDepth(8));
      expect(result.current.settings.bitDepth).toBe(8);

      act(() => result.current.setBitDepth(10));
      expect(result.current.settings.bitDepth).toBe(10);

      act(() => result.current.setBitDepth(12));
      expect(result.current.settings.bitDepth).toBe(12);
    });
  });

  // ===========================================================================
  // Preset Tests
  // ===========================================================================

  describe('applyPreset', () => {
    it('should apply HDR10 preset', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.applyPreset('hdr10');
      });

      expect(result.current.settings).toEqual(HDR10_EXPORT_PRESET);
    });

    it('should apply SDR preset', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      // First set to HDR10
      act(() => {
        result.current.applyPreset('hdr10');
      });

      expect(result.current.settings.hdrMode).toBe('hdr10');

      // Then reset to SDR
      act(() => {
        result.current.applyPreset('sdr');
      });

      expect(result.current.settings).toEqual(DEFAULT_HDR_EXPORT);
    });
  });

  // ===========================================================================
  // Validation Tests
  // ===========================================================================

  describe('validation', () => {
    it('should show warning when HDR mode with 8-bit', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.setHdrMode('hdr10');
        result.current.setBitDepth(8);
      });

      expect(result.current.validationWarning).toContain('10-bit');
    });

    it('should clear warning with valid HDR settings', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.setHdrMode('hdr10');
        result.current.setBitDepth(10);
      });

      expect(result.current.validationWarning).toBeNull();
    });

    it('should validate codec compatibility', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.setHdrMode('hdr10');
      });

      const codecWarning = result.current.validateCodec('h264');
      expect(codecWarning).toContain('H.265');
    });

    it('should pass validation for HEVC with HDR', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.setHdrMode('hdr10');
      });

      const codecWarning = result.current.validateCodec('h265');
      expect(codecWarning).toBeNull();
    });
  });

  // ===========================================================================
  // Save Tests
  // ===========================================================================

  describe('save', () => {
    it('should save settings to backend', async () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.setHdrMode('hdr10');
        result.current.setMaxCll(1000);
      });

      await act(async () => {
        await result.current.save();
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'UpdateSequenceHdrSettings',
        payload: {
          sequenceId: mockSequenceId,
          settings: expect.objectContaining({
            hdrMode: 'hdr10',
            maxCll: 1000,
          }),
        },
      });
    });

    it('should handle save error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Save failed'));

      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      await act(async () => {
        await result.current.save();
      });

      expect(result.current.error).toBe('Save failed');
    });
  });

  // ===========================================================================
  // Dirty State Tests
  // ===========================================================================

  describe('dirty state', () => {
    it('should track dirty state when settings change', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      expect(result.current.isDirty).toBe(false);

      act(() => {
        result.current.setHdrMode('hdr10');
      });

      expect(result.current.isDirty).toBe(true);
    });

    it('should reset dirty state after save', async () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.setHdrMode('hdr10');
      });

      expect(result.current.isDirty).toBe(true);

      await act(async () => {
        await result.current.save();
      });

      expect(result.current.isDirty).toBe(false);
    });
  });

  // ===========================================================================
  // isHdr Computed Property
  // ===========================================================================

  describe('isHdr', () => {
    it('should return false for SDR mode', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      expect(result.current.isHdr).toBe(false);
    });

    it('should return true for HDR10 mode', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.setHdrMode('hdr10');
      });

      expect(result.current.isHdr).toBe(true);
    });

    it('should return true for HLG mode', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.setHdrMode('hlg');
      });

      expect(result.current.isHdr).toBe(true);
    });
  });

  // ===========================================================================
  // Edge Case & Destructive Tests
  // ===========================================================================

  describe('edge cases and destructive scenarios', () => {
    it('should handle rapid mode switches without race conditions', async () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      // Rapidly switch modes
      act(() => {
        result.current.setHdrMode('hdr10');
        result.current.setHdrMode('hlg');
        result.current.setHdrMode('sdr');
        result.current.setHdrMode('hdr10');
      });

      // Final state should be hdr10
      expect(result.current.settings.hdrMode).toBe('hdr10');
      expect(result.current.settings.bitDepth).toBe(10);
    });

    it('should handle concurrent save operations', async () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.setHdrMode('hdr10');
      });

      // Start multiple save operations concurrently
      const savePromises = [
        result.current.save(),
        result.current.save(),
        result.current.save(),
      ];

      await act(async () => {
        await Promise.all(savePromises);
      });

      // All should complete without error
      expect(result.current.error).toBeNull();
    });

    it('should handle network timeout gracefully', async () => {
      // Simulate network timeout by rejecting after delay
      mockInvoke.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Network timeout')), 50);
          })
      );

      const { result } = renderHook(() =>
        useHDRSettings({ sequenceId: mockSequenceId, fetchOnMount: true })
      );

      await waitFor(() => {
        expect(result.current.error).toBe('Network timeout');
      });

      // Should still have default settings
      expect(result.current.settings).toEqual(DEFAULT_HDR_EXPORT);
    });

    it('should handle malformed server response', async () => {
      mockInvoke.mockResolvedValueOnce({
        // Missing required fields
        hdrMode: 'invalid_mode',
      });

      const { result } = renderHook(() =>
        useHDRSettings({ sequenceId: mockSequenceId, fetchOnMount: true })
      );

      // The hook should handle this without crashing
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('should clamp extreme luminance values', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.setHdrMode('hdr10');
        result.current.setMaxCll(Number.MAX_SAFE_INTEGER);
        result.current.setMaxFall(-Number.MAX_SAFE_INTEGER);
      });

      expect(result.current.settings.maxCll).toBe(10000); // clamped to max
      expect(result.current.settings.maxFall).toBe(1); // clamped to min
    });

    it('should handle NaN input gracefully', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.setHdrMode('hdr10');
        result.current.setMaxCll(NaN);
      });

      // NaN should be clamped to valid range
      expect(Number.isNaN(result.current.settings.maxCll)).toBe(false);
    });

    it('should preserve state across multiple preset applications', () => {
      const { result } = renderHook(() => useHDRSettings({ sequenceId: mockSequenceId }));

      act(() => {
        result.current.applyPreset('hdr10');
        result.current.setMaxCll(2000);
        result.current.applyPreset('hlg');
        result.current.applyPreset('sdr');
      });

      // Should end up at SDR defaults
      expect(result.current.settings.hdrMode).toBe('sdr');
      expect(result.current.settings.maxCll).toBeUndefined();
    });
  });
});
