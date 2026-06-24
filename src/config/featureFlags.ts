import { useSyncExternalStore } from 'react';

/**
 * Feature Flags System
 *
 * Provides feature flag functionality for AI runtime rollout,
 * compatibility paths, and related product features.
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
 * // Check if the canonical engine is enabled
 * if (isAgenticEngineEnabled()) {
 *   // Use canonical agentic engine
 * } else {
 *   // Hide interactive AI runtime
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
   * Enable the canonical TPAO Agentic Engine used by the shipping AI sidebar.
   * @default true
   */
  USE_AGENTIC_ENGINE: boolean;

  /**
   * Enable AI video generation (Seedance 2.0 integration)
   * When false, video generation UI and agent tools are hidden
   * @default false
   */
  USE_VIDEO_GENERATION: boolean;

  /**
   * Enable the simplified Agent Loop (opencode-style stream → tool → loop)
   * for compatibility verification and internal entry points.
   * This does not replace the shipping AI sidebar runtime.
   * @default false
   */
  USE_AGENT_LOOP: boolean;

  /**
   * Enable backend tool execution for editing tools
   * When true, editing tools route through backend IPC (execute_agent_plan)
   * and analysis tools stay on frontend. When false, all tools use frontend.
   * @default false
   */
  USE_BACKEND_TOOLS: boolean;

  /**
   * Enable consolidated meta-tools (6 tools) instead of individual tools (56+)
   * When true, registers 6 high-level meta-tools (query, edit, audio, effects, text,
   * execute_plan) that dispatch to underlying individual tools. This reduces LLM
   * context overhead from ~15K tokens to ~2K tokens and improves agent accuracy.
   * @default true
   */
  USE_META_TOOLS: boolean;

  /**
   * Enable the vendor-neutral External Agent Host shell.
   * This does not replace the canonical TPAO sidebar runtime.
   * @default false
   */
  USE_EXTERNAL_AGENT_HOST: boolean;

  /**
   * Enable the Codex reference adapter for the External Agent Host.
   * This flag has no effect unless USE_EXTERNAL_AGENT_HOST is enabled.
   * @default false
   */
  USE_CODEX_AGENT: boolean;
}

/**
 * Keys of all feature flags
 */
export type FeatureFlagKey = keyof FeatureFlags;

export type AgentSidebarRuntime = 'tpao' | 'disabled';
export type AgentSidebarRuntimeTrack = 'canonical' | 'disabled';

