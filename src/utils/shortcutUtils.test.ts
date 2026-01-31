/**
 * Shortcut Utilities Tests
 *
 * TDD: Tests for keyboard shortcut key signature parsing and validation.
 */

import { describe, it, expect } from 'vitest';
import {
  parseKeySignature,
  buildKeySignature,
  normalizeKeySignature,
  isValidKeySignature,
  keyEventToSignature,
  signatureToDisplayString,
  compareSignatures,
} from './shortcutUtils';

// =============================================================================
// parseKeySignature
// =============================================================================

describe('parseKeySignature', () => {
  it('should parse simple key', () => {
    const result = parseKeySignature('a');
    expect(result).toEqual({
      key: 'a',
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
    });
  });

  it('should parse Ctrl modifier', () => {
    const result = parseKeySignature('Ctrl+S');
    expect(result).toEqual({
      key: 's',
      ctrl: true,
      shift: false,
      alt: false,
      meta: false,
    });
  });

  it('should parse Shift modifier', () => {
    const result = parseKeySignature('Shift+A');
    expect(result).toEqual({
      key: 'a',
      ctrl: false,
      shift: true,
      alt: false,
      meta: false,
    });
  });

  it('should parse Alt modifier', () => {
    const result = parseKeySignature('Alt+Tab');
    expect(result).toEqual({
      key: 'tab',
      ctrl: false,
      shift: false,
      alt: true,
      meta: false,
    });
  });

  it('should parse Meta/Cmd modifier', () => {
    const result = parseKeySignature('Meta+C');
    expect(result).toEqual({
      key: 'c',
      ctrl: false,
      shift: false,
      alt: false,
      meta: true,
    });
  });

  it('should parse multiple modifiers', () => {
    const result = parseKeySignature('Ctrl+Shift+Z');
    expect(result).toEqual({
      key: 'z',
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
    });
  });

  it('should parse all modifiers', () => {
    const result = parseKeySignature('Ctrl+Shift+Alt+Meta+X');
    expect(result).toEqual({
      key: 'x',
      ctrl: true,
      shift: true,
      alt: true,
      meta: true,
    });
  });

  it('should handle case insensitivity', () => {
    const result = parseKeySignature('ctrl+shift+s');
    expect(result).toEqual({
      key: 's',
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
    });
  });

  it('should parse special keys', () => {
    expect(parseKeySignature('Space')?.key).toBe('space');
    expect(parseKeySignature('Enter')?.key).toBe('enter');
    expect(parseKeySignature('Escape')?.key).toBe('escape');
    expect(parseKeySignature('Delete')?.key).toBe('delete');
    expect(parseKeySignature('Backspace')?.key).toBe('backspace');
    expect(parseKeySignature('ArrowUp')?.key).toBe('arrowup');
    expect(parseKeySignature('ArrowDown')?.key).toBe('arrowdown');
    expect(parseKeySignature('ArrowLeft')?.key).toBe('arrowleft');
    expect(parseKeySignature('ArrowRight')?.key).toBe('arrowright');
  });

  it('should parse function keys', () => {
    expect(parseKeySignature('F1')?.key).toBe('f1');
    expect(parseKeySignature('F12')?.key).toBe('f12');
    expect(parseKeySignature('Ctrl+F5')?.key).toBe('f5');
  });

  it('should return null for empty string', () => {
    expect(parseKeySignature('')).toBeNull();
  });

  it('should return null for invalid signature', () => {
    expect(parseKeySignature('Ctrl+')).toBeNull();
    expect(parseKeySignature('+++')).toBeNull();
  });
});

// =============================================================================
// buildKeySignature
// =============================================================================

describe('buildKeySignature', () => {
  it('should build simple key signature', () => {
    const result = buildKeySignature({
      key: 'a',
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
    });
    expect(result).toBe('A');
  });

  it('should build with Ctrl modifier', () => {
    const result = buildKeySignature({
      key: 's',
      ctrl: true,
      shift: false,
      alt: false,
      meta: false,
    });
    expect(result).toBe('Ctrl+S');
  });

  it('should build with multiple modifiers in correct order', () => {
    const result = buildKeySignature({
      key: 'z',
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
    });
    expect(result).toBe('Ctrl+Shift+Z');
  });

  it('should build with all modifiers', () => {
    const result = buildKeySignature({
      key: 'x',
      ctrl: true,
      shift: true,
      alt: true,
      meta: true,
    });
    expect(result).toBe('Ctrl+Shift+Alt+Meta+X');
  });

  it('should capitalize key', () => {
    const result = buildKeySignature({
      key: 'space',
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
    });
    expect(result).toBe('Space');
  });
});

// =============================================================================
// normalizeKeySignature
// =============================================================================

