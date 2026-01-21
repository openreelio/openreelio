/**
 * Preview Constants Tests
 *
 * Validates constant values and utility functions.
 */

import { describe, it, expect } from 'vitest';
import {
  FRAME_EXTRACTION,
  PLAYBACK,
  PREVIEW_PLAYER,
  createFrameCacheKey,
  parseFrameCacheKey,
} from './preview';

describe('FRAME_EXTRACTION constants', () => {
  it('should have valid cache configuration', () => {
    expect(FRAME_EXTRACTION.MAX_CACHE_ENTRIES).toBeGreaterThan(0);
    expect(FRAME_EXTRACTION.MAX_CACHE_MEMORY_MB).toBeGreaterThan(0);
    expect(FRAME_EXTRACTION.CACHE_TTL_MS).toBeGreaterThan(0);
  });

  it('should have valid prefetch configuration', () => {
    expect(FRAME_EXTRACTION.PREFETCH_AHEAD_SEC).toBeGreaterThan(0);
    expect(FRAME_EXTRACTION.PREFETCH_INTERVAL_SEC).toBeGreaterThan(0);
    expect(FRAME_EXTRACTION.PREFETCH_INTERVAL_SEC).toBeLessThan(1);
  });

  it('should have valid concurrency limits', () => {
    expect(FRAME_EXTRACTION.MAX_CONCURRENT_EXTRACTIONS).toBeGreaterThanOrEqual(1);
    expect(FRAME_EXTRACTION.MAX_CONCURRENT_EXTRACTIONS).toBeLessThanOrEqual(10);
  });

  it('should have valid JPEG quality range', () => {
    expect(FRAME_EXTRACTION.JPEG_QUALITY).toBeGreaterThanOrEqual(1);
    expect(FRAME_EXTRACTION.JPEG_QUALITY).toBeLessThanOrEqual(31);
  });
});

describe('PLAYBACK constants', () => {
  it('should have industry standard FPS', () => {
    expect(PLAYBACK.TARGET_FPS).toBe(30);
  });

  it('should calculate correct frame interval', () => {
    const expectedInterval = 1000 / 30; // ~33.33ms
    expect(PLAYBACK.FRAME_INTERVAL_MS).toBeCloseTo(expectedInterval, 2);
  });

  it('should have valid rate limits', () => {
    expect(PLAYBACK.MIN_RATE).toBeGreaterThan(0);
    expect(PLAYBACK.MIN_RATE).toBeLessThan(1);
    expect(PLAYBACK.MAX_RATE).toBeGreaterThan(1);
    expect(PLAYBACK.MAX_RATE).toBeLessThanOrEqual(4);
  });

  it('should have reasonable audio sync threshold', () => {
    expect(PLAYBACK.AUDIO_SYNC_THRESHOLD_SEC).toBeGreaterThan(0);
    expect(PLAYBACK.AUDIO_SYNC_THRESHOLD_SEC).toBeLessThanOrEqual(0.5);
  });
});

describe('PREVIEW_PLAYER constants', () => {
  it('should have valid default dimensions', () => {
    expect(PREVIEW_PLAYER.DEFAULT_WIDTH).toBe(1920);
    expect(PREVIEW_PLAYER.DEFAULT_HEIGHT).toBe(1080);
  });

  it('should have all scale modes defined', () => {
    expect(PREVIEW_PLAYER.SCALE_MODES.FIT).toBe('fit');
    expect(PREVIEW_PLAYER.SCALE_MODES.FILL).toBe('fill');
    expect(PREVIEW_PLAYER.SCALE_MODES.STRETCH).toBe('stretch');
  });

  it('should have valid hex color for background', () => {
    expect(PREVIEW_PLAYER.BACKGROUND_COLOR).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});

describe('createFrameCacheKey', () => {
  it('should create key with correct format', () => {
    const key = createFrameCacheKey('asset123', 5.5);
    expect(key).toBe('asset123:5.50');
  });

  it('should respect timestamp precision', () => {
    const key = createFrameCacheKey('asset123', 5.123456);
    expect(key).toBe('asset123:5.12');
  });

  it('should handle zero timestamp', () => {
    const key = createFrameCacheKey('asset123', 0);
    expect(key).toBe('asset123:0.00');
  });

  it('should handle large timestamps', () => {
    const key = createFrameCacheKey('asset123', 3600.99);
    expect(key).toBe('asset123:3600.99');
  });

  it('should handle special characters in assetId', () => {
    const key = createFrameCacheKey('asset-123_abc', 1.5);
    expect(key).toBe('asset-123_abc:1.50');
  });
});

describe('parseFrameCacheKey', () => {
  it('should parse valid key correctly', () => {
    const result = parseFrameCacheKey('asset123:5.50');
    expect(result).toEqual({ assetId: 'asset123', timestamp: 5.5 });
  });

  it('should return null for invalid format', () => {
    expect(parseFrameCacheKey('invalid')).toBeNull();
    expect(parseFrameCacheKey('')).toBeNull();
    expect(parseFrameCacheKey('a:b:c')).toBeNull();
  });

  it('should return null for non-numeric timestamp', () => {
    expect(parseFrameCacheKey('asset123:abc')).toBeNull();
  });

  it('should handle edge cases', () => {
    const result = parseFrameCacheKey('asset-123_abc:0.00');
    expect(result).toEqual({ assetId: 'asset-123_abc', timestamp: 0 });
  });

  it('should be inverse of createFrameCacheKey', () => {
    const assetId = 'test-asset';
    const timestamp = 12.34;
    const key = createFrameCacheKey(assetId, timestamp);
    const parsed = parseFrameCacheKey(key);

    expect(parsed).not.toBeNull();
    expect(parsed!.assetId).toBe(assetId);
    expect(parsed!.timestamp).toBeCloseTo(timestamp, 2);
  });
});
