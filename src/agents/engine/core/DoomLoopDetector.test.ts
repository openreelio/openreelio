/**
 * Tests for DoomLoopDetector
 */

import { describe, it, expect } from 'vitest';
import { DoomLoopDetector } from './DoomLoopDetector';

describe('DoomLoopDetector', () => {
  describe('constructor', () => {
    it('should create with default threshold of 3', () => {
      const detector = new DoomLoopDetector();
      // Call twice with same args - should not trigger
      expect(detector.check('tool_a', { x: 1 })).toBe(false);
      expect(detector.check('tool_a', { x: 1 })).toBe(false);
      // Third time - should trigger
      expect(detector.check('tool_a', { x: 1 })).toBe(true);
    });

    it('should create with custom threshold', () => {
      const detector = new DoomLoopDetector(5);
      for (let i = 0; i < 4; i++) {
        expect(detector.check('tool_a', { x: 1 })).toBe(false);
      }
      expect(detector.check('tool_a', { x: 1 })).toBe(true);
    });

    it('should reject threshold less than 2', () => {
      expect(() => new DoomLoopDetector(1)).toThrow('threshold must be at least 2');
      expect(() => new DoomLoopDetector(0)).toThrow('threshold must be at least 2');
    });
  });

  describe('check', () => {
    it('should not trigger for varied tool calls', () => {
      const detector = new DoomLoopDetector(3);
      expect(detector.check('tool_a', { x: 1 })).toBe(false);
      expect(detector.check('tool_b', { x: 2 })).toBe(false);
      expect(detector.check('tool_c', { x: 3 })).toBe(false);
      expect(detector.check('tool_d', { x: 4 })).toBe(false);
    });

    it('should not trigger for same tool with different args', () => {
      const detector = new DoomLoopDetector(3);
      expect(detector.check('split_clip', { position: 1 })).toBe(false);
      expect(detector.check('split_clip', { position: 2 })).toBe(false);
      expect(detector.check('split_clip', { position: 3 })).toBe(false);
    });

    it('should trigger for identical consecutive calls', () => {
      const detector = new DoomLoopDetector(3);
      expect(detector.check('split_clip', { clipId: 'c1', position: 5 })).toBe(false);
      expect(detector.check('split_clip', { clipId: 'c1', position: 5 })).toBe(false);
      expect(detector.check('split_clip', { clipId: 'c1', position: 5 })).toBe(true);
    });

    it('should trigger on exact threshold boundary', () => {
      const detector = new DoomLoopDetector(2);
      expect(detector.check('tool', {})).toBe(false);
      expect(detector.check('tool', {})).toBe(true);
    });

    it('should not trigger if a different call breaks the sequence', () => {
      const detector = new DoomLoopDetector(3);
      expect(detector.check('tool_a', { x: 1 })).toBe(false);
      expect(detector.check('tool_a', { x: 1 })).toBe(false);
      expect(detector.check('tool_b', { x: 2 })).toBe(false); // breaks it
      expect(detector.check('tool_a', { x: 1 })).toBe(false); // starts over
      expect(detector.check('tool_a', { x: 1 })).toBe(false);
    });

    it('should continue detecting after a broken sequence resumes', () => {
      const detector = new DoomLoopDetector(3);
      detector.check('tool_a', { x: 1 });
      detector.check('tool_a', { x: 1 });
      detector.check('tool_b', { x: 2 }); // breaks sequence
      detector.check('tool_a', { x: 1 }); // restart
      detector.check('tool_a', { x: 1 });
      expect(detector.check('tool_a', { x: 1 })).toBe(true); // 3 consecutive again
    });

    it('should handle args with different key order', () => {
      const detector = new DoomLoopDetector(3);
      detector.check('tool', { a: 1, b: 2 });
      detector.check('tool', { b: 2, a: 1 }); // Same args, different order
      expect(detector.check('tool', { a: 1, b: 2 })).toBe(true);
    });

    it('should handle empty args', () => {
      const detector = new DoomLoopDetector(3);
      detector.check('tool', {});
      detector.check('tool', {});
      expect(detector.check('tool', {})).toBe(true);
    });

    it('should handle complex nested args', () => {
      const detector = new DoomLoopDetector(3);
      const args = { clipId: 'c1', options: { speed: 2, volume: 0.5 } };
      detector.check('tool', args);
      detector.check('tool', args);
      expect(detector.check('tool', args)).toBe(true);
    });

    it('should treat nested objects with different key order as identical', () => {
      const detector = new DoomLoopDetector(3);
      detector.check('tool', { outer: { z: 1, a: 2 } });
      detector.check('tool', { outer: { a: 2, z: 1 } });
      expect(detector.check('tool', { outer: { z: 1, a: 2 } })).toBe(true);
    });
  });

  describe('reset', () => {
    it('should clear all recorded calls', () => {
      const detector = new DoomLoopDetector(3);
      detector.check('tool', { x: 1 });
      detector.check('tool', { x: 1 });
      expect(detector.callCount).toBe(2);

      detector.reset();
      expect(detector.callCount).toBe(0);

      // Should not trigger after reset
      expect(detector.check('tool', { x: 1 })).toBe(false);
      expect(detector.check('tool', { x: 1 })).toBe(false);
    });
  });

  describe('callCount', () => {
    it('should track number of recorded calls', () => {
      const detector = new DoomLoopDetector(3);
      expect(detector.callCount).toBe(0);

      detector.check('a', {});
      expect(detector.callCount).toBe(1);

      detector.check('b', {});
      expect(detector.callCount).toBe(2);
    });
  });
});
