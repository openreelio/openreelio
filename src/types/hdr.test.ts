import { describe, it, expect } from 'vitest';
import {
  isWideGamut,
  isHdrTransfer,
  getMaxLuminance,
  isHdrContent,
  getHdrFormatDisplay,
  validateHdrExportSettings,
  COLOR_SPACE_PRESETS,
  TONEMAP_PRESETS,
  SDR_DETECTION,
  HDR10_EXPORT_PRESET,
} from './hdr';

describe('HDR types', () => {
  describe('isWideGamut', () => {
    it('should return false for bt709', () => {
      expect(isWideGamut('bt709')).toBe(false);
    });

    it('should return true for bt2020', () => {
      expect(isWideGamut('bt2020')).toBe(true);
    });

    it('should return true for display_p3', () => {
      expect(isWideGamut('display_p3')).toBe(true);
    });

    it('should return true for dci_p3', () => {
      expect(isWideGamut('dci_p3')).toBe(true);
    });
  });

  describe('isHdrTransfer', () => {
    it('should return true for pq', () => {
      expect(isHdrTransfer('pq')).toBe(true);
    });

    it('should return true for hlg', () => {
      expect(isHdrTransfer('hlg')).toBe(true);
    });

    it('should return false for srgb', () => {
      expect(isHdrTransfer('srgb')).toBe(false);
    });

    it('should return false for bt709', () => {
      expect(isHdrTransfer('bt709')).toBe(false);
    });

    it('should return false for linear', () => {
      expect(isHdrTransfer('linear')).toBe(false);
    });
  });

  describe('getMaxLuminance', () => {
    it('should return 10000 for pq', () => {
      expect(getMaxLuminance('pq')).toBe(10000);
    });

    it('should return 1000 for hlg', () => {
      expect(getMaxLuminance('hlg')).toBe(1000);
    });

    it('should return 100 for srgb', () => {
      expect(getMaxLuminance('srgb')).toBe(100);
    });

    it('should return 100 for bt709', () => {
      expect(getMaxLuminance('bt709')).toBe(100);
    });

    it('should return 100 for linear', () => {
      expect(getMaxLuminance('linear')).toBe(100);
    });
  });

  describe('COLOR_SPACE_PRESETS', () => {
    it('should have sdr preset', () => {
      expect(COLOR_SPACE_PRESETS.sdr.primaries).toBe('bt709');
      expect(COLOR_SPACE_PRESETS.sdr.transfer).toBe('srgb');
    });

    it('should have hdr10 preset', () => {
      expect(COLOR_SPACE_PRESETS.hdr10.primaries).toBe('bt2020');
      expect(COLOR_SPACE_PRESETS.hdr10.transfer).toBe('pq');
    });

    it('should have hlg preset', () => {
      expect(COLOR_SPACE_PRESETS.hlg.primaries).toBe('bt2020');
      expect(COLOR_SPACE_PRESETS.hlg.transfer).toBe('hlg');
    });

    it('should have display_p3 preset', () => {
      expect(COLOR_SPACE_PRESETS.display_p3.primaries).toBe('display_p3');
      expect(COLOR_SPACE_PRESETS.display_p3.transfer).toBe('srgb');
    });
  });

  describe('TONEMAP_PRESETS', () => {
    it('should have preview preset', () => {
      expect(TONEMAP_PRESETS.preview.mode).toBe('reinhard');
      expect(TONEMAP_PRESETS.preview.targetPeak).toBe(100);
      expect(TONEMAP_PRESETS.preview.desat).toBe(0.5);
    });

    it('should have high_quality preset', () => {
      expect(TONEMAP_PRESETS.high_quality.mode).toBe('bt2390');
      expect(TONEMAP_PRESETS.high_quality.targetPeak).toBe(100);
      expect(TONEMAP_PRESETS.high_quality.desat).toBe(0.75);
    });

    it('should have filmic preset', () => {
      expect(TONEMAP_PRESETS.filmic.mode).toBe('hable');
      expect(TONEMAP_PRESETS.filmic.targetPeak).toBe(100);
      expect(TONEMAP_PRESETS.filmic.desat).toBe(0.9);
    });
  });

  describe('isHdrContent', () => {
    it('should return true for HDR10', () => {
      expect(isHdrContent({ colorSpace: COLOR_SPACE_PRESETS.hdr10 })).toBe(true);
    });

    it('should return true for HLG', () => {
      expect(isHdrContent({ colorSpace: COLOR_SPACE_PRESETS.hlg })).toBe(true);
    });

    it('should return false for SDR', () => {
      expect(isHdrContent({ colorSpace: COLOR_SPACE_PRESETS.sdr })).toBe(false);
    });

    it('should return false for Display P3', () => {
      expect(isHdrContent({ colorSpace: COLOR_SPACE_PRESETS.display_p3 })).toBe(false);
    });

    it('should handle metadata with additional fields', () => {
      expect(
        isHdrContent({
          colorSpace: COLOR_SPACE_PRESETS.hdr10,
          maxCll: 1000,
          maxFall: 400,
        })
      ).toBe(true);
    });
  });

  describe('SDR_DETECTION', () => {
    it('should have correct default values', () => {
      expect(SDR_DETECTION.isHdr).toBe(false);
      expect(SDR_DETECTION.formatName).toBe('SDR');
    });
  });

  describe('getHdrFormatDisplay', () => {
    it('should display SDR for non-HDR', () => {
      expect(getHdrFormatDisplay(SDR_DETECTION)).toBe('SDR');
    });

    it('should display HDR10 with nits when available', () => {
      const info = { isHdr: true, transfer: 'pq' as const, maxCll: 1000, formatName: 'HDR10' };
      expect(getHdrFormatDisplay(info)).toBe('HDR10 (1000 nits)');
    });

    it('should display HDR10 without nits when maxCll not available', () => {
      const info = { isHdr: true, transfer: 'pq' as const, formatName: 'HDR10' };
      expect(getHdrFormatDisplay(info)).toBe('HDR10');
    });

    it('should display HLG for hlg transfer', () => {
      const info = { isHdr: true, transfer: 'hlg' as const, formatName: 'HLG' };
      expect(getHdrFormatDisplay(info)).toBe('HLG');
    });

    it('should fallback to formatName for unknown HDR formats', () => {
      const info = { isHdr: true, formatName: 'Dolby Vision' };
      expect(getHdrFormatDisplay(info)).toBe('Dolby Vision');
    });
  });

  describe('HDR10_EXPORT_PRESET', () => {
    it('should have correct preset values', () => {
      expect(HDR10_EXPORT_PRESET.hdrMode).toBe('hdr10');
      expect(HDR10_EXPORT_PRESET.maxCll).toBe(1000);
      expect(HDR10_EXPORT_PRESET.maxFall).toBe(400);
      expect(HDR10_EXPORT_PRESET.bitDepth).toBe(10);
    });
  });

  describe('validateHdrExportSettings', () => {
    it('should return error for HDR with H.264', () => {
      const error = validateHdrExportSettings(HDR10_EXPORT_PRESET, 'h264');
      expect(error).toContain('H.265');
    });

    it('should return null for HDR with H.265', () => {
      const error = validateHdrExportSettings(HDR10_EXPORT_PRESET, 'h265');
      expect(error).toBeNull();
    });

    it('should return null for HDR with HEVC', () => {
      const error = validateHdrExportSettings(HDR10_EXPORT_PRESET, 'hevc');
      expect(error).toBeNull();
    });

    it('should return null for HDR with case-insensitive HEVC', () => {
      const error = validateHdrExportSettings(HDR10_EXPORT_PRESET, 'HEVC');
      expect(error).toBeNull();
    });

    it('should return null for SDR with any codec', () => {
      const error = validateHdrExportSettings({ hdrMode: 'sdr', bitDepth: 8 }, 'h264');
      expect(error).toBeNull();
    });

    it('should warn about 8-bit HDR content', () => {
      const settings = { hdrMode: 'hdr10' as const, bitDepth: 8 as const };
      const error = validateHdrExportSettings(settings, 'h265');
      expect(error).toContain('10-bit');
    });

    it('should accept 10-bit HDR with H.265', () => {
      const settings = { hdrMode: 'hdr10' as const, bitDepth: 10 as const };
      const error = validateHdrExportSettings(settings, 'h265');
      expect(error).toBeNull();
    });

    it('should accept 12-bit HDR with H.265', () => {
      const settings = { hdrMode: 'hdr10' as const, bitDepth: 12 as const };
      const error = validateHdrExportSettings(settings, 'h265');
      expect(error).toBeNull();
    });

    it('should validate HLG mode the same as HDR10', () => {
      const settings = { hdrMode: 'hlg' as const, bitDepth: 10 as const };
      const errorH264 = validateHdrExportSettings(settings, 'h264');
      expect(errorH264).toContain('H.265');

      const errorH265 = validateHdrExportSettings(settings, 'h265');
      expect(errorH265).toBeNull();
    });
  });
});
