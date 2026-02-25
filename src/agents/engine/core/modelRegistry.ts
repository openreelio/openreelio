/**
 * Model Metadata Registry
 *
 * Provides model-aware token budget resolution so that output limits
 * flow from model capabilities + user settings, not hardcoded constants.
 *
 * Resolution order: exact match → prefix match → provider fallback → universal fallback.
 */

// =============================================================================
// Types
// =============================================================================

export interface ModelTokenLimits {
  /** Total context window size in tokens */
  contextWindow: number;
  /** Maximum output tokens the model supports */
  maxOutputTokens: number;
}

// =============================================================================
// Registry Data
// =============================================================================

/**
 * Known model limits. Updated as new models are released.
 * Source: official documentation for each provider.
 */
const MODEL_REGISTRY: Record<string, ModelTokenLimits> = {
  // Anthropic — Claude 4 / 4.5 / 4.6 family
  'claude-opus-4-6': { contextWindow: 200_000, maxOutputTokens: 32_000 },
  'claude-sonnet-4-6': { contextWindow: 200_000, maxOutputTokens: 16_000 },
  'claude-sonnet-4-5-20251015': { contextWindow: 200_000, maxOutputTokens: 16_000 },
  'claude-haiku-4-5-20251001': { contextWindow: 200_000, maxOutputTokens: 8_192 },
  // Anthropic — Claude 3.5 family
  'claude-3-5-sonnet-20241022': { contextWindow: 200_000, maxOutputTokens: 8_192 },
  'claude-3-5-haiku-20241022': { contextWindow: 200_000, maxOutputTokens: 8_192 },
  // Anthropic — Claude 3 family
  'claude-3-opus-20240229': { contextWindow: 200_000, maxOutputTokens: 4_096 },
  'claude-3-sonnet-20240229': { contextWindow: 200_000, maxOutputTokens: 4_096 },
  'claude-3-haiku-20240307': { contextWindow: 200_000, maxOutputTokens: 4_096 },

  // OpenAI — GPT-4o family
  'gpt-4o': { contextWindow: 128_000, maxOutputTokens: 16_384 },
  'gpt-4o-mini': { contextWindow: 128_000, maxOutputTokens: 16_384 },
  'gpt-4o-2024-11-20': { contextWindow: 128_000, maxOutputTokens: 16_384 },
  // OpenAI — o-series reasoning
  'o1': { contextWindow: 200_000, maxOutputTokens: 100_000 },
  'o1-mini': { contextWindow: 128_000, maxOutputTokens: 65_536 },
  'o3-mini': { contextWindow: 200_000, maxOutputTokens: 100_000 },
  // OpenAI — GPT-4 Turbo
  'gpt-4-turbo': { contextWindow: 128_000, maxOutputTokens: 4_096 },
  'gpt-4-turbo-preview': { contextWindow: 128_000, maxOutputTokens: 4_096 },

  // Google — Gemini
  'gemini-2.0-flash': { contextWindow: 1_048_576, maxOutputTokens: 8_192 },
  'gemini-2.0-pro': { contextWindow: 1_048_576, maxOutputTokens: 8_192 },
  'gemini-1.5-pro': { contextWindow: 2_097_152, maxOutputTokens: 8_192 },
  'gemini-1.5-flash': { contextWindow: 1_048_576, maxOutputTokens: 8_192 },
};

/**
 * Fallback limits by provider when the exact model is unknown.
 */
const PROVIDER_DEFAULTS: Record<string, ModelTokenLimits> = {
  anthropic: { contextWindow: 200_000, maxOutputTokens: 8_192 },
  openai: { contextWindow: 128_000, maxOutputTokens: 16_384 },
  gemini: { contextWindow: 1_048_576, maxOutputTokens: 8_192 },
  local: { contextWindow: 32_000, maxOutputTokens: 4_096 },
};

/** Universal fallback when both model and provider are unknown */
const UNIVERSAL_FALLBACK: ModelTokenLimits = {
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
};

// =============================================================================
// Resolution Functions
// =============================================================================

/**
 * Get token limits for a model.
 *
 * Resolution order:
 * 1. Exact match in MODEL_REGISTRY
 * 2. Prefix match (e.g. "claude-sonnet-4-5-20251015" matches "claude-sonnet-4-5-*")
 * 3. Provider fallback from PROVIDER_DEFAULTS
 * 4. Universal fallback
 */
export function getModelLimits(
  model?: string | null,
  provider?: string | null,
): ModelTokenLimits {
  if (model) {
    // 1. Exact match
    const exact = MODEL_REGISTRY[model];
    if (exact) return exact;

    // 2. Prefix match — find the longest matching key
    let bestMatch: ModelTokenLimits | null = null;
    let bestLength = 0;

    for (const [key, limits] of Object.entries(MODEL_REGISTRY)) {
      if (model.startsWith(key) && key.length > bestLength) {
        bestMatch = limits;
        bestLength = key.length;
      }
    }

    if (bestMatch) return bestMatch;
  }

  // 3. Provider fallback
  if (provider) {
    const providerLimits = PROVIDER_DEFAULTS[provider];
    if (providerLimits) return providerLimits;
  }

  // 4. Universal fallback
  return UNIVERSAL_FALLBACK;
}

/**
 * Resolve the effective maxOutputTokens for an LLM call.
 *
 * Returns `min(userSetting, modelLimit)`, or just `modelLimit` if no user setting.
 * Returns `undefined` if neither is available (let the backend decide).
 */
export function resolveMaxOutputTokens(
  userSetting?: number | null,
  model?: string | null,
  provider?: string | null,
): number | undefined {
  const limits = getModelLimits(model, provider);
  const modelMax = limits.maxOutputTokens;

  if (userSetting != null && userSetting > 0) {
    return Math.min(userSetting, modelMax);
  }

  return modelMax;
}

/**
 * Resolve the context window limit for a model.
 */
export function resolveContextLimit(
  model?: string | null,
  provider?: string | null,
): number {
  return getModelLimits(model, provider).contextWindow;
}
