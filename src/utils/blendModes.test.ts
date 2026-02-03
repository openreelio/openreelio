/**
 * Blend Modes Utility Tests
 *
 * Tests for blend mode definitions and utilities.
 * Following TDD methodology.
 */

import { describe, it, expect } from 'vitest';
import {
  BLEND_MODE_DEFINITIONS,
  getBlendModeLabel,
  getBlendModeDescription,
  getBlendModeCategory,
  getBlendModesByCategory,
  isValidBlendMode,
  DEFAULT_BLEND_MODE,
} from './blendModes';
import type { BlendMode } from '@/types';

// =============================================================================
// Blend Mode Definitions Tests
// =============================================================================

describe('BLEND_MODE_DEFINITIONS', () => {
  it('should define all 5 blend modes', () => {
    const modes: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'add'];
    modes.forEach((mode) => {
      expect(BLEND_MODE_DEFINITIONS[mode]).toBeDefined();
    });
  });

  it('should have label for each blend mode', () => {
    const modes: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'add'];
    modes.forEach((mode) => {
      expect(BLEND_MODE_DEFINITIONS[mode].label).toBeDefined();
      expect(typeof BLEND_MODE_DEFINITIONS[mode].label).toBe('string');
      expect(BLEND_MODE_DEFINITIONS[mode].label.length).toBeGreaterThan(0);
    });
  });

  it('should have description for each blend mode', () => {
    const modes: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'add'];
    modes.forEach((mode) => {
      expect(BLEND_MODE_DEFINITIONS[mode].description).toBeDefined();
      expect(typeof BLEND_MODE_DEFINITIONS[mode].description).toBe('string');
    });
  });

  it('should have category for each blend mode', () => {
    const modes: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'add'];
    modes.forEach((mode) => {
      expect(BLEND_MODE_DEFINITIONS[mode].category).toBeDefined();
      expect(['basic', 'darken', 'lighten', 'contrast', 'component']).toContain(
        BLEND_MODE_DEFINITIONS[mode].category
      );
    });
  });
});

// =============================================================================
// getBlendModeLabel Tests
// =============================================================================

describe('getBlendModeLabel', () => {
  it('should return "Normal" for normal mode', () => {
    expect(getBlendModeLabel('normal')).toBe('Normal');
  });

  it('should return "Multiply" for multiply mode', () => {
    expect(getBlendModeLabel('multiply')).toBe('Multiply');
  });

  it('should return "Screen" for screen mode', () => {
    expect(getBlendModeLabel('screen')).toBe('Screen');
  });

  it('should return "Overlay" for overlay mode', () => {
    expect(getBlendModeLabel('overlay')).toBe('Overlay');
  });

  it('should return "Add" for add mode', () => {
    expect(getBlendModeLabel('add')).toBe('Add');
  });
});

// =============================================================================
// getBlendModeDescription Tests
// =============================================================================

describe('getBlendModeDescription', () => {
  it('should return description for normal mode', () => {
    const desc = getBlendModeDescription('normal');
    expect(desc).toBeDefined();
    expect(desc.length).toBeGreaterThan(10);
  });

  it('should return description for multiply mode', () => {
    const desc = getBlendModeDescription('multiply');
    expect(desc).toBeDefined();
    expect(desc.toLowerCase()).toContain('dark');
  });

  it('should return description for screen mode', () => {
    const desc = getBlendModeDescription('screen');
    expect(desc).toBeDefined();
    expect(desc.toLowerCase()).toContain('light');
  });
});

// =============================================================================
// getBlendModeCategory Tests
// =============================================================================

describe('getBlendModeCategory', () => {
  it('should return "basic" for normal mode', () => {
    expect(getBlendModeCategory('normal')).toBe('basic');
  });

  it('should return "darken" for multiply mode', () => {
    expect(getBlendModeCategory('multiply')).toBe('darken');
  });

  it('should return "lighten" for screen and add modes', () => {
    expect(getBlendModeCategory('screen')).toBe('lighten');
    expect(getBlendModeCategory('add')).toBe('lighten');
  });

  it('should return "contrast" for overlay mode', () => {
    expect(getBlendModeCategory('overlay')).toBe('contrast');
  });
});

// =============================================================================
// getBlendModesByCategory Tests
// =============================================================================

describe('getBlendModesByCategory', () => {
  it('should return normal in basic category', () => {
    const modes = getBlendModesByCategory('basic');
    expect(modes).toContain('normal');
  });

  it('should return multiply in darken category', () => {
    const modes = getBlendModesByCategory('darken');
    expect(modes).toContain('multiply');
  });

  it('should return screen and add in lighten category', () => {
    const modes = getBlendModesByCategory('lighten');
    expect(modes).toContain('screen');
    expect(modes).toContain('add');
  });

  it('should return overlay in contrast category', () => {
    const modes = getBlendModesByCategory('contrast');
    expect(modes).toContain('overlay');
  });

  it('should return empty array for unknown category', () => {
    const modes = getBlendModesByCategory('unknown' as any);
    expect(modes).toEqual([]);
  });
});

// =============================================================================
// isValidBlendMode Tests
// =============================================================================

describe('isValidBlendMode', () => {
  it('should return true for valid blend modes', () => {
    const modes: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'add'];
    modes.forEach((mode) => {
      expect(isValidBlendMode(mode)).toBe(true);
    });
  });

  it('should return false for invalid blend modes', () => {
    expect(isValidBlendMode('invalid' as any)).toBe(false);
    expect(isValidBlendMode('' as any)).toBe(false);
    expect(isValidBlendMode(null as any)).toBe(false);
    expect(isValidBlendMode(undefined as any)).toBe(false);
  });
});

// =============================================================================
// DEFAULT_BLEND_MODE Tests
// =============================================================================

describe('DEFAULT_BLEND_MODE', () => {
  it('should be "normal"', () => {
    expect(DEFAULT_BLEND_MODE).toBe('normal');
  });
});
