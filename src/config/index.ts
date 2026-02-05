/**
 * Configuration Module
 *
 * Exports all configuration-related utilities including
 * feature flags, environment settings, and constants.
 */

// Feature flags for gradual rollout
export {
  // Core functions
  getFeatureFlag,
  setFeatureFlag,
  resetFeatureFlags,
  getAllFeatureFlags,

  // Convenience functions
  isAgenticEngineEnabled,

  // Debug utilities
  debugFeatureFlags,

  // Constants
  FEATURE_FLAG_KEYS,
  FEATURE_FLAGS,

  // Types
  type FeatureFlags,
  type FeatureFlagKey,
} from './featureFlags';