describe('normalizeKeySignature', () => {
  it('should normalize modifier order', () => {
    expect(normalizeKeySignature('Shift+Ctrl+S')).toBe('Ctrl+Shift+S');
    expect(normalizeKeySignature('Alt+Ctrl+A')).toBe('Ctrl+Alt+A');
    expect(normalizeKeySignature('Meta+Shift+Alt+Ctrl+X')).toBe('Ctrl+Shift+Alt+Meta+X');
  });

  it('should normalize case', () => {
    expect(normalizeKeySignature('ctrl+s')).toBe('Ctrl+S');
    expect(normalizeKeySignature('CTRL+SHIFT+Z')).toBe('Ctrl+Shift+Z');
  });

  it('should handle simple keys', () => {
    expect(normalizeKeySignature('a')).toBe('A');
    expect(normalizeKeySignature('SPACE')).toBe('Space');
  });

  it('should return empty string for invalid signature', () => {
    expect(normalizeKeySignature('')).toBe('');
    expect(normalizeKeySignature('Ctrl+')).toBe('');
  });
});

// =============================================================================
// isValidKeySignature
// =============================================================================

describe('isValidKeySignature', () => {
  it('should validate correct signatures', () => {
    expect(isValidKeySignature('A')).toBe(true);
    expect(isValidKeySignature('Ctrl+S')).toBe(true);
    expect(isValidKeySignature('Ctrl+Shift+Z')).toBe(true);
    expect(isValidKeySignature('F1')).toBe(true);
    expect(isValidKeySignature('Space')).toBe(true);
  });

  it('should reject invalid signatures', () => {
    expect(isValidKeySignature('')).toBe(false);
    expect(isValidKeySignature('Ctrl+')).toBe(false);
    expect(isValidKeySignature('+++')).toBe(false);
    expect(isValidKeySignature('NotAKey')).toBe(false);
  });
});

// =============================================================================
// keyEventToSignature
// =============================================================================

describe('keyEventToSignature', () => {
  it('should convert simple key event', () => {
    const event = {
      key: 'a',
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    } as KeyboardEvent;

    expect(keyEventToSignature(event)).toBe('A');
  });

  it('should convert key event with modifiers', () => {
    const event = {
      key: 's',
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    } as KeyboardEvent;

    expect(keyEventToSignature(event)).toBe('Ctrl+S');
  });

  it('should convert key event with multiple modifiers', () => {
    const event = {
      key: 'z',
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    } as KeyboardEvent;

    expect(keyEventToSignature(event)).toBe('Ctrl+Shift+Z');
  });

  it('should handle special keys', () => {
    const event = {
      key: ' ',
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    } as KeyboardEvent;

    expect(keyEventToSignature(event)).toBe('Space');
  });

  it('should ignore modifier-only events', () => {
    const event = {
      key: 'Control',
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    } as KeyboardEvent;

    expect(keyEventToSignature(event)).toBe('');
  });
});

// =============================================================================
// signatureToDisplayString
// =============================================================================

describe('signatureToDisplayString', () => {
  it('should display simple key', () => {
    expect(signatureToDisplayString('A')).toBe('A');
  });

  it('should display Ctrl modifier', () => {
    expect(signatureToDisplayString('Ctrl+S')).toBe('Ctrl+S');
  });

  it('should use platform-specific symbols when requested', () => {
    // On Mac, Ctrl becomes ⌃, Meta becomes ⌘
    const macResult = signatureToDisplayString('Ctrl+Meta+S', true);
    expect(macResult).toContain('⌃');
    expect(macResult).toContain('⌘');
  });

  it('should display special keys with readable names', () => {
    expect(signatureToDisplayString('Space')).toBe('Space');
    expect(signatureToDisplayString('ArrowUp')).toBe('↑');
    expect(signatureToDisplayString('ArrowDown')).toBe('↓');
    expect(signatureToDisplayString('ArrowLeft')).toBe('←');
    expect(signatureToDisplayString('ArrowRight')).toBe('→');
  });
});

// =============================================================================
// compareSignatures
// =============================================================================

describe('compareSignatures', () => {
  it('should match identical signatures', () => {
    expect(compareSignatures('Ctrl+S', 'Ctrl+S')).toBe(true);
    expect(compareSignatures('A', 'A')).toBe(true);
  });

  it('should match regardless of case', () => {
    expect(compareSignatures('ctrl+s', 'Ctrl+S')).toBe(true);
    expect(compareSignatures('a', 'A')).toBe(true);
  });

  it('should match regardless of modifier order', () => {
    expect(compareSignatures('Shift+Ctrl+S', 'Ctrl+Shift+S')).toBe(true);
    expect(compareSignatures('Alt+Ctrl+A', 'Ctrl+Alt+A')).toBe(true);
  });

  it('should not match different signatures', () => {
    expect(compareSignatures('Ctrl+S', 'Ctrl+A')).toBe(false);
    expect(compareSignatures('Ctrl+S', 'Shift+S')).toBe(false);
    expect(compareSignatures('A', 'B')).toBe(false);
  });
});
