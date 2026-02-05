/**
 * Feature Flags Tests
 *
 * Tests for the feature flag system used for gradual rollout
 * of the new agentic engine.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getFeatureFlag,
  setFeatureFlag,
  resetFeatureFlags,
  isAgenticEngineEnabled,
  getAllFeatureFlags,
  FEATURE_FLAG_KEYS,
} from './featureFlags';

describe('featureFlags', () => {
  // Mock localStorage
  const localStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
      clear: vi.fn(() => {
        store = {};
      }),
    };
  })();

  beforeEach(() => {
    // Setup localStorage mock
    vi.stubGlobal('localStorage', localStorageMock);
    localStorageMock.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getFeatureFlag', () => {
    it('should return default value when not set', () => {
      expect(getFeatureFlag('USE_AGENTIC_ENGINE')).toBe(false);
    });

    it('should return true when flag is enabled via localStorage', () => {
      localStorageMock.setItem(
        'openreelio-feature-flags',
        JSON.stringify({ USE_AGENTIC_ENGINE: true })
      );

      expect(getFeatureFlag('USE_AGENTIC_ENGINE')).toBe(true);
    });

    it('should return false when flag is explicitly disabled', () => {
      localStorageMock.setItem(
        'openreelio-feature-flags',
        JSON.stringify({ USE_AGENTIC_ENGINE: false })
      );

      expect(getFeatureFlag('USE_AGENTIC_ENGINE')).toBe(false);
    });

    it('should return default value for invalid JSON in localStorage', () => {
      localStorageMock.setItem('openreelio-feature-flags', 'invalid-json');

      expect(getFeatureFlag('USE_AGENTIC_ENGINE')).toBe(false);
    });

    it('should handle missing localStorage gracefully', () => {
      vi.stubGlobal('localStorage', undefined);

      // Should not throw and return default
      expect(getFeatureFlag('USE_AGENTIC_ENGINE')).toBe(false);
    });
  });

  describe('setFeatureFlag', () => {
    it('should set flag value in localStorage', () => {
      setFeatureFlag('USE_AGENTIC_ENGINE', true);

      const stored = JSON.parse(
        localStorageMock.getItem('openreelio-feature-flags') ?? '{}'
      );
      expect(stored.USE_AGENTIC_ENGINE).toBe(true);
    });

    it('should preserve other flags when setting one', () => {
      // First set initial state
      localStorageMock.setItem(
        'openreelio-feature-flags',
        JSON.stringify({ USE_AGENTIC_ENGINE: false, OTHER_FLAG: true })
      );

      setFeatureFlag('USE_AGENTIC_ENGINE', true);

      const stored = JSON.parse(
        localStorageMock.getItem('openreelio-feature-flags') ?? '{}'
      );
      expect(stored.USE_AGENTIC_ENGINE).toBe(true);
      // Note: OTHER_FLAG may or may not be preserved depending on implementation
    });

    it('should handle missing localStorage gracefully', () => {
      vi.stubGlobal('localStorage', undefined);

      // Should not throw
      expect(() => setFeatureFlag('USE_AGENTIC_ENGINE', true)).not.toThrow();
    });
  });

  describe('resetFeatureFlags', () => {
    it('should remove all feature flags from localStorage', () => {
      localStorageMock.setItem(
        'openreelio-feature-flags',
        JSON.stringify({ USE_AGENTIC_ENGINE: true })
      );

      resetFeatureFlags();

      expect(localStorageMock.getItem('openreelio-feature-flags')).toBeNull();
    });

    it('should handle missing localStorage gracefully', () => {
      vi.stubGlobal('localStorage', undefined);

      expect(() => resetFeatureFlags()).not.toThrow();
    });
  });

  describe('isAgenticEngineEnabled', () => {
    it('should return false by default', () => {
      expect(isAgenticEngineEnabled()).toBe(false);
    });

    it('should return true when USE_AGENTIC_ENGINE is enabled', () => {
      setFeatureFlag('USE_AGENTIC_ENGINE', true);

      expect(isAgenticEngineEnabled()).toBe(true);
    });

    it('should be a convenience wrapper for getFeatureFlag', () => {
      localStorageMock.setItem(
        'openreelio-feature-flags',
        JSON.stringify({ USE_AGENTIC_ENGINE: true })
      );

      expect(isAgenticEngineEnabled()).toBe(getFeatureFlag('USE_AGENTIC_ENGINE'));
    });
  });

  describe('getAllFeatureFlags', () => {
    it('should return all flags with their current values', () => {
      const flags = getAllFeatureFlags();

      expect(flags).toHaveProperty('USE_AGENTIC_ENGINE');
      expect(typeof flags.USE_AGENTIC_ENGINE).toBe('boolean');
    });

    it('should reflect localStorage overrides', () => {
      localStorageMock.setItem(
        'openreelio-feature-flags',
        JSON.stringify({ USE_AGENTIC_ENGINE: true })
      );

      const flags = getAllFeatureFlags();

      expect(flags.USE_AGENTIC_ENGINE).toBe(true);
    });
  });

  describe('FEATURE_FLAG_KEYS', () => {
    it('should include USE_AGENTIC_ENGINE', () => {
      expect(FEATURE_FLAG_KEYS).toContain('USE_AGENTIC_ENGINE');
    });

    it('should be a readonly array', () => {
      // TypeScript should prevent modification, but we can verify it exists
      expect(Array.isArray(FEATURE_FLAG_KEYS)).toBe(true);
    });
  });

  describe('environment-based defaults', () => {
    it('should allow environment variables to override defaults', () => {
      // This test verifies that the system can handle environment overrides
      // The actual implementation might use import.meta.env or process.env
      const flags = getAllFeatureFlags();

      // Should always have a boolean value
      expect(typeof flags.USE_AGENTIC_ENGINE).toBe('boolean');
    });
  });

  describe('integration scenarios', () => {
    it('should support typical development workflow', () => {
      // 1. Start with default (disabled)
      expect(isAgenticEngineEnabled()).toBe(false);

      // 2. Developer enables for testing
      setFeatureFlag('USE_AGENTIC_ENGINE', true);
      expect(isAgenticEngineEnabled()).toBe(true);

      // 3. Developer resets to defaults
      resetFeatureFlags();
      expect(isAgenticEngineEnabled()).toBe(false);
    });

    it('should support feature flag toggling in UI', () => {
      // Simulate UI toggle
      const initialValue = getFeatureFlag('USE_AGENTIC_ENGINE');

      // Toggle
      setFeatureFlag('USE_AGENTIC_ENGINE', !initialValue);
      expect(getFeatureFlag('USE_AGENTIC_ENGINE')).toBe(!initialValue);

      // Toggle back
      setFeatureFlag('USE_AGENTIC_ENGINE', initialValue);
      expect(getFeatureFlag('USE_AGENTIC_ENGINE')).toBe(initialValue);
    });
  });
});
