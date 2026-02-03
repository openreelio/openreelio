/**
 * Motion Tracking Utility Tests
 *
 * Tests for motion tracking definitions and utilities.
 * Following TDD methodology.
 */

import { describe, it, expect } from 'vitest';
import {
  TRACKING_METHODS,
  DEFAULT_TRACKING_SETTINGS,
  DEFAULT_TRACK_POINT,
  createTrackPoint,
  createTrackRegion,
  createMotionTrack,
  isValidTrackPoint,
  isValidTrackRegion,
  getTrackingMethodLabel,
  getTrackingMethodDescription,
  interpolateTrackData,
  calculateTrackBounds,
  applyTrackToTransform,
  type TrackingMethod,
  type TrackKeyframe,
  type Transform2D,
} from './motionTracking';

// =============================================================================
// Tracking Method Tests
// =============================================================================

describe('TRACKING_METHODS', () => {
  it('should define point, region, and planar methods', () => {
    expect(TRACKING_METHODS.point).toBeDefined();
    expect(TRACKING_METHODS.region).toBeDefined();
    expect(TRACKING_METHODS.planar).toBeDefined();
  });

  it('should have label for each method', () => {
    const methods: TrackingMethod[] = ['point', 'region', 'planar'];
    methods.forEach((method) => {
      expect(TRACKING_METHODS[method].label).toBeDefined();
      expect(typeof TRACKING_METHODS[method].label).toBe('string');
    });
  });

  it('should have description for each method', () => {
    const methods: TrackingMethod[] = ['point', 'region', 'planar'];
    methods.forEach((method) => {
      expect(TRACKING_METHODS[method].description).toBeDefined();
    });
  });
});

// =============================================================================
// Default Settings Tests
// =============================================================================

describe('DEFAULT_TRACKING_SETTINGS', () => {
  it('should have valid default method', () => {
    expect(['point', 'region', 'planar']).toContain(
      DEFAULT_TRACKING_SETTINGS.method
    );
  });

  it('should have search area size', () => {
    expect(DEFAULT_TRACKING_SETTINGS.searchAreaSize).toBeGreaterThan(0);
  });

  it('should have pattern size', () => {
    expect(DEFAULT_TRACKING_SETTINGS.patternSize).toBeGreaterThan(0);
  });

  it('should have confidence threshold between 0 and 1', () => {
    expect(DEFAULT_TRACKING_SETTINGS.confidenceThreshold).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_TRACKING_SETTINGS.confidenceThreshold).toBeLessThanOrEqual(1);
  });
});

// =============================================================================
// Track Point Tests
// =============================================================================

describe('createTrackPoint', () => {
  it('should create a track point with given coordinates', () => {
    const point = createTrackPoint(100, 200);
    expect(point.x).toBe(100);
    expect(point.y).toBe(200);
  });

  it('should generate unique id', () => {
    const point1 = createTrackPoint(0, 0);
    const point2 = createTrackPoint(0, 0);
    expect(point1.id).not.toBe(point2.id);
  });

  it('should have default name if not provided', () => {
    const point = createTrackPoint(50, 50);
    expect(point.name).toBeDefined();
    expect(point.name.length).toBeGreaterThan(0);
  });

  it('should use custom name when provided', () => {
    const point = createTrackPoint(50, 50, { name: 'Eye Tracker' });
    expect(point.name).toBe('Eye Tracker');
  });

  it('should have empty keyframes array', () => {
    const point = createTrackPoint(50, 50);
    expect(point.keyframes).toEqual([]);
  });
});

describe('DEFAULT_TRACK_POINT', () => {
  it('should have x and y at 0', () => {
    expect(DEFAULT_TRACK_POINT.x).toBe(0);
    expect(DEFAULT_TRACK_POINT.y).toBe(0);
  });
});

describe('isValidTrackPoint', () => {
  it('should return true for valid track point', () => {
    const point = createTrackPoint(100, 200);
    expect(isValidTrackPoint(point)).toBe(true);
  });

  it('should return false for point with NaN coordinates', () => {
    const point = { ...createTrackPoint(0, 0), x: NaN };
    expect(isValidTrackPoint(point)).toBe(false);
  });

  it('should return false for null', () => {
    expect(isValidTrackPoint(null as any)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isValidTrackPoint(undefined as any)).toBe(false);
  });
});

