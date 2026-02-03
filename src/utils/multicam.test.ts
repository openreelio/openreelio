/**
 * Multicam Utilities Tests
 *
 * Tests for multicam editing functionality including:
 * - Audio waveform synchronization
 * - Angle management
 * - Multicam group operations
 *
 * Following TDD methodology.
 */

import { describe, it, expect } from 'vitest';
import {
  createMulticamGroup,
  validateMulticamGroup,
  findAudioSyncOffset,
  calculateCrossCorrelation,
  normalizeWaveformPeaks,
  addAngleToGroup,
  removeAngleFromGroup,
  switchActiveAngle,
  getAngleAtTime,
  createAngleSwitchPoint,
  getAngleSwitchesInRange,
  sortAngleSwitches,
  calculateGroupDuration,
  validateAngleSwitch,
  canSyncAngles,
  mergeOverlappingGroups,
  splitMulticamGroup,
  type MulticamGroup,
  type MulticamAngle,
  type AngleSwitch,
} from './multicam';

describe('multicam utilities', () => {
  // =============================================================================
  // Type Definitions
  // =============================================================================

  describe('MulticamGroup type', () => {
    it('should create a valid multicam group', () => {
      const group = createMulticamGroup({
        sequenceId: 'seq-1',
        name: 'Scene 1 Multicam',
        angles: [
          { clipId: 'clip-1', trackId: 'track-1', label: 'Camera 1' },
          { clipId: 'clip-2', trackId: 'track-2', label: 'Camera 2' },
        ],
        timelineInSec: 10.0,
        durationSec: 30.0,
      });

      expect(group.id).toBeDefined();
      expect(group.sequenceId).toBe('seq-1');
      expect(group.name).toBe('Scene 1 Multicam');
      expect(group.angles).toHaveLength(2);
      expect(group.activeAngleIndex).toBe(0);
      expect(group.timelineInSec).toBe(10.0);
      expect(group.durationSec).toBe(30.0);
    });

    it('should have default active angle index of 0', () => {
      const group = createMulticamGroup({
        sequenceId: 'seq-1',
        name: 'Test',
        angles: [
          { clipId: 'clip-1', trackId: 'track-1' },
        ],
        timelineInSec: 0,
        durationSec: 10,
      });

      expect(group.activeAngleIndex).toBe(0);
    });

    it('should have default audio mix mode of "active"', () => {
      const group = createMulticamGroup({
        sequenceId: 'seq-1',
        name: 'Test',
        angles: [
          { clipId: 'clip-1', trackId: 'track-1' },
        ],
        timelineInSec: 0,
        durationSec: 10,
      });

      expect(group.audioMixMode).toBe('active');
    });
  });

  describe('validateMulticamGroup', () => {
    it('should return valid for a proper multicam group', () => {
      const group: MulticamGroup = {
        id: 'group-1',
        sequenceId: 'seq-1',
        name: 'Test Group',
        angles: [
          { id: 'angle-1', clipId: 'clip-1', trackId: 'track-1' },
          { id: 'angle-2', clipId: 'clip-2', trackId: 'track-2' },
        ],
        activeAngleIndex: 0,
        timelineInSec: 0,
        durationSec: 10,
        audioMixMode: 'active',
        angleSwitches: [],
      };

      const result = validateMulticamGroup(group);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return invalid for empty angles array', () => {
      const group: MulticamGroup = {
        id: 'group-1',
        sequenceId: 'seq-1',
        name: 'Test',
        angles: [],
        activeAngleIndex: 0,
        timelineInSec: 0,
        durationSec: 10,
        audioMixMode: 'active',
        angleSwitches: [],
      };

      const result = validateMulticamGroup(group);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Multicam group must have at least one angle');
    });

    it('should return invalid for out-of-bounds active angle index', () => {
      const group: MulticamGroup = {
        id: 'group-1',
        sequenceId: 'seq-1',
        name: 'Test',
        angles: [
          { id: 'angle-1', clipId: 'clip-1', trackId: 'track-1' },
        ],
        activeAngleIndex: 5,
        timelineInSec: 0,
        durationSec: 10,
        audioMixMode: 'active',
        angleSwitches: [],
      };

      const result = validateMulticamGroup(group);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Active angle index out of bounds');
    });

    it('should return invalid for negative duration', () => {
      const group: MulticamGroup = {
        id: 'group-1',
        sequenceId: 'seq-1',
        name: 'Test',
        angles: [
          { id: 'angle-1', clipId: 'clip-1', trackId: 'track-1' },
        ],
        activeAngleIndex: 0,
        timelineInSec: 0,
        durationSec: -5,
        audioMixMode: 'active',
        angleSwitches: [],
      };

      const result = validateMulticamGroup(group);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duration must be positive');
    });

    it('should return invalid for negative timeline start', () => {
      const group: MulticamGroup = {
        id: 'group-1',
        sequenceId: 'seq-1',
        name: 'Test',
        angles: [
          { id: 'angle-1', clipId: 'clip-1', trackId: 'track-1' },
        ],
        activeAngleIndex: 0,
        timelineInSec: -10,
        durationSec: 10,
        audioMixMode: 'active',
        angleSwitches: [],
      };

      const result = validateMulticamGroup(group);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Timeline start must be non-negative');
    });
  });

  // =============================================================================
  // Audio Sync
  // =============================================================================

  describe('normalizeWaveformPeaks', () => {
    it('should normalize peaks to 0-1 range', () => {
      const peaks = [0.2, 0.5, 1.0, 0.3, 0.8];
      const normalized = normalizeWaveformPeaks(peaks);

      expect(Math.max(...normalized)).toBe(1.0);
      expect(Math.min(...normalized)).toBeGreaterThanOrEqual(0);
    });

    it('should handle all-zero peaks', () => {
      const peaks = [0, 0, 0, 0, 0];
      const normalized = normalizeWaveformPeaks(peaks);

      expect(normalized).toEqual([0, 0, 0, 0, 0]);
    });

    it('should handle already normalized peaks', () => {
      const peaks = [0.2, 0.5, 1.0, 0.3, 0.8];
      const normalized = normalizeWaveformPeaks(peaks);

      expect(normalized).toEqual(peaks);
    });

    it('should scale up small peaks', () => {
      const peaks = [0.01, 0.025, 0.05, 0.015, 0.04];
      const normalized = normalizeWaveformPeaks(peaks);

      expect(normalized[2]).toBe(1.0); // Max should be 1.0
      expect(normalized[0]).toBeCloseTo(0.2, 2);
    });
  });

  describe('calculateCrossCorrelation', () => {
    it('should return 1.0 for identical signals', () => {
      const signal = [0.1, 0.5, 0.8, 0.3, 0.2];
      const correlation = calculateCrossCorrelation(signal, signal, 0);

      expect(correlation).toBeCloseTo(1.0, 2);
    });

    it('should return lower correlation for different signals', () => {
      const signal1 = [0.1, 0.5, 0.8, 0.3, 0.2];
      const signal2 = [0.9, 0.4, 0.1, 0.6, 0.7];
      const correlation = calculateCrossCorrelation(signal1, signal2, 0);

      expect(correlation).toBeLessThan(1.0);
    });

    it('should calculate correlation at various offsets', () => {
      // Use a simple distinctive pattern
      const signal1 = [0.1, 0.8, 0.3, 0.9, 0.2, 0.7, 0.4, 0.6];
      const signal2 = [0.1, 0.8, 0.3, 0.9, 0.2, 0.7, 0.4, 0.6];

      // At zero offset, identical signals should correlate perfectly
      const correlationZero = calculateCrossCorrelation(signal1, signal2, 0);
      expect(correlationZero).toBeCloseTo(1.0, 2);

      // At non-zero offset, correlation should still be a valid number
      const correlationOffset = calculateCrossCorrelation(signal1, signal2, 2);
      expect(correlationOffset).toBeGreaterThanOrEqual(0);
      expect(correlationOffset).toBeLessThanOrEqual(1);
    });

    it('should return 0 for empty arrays', () => {
      const correlation = calculateCrossCorrelation([], [], 0);
      expect(correlation).toBe(0);
    });
  });

  describe('findAudioSyncOffset', () => {
    it('should find zero offset for identical waveforms', () => {
      const waveform = {
        samplesPerSecond: 10,
        peaks: [0.1, 0.5, 0.8, 0.3, 0.2, 0.6, 0.9, 0.4, 0.1, 0.3],
        durationSec: 1.0,
        channels: 1,
      };

      const result = findAudioSyncOffset(waveform, waveform);
      expect(result.offsetSec).toBeCloseTo(0, 1);
      expect(result.confidence).toBeGreaterThan(0.9);
    });

    it('should detect offset when second waveform is delayed', () => {
      const waveform1 = {
        samplesPerSecond: 10,
        peaks: [0.1, 0.5, 0.8, 0.3, 0.2, 0.6, 0.9, 0.4, 0.1, 0.3],
        durationSec: 1.0,
        channels: 1,
      };

      // waveform2 is shifted by 0.3s (3 samples at 10 sps)
      const waveform2 = {
        samplesPerSecond: 10,
        peaks: [0.0, 0.0, 0.0, 0.1, 0.5, 0.8, 0.3, 0.2, 0.6, 0.9],
        durationSec: 1.0,
        channels: 1,
      };

      const result = findAudioSyncOffset(waveform1, waveform2);
      expect(result.offsetSec).toBeCloseTo(-0.3, 1);
    });

    it('should return confidence score between 0 and 1', () => {
      const waveform1 = {
        samplesPerSecond: 10,
        peaks: [0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9],
        durationSec: 1.0,
        channels: 1,
      };

      const waveform2 = {
        samplesPerSecond: 10,
        peaks: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
        durationSec: 1.0,
        channels: 1,
      };

      const result = findAudioSyncOffset(waveform1, waveform2);
      // Confidence should always be in valid range
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should respect maxOffsetSec parameter', () => {
      const waveform1 = {
        samplesPerSecond: 10,
        peaks: [0.1, 0.5, 0.8, 0.3, 0.2, 0.6, 0.9, 0.4, 0.1, 0.3],
        durationSec: 1.0,
        channels: 1,
      };

      const result = findAudioSyncOffset(waveform1, waveform1, { maxOffsetSec: 0.2 });
      expect(Math.abs(result.offsetSec)).toBeLessThanOrEqual(0.2);
    });
  });

  describe('canSyncAngles', () => {
    it('should return true when all angles have audio', () => {
      const angles: MulticamAngle[] = [
        { id: 'a1', clipId: 'c1', trackId: 't1', hasAudio: true },
        { id: 'a2', clipId: 'c2', trackId: 't2', hasAudio: true },
      ];

      expect(canSyncAngles(angles)).toBe(true);
    });

    it('should return false when no angles have audio', () => {
      const angles: MulticamAngle[] = [
        { id: 'a1', clipId: 'c1', trackId: 't1', hasAudio: false },
        { id: 'a2', clipId: 'c2', trackId: 't2', hasAudio: false },
      ];

      expect(canSyncAngles(angles)).toBe(false);
    });

    it('should return true when at least 2 angles have audio', () => {
      const angles: MulticamAngle[] = [
        { id: 'a1', clipId: 'c1', trackId: 't1', hasAudio: true },
        { id: 'a2', clipId: 'c2', trackId: 't2', hasAudio: false },
        { id: 'a3', clipId: 'c3', trackId: 't3', hasAudio: true },
      ];

      expect(canSyncAngles(angles)).toBe(true);
    });

    it('should return false for single angle', () => {
      const angles: MulticamAngle[] = [
        { id: 'a1', clipId: 'c1', trackId: 't1', hasAudio: true },
      ];

      expect(canSyncAngles(angles)).toBe(false);
    });
  });

  // =============================================================================
  // Angle Management
  // =============================================================================

  describe('addAngleToGroup', () => {
    it('should add a new angle to the group', () => {
      const group: MulticamGroup = {
        id: 'group-1',
        sequenceId: 'seq-1',
        name: 'Test',
        angles: [
          { id: 'angle-1', clipId: 'clip-1', trackId: 'track-1' },
        ],
        activeAngleIndex: 0,
        timelineInSec: 0,
        durationSec: 10,
        audioMixMode: 'active',
        angleSwitches: [],
      };

      const newAngle: MulticamAngle = {
        id: 'angle-2',
        clipId: 'clip-2',
        trackId: 'track-2',
        label: 'Camera 2',
      };

      const updated = addAngleToGroup(group, newAngle);
      expect(updated.angles).toHaveLength(2);
      expect(updated.angles[1]).toEqual(newAngle);
    });

    it('should not mutate the original group', () => {
      const group: MulticamGroup = {
        id: 'group-1',
        sequenceId: 'seq-1',
        name: 'Test',
        angles: [
          { id: 'angle-1', clipId: 'clip-1', trackId: 'track-1' },
        ],
        activeAngleIndex: 0,
        timelineInSec: 0,
        durationSec: 10,
        audioMixMode: 'active',
        angleSwitches: [],
      };

      const newAngle: MulticamAngle = {
        id: 'angle-2',
        clipId: 'clip-2',
        trackId: 'track-2',
      };

      addAngleToGroup(group, newAngle);
      expect(group.angles).toHaveLength(1);
    });
  });

  describe('removeAngleFromGroup', () => {
    it('should remove an angle by id', () => {
      const group: MulticamGroup = {
        id: 'group-1',
        sequenceId: 'seq-1',
        name: 'Test',
        angles: [
          { id: 'angle-1', clipId: 'clip-1', trackId: 'track-1' },
          { id: 'angle-2', clipId: 'clip-2', trackId: 'track-2' },
        ],
        activeAngleIndex: 0,
        timelineInSec: 0,
        durationSec: 10,
        audioMixMode: 'active',
        angleSwitches: [],
      };

      const updated = removeAngleFromGroup(group, 'angle-1');
      expect(updated.angles).toHaveLength(1);
      expect(updated.angles[0].id).toBe('angle-2');
    });

    it('should adjust activeAngleIndex if needed', () => {
      const group: MulticamGroup = {
        id: 'group-1',
        sequenceId: 'seq-1',
        name: 'Test',
        angles: [
          { id: 'angle-1', clipId: 'clip-1', trackId: 'track-1' },
          { id: 'angle-2', clipId: 'clip-2', trackId: 'track-2' },
        ],
        activeAngleIndex: 1,
        timelineInSec: 0,
        durationSec: 10,
        audioMixMode: 'active',
        angleSwitches: [],
      };

      const updated = removeAngleFromGroup(group, 'angle-2');
      expect(updated.activeAngleIndex).toBe(0);
    });

    it('should remove related angle switches', () => {
      const group: MulticamGroup = {
        id: 'group-1',
        sequenceId: 'seq-1',
        name: 'Test',
        angles: [
          { id: 'angle-1', clipId: 'clip-1', trackId: 'track-1' },
          { id: 'angle-2', clipId: 'clip-2', trackId: 'track-2' },
          { id: 'angle-3', clipId: 'clip-3', trackId: 'track-3' },
        ],
        activeAngleIndex: 0,
        timelineInSec: 0,
        durationSec: 10,
        audioMixMode: 'active',
        angleSwitches: [
          { id: 'sw-1', timeSec: 2, fromAngleIndex: 0, toAngleIndex: 1, transitionType: 'cut' },
          { id: 'sw-2', timeSec: 5, fromAngleIndex: 1, toAngleIndex: 2, transitionType: 'cut' },
        ],
      };

      const updated = removeAngleFromGroup(group, 'angle-2');
      expect(updated.angleSwitches).toHaveLength(0);
    });
  });

  describe('switchActiveAngle', () => {
    it('should update the active angle index', () => {
      const group: MulticamGroup = {
        id: 'group-1',
        sequenceId: 'seq-1',
        name: 'Test',
        angles: [
          { id: 'angle-1', clipId: 'clip-1', trackId: 'track-1' },
          { id: 'angle-2', clipId: 'clip-2', trackId: 'track-2' },
        ],
        activeAngleIndex: 0,
        timelineInSec: 0,
        durationSec: 10,
        audioMixMode: 'active',
        angleSwitches: [],
      };

      const updated = switchActiveAngle(group, 1);
      expect(updated.activeAngleIndex).toBe(1);
    });

    it('should throw for invalid angle index', () => {
      const group: MulticamGroup = {
        id: 'group-1',
        sequenceId: 'seq-1',
        name: 'Test',
        angles: [
          { id: 'angle-1', clipId: 'clip-1', trackId: 'track-1' },
        ],
        activeAngleIndex: 0,
        timelineInSec: 0,
        durationSec: 10,
        audioMixMode: 'active',
        angleSwitches: [],
      };

      expect(() => switchActiveAngle(group, 5)).toThrow('Invalid angle index');
    });
  });

  // =============================================================================
  // Angle Switches
  // =============================================================================

  describe('createAngleSwitchPoint', () => {
    it('should create an angle switch point', () => {
      const switchPoint = createAngleSwitchPoint({
        timeSec: 5.0,
        fromAngleIndex: 0,
        toAngleIndex: 1,
      });

      expect(switchPoint.id).toBeDefined();
      expect(switchPoint.timeSec).toBe(5.0);
      expect(switchPoint.fromAngleIndex).toBe(0);
      expect(switchPoint.toAngleIndex).toBe(1);
      expect(switchPoint.transitionType).toBe('cut');
    });

    it('should support dissolve transition type', () => {
      const switchPoint = createAngleSwitchPoint({
        timeSec: 5.0,
        fromAngleIndex: 0,
        toAngleIndex: 1,
        transitionType: 'dissolve',
        transitionDurationSec: 0.5,
      });

      expect(switchPoint.transitionType).toBe('dissolve');
      expect(switchPoint.transitionDurationSec).toBe(0.5);
    });
  });

  describe('validateAngleSwitch', () => {
    const group: MulticamGroup = {
      id: 'group-1',
      sequenceId: 'seq-1',
      name: 'Test',
      angles: [
        { id: 'angle-1', clipId: 'clip-1', trackId: 'track-1' },
        { id: 'angle-2', clipId: 'clip-2', trackId: 'track-2' },
      ],
      activeAngleIndex: 0,
      timelineInSec: 10,
      durationSec: 20,
      audioMixMode: 'active',
      angleSwitches: [],
    };

    it('should return valid for proper switch', () => {
      const switchPoint: AngleSwitch = {
        id: 'sw-1',
        timeSec: 15,
        fromAngleIndex: 0,
        toAngleIndex: 1,
        transitionType: 'cut',
      };

      const result = validateAngleSwitch(switchPoint, group);
      expect(result.valid).toBe(true);
    });

    it('should return invalid for switch before group start', () => {
      const switchPoint: AngleSwitch = {
        id: 'sw-1',
        timeSec: 5,
        fromAngleIndex: 0,
        toAngleIndex: 1,
        transitionType: 'cut',
      };

      const result = validateAngleSwitch(switchPoint, group);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('outside group time range');
    });

    it('should return invalid for switch after group end', () => {
      const switchPoint: AngleSwitch = {
        id: 'sw-1',
        timeSec: 35,
        fromAngleIndex: 0,
        toAngleIndex: 1,
        transitionType: 'cut',
      };

      const result = validateAngleSwitch(switchPoint, group);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('outside group time range');
    });

    it('should return invalid for same from/to angle', () => {
      const switchPoint: AngleSwitch = {
        id: 'sw-1',
        timeSec: 15,
        fromAngleIndex: 0,
        toAngleIndex: 0,
        transitionType: 'cut',
      };

      const result = validateAngleSwitch(switchPoint, group);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('same angle');
    });

    it('should return invalid for out-of-bounds angle index', () => {
      const switchPoint: AngleSwitch = {
        id: 'sw-1',
        timeSec: 15,
        fromAngleIndex: 0,
        toAngleIndex: 5,
        transitionType: 'cut',
      };

      const result = validateAngleSwitch(switchPoint, group);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid angle index');
    });
  });

  describe('getAngleAtTime', () => {
    const group: MulticamGroup = {
      id: 'group-1',
      sequenceId: 'seq-1',
      name: 'Test',
      angles: [
        { id: 'angle-1', clipId: 'clip-1', trackId: 'track-1' },
        { id: 'angle-2', clipId: 'clip-2', trackId: 'track-2' },
        { id: 'angle-3', clipId: 'clip-3', trackId: 'track-3' },
      ],
      activeAngleIndex: 0,
      timelineInSec: 0,
      durationSec: 30,
      audioMixMode: 'active',
      angleSwitches: [
        { id: 'sw-1', timeSec: 10, fromAngleIndex: 0, toAngleIndex: 1, transitionType: 'cut' },
        { id: 'sw-2', timeSec: 20, fromAngleIndex: 1, toAngleIndex: 2, transitionType: 'cut' },
      ],
    };

    it('should return initial angle before first switch', () => {
      const result = getAngleAtTime(group, 5);
      expect(result).not.toBeNull();
      if (!result) {
        throw new Error('Expected non-null angle result');
      }
      expect(result.angleIndex).toBe(0);
      expect(result.angle.id).toBe('angle-1');
    });

    it('should return correct angle after switches', () => {
      const result1 = getAngleAtTime(group, 15);
      expect(result1).not.toBeNull();
      if (!result1) {
        throw new Error('Expected non-null angle result');
      }
      expect(result1.angleIndex).toBe(1);

      const result2 = getAngleAtTime(group, 25);
      expect(result2).not.toBeNull();
      if (!result2) {
        throw new Error('Expected non-null angle result');
      }
      expect(result2.angleIndex).toBe(2);
    });

    it('should return correct angle at exact switch time', () => {
      const result = getAngleAtTime(group, 10);
      expect(result).not.toBeNull();
      if (!result) {
        throw new Error('Expected non-null angle result');
      }
      expect(result.angleIndex).toBe(1); // After switch
    });

    it('should return null for time outside group', () => {
      const result = getAngleAtTime(group, 50);
      expect(result).toBeNull();
    });
  });

  describe('getAngleSwitchesInRange', () => {
    const switches: AngleSwitch[] = [
      { id: 'sw-1', timeSec: 5, fromAngleIndex: 0, toAngleIndex: 1, transitionType: 'cut' },
      { id: 'sw-2', timeSec: 10, fromAngleIndex: 1, toAngleIndex: 2, transitionType: 'cut' },
      { id: 'sw-3', timeSec: 15, fromAngleIndex: 2, toAngleIndex: 0, transitionType: 'cut' },
      { id: 'sw-4', timeSec: 20, fromAngleIndex: 0, toAngleIndex: 1, transitionType: 'cut' },
    ];

    it('should return switches within range', () => {
      const result = getAngleSwitchesInRange(switches, 8, 17);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('sw-2');
      expect(result[1].id).toBe('sw-3');
    });

    it('should include switches at boundaries', () => {
      const result = getAngleSwitchesInRange(switches, 10, 15);
      expect(result).toHaveLength(2);
    });

    it('should return empty array for no matches', () => {
      const result = getAngleSwitchesInRange(switches, 25, 30);
      expect(result).toHaveLength(0);
    });
  });

  describe('sortAngleSwitches', () => {
    it('should sort switches by time ascending', () => {
      const switches: AngleSwitch[] = [
        { id: 'sw-3', timeSec: 15, fromAngleIndex: 0, toAngleIndex: 1, transitionType: 'cut' },
        { id: 'sw-1', timeSec: 5, fromAngleIndex: 0, toAngleIndex: 1, transitionType: 'cut' },
        { id: 'sw-2', timeSec: 10, fromAngleIndex: 0, toAngleIndex: 1, transitionType: 'cut' },
      ];

      const sorted = sortAngleSwitches(switches);
      expect(sorted[0].timeSec).toBe(5);
      expect(sorted[1].timeSec).toBe(10);
      expect(sorted[2].timeSec).toBe(15);
    });

    it('should not mutate original array', () => {
      const switches: AngleSwitch[] = [
        { id: 'sw-2', timeSec: 10, fromAngleIndex: 0, toAngleIndex: 1, transitionType: 'cut' },
        { id: 'sw-1', timeSec: 5, fromAngleIndex: 0, toAngleIndex: 1, transitionType: 'cut' },
      ];

      sortAngleSwitches(switches);
      expect(switches[0].timeSec).toBe(10);
    });
  });

  // =============================================================================
  // Group Operations
  // =============================================================================

  describe('calculateGroupDuration', () => {
    it('should return the duration from the group', () => {
      const group: MulticamGroup = {
        id: 'group-1',
        sequenceId: 'seq-1',
        name: 'Test',
        angles: [],
        activeAngleIndex: 0,
        timelineInSec: 5,
        durationSec: 25,
        audioMixMode: 'active',
        angleSwitches: [],
      };

      expect(calculateGroupDuration(group)).toBe(25);
    });
  });

  describe('mergeOverlappingGroups', () => {
    it('should merge two overlapping groups', () => {
      const group1: MulticamGroup = {
        id: 'group-1',
        sequenceId: 'seq-1',
        name: 'Group 1',
        angles: [
          { id: 'angle-1', clipId: 'clip-1', trackId: 'track-1' },
        ],
        activeAngleIndex: 0,
        timelineInSec: 0,
        durationSec: 15,
        audioMixMode: 'active',
        angleSwitches: [],
      };

      const group2: MulticamGroup = {
        id: 'group-2',
        sequenceId: 'seq-1',
        name: 'Group 2',
        angles: [
          { id: 'angle-2', clipId: 'clip-2', trackId: 'track-2' },
        ],
        activeAngleIndex: 0,
        timelineInSec: 10,
        durationSec: 15,
        audioMixMode: 'active',
        angleSwitches: [],
      };

      const merged = mergeOverlappingGroups(group1, group2);
      expect(merged.timelineInSec).toBe(0);
      expect(merged.durationSec).toBe(25); // 0 to 25
      expect(merged.angles).toHaveLength(2);
    });

    it('should throw for non-overlapping groups', () => {
      const group1: MulticamGroup = {
        id: 'group-1',
        sequenceId: 'seq-1',
        name: 'Group 1',
        angles: [],
        activeAngleIndex: 0,
        timelineInSec: 0,
        durationSec: 10,
        audioMixMode: 'active',
        angleSwitches: [],
      };

      const group2: MulticamGroup = {
        id: 'group-2',
        sequenceId: 'seq-1',
        name: 'Group 2',
        angles: [],
        activeAngleIndex: 0,
        timelineInSec: 20,
        durationSec: 10,
        audioMixMode: 'active',
        angleSwitches: [],
      };

      expect(() => mergeOverlappingGroups(group1, group2)).toThrow('Groups do not overlap');
    });
  });

  describe('splitMulticamGroup', () => {
    it('should split a group at the specified time', () => {
      const group: MulticamGroup = {
        id: 'group-1',
        sequenceId: 'seq-1',
        name: 'Test Group',
        angles: [
          { id: 'angle-1', clipId: 'clip-1', trackId: 'track-1' },
          { id: 'angle-2', clipId: 'clip-2', trackId: 'track-2' },
        ],
        activeAngleIndex: 0,
        timelineInSec: 0,
        durationSec: 20,
        audioMixMode: 'active',
        angleSwitches: [
          { id: 'sw-1', timeSec: 5, fromAngleIndex: 0, toAngleIndex: 1, transitionType: 'cut' },
          { id: 'sw-2', timeSec: 15, fromAngleIndex: 1, toAngleIndex: 0, transitionType: 'cut' },
        ],
      };

      const [first, second] = splitMulticamGroup(group, 10);

      expect(first.timelineInSec).toBe(0);
      expect(first.durationSec).toBe(10);
      expect(first.angleSwitches).toHaveLength(1); // Only sw-1 at 5

      expect(second.timelineInSec).toBe(10);
      expect(second.durationSec).toBe(10);
      expect(second.angleSwitches).toHaveLength(1); // Only sw-2 at 15
    });

    it('should throw for split time outside group', () => {
      const group: MulticamGroup = {
        id: 'group-1',
        sequenceId: 'seq-1',
        name: 'Test',
        angles: [],
        activeAngleIndex: 0,
        timelineInSec: 10,
        durationSec: 10,
        audioMixMode: 'active',
        angleSwitches: [],
      };

      expect(() => splitMulticamGroup(group, 5)).toThrow('Split time outside group range');
      expect(() => splitMulticamGroup(group, 25)).toThrow('Split time outside group range');
    });

    it('should preserve angles in both split groups', () => {
      const group: MulticamGroup = {
        id: 'group-1',
        sequenceId: 'seq-1',
        name: 'Test',
        angles: [
          { id: 'angle-1', clipId: 'clip-1', trackId: 'track-1' },
          { id: 'angle-2', clipId: 'clip-2', trackId: 'track-2' },
        ],
        activeAngleIndex: 1,
        timelineInSec: 0,
        durationSec: 20,
        audioMixMode: 'mix',
        angleSwitches: [],
      };

      const [first, second] = splitMulticamGroup(group, 10);

      expect(first.angles).toHaveLength(2);
      expect(second.angles).toHaveLength(2);
      expect(first.audioMixMode).toBe('mix');
      expect(second.audioMixMode).toBe('mix');
    });
  });
});