export interface AgentSidebarRuntimePolicy {
  canonicalRuntime: 'tpao';
  selectedRuntime: AgentSidebarRuntime;
  track: AgentSidebarRuntimeTrack;
  compatibilityRuntime: 'fast' | null;
  compatibilityRuntimeEnabled: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * localStorage key for storing feature flag overrides
 */
const STORAGE_KEY = 'openreelio-feature-flags';
const featureFlagListeners = new Set<() => void>();
let cachedFeatureFlagsSnapshot: FeatureFlags | null = null;

/**
 * Default values for all feature flags
 *
 * These are the production defaults. All new features should
 * default to `false` until ready for general release.
 */
const DEFAULT_FLAGS: FeatureFlags = {
  USE_AGENTIC_ENGINE: true,
  USE_BACKEND_TOOLS: true,
  USE_META_TOOLS: true,
  // Release-gated, off by default. These speculative subsystems must NOT ship
  // enabled. Do not flip to true in committed code; enable per-environment via
  // VITE_FF_<FLAG>=true or a localStorage override during development only.
  USE_VIDEO_GENERATION: false,
  USE_AGENT_LOOP: false,
  USE_EXTERNAL_AGENT_HOST: false,
  USE_CODEX_AGENT: false,
};

/**
 * List of all feature flag keys for iteration
 */
export const FEATURE_FLAG_KEYS: readonly FeatureFlagKey[] = [
  'USE_AGENTIC_ENGINE',
  'USE_VIDEO_GENERATION',
  'USE_AGENT_LOOP',
  'USE_BACKEND_TOOLS',
  'USE_META_TOOLS',
  'USE_EXTERNAL_AGENT_HOST',
  'USE_CODEX_AGENT',
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

function notifyFeatureFlagListeners(): void {
  for (const listener of featureFlagListeners) {
    listener();
  }
}

function readFeatureFlagsSnapshot(): FeatureFlags {
  const nextSnapshot = getAllFeatureFlags();

  if (
    cachedFeatureFlagsSnapshot &&
    FEATURE_FLAG_KEYS.every((key) => cachedFeatureFlagsSnapshot?.[key] === nextSnapshot[key])
  ) {
    return cachedFeatureFlagsSnapshot;
  }

  cachedFeatureFlagsSnapshot = nextSnapshot;
  return nextSnapshot;
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
  notifyFeatureFlagListeners();
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
    notifyFeatureFlagListeners();
  } catch {
    // Silently ignore errors
  }
}

export function subscribeFeatureFlags(listener: () => void): () => void {
  featureFlagListeners.add(listener);
  return () => {
    featureFlagListeners.delete(listener);
  };
}

export function useFeatureFlag(flag: FeatureFlagKey): boolean {
  return useSyncExternalStore(
    subscribeFeatureFlags,
    () => getFeatureFlag(flag),
    () => DEFAULT_FLAGS[flag],
  );
}

export function useFeatureFlags(): FeatureFlags {
  return useSyncExternalStore(subscribeFeatureFlags, readFeatureFlagsSnapshot, () => DEFAULT_FLAGS);
}

export function useSidebarRuntimePolicy(): AgentSidebarRuntimePolicy {
  const flags = useFeatureFlags();
  const compatibilityRuntimeEnabled = flags.USE_AGENT_LOOP;

  if (flags.USE_AGENTIC_ENGINE) {
    return {
      canonicalRuntime: 'tpao',
      selectedRuntime: 'tpao',
      track: 'canonical',
      compatibilityRuntime: compatibilityRuntimeEnabled ? 'fast' : null,
      compatibilityRuntimeEnabled,
    };
  }

  return {
    canonicalRuntime: 'tpao',
    selectedRuntime: 'disabled',
    track: 'disabled',
    compatibilityRuntime: compatibilityRuntimeEnabled ? 'fast' : null,
    compatibilityRuntimeEnabled,
  };
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

/**
 * Check if Video Generation is enabled
 *
 * Convenience wrapper for the video generation feature flag.
 *
 * @returns true if AI video generation should be available
 */
export function isVideoGenerationEnabled(): boolean {
  return getFeatureFlag('USE_VIDEO_GENERATION');
}

/**
 * Check if the simplified Agent Loop compatibility runtime is enabled.
 *
 * When true, internal debug or harness-oriented entry points may use
 * AgentLoop (stream → tool → loop) for compatibility verification.
 *
 * @returns true if the compatibility runtime should be available
 */
export function isAgentLoopEnabled(): boolean {
  return getFeatureFlag('USE_AGENT_LOOP');
}

/**
 * Resolve the sidebar runtime policy from the current feature-flag matrix.
 *
 * TPAO remains the canonical interactive runtime. The fast AgentLoop runtime
 * may remain available for compatibility verification, but it does not replace
 * the shipping sidebar runtime.
 */
export function resolveSidebarRuntimePolicy(): AgentSidebarRuntimePolicy {
  const compatibilityRuntimeEnabled = isAgentLoopEnabled();
  const tpaoRuntimeEnabled = isAgenticEngineEnabled();

  if (tpaoRuntimeEnabled) {
    return {
      canonicalRuntime: 'tpao',
      selectedRuntime: 'tpao',
      track: 'canonical',
      compatibilityRuntime: compatibilityRuntimeEnabled ? 'fast' : null,
      compatibilityRuntimeEnabled,
    };
  }

  return {
    canonicalRuntime: 'tpao',
    selectedRuntime: 'disabled',
    track: 'disabled',
    compatibilityRuntime: compatibilityRuntimeEnabled ? 'fast' : null,
    compatibilityRuntimeEnabled,
  };
}

/**
 * Check if backend tool execution is enabled
 *
 * When true, editing tools are routed through the backend
 * execute_agent_plan IPC endpoint for atomic execution with rollback.
 * Analysis tools remain on the frontend.
 *
 * @returns true if backend tool execution should be used
 */
export function isBackendToolsEnabled(): boolean {
  return getFeatureFlag('USE_BACKEND_TOOLS');
}

/**
 * Check if meta-tools (consolidated 6-tool set) are enabled.
 * When true, registers 6 meta-tools instead of 56+ individual tools.
 */
export function isMetaToolsEnabled(): boolean {
  return getFeatureFlag('USE_META_TOOLS');
}

/**
 * Check if the vendor-neutral External Agent Host shell is enabled.
 *
 * This is intentionally separate from the canonical sidebar runtime policy.
 */
export function isExternalAgentHostEnabled(): boolean {
  return getFeatureFlag('USE_EXTERNAL_AGENT_HOST');
}

/**
 * Check if the Codex reference adapter is enabled for External Agent Host.
 */
export function isCodexAgentEnabled(): boolean {
  return isExternalAgentHostEnabled() && getFeatureFlag('USE_CODEX_AGENT');
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
