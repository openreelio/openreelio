/**
 * useKeyboardScope Tests
 *
 * Tests for the keyboard scope system with z-index awareness.
 */

import { describe, it, expect } from 'vitest';
import { buildKeySignature } from './useKeyboardScope';

// Helper to create keyboard events
function createKeyboardEvent(
  key: string,
  options: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}
): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key,
    ctrlKey: options.ctrl ?? false,
    shiftKey: options.shift ?? false,
    altKey: options.alt ?? false,
    metaKey: options.meta ?? false,
    bubbles: true,
  });
}

describe('useKeyboardScope', () => {
  describe('buildKeySignature', () => {
    it('should build simple key signature', () => {
      const event = createKeyboardEvent('a');
      expect(buildKeySignature(event)).toBe('a');
    });

    it('should build key signature with ctrl modifier', () => {
      const event = createKeyboardEvent('s', { ctrl: true });
      expect(buildKeySignature(event)).toBe('mod+s');
    });

    it('should build key signature with meta modifier', () => {
      const event = createKeyboardEvent('s', { meta: true });
      expect(buildKeySignature(event)).toBe('mod+s');
    });

    it('should build key signature with shift modifier', () => {
      const event = createKeyboardEvent('A', { shift: true });
      expect(buildKeySignature(event)).toBe('shift+a');
    });

    it('should build key signature with alt modifier', () => {
      const event = createKeyboardEvent('f', { alt: true });
      expect(buildKeySignature(event)).toBe('alt+f');
    });

    it('should build key signature with multiple modifiers', () => {
      const event = createKeyboardEvent('z', { ctrl: true, shift: true });
      expect(buildKeySignature(event)).toBe('mod+shift+z');
    });

    it('should handle special keys', () => {
      const event = createKeyboardEvent('Escape');
      expect(buildKeySignature(event)).toBe('escape');
    });

    it('should handle space key', () => {
      const event = createKeyboardEvent(' ');
      expect(buildKeySignature(event)).toBe('space');
    });

    it('should handle arrow keys', () => {
      const event = createKeyboardEvent('ArrowLeft');
      expect(buildKeySignature(event)).toBe('arrowleft');
    });

    it('should handle Delete key', () => {
      const event = createKeyboardEvent('Delete');
      expect(buildKeySignature(event)).toBe('delete');
    });

    it('should handle Enter key', () => {
      const event = createKeyboardEvent('Enter', { ctrl: true });
      expect(buildKeySignature(event)).toBe('mod+enter');
    });
  });
});