// =============================================================================
// Track Region Tests
// =============================================================================

describe('createTrackRegion', () => {
  it('should create a track region with given bounds', () => {
    const region = createTrackRegion(10, 20, 100, 80);
    expect(region.x).toBe(10);
    expect(region.y).toBe(20);
    expect(region.width).toBe(100);
    expect(region.height).toBe(80);
  });

  it('should generate unique id', () => {
    const region1 = createTrackRegion(0, 0, 50, 50);
    const region2 = createTrackRegion(0, 0, 50, 50);
    expect(region1.id).not.toBe(region2.id);
  });

  it('should have default name if not provided', () => {
    const region = createTrackRegion(0, 0, 50, 50);
    expect(region.name).toBeDefined();
  });

  it('should use custom name when provided', () => {
    const region = createTrackRegion(0, 0, 50, 50, { name: 'Face Region' });
    expect(region.name).toBe('Face Region');
  });
});

describe('isValidTrackRegion', () => {
  it('should return true for valid region', () => {
    const region = createTrackRegion(10, 20, 100, 80);
    expect(isValidTrackRegion(region)).toBe(true);
  });

  it('should return false for region with zero width', () => {
    const region = { ...createTrackRegion(0, 0, 100, 80), width: 0 };
    expect(isValidTrackRegion(region)).toBe(false);
  });

  it('should return false for region with negative height', () => {
    const region = { ...createTrackRegion(0, 0, 100, 80), height: -10 };
    expect(isValidTrackRegion(region)).toBe(false);
  });
});

// =============================================================================
// Motion Track Tests
// =============================================================================

describe('createMotionTrack', () => {
  it('should create a motion track with clipId', () => {
    const track = createMotionTrack('clip-123');
    expect(track.clipId).toBe('clip-123');
  });

  it('should have empty points and regions', () => {
    const track = createMotionTrack('clip-123');
    expect(track.points).toEqual([]);
    expect(track.regions).toEqual([]);
  });

  it('should generate unique id', () => {
    const track1 = createMotionTrack('clip-1');
    const track2 = createMotionTrack('clip-1');
    expect(track1.id).not.toBe(track2.id);
  });

  it('should have default settings', () => {
    const track = createMotionTrack('clip-1');
    expect(track.settings).toBeDefined();
    expect(track.settings.method).toBe(DEFAULT_TRACKING_SETTINGS.method);
  });

  it('should use custom settings when provided', () => {
    const track = createMotionTrack('clip-1', {
      settings: { ...DEFAULT_TRACKING_SETTINGS, method: 'planar' },
    });
    expect(track.settings.method).toBe('planar');
  });
});

// =============================================================================
// Utility Function Tests
// =============================================================================

describe('getTrackingMethodLabel', () => {
  it('should return "Point Tracking" for point method', () => {
    expect(getTrackingMethodLabel('point')).toBe('Point Tracking');
  });

  it('should return "Region Tracking" for region method', () => {
    expect(getTrackingMethodLabel('region')).toBe('Region Tracking');
  });

  it('should return "Planar Tracking" for planar method', () => {
    expect(getTrackingMethodLabel('planar')).toBe('Planar Tracking');
  });
});

describe('getTrackingMethodDescription', () => {
  it('should return description for each method', () => {
    const methods: TrackingMethod[] = ['point', 'region', 'planar'];
    methods.forEach((method) => {
      const desc = getTrackingMethodDescription(method);
      expect(desc).toBeDefined();
      expect(desc.length).toBeGreaterThan(10);
    });
  });
});

// =============================================================================
// Interpolation Tests
// =============================================================================

