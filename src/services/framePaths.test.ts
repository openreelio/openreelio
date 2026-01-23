/**
 * Frame Paths Tests
 *
 * Comprehensive test suite including:
 * - Happy path scenarios
 * - Edge cases and boundary conditions
 * - Security vulnerability tests (path traversal, injection)
 * - Race condition tests
 * - Error handling tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We dynamically import the module under test so that each test can control
// the runtime environment (presence of __TAURI_INTERNALS__).

describe('framePaths', () => {
  const originalInternals = (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

  beforeEach(() => {
    vi.resetModules();
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    vi.resetAllMocks();
    if (originalInternals !== undefined) {
      (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = originalInternals;
    } else {
      delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  describe('isTauriRuntime', () => {
    it('returns false when __TAURI_INTERNALS__ is not defined', async () => {
      const { isTauriRuntime } = await import('./framePaths');
      expect(isTauriRuntime()).toBe(false);
    });

    it('returns true when __TAURI_INTERNALS__ is defined', async () => {
      (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
      const { isTauriRuntime } = await import('./framePaths');
      expect(isTauriRuntime()).toBe(true);
    });

    it('returns true when __TAURI_INTERNALS__ is an object with properties', async () => {
      (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke: vi.fn() };
      const { isTauriRuntime } = await import('./framePaths');
      expect(isTauriRuntime()).toBe(true);
    });
  });

  describe('sanitizeFileKey', () => {
    it('returns sanitized key for valid alphanumeric input', async () => {
      const { sanitizeFileKey } = await import('./framePaths');
      expect(sanitizeFileKey('asset123')).toBe('asset123');
    });

    it('replaces special characters with underscores', async () => {
      const { sanitizeFileKey } = await import('./framePaths');
      expect(sanitizeFileKey('my file@name.mp4')).toBe('my_file_name_mp4');
    });

    it('removes path traversal attempts (..)', async () => {
      const { sanitizeFileKey } = await import('./framePaths');
      expect(sanitizeFileKey('../../../etc/passwd')).toBe('etc_passwd');
    });

    it('removes forward slashes', async () => {
      const { sanitizeFileKey } = await import('./framePaths');
      expect(sanitizeFileKey('path/to/file')).toBe('path_to_file');
    });

    it('removes backslashes', async () => {
      const { sanitizeFileKey } = await import('./framePaths');
      expect(sanitizeFileKey('path\\to\\file')).toBe('path_to_file');
    });

    it('removes null bytes (security)', async () => {
      const { sanitizeFileKey } = await import('./framePaths');
      expect(sanitizeFileKey('file\0name')).toBe('file_name');
    });

    it('collapses multiple underscores', async () => {
      const { sanitizeFileKey } = await import('./framePaths');
      expect(sanitizeFileKey('file___name')).toBe('file_name');
    });

    it('truncates to max length (100 chars)', async () => {
      const { sanitizeFileKey } = await import('./framePaths');
      const longKey = 'a'.repeat(200);
      expect(sanitizeFileKey(longKey).length).toBe(100);
    });

    it('returns fallback for empty string', async () => {
      const { sanitizeFileKey } = await import('./framePaths');
      expect(sanitizeFileKey('')).toBe('unknown_asset');
    });

    it('returns fallback for null/undefined', async () => {
      const { sanitizeFileKey } = await import('./framePaths');
      expect(sanitizeFileKey(null as unknown as string)).toBe('unknown_asset');
      expect(sanitizeFileKey(undefined as unknown as string)).toBe('unknown_asset');
    });

    it('returns fallback for string that sanitizes to empty', async () => {
      const { sanitizeFileKey } = await import('./framePaths');
      expect(sanitizeFileKey('...')).toBe('unknown_asset');
      expect(sanitizeFileKey('///')).toBe('unknown_asset');
    });

    it('preserves dashes and underscores', async () => {
      const { sanitizeFileKey } = await import('./framePaths');
      expect(sanitizeFileKey('my-asset_123')).toBe('my-asset_123');
    });

    it('handles unicode characters by removing them', async () => {
      const { sanitizeFileKey } = await import('./framePaths');
      expect(sanitizeFileKey('файл名前')).toBe('unknown_asset');
    });

    it('handles mixed valid and invalid characters', async () => {
      const { sanitizeFileKey } = await import('./framePaths');
      expect(sanitizeFileKey('valid123-_./\\..invalid')).toBe('valid123-_invalid');
    });
  });

  describe('validateTimestamp', () => {
    it('returns valid positive integer unchanged', async () => {
      const { validateTimestamp } = await import('./framePaths');
      expect(validateTimestamp(12345)).toBe(12345);
    });

    it('floors floating point numbers', async () => {
      const { validateTimestamp } = await import('./framePaths');
      expect(validateTimestamp(123.999)).toBe(123);
    });

    it('returns 0 for negative numbers', async () => {
      const { validateTimestamp } = await import('./framePaths');
      expect(validateTimestamp(-100)).toBe(0);
    });

    it('returns 0 for NaN', async () => {
      const { validateTimestamp } = await import('./framePaths');
      expect(validateTimestamp(NaN)).toBe(0);
    });

    it('returns 0 for Infinity', async () => {
      const { validateTimestamp } = await import('./framePaths');
      expect(validateTimestamp(Infinity)).toBe(0);
      expect(validateTimestamp(-Infinity)).toBe(0);
    });

    it('handles zero correctly', async () => {
      const { validateTimestamp } = await import('./framePaths');
      expect(validateTimestamp(0)).toBe(0);
    });

    it('handles very large numbers', async () => {
      const { validateTimestamp } = await import('./framePaths');
      const largeNumber = Number.MAX_SAFE_INTEGER;
      expect(validateTimestamp(largeNumber)).toBe(largeNumber);
    });
  });

  describe('validateExtension', () => {
    it('accepts valid extensions', async () => {
      const { validateExtension } = await import('./framePaths');
      expect(validateExtension('png')).toBe('png');
      expect(validateExtension('jpg')).toBe('jpg');
      expect(validateExtension('jpeg')).toBe('jpeg');
      expect(validateExtension('webp')).toBe('webp');
    });

    it('normalizes to lowercase', async () => {
      const { validateExtension } = await import('./framePaths');
      expect(validateExtension('PNG')).toBe('png');
      expect(validateExtension('JpG')).toBe('jpg');
    });

    it('returns png for invalid extensions', async () => {
      const { validateExtension } = await import('./framePaths');
      expect(validateExtension('gif')).toBe('png');
      expect(validateExtension('bmp')).toBe('png');
      expect(validateExtension('exe')).toBe('png');
    });

    it('returns png for empty string', async () => {
      const { validateExtension } = await import('./framePaths');
      expect(validateExtension('')).toBe('png');
    });

    it('removes non-alphabetic characters', async () => {
      const { validateExtension } = await import('./framePaths');
      expect(validateExtension('p.n.g')).toBe('png');
      expect(validateExtension('png123')).toBe('png');
    });

    it('handles null/undefined', async () => {
      const { validateExtension } = await import('./framePaths');
      expect(validateExtension(null as unknown as string)).toBe('png');
      expect(validateExtension(undefined as unknown as string)).toBe('png');
    });
  });

  describe('getFramesCacheDir', () => {
    it('falls back to relative path outside Tauri runtime', async () => {
      const { getFramesCacheDir } = await import('./framePaths');
      await expect(getFramesCacheDir()).resolves.toBe('.openreelio/frames');
    });

    it('uses app cache dir in Tauri runtime', async () => {
      (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

      vi.doMock('@tauri-apps/api/path', () => ({
        appCacheDir: vi.fn(async () => 'C:/Users/test/AppData/Local/openreelio/cache'),
        join: vi.fn(async (...parts: string[]) => parts.join('/')),
      }));

      const { getFramesCacheDir, resetFramesDirCache } = await import('./framePaths');
      resetFramesDirCache();

      await expect(getFramesCacheDir()).resolves.toContain('openreelio/frames');
    });

    it('caches the directory promise for subsequent calls', async () => {
      const { getFramesCacheDir } = await import('./framePaths');

      const result1 = await getFramesCacheDir();
      const result2 = await getFramesCacheDir();

      expect(result1).toBe(result2);
    });

    it('handles Tauri API failure gracefully', async () => {
      (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

      vi.doMock('@tauri-apps/api/path', () => ({
        appCacheDir: vi.fn(async () => {
          throw new Error('Tauri API unavailable');
        }),
        join: vi.fn(async (...parts: string[]) => parts.join('/')),
      }));

      const { getFramesCacheDir, resetFramesDirCache } = await import('./framePaths');
      resetFramesDirCache();

      // Should fall back to relative path without throwing
      await expect(getFramesCacheDir()).resolves.toBe('.openreelio/frames');
    });
  });

  describe('buildFrameOutputPath', () => {
    it('falls back to relative path outside Tauri runtime', async () => {
      const { buildFrameOutputPath } = await import('./framePaths');

      await expect(buildFrameOutputPath('asset', 123, 'png')).resolves.toBe(
        '.openreelio/frames/asset_123.png',
      );
    });

    it('uses app cache dir in Tauri runtime', async () => {
      (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

      vi.doMock('@tauri-apps/api/path', () => ({
        appCacheDir: vi.fn(async () => 'C:/Users/test/AppData/Local/openreelio/cache'),
        join: vi.fn(async (...parts: string[]) => parts.join('/')),
      }));

      const { buildFrameOutputPath, resetFramesDirCache } = await import('./framePaths');
      resetFramesDirCache();

      await expect(buildFrameOutputPath('asset', 123, 'png')).resolves.toContain('asset_123.png');
    });

    it('sanitizes dangerous fileKey inputs', async () => {
      const { buildFrameOutputPath } = await import('./framePaths');

      // Path traversal attempt
      const result = await buildFrameOutputPath('../../../etc/passwd', 123, 'png');
      expect(result).not.toContain('..');
      expect(result).not.toContain('/etc/');
      expect(result).toContain('etc_passwd');
    });

    it('validates timestamp', async () => {
      const { buildFrameOutputPath } = await import('./framePaths');

      const result = await buildFrameOutputPath('asset', -100, 'png');
      expect(result).toContain('_0.png');
    });

    it('validates extension', async () => {
      const { buildFrameOutputPath } = await import('./framePaths');

      const result = await buildFrameOutputPath('asset', 123, 'exe');
      expect(result).toContain('.png');
      expect(result).not.toContain('.exe');
    });

    it('handles floating point timestamps', async () => {
      const { buildFrameOutputPath } = await import('./framePaths');

      const result = await buildFrameOutputPath('asset', 123.999, 'png');
      expect(result).toContain('_123.png');
    });
  });

  describe('resetFramesDirCache', () => {
    it('clears the cached directory promise', async () => {
      const { getFramesCacheDir, resetFramesDirCache } = await import('./framePaths');

      // First call caches the result
      await getFramesCacheDir();

      // Reset the cache
      resetFramesDirCache();

      // Should work without errors
      await expect(getFramesCacheDir()).resolves.toBe('.openreelio/frames');
    });
  });

  describe('Race Condition Tests', () => {
    it('handles concurrent getFramesCacheDir calls safely', async () => {
      const { getFramesCacheDir, resetFramesDirCache } = await import('./framePaths');
      resetFramesDirCache();

      // Launch multiple concurrent calls
      const promises = Array.from({ length: 10 }, () => getFramesCacheDir());

      const results = await Promise.all(promises);

      // All results should be identical
      expect(new Set(results).size).toBe(1);
    });

    it('handles concurrent buildFrameOutputPath calls safely', async () => {
      const { buildFrameOutputPath } = await import('./framePaths');

      const promises = Array.from({ length: 10 }, (_, i) =>
        buildFrameOutputPath(`asset${i}`, i * 1000, 'png'),
      );

      const results = await Promise.all(promises);

      // All results should be unique
      expect(new Set(results).size).toBe(10);
    });
  });

  describe('Security Tests - Path Injection', () => {
    it('prevents directory traversal with ..', async () => {
      const { buildFrameOutputPath } = await import('./framePaths');

      const maliciousInputs = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32',
        'valid/../../../etc/passwd',
        '....//....//etc/passwd',
        '..%2f..%2f..%2fetc/passwd',
      ];

      for (const input of maliciousInputs) {
        const result = await buildFrameOutputPath(input, 0, 'png');
        expect(result).not.toMatch(/\.\./);
        expect(result).not.toContain('/etc/');
        expect(result).not.toContain('\\windows\\');
      }
    });

    it('prevents null byte injection', async () => {
      const { buildFrameOutputPath } = await import('./framePaths');

      const result = await buildFrameOutputPath('valid\0malicious', 123, 'png');
      expect(result).not.toContain('\0');
    });

    it('prevents extension injection', async () => {
      const { buildFrameOutputPath } = await import('./framePaths');

      // Attempt to inject different extension via fileKey
      const result = await buildFrameOutputPath('file.exe', 123, 'png');
      expect(result).toContain('.png');
      expect(result).not.toMatch(/\.exe\./);
    });

    it('handles extremely long inputs', async () => {
      const { buildFrameOutputPath, sanitizeFileKey } = await import('./framePaths');

      const longInput = 'a'.repeat(10000);
      const result = await buildFrameOutputPath(longInput, 123, 'png');

      // Should be truncated and not cause buffer overflow
      expect(sanitizeFileKey(longInput).length).toBeLessThanOrEqual(100);
      expect(result.length).toBeLessThan(200);
    });
  });

  describe('Edge Cases', () => {
    it('handles empty fileKey', async () => {
      const { buildFrameOutputPath } = await import('./framePaths');

      const result = await buildFrameOutputPath('', 123, 'png');
      expect(result).toContain('unknown_asset');
    });

    it('handles zero timestamp', async () => {
      const { buildFrameOutputPath } = await import('./framePaths');

      const result = await buildFrameOutputPath('asset', 0, 'png');
      expect(result).toContain('_0.png');
    });

    it('handles uppercase extension', async () => {
      const { buildFrameOutputPath } = await import('./framePaths');

      const result = await buildFrameOutputPath('asset', 123, 'PNG');
      expect(result).toContain('.png');
    });

    it('handles special unicode in fileKey', async () => {
      const { buildFrameOutputPath } = await import('./framePaths');

      const result = await buildFrameOutputPath('文件名', 123, 'png');
      // Should sanitize to fallback
      expect(result).toContain('unknown_asset');
    });

    it('handles very large timestamp', async () => {
      const { buildFrameOutputPath } = await import('./framePaths');

      const result = await buildFrameOutputPath('asset', Number.MAX_SAFE_INTEGER, 'png');
      expect(result).toContain(`_${Number.MAX_SAFE_INTEGER}.png`);
    });
  });
});
