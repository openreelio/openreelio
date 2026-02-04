/**
 * Feature Flags System
 *
 * Provides feature flag functionality for gradual rollout of new features.
 * The primary use case is enabling the new Agentic Engine while keeping
 * the legacy AI chat system as fallback.
 *
 * Features:
 * - Default values defined in code
 * - localStorage override for development and testing
 * - Environment variable support for CI/CD
 * - Type-safe flag access
 *
 * @example
 * ```typescript
 * import { isAgenticEngineEnabled, setFeatureFlag } from '@/config/featureFlags';
 *
 * // Check if new engine is enabled
 * if (isAgenticEngineEnabled()) {
 *   // Use new agentic engine
 * } else {
 *   // Use legacy chat
 * }
 *
 * // Enable for testing (persists in localStorage)
 * setFeatureFlag('USE_AGENTIC_ENGINE', true);
 * ```
 */

// =============================================================================
// Types
// =============================================================================

/**
 * All available feature flags
 */
export interface FeatureFlags {
  /**
   * Enable the new Agentic Engine (Think-Plan-Act-Observe loop)
   * When false, uses legacy single-shot AI chat
   * @default false
   */
  USE_AGENTIC_ENGINE: boolean;
}

/**
 * Keys of all feature flags
 */
export type FeatureFlagKey = keyof FeatureFlags;

// =============================================================================
// Constants
// =============================================================================

/**
 * localStorage key for storing feature flag overrides
 */
const STORAGE_KEY = 'openreelio-feature-flags';

/**
 * Default values for all feature flags
 *
 * These are the production defaults. All new features should
 * default to `false` until ready for general release.
 */
const DEFAULT_FLAGS: FeatureFlags = {
  USE_AGENTIC_ENGINE: false,
};

/**
 * List of all feature flag keys for iteration
 */
export const FEATURE_FLAG_KEYS: readonly FeatureFlagKey[] = [
  'USE_AGENTIC_ENGINE',
] as const;

// =============================================================================
// Private Helpers
// =============================================================================

/**
 * Check if localStorage is available
 */
function isLocalStorageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

/**
 * Get stored overrides from localStorage
 */
function getStoredOverrides(): Partial<FeatureFlags> {
  if (!isLocalStorageAvailable()) {
    return {};
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return {};
    }

    const parsed = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }

    return parsed as Partial<FeatureFlags>;
  } catch {
    // Invalid JSON or other error
    return {};
  }
}

/**
 * Save overrides to localStorage
 */
function saveOverrides(overrides: Partial<FeatureFlags>): void {
  if (!isLocalStorageAvailable()) {
    return;
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // localStorage full or other error - silently ignore
  }
}

/**
 * Check environment variable override
 *
 * Environment variables take format: VITE_FF_<FLAG_NAME>
 * e.g., VITE_FF_USE_AGENTIC_ENGINE=true
 */
function getEnvOverride(flag: FeatureFlagKey): boolean | undefined {
  try {
    // Check for Vite environment variable
    const envKey = `VITE_FF_${flag}`;
    const envValue = (import.meta as { env?: Record<string, string> }).env?.[envKey];

    if (envValue === 'true') {
      return true;
    }
    if (envValue === 'false') {
      return false;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Get the current value of a feature flag
 *
 * Priority:
 * 1. Environment variable (VITE_FF_<FLAG_NAME>)
 * 2. localStorage override
 * 3. Default value
 *
 * @param flag - The feature flag to check
 * @returns The current boolean value of the flag
 *
 * @example
 * ```typescript
 * if (getFeatureFlag('USE_AGENTIC_ENGINE')) {
 *   // New engine is enabled
 * }
 * ```
 */
export function getFeatureFlag(flag: FeatureFlagKey): boolean {
  // 1. Check environment override
  const envValue = getEnvOverride(flag);
  if (envValue !== undefined) {
    return envValue;
  }

  // 2. Check localStorage override
  const overrides = getStoredOverrides();
  if (flag in overrides) {
    return overrides[flag] ?? DEFAULT_FLAGS[flag];
  }

  // 3. Return default
  return DEFAULT_FLAGS[flag];
}

/**
 * Set a feature flag value (persisted in localStorage)
 *
 * This is primarily for development and testing. In production,
 * feature flags should be controlled via environment variables.
 *
 * @param flag - The feature flag to set
 * @param value - The new boolean value
 *
 * @example
 * ```typescript
 * // Enable new engine for testing
 * setFeatureFlag('USE_AGENTIC_ENGINE', true);
 *
 * // Disable it again
 * setFeatureFlag('USE_AGENTIC_ENGINE', false);
 * ```
 */
export function setFeatureFlag(flag: FeatureFlagKey, value: boolean): void {
  const overrides = getStoredOverrides();
  overrides[flag] = value;
  saveOverrides(overrides);
}

/**
 * Reset all feature flags to their defaults
 *
 * Removes all localStorage overrides, returning flags to
 * their default values (or environment overrides if set).
 *
 * @example
 * ```typescript
 * // Reset all flags to defaults
 * resetFeatureFlags();
 * ```
 */
export function resetFeatureFlags(): void {
  if (!isLocalStorageAvailable()) {
    return;
  }

  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Silently ignore errors
  }
}

/**
 * Get all feature flags with their current values
 *
 * Useful for debugging and displaying in settings UI.
 *
 * @returns Object with all flag names and their current boolean values
 *
 * @example
 * ```typescript
 * const flags = getAllFeatureFlags();
 * console.log(flags);
 * // { USE_AGENTIC_ENGINE: false }
 * ```
 */
export function getAllFeatureFlags(): FeatureFlags {
  const flags: Partial<FeatureFlags> = {};

  for (const key of FEATURE_FLAG_KEYS) {
    flags[key] = getFeatureFlag(key);
  }

  return flags as FeatureFlags;
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Check if the Agentic Engine is enabled
 *
 * Convenience wrapper for the most commonly used feature flag.
 *
 * @returns true if the new agentic engine should be used
 *
 * @example
 * ```typescript
 * import { isAgenticEngineEnabled } from '@/config/featureFlags';
 *
 * if (isAgenticEngineEnabled()) {
 *   return <AgenticChat />;
 * } else {
 *   return <LegacyChat />;
 * }
 * ```
 */
export function isAgenticEngineEnabled(): boolean {
  return getFeatureFlag('USE_AGENTIC_ENGINE');
}

// =============================================================================
// Development Utilities
// =============================================================================

/**
 * Debug helper to log all feature flags
 *
 * Only available in development mode.
 */
export function debugFeatureFlags(): void {
  if (import.meta.env?.DEV) {
    console.group('Feature Flags');
    const flags = getAllFeatureFlags();
    for (const [key, value] of Object.entries(flags)) {
      console.log(`${key}: ${value}`);
    }
    console.groupEnd();
  }
}

/**
 * Feature flag object for direct access (readonly)
 *
 * @deprecated Use getFeatureFlag() for proper override support
 */
export const FEATURE_FLAGS: Readonly<FeatureFlags> = Object.freeze({ ...DEFAULT_FLAGS });
