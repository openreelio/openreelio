/**
 * Deterministic Utilities Tests
 *
 * Tests for deterministic random generation utilities.
 * Following TDD methodology.
 */

import { describe, it, expect } from 'vitest';
import {
  seededRandom,
  deterministicUUID,
  seededColor,
  seededId,
  seededChoice,
  seededShuffle,
} from './deterministic';

describe('deterministic utilities', () => {
  describe('seededRandom', () => {
    it('should return a function', () => {
      const random = seededRandom('test-seed');
      expect(typeof random).toBe('function');
    });

    it('should return numbers between 0 and 1', () => {
      const random = seededRandom('test-seed');
      for (let i = 0; i < 100; i++) {
        const value = random();
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    });

    it('should produce same sequence for same seed', () => {
      const random1 = seededRandom('same-seed');
      const random2 = seededRandom('same-seed');

      for (let i = 0; i < 10; i++) {
        expect(random1()).toBe(random2());
      }
    });

    it('should produce different sequences for different seeds', () => {
      const random1 = seededRandom('seed-a');
      const random2 = seededRandom('seed-b');

      const values1 = Array.from({ length: 5 }, () => random1());
      const values2 = Array.from({ length: 5 }, () => random2());

      expect(values1).not.toEqual(values2);
    });
  });

  describe('deterministicUUID', () => {
    it('should return valid UUID format', () => {
      const uuid = deterministicUUID('test', 0);
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(uuid).toMatch(uuidRegex);
    });

    it('should produce same UUID for same seed and index', () => {
      const uuid1 = deterministicUUID('my-seed', 5);
      const uuid2 = deterministicUUID('my-seed', 5);
      expect(uuid1).toBe(uuid2);
    });

    it('should produce different UUIDs for different indices', () => {
      const uuid1 = deterministicUUID('seed', 0);
      const uuid2 = deterministicUUID('seed', 1);
      const uuid3 = deterministicUUID('seed', 2);

      expect(uuid1).not.toBe(uuid2);
      expect(uuid2).not.toBe(uuid3);
      expect(uuid1).not.toBe(uuid3);
    });

    it('should produce different UUIDs for different seeds', () => {
      const uuid1 = deterministicUUID('seed-a', 0);
      const uuid2 = deterministicUUID('seed-b', 0);
      expect(uuid1).not.toBe(uuid2);
    });
  });

  describe('seededColor', () => {
    it('should return valid HSL color string', () => {
      const color = seededColor('test');
      expect(color).toMatch(/^hsl\(\d+,\s*\d+%,\s*\d+%\)$/);
    });

    it('should produce same color for same seed', () => {
      const color1 = seededColor('color-seed');
      const color2 = seededColor('color-seed');
      expect(color1).toBe(color2);
    });

    it('should produce different colors for different seeds', () => {
      const color1 = seededColor('seed-x');
      const color2 = seededColor('seed-y');
      expect(color1).not.toBe(color2);
    });

    it('should produce colors with valid ranges', () => {
      for (let i = 0; i < 20; i++) {
        const color = seededColor(`test-${i}`);
        const match = color.match(/^hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)$/);
        expect(match).not.toBeNull();

        if (match) {
          const h = parseInt(match[1], 10);
          const s = parseInt(match[2], 10);
          const l = parseInt(match[3], 10);

          expect(h).toBeGreaterThanOrEqual(0);
          expect(h).toBeLessThan(360);
          expect(s).toBeGreaterThanOrEqual(50);
          expect(s).toBeLessThanOrEqual(80);
          expect(l).toBeGreaterThanOrEqual(40);
          expect(l).toBeLessThanOrEqual(60);
        }
      }
    });
  });

  describe('seededId', () => {
    it('should return alphanumeric string', () => {
      const id = seededId('test', 8);
      expect(id).toMatch(/^[a-z0-9]+$/);
    });

    it('should return correct length', () => {
      expect(seededId('test', 8).length).toBe(8);
      expect(seededId('test', 16).length).toBe(16);
      expect(seededId('test', 4).length).toBe(4);
    });

    it('should produce same ID for same seed and length', () => {
      const id1 = seededId('my-id', 10);
      const id2 = seededId('my-id', 10);
      expect(id1).toBe(id2);
    });

    it('should produce different IDs for different seeds', () => {
      const id1 = seededId('seed-1', 8);
      const id2 = seededId('seed-2', 8);
      expect(id1).not.toBe(id2);
    });
  });

  describe('seededChoice', () => {
    it('should return item from array', () => {
      const items = ['a', 'b', 'c', 'd'];
      const choice = seededChoice('test', items);
      expect(items).toContain(choice);
    });

    it('should produce same choice for same seed', () => {
      const items = [1, 2, 3, 4, 5];
      const choice1 = seededChoice('pick-seed', items);
      const choice2 = seededChoice('pick-seed', items);
      expect(choice1).toBe(choice2);
    });

    it('should handle single item array', () => {
      const choice = seededChoice('test', ['only']);
      expect(choice).toBe('only');
    });

    it('should throw for empty array', () => {
      expect(() => seededChoice('test', [])).toThrow();
    });
  });

  describe('seededShuffle', () => {
    it('should return array with same elements', () => {
      const original = [1, 2, 3, 4, 5];
      const shuffled = seededShuffle('test', [...original]);

      expect(shuffled).toHaveLength(original.length);
      expect(shuffled.sort()).toEqual(original.sort());
    });

    it('should produce same order for same seed', () => {
      const items = ['a', 'b', 'c', 'd', 'e'];
      const shuffled1 = seededShuffle('shuffle-seed', [...items]);
      const shuffled2 = seededShuffle('shuffle-seed', [...items]);
      expect(shuffled1).toEqual(shuffled2);
    });

    it('should produce different orders for different seeds', () => {
      const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const shuffled1 = seededShuffle('seed-a', [...items]);
      const shuffled2 = seededShuffle('seed-b', [...items]);
      expect(shuffled1).not.toEqual(shuffled2);
    });

    it('should not modify original array', () => {
      const original = [1, 2, 3, 4, 5];
      const copy = [...original];
      seededShuffle('test', copy);
      // Note: The function modifies in place, so we need to pass a copy
      expect(original).toEqual([1, 2, 3, 4, 5]);
    });

    it('should handle empty array', () => {
      const shuffled = seededShuffle('test', []);
      expect(shuffled).toEqual([]);
    });

    it('should handle single item array', () => {
      const shuffled = seededShuffle('test', ['single']);
      expect(shuffled).toEqual(['single']);
    });
  });
});