describe('interpolateTrackData', () => {
  const keyframes: TrackKeyframe[] = [
    { time: 0, x: 0, y: 0, confidence: 1 },
    { time: 1, x: 100, y: 50, confidence: 1 },
    { time: 2, x: 200, y: 100, confidence: 1 },
  ];

  it('should return exact value at keyframe time', () => {
    const result = interpolateTrackData(keyframes, 1);
    expect(result).not.toBeNull();
    if (!result) {
      throw new Error('Expected non-null track data');
    }
    expect(result.x).toBe(100);
    expect(result.y).toBe(50);
  });

  it('should interpolate between keyframes', () => {
    const result = interpolateTrackData(keyframes, 0.5);
    expect(result).not.toBeNull();
    if (!result) {
      throw new Error('Expected non-null track data');
    }
    expect(result.x).toBe(50);
    expect(result.y).toBe(25);
  });

  it('should return first keyframe value before first time', () => {
    const result = interpolateTrackData(keyframes, -1);
    expect(result).not.toBeNull();
    if (!result) {
      throw new Error('Expected non-null track data');
    }
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });

  it('should return last keyframe value after last time', () => {
    const result = interpolateTrackData(keyframes, 5);
    expect(result).not.toBeNull();
    if (!result) {
      throw new Error('Expected non-null track data');
    }
    expect(result.x).toBe(200);
    expect(result.y).toBe(100);
  });

  it('should return null for empty keyframes', () => {
    const result = interpolateTrackData([], 1);
    expect(result).toBeNull();
  });
});

// =============================================================================
// Bounds Calculation Tests
// =============================================================================

describe('calculateTrackBounds', () => {
  const keyframes: TrackKeyframe[] = [
    { time: 0, x: 10, y: 20, confidence: 1 },
    { time: 1, x: 100, y: 50, confidence: 1 },
    { time: 2, x: 50, y: 150, confidence: 1 },
  ];

  it('should calculate min and max bounds', () => {
    const bounds = calculateTrackBounds(keyframes);
    expect(bounds).not.toBeNull();
    if (!bounds) {
      throw new Error('Expected non-null bounds');
    }
    expect(bounds.minX).toBe(10);
    expect(bounds.maxX).toBe(100);
    expect(bounds.minY).toBe(20);
    expect(bounds.maxY).toBe(150);
  });

  it('should return null for empty keyframes', () => {
    const bounds = calculateTrackBounds([]);
    expect(bounds).toBeNull();
  });

  it('should handle single keyframe', () => {
    const bounds = calculateTrackBounds([{ time: 0, x: 50, y: 60, confidence: 1 }]);
    expect(bounds?.minX).toBe(50);
    expect(bounds?.maxX).toBe(50);
    expect(bounds?.minY).toBe(60);
    expect(bounds?.maxY).toBe(60);
  });
});

// =============================================================================
// Transform Application Tests
// =============================================================================

describe('applyTrackToTransform', () => {
  it('should apply track position to transform', () => {
    const trackData = { x: 100, y: 50, confidence: 1 };
    const baseTransform: Transform2D = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };

    const result = applyTrackToTransform(trackData, baseTransform, {
      applyPosition: true,
    });

    expect(result.x).toBe(100);
    expect(result.y).toBe(50);
  });

  it('should not modify transform when applyPosition is false', () => {
    const trackData = { x: 100, y: 50, confidence: 1 };
    const baseTransform: Transform2D = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };

    const result = applyTrackToTransform(trackData, baseTransform, {
      applyPosition: false,
    });

    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });

  it('should offset position when offset is provided', () => {
    const trackData = { x: 100, y: 50, confidence: 1 };
    const baseTransform: Transform2D = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };

    const result = applyTrackToTransform(trackData, baseTransform, {
      applyPosition: true,
      offsetX: -50,
      offsetY: -25,
    });

    expect(result.x).toBe(50);
    expect(result.y).toBe(25);
  });

  it('should preserve other transform properties', () => {
    const trackData = { x: 100, y: 50, confidence: 1 };
    const baseTransform: Transform2D = { x: 0, y: 0, scaleX: 2, scaleY: 1.5, rotation: 45 };

    const result = applyTrackToTransform(trackData, baseTransform, {
      applyPosition: true,
    });

    expect(result.scaleX).toBe(2);
    expect(result.scaleY).toBe(1.5);
    expect(result.rotation).toBe(45);
  });
});
