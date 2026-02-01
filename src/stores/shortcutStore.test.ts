/**
 * Shortcut Store Tests
 *
 * Tests for customizable keyboard shortcuts store.
 * Follows TDD methodology.
 *
 * @module stores/shortcutStore.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  useShortcutStore,
  formatShortcut,
  DEFAULT_SHORTCUTS,
  SHORTCUT_PRESETS,
  type ShortcutBinding,
} from './shortcutStore';

describe('shortcutStore', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useShortcutStore.getState().resetAllBindings();
  });

  describe('initial state', () => {
    it('should have default bindings loaded', () => {
      const state = useShortcutStore.getState();
      expect(state.bindings.length).toBe(DEFAULT_SHORTCUTS.length);
      expect(state.activePreset).toBe('default');
    });

    it('should have all bindings enabled by default', () => {
      const state = useShortcutStore.getState();
      const allEnabled = state.bindings.every(b => b.enabled);
      expect(allEnabled).toBe(true);
    });

    it('should have no customized bindings initially', () => {
      const state = useShortcutStore.getState();
      const anyCustomized = state.bindings.some(b => b.customized);
      expect(anyCustomized).toBe(false);
    });
  });

  describe('updateBinding', () => {
    it('should update a binding key', () => {
      const store = useShortcutStore.getState();
      const result = store.updateBinding('tool-select', { key: 'KeyA' });

      expect(result).toBeNull(); // No conflict

      const updated = useShortcutStore.getState().getBindingById('tool-select');
      expect(updated?.key).toBe('KeyA');
      expect(updated?.customized).toBe(true);
    });

    it('should update binding modifiers', () => {
      const store = useShortcutStore.getState();
      // Use alt modifier to avoid conflict with paste (Ctrl+V)
      const result = store.updateBinding('tool-select', { modifiers: ['alt'] });

      expect(result).toBeNull();

      const updated = useShortcutStore.getState().getBindingById('tool-select');
      expect(updated?.modifiers).toEqual(['alt']);
    });

    it('should detect conflicts with existing bindings', () => {
      const store = useShortcutStore.getState();
      // Try to set tool-select to use the same key as tool-razor (KeyC)
      const result = store.updateBinding('tool-select', { key: 'KeyC', modifiers: [] });

      expect(result).not.toBeNull();
      expect(result?.existingBinding.id).toBe('tool-razor');
    });

    it('should clear activePreset when binding is customized', () => {
      const store = useShortcutStore.getState();
      expect(store.activePreset).toBe('default');

      store.updateBinding('tool-select', { key: 'KeyA' });

      expect(useShortcutStore.getState().activePreset).toBeNull();
    });

    it('should toggle binding enabled state', () => {
      const store = useShortcutStore.getState();
      store.updateBinding('tool-select', { enabled: false });

      const updated = useShortcutStore.getState().getBindingById('tool-select');
      expect(updated?.enabled).toBe(false);
    });
  });

  describe('resetBinding', () => {
    it('should reset a single binding to default', () => {
      const store = useShortcutStore.getState();

      // Customize first
      store.updateBinding('tool-select', { key: 'KeyA' });
      expect(useShortcutStore.getState().getBindingById('tool-select')?.key).toBe('KeyA');

      // Reset
      store.resetBinding('tool-select');

      const binding = useShortcutStore.getState().getBindingById('tool-select');
      expect(binding?.key).toBe('KeyV');
      expect(binding?.customized).toBe(false);
    });
  });

  describe('resetAllBindings', () => {
    it('should reset all bindings to defaults', () => {
      const store = useShortcutStore.getState();

      // Customize multiple bindings
      store.updateBinding('tool-select', { key: 'KeyA' });
      store.updateBinding('tool-razor', { key: 'KeyB' });

      // Reset all
      store.resetAllBindings();

      const state = useShortcutStore.getState();
      expect(state.activePreset).toBe('default');
      expect(state.getBindingById('tool-select')?.key).toBe('KeyV');
      expect(state.getBindingById('tool-razor')?.key).toBe('KeyC');
    });
  });

  describe('applyPreset', () => {
    it('should apply a preset', () => {
      const store = useShortcutStore.getState();
      store.applyPreset('premiere');

      const state = useShortcutStore.getState();
      expect(state.activePreset).toBe('premiere');
    });

    it('should not apply non-existent preset', () => {
      const store = useShortcutStore.getState();
      const before = useShortcutStore.getState().bindings;

      store.applyPreset('non-existent');

      const after = useShortcutStore.getState().bindings;
      expect(after).toEqual(before);
    });
  });

  describe('checkConflict', () => {
    it('should return null for non-conflicting binding', () => {
      const store = useShortcutStore.getState();
      const conflict = store.checkConflict('tool-select', 'KeyZ', []);

      expect(conflict).toBeNull();
    });

    it('should detect conflict with same key and modifiers', () => {
      const store = useShortcutStore.getState();
      const conflict = store.checkConflict('tool-select', 'KeyC', []);

      expect(conflict).not.toBeNull();
      expect(conflict?.existingBinding.id).toBe('tool-razor');
    });

    it('should not conflict with disabled bindings', () => {
      const store = useShortcutStore.getState();

      // Disable tool-razor
      store.updateBinding('tool-razor', { enabled: false });

      // Now there should be no conflict
      const conflict = useShortcutStore.getState().checkConflict('tool-select', 'KeyC', []);
      expect(conflict).toBeNull();
    });

    it('should distinguish by modifiers', () => {
      const store = useShortcutStore.getState();

      // KeyC without modifiers = tool-razor
      // KeyC with Ctrl = copy
      const noModConflict = store.checkConflict('tool-select', 'KeyC', []);
      const ctrlConflict = store.checkConflict('tool-select', 'KeyC', ['ctrl']);

      expect(noModConflict?.existingBinding.id).toBe('tool-razor');
      expect(ctrlConflict?.existingBinding.id).toBe('copy');
    });
  });

  describe('getBindingByAction', () => {
    it('should find binding by action name', () => {
      const store = useShortcutStore.getState();
      const binding = store.getBindingByAction('tool.select');

      expect(binding).toBeDefined();
      expect(binding?.id).toBe('tool-select');
    });

    it('should return undefined for non-existent action', () => {
      const store = useShortcutStore.getState();
      const binding = store.getBindingByAction('non.existent');

      expect(binding).toBeUndefined();
    });

    it('should not return disabled bindings', () => {
      const store = useShortcutStore.getState();
      store.updateBinding('tool-select', { enabled: false });

      const binding = useShortcutStore.getState().getBindingByAction('tool.select');
      expect(binding).toBeUndefined();
    });
  });

  describe('getBindingsByCategory', () => {
    it('should return all bindings in a category', () => {
      const store = useShortcutStore.getState();
      const toolBindings = store.getBindingsByCategory('tools');

      expect(toolBindings.length).toBeGreaterThan(0);
      expect(toolBindings.every(b => b.category === 'tools')).toBe(true);
    });
  });

  describe('exportBindings / importBindings', () => {
    it('should export bindings as JSON', () => {
      const store = useShortcutStore.getState();
      const json = store.exportBindings();

      expect(typeof json).toBe('string');

      const parsed = JSON.parse(json);
      expect(parsed.version).toBe(1);
      expect(Array.isArray(parsed.bindings)).toBe(true);
    });

    it('should import bindings from JSON', () => {
      const store = useShortcutStore.getState();

      // Customize and export
      store.updateBinding('tool-select', { key: 'KeyA' });
      const json = store.exportBindings();

      // Reset and import
      store.resetAllBindings();
      expect(useShortcutStore.getState().getBindingById('tool-select')?.key).toBe('KeyV');

      const success = store.importBindings(json);
      expect(success).toBe(true);
      expect(useShortcutStore.getState().getBindingById('tool-select')?.key).toBe('KeyA');
    });

    it('should reject invalid JSON', () => {
      const store = useShortcutStore.getState();
      const success = store.importBindings('invalid json');

      expect(success).toBe(false);
    });

    it('should reject wrong version', () => {
      const store = useShortcutStore.getState();
      const success = store.importBindings(JSON.stringify({ version: 99, bindings: [] }));

      expect(success).toBe(false);
    });
  });

  describe('panel state', () => {
    it('should toggle panel open state', () => {
      const store = useShortcutStore.getState();
      expect(store.isPanelOpen).toBe(false);

      store.togglePanel();
      expect(useShortcutStore.getState().isPanelOpen).toBe(true);

      store.togglePanel();
      expect(useShortcutStore.getState().isPanelOpen).toBe(false);
    });

    it('should set panel open state directly', () => {
      const store = useShortcutStore.getState();

      store.setPanelOpen(true);
      expect(useShortcutStore.getState().isPanelOpen).toBe(true);

      store.setPanelOpen(false);
      expect(useShortcutStore.getState().isPanelOpen).toBe(false);
    });
  });
});

describe('formatShortcut', () => {
  it('should format simple key', () => {
    const binding: ShortcutBinding = {
      id: 'test',
      label: 'Test',
      description: 'Test',
      key: 'KeyV',
      modifiers: [],
      action: 'test',
      category: 'tools',
      customized: false,
      enabled: true,
    };

    expect(formatShortcut(binding)).toBe('V');
  });

  it('should format key with modifiers', () => {
    const binding: ShortcutBinding = {
      id: 'test',
      label: 'Test',
      description: 'Test',
      key: 'KeyC',
      modifiers: ['ctrl'],
      action: 'test',
      category: 'editing',
      customized: false,
      enabled: true,
    };

    expect(formatShortcut(binding)).toBe('Ctrl+C');
  });

  it('should format multiple modifiers in order', () => {
    const binding: ShortcutBinding = {
      id: 'test',
      label: 'Test',
      description: 'Test',
      key: 'KeyZ',
      modifiers: ['ctrl', 'shift'],
      action: 'test',
      category: 'editing',
      customized: false,
      enabled: true,
    };

    expect(formatShortcut(binding)).toBe('Ctrl+Shift+Z');
  });

  it('should format arrow keys with symbols', () => {
    const binding: ShortcutBinding = {
      id: 'test',
      label: 'Test',
      description: 'Test',
      key: 'ArrowLeft',
      modifiers: [],
      action: 'test',
      category: 'navigation',
      customized: false,
      enabled: true,
    };

    expect(formatShortcut(binding)).toBe('\u2190');
  });

  it('should format digit keys', () => {
    const binding: ShortcutBinding = {
      id: 'test',
      label: 'Test',
      description: 'Test',
      key: 'Digit0',
      modifiers: ['ctrl'],
      action: 'test',
      category: 'view',
      customized: false,
      enabled: true,
    };

    expect(formatShortcut(binding)).toBe('Ctrl+0');
  });

  it('should format special keys', () => {
    const binding: ShortcutBinding = {
      id: 'test',
      label: 'Test',
      description: 'Test',
      key: 'Space',
      modifiers: [],
      action: 'test',
      category: 'playback',
      customized: false,
      enabled: true,
    };

    expect(formatShortcut(binding)).toBe('Space');
  });
});

describe('SHORTCUT_PRESETS', () => {
  it('should have default preset', () => {
    const defaultPreset = SHORTCUT_PRESETS.find(p => p.id === 'default');
    expect(defaultPreset).toBeDefined();
    expect(defaultPreset?.bindings.length).toBe(DEFAULT_SHORTCUTS.length);
  });

  it('should have premiere preset', () => {
    const premierePreset = SHORTCUT_PRESETS.find(p => p.id === 'premiere');
    expect(premierePreset).toBeDefined();
  });

  it('should have davinci preset', () => {
    const davinciPreset = SHORTCUT_PRESETS.find(p => p.id === 'davinci');
    expect(davinciPreset).toBeDefined();
  });
});
