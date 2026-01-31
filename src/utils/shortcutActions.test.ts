/**
 * Shortcut Actions Tests
 *
 * TDD: Tests for shortcut action registry and default bindings.
 */

import { describe, it, expect } from 'vitest';
import {
  SHORTCUT_ACTIONS,
  DEFAULT_SHORTCUTS,
  getShortcutAction,
  getActionByShortcut,
  getShortcutForAction,
  getAllShortcuts,
  getShortcutsByCategory,
} from './shortcutActions';

// =============================================================================
// SHORTCUT_ACTIONS Registry
// =============================================================================

describe('SHORTCUT_ACTIONS', () => {
  it('should have all required actions defined', () => {
    // Playback
    expect(SHORTCUT_ACTIONS['playback.playPause']).toBeDefined();
    expect(SHORTCUT_ACTIONS['playback.stop']).toBeDefined();
    expect(SHORTCUT_ACTIONS['playback.frameForward']).toBeDefined();
    expect(SHORTCUT_ACTIONS['playback.frameBackward']).toBeDefined();
    expect(SHORTCUT_ACTIONS['playback.shuttleForward']).toBeDefined();
    expect(SHORTCUT_ACTIONS['playback.shuttleBackward']).toBeDefined();
    expect(SHORTCUT_ACTIONS['playback.shuttleStop']).toBeDefined();

    // Timeline
    expect(SHORTCUT_ACTIONS['timeline.split']).toBeDefined();
    expect(SHORTCUT_ACTIONS['timeline.delete']).toBeDefined();
    expect(SHORTCUT_ACTIONS['timeline.selectAll']).toBeDefined();
    expect(SHORTCUT_ACTIONS['timeline.rippleDelete']).toBeDefined();

    // Project
    expect(SHORTCUT_ACTIONS['project.save']).toBeDefined();
    expect(SHORTCUT_ACTIONS['project.undo']).toBeDefined();
    expect(SHORTCUT_ACTIONS['project.redo']).toBeDefined();

    // Navigation
    expect(SHORTCUT_ACTIONS['navigate.zoomIn']).toBeDefined();
    expect(SHORTCUT_ACTIONS['navigate.zoomOut']).toBeDefined();
    expect(SHORTCUT_ACTIONS['navigate.fitToWindow']).toBeDefined();
  });

  it('should have valid action structure', () => {
    Object.values(SHORTCUT_ACTIONS).forEach((action) => {
      expect(action.id).toBeDefined();
      expect(action.label).toBeDefined();
      expect(action.category).toBeDefined();
      expect(typeof action.id).toBe('string');
      expect(typeof action.label).toBe('string');
      expect(['playback', 'timeline', 'project', 'navigation', 'view', 'tools']).toContain(
        action.category
      );
    });
  });

  it('should have unique action IDs', () => {
    const ids = Object.keys(SHORTCUT_ACTIONS);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// =============================================================================
// DEFAULT_SHORTCUTS
// =============================================================================

describe('DEFAULT_SHORTCUTS', () => {
  it('should have default shortcuts for common actions', () => {
    expect(DEFAULT_SHORTCUTS['playback.playPause']).toBe('Space');
    expect(DEFAULT_SHORTCUTS['project.save']).toBe('Ctrl+S');
    expect(DEFAULT_SHORTCUTS['project.undo']).toBe('Ctrl+Z');
    expect(DEFAULT_SHORTCUTS['project.redo']).toBe('Ctrl+Shift+Z');
    expect(DEFAULT_SHORTCUTS['timeline.split']).toBe('S');
    expect(DEFAULT_SHORTCUTS['timeline.delete']).toBe('Delete');
  });

  it('should have JKL shuttle controls', () => {
    expect(DEFAULT_SHORTCUTS['playback.shuttleBackward']).toBe('J');
    expect(DEFAULT_SHORTCUTS['playback.shuttleStop']).toBe('K');
    expect(DEFAULT_SHORTCUTS['playback.shuttleForward']).toBe('L');
  });

  it('should have arrow key navigation', () => {
    expect(DEFAULT_SHORTCUTS['playback.frameBackward']).toBe('ArrowLeft');
    expect(DEFAULT_SHORTCUTS['playback.frameForward']).toBe('ArrowRight');
  });

  it('should have zoom shortcuts', () => {
    expect(DEFAULT_SHORTCUTS['navigate.zoomIn']).toBe('Ctrl+=');
    expect(DEFAULT_SHORTCUTS['navigate.zoomOut']).toBe('Ctrl+-');
  });
});

// =============================================================================
// getShortcutAction
// =============================================================================

describe('getShortcutAction', () => {
  it('should return action by ID', () => {
    const action = getShortcutAction('playback.playPause');
    expect(action).toBeDefined();
    expect(action?.id).toBe('playback.playPause');
    expect(action?.label).toBe('Play/Pause');
  });

  it('should return undefined for unknown action', () => {
    const action = getShortcutAction('unknown.action');
    expect(action).toBeUndefined();
  });
});

// =============================================================================
// getActionByShortcut
// =============================================================================

describe('getActionByShortcut', () => {
  it('should find action by shortcut', () => {
    const actionId = getActionByShortcut('Space');
    expect(actionId).toBe('playback.playPause');
  });

  it('should find action with custom shortcuts override', () => {
    const customShortcuts = { 'playback.playPause': 'P' };
    const actionId = getActionByShortcut('P', customShortcuts);
    expect(actionId).toBe('playback.playPause');
  });

  it('should prioritize custom shortcuts over defaults', () => {
    const customShortcuts = { 'playback.playPause': 'P' };
    const actionIdP = getActionByShortcut('P', customShortcuts);
    const actionIdSpace = getActionByShortcut('Space', customShortcuts);
    expect(actionIdP).toBe('playback.playPause');
    expect(actionIdSpace).toBeUndefined(); // Space no longer bound
  });

  it('should return undefined for unbound shortcut', () => {
    const actionId = getActionByShortcut('Ctrl+Shift+Alt+X');
    expect(actionId).toBeUndefined();
  });

  it('should be case-insensitive', () => {
    const actionId = getActionByShortcut('space');
    expect(actionId).toBe('playback.playPause');
  });

  it('should handle modifier order variations', () => {
    const actionId = getActionByShortcut('Shift+Ctrl+Z');
    expect(actionId).toBe('project.redo');
  });
});

// =============================================================================
// getShortcutForAction
// =============================================================================

describe('getShortcutForAction', () => {
  it('should return default shortcut for action', () => {
    const shortcut = getShortcutForAction('playback.playPause');
    expect(shortcut).toBe('Space');
  });

  it('should return custom shortcut when defined', () => {
    const customShortcuts = { 'playback.playPause': 'P' };
    const shortcut = getShortcutForAction('playback.playPause', customShortcuts);
    expect(shortcut).toBe('P');
  });

  it('should fall back to default if custom not defined', () => {
    const customShortcuts = { 'project.save': 'Ctrl+Shift+S' };
    const shortcut = getShortcutForAction('playback.playPause', customShortcuts);
    expect(shortcut).toBe('Space');
  });

  it('should return undefined for action without shortcut', () => {
    const shortcut = getShortcutForAction('unknown.action');
    expect(shortcut).toBeUndefined();
  });
});

// =============================================================================
// getAllShortcuts
// =============================================================================

describe('getAllShortcuts', () => {
  it('should return all shortcuts merged with defaults', () => {
    const shortcuts = getAllShortcuts();
    expect(shortcuts['playback.playPause']).toBe('Space');
    expect(shortcuts['project.save']).toBe('Ctrl+S');
  });

  it('should merge custom shortcuts over defaults', () => {
    const customShortcuts = { 'playback.playPause': 'P' };
    const shortcuts = getAllShortcuts(customShortcuts);
    expect(shortcuts['playback.playPause']).toBe('P');
    expect(shortcuts['project.save']).toBe('Ctrl+S'); // Unchanged
  });
});

// =============================================================================
// getShortcutsByCategory
// =============================================================================

describe('getShortcutsByCategory', () => {
  it('should return shortcuts grouped by category', () => {
    const byCategory = getShortcutsByCategory();

    expect(byCategory.playback).toBeDefined();
    expect(byCategory.timeline).toBeDefined();
    expect(byCategory.project).toBeDefined();
    expect(byCategory.navigation).toBeDefined();
  });

  it('should include action info with shortcuts', () => {
    const byCategory = getShortcutsByCategory();

    const playPause = byCategory.playback.find((s) => s.actionId === 'playback.playPause');
    expect(playPause).toBeDefined();
    expect(playPause?.label).toBe('Play/Pause');
    expect(playPause?.shortcut).toBe('Space');
  });

  it('should apply custom shortcuts', () => {
    const customShortcuts = { 'playback.playPause': 'P' };
    const byCategory = getShortcutsByCategory(customShortcuts);

    const playPause = byCategory.playback.find((s) => s.actionId === 'playback.playPause');
    expect(playPause?.shortcut).toBe('P');
  });
});
