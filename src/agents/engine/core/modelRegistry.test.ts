import { describe, it, expect } from 'vitest';
import {
  getModelLimits,
  resolveMaxOutputTokens,
  resolveContextLimit,
} from './modelRegistry';

describe('modelRegistry', () => {
  describe('getModelLimits', () => {
    it('should return exact match for known model', () => {
      const limits = getModelLimits('claude-sonnet-4-5-20251015', 'anthropic');
      expect(limits.contextWindow).toBe(200_000);
      expect(limits.maxOutputTokens).toBe(16_000);
    });

    it('should return exact match for OpenAI model', () => {
      const limits = getModelLimits('gpt-4o', 'openai');
      expect(limits.contextWindow).toBe(128_000);
      expect(limits.maxOutputTokens).toBe(16_384);
    });

    it('should return exact match for Gemini model', () => {
      const limits = getModelLimits('gemini-2.0-flash', 'gemini');
      expect(limits.contextWindow).toBe(1_048_576);
      expect(limits.maxOutputTokens).toBe(8_192);
    });

    it('should use prefix match for versioned model strings', () => {
      // "gpt-4o-2024-11-20" is an exact match, but "gpt-4o-2025-01-01" should prefix-match "gpt-4o"
      const limits = getModelLimits('gpt-4o-2025-01-01', 'openai');
      expect(limits.maxOutputTokens).toBe(16_384);
    });

    it('should prefer longer prefix match', () => {
      // "gpt-4o-mini" is exact, "gpt-4o-mini-2025-something" should match "gpt-4o-mini" not "gpt-4o"
      const limits = getModelLimits('gpt-4o-mini-2025-something', 'openai');
      expect(limits.maxOutputTokens).toBe(16_384);
    });

    it('should fall back to provider defaults for unknown model', () => {
      const limits = getModelLimits('unknown-future-model', 'anthropic');
      expect(limits.contextWindow).toBe(200_000);
      expect(limits.maxOutputTokens).toBe(8_192);
    });

    it('should fall back to local provider defaults', () => {
      const limits = getModelLimits('llama-3-8b', 'local');
      expect(limits.contextWindow).toBe(32_000);
      expect(limits.maxOutputTokens).toBe(4_096);
    });

    it('should use universal fallback when both model and provider are unknown', () => {
      const limits = getModelLimits('totally-unknown', 'unknown-provider');
      expect(limits.contextWindow).toBe(128_000);
      expect(limits.maxOutputTokens).toBe(4_096);
    });

    it('should use universal fallback when model and provider are null', () => {
      const limits = getModelLimits(null, null);
      expect(limits.contextWindow).toBe(128_000);
      expect(limits.maxOutputTokens).toBe(4_096);
    });

    it('should use universal fallback when model and provider are undefined', () => {
      const limits = getModelLimits(undefined, undefined);
      expect(limits.contextWindow).toBe(128_000);
      expect(limits.maxOutputTokens).toBe(4_096);
    });

    it('should use provider fallback when model is empty string', () => {
      const limits = getModelLimits('', 'openai');
      expect(limits.contextWindow).toBe(128_000);
      expect(limits.maxOutputTokens).toBe(16_384);
    });
  });

  describe('resolveMaxOutputTokens', () => {
    it('should return min(userSetting, modelLimit) when user sets a lower value', () => {
      // Claude Sonnet 4.5 has maxOutputTokens=16000
      const result = resolveMaxOutputTokens(8000, 'claude-sonnet-4-5-20251015', 'anthropic');
      expect(result).toBe(8000);
    });

    it('should cap at model limit when user sets a higher value', () => {
      // Claude Sonnet 4.5 has maxOutputTokens=16000, user wants 32000
      const result = resolveMaxOutputTokens(32000, 'claude-sonnet-4-5-20251015', 'anthropic');
      expect(result).toBe(16_000);
    });

    it('should return model limit when userSetting is undefined', () => {
      const result = resolveMaxOutputTokens(undefined, 'gpt-4o', 'openai');
      expect(result).toBe(16_384);
    });

    it('should return model limit when userSetting is null', () => {
      const result = resolveMaxOutputTokens(null, 'gpt-4o', 'openai');
      expect(result).toBe(16_384);
    });

    it('should return model limit when userSetting is 0', () => {
      const result = resolveMaxOutputTokens(0, 'gpt-4o', 'openai');
      expect(result).toBe(16_384);
    });

    it('should use provider fallback for unknown model', () => {
      const result = resolveMaxOutputTokens(4096, 'unknown-model', 'anthropic');
      // anthropic fallback maxOutputTokens=8192, user wants 4096
      expect(result).toBe(4096);
    });

    it('should use universal fallback when all params are undefined', () => {
      const result = resolveMaxOutputTokens(undefined, undefined, undefined);
      // universal fallback maxOutputTokens=4096
      expect(result).toBe(4_096);
    });
  });

  describe('resolveContextLimit', () => {
    it('should return model context window for known model', () => {
      expect(resolveContextLimit('claude-opus-4-6', 'anthropic')).toBe(200_000);
    });

    it('should return provider fallback for unknown model', () => {
      expect(resolveContextLimit('unknown', 'gemini')).toBe(1_048_576);
    });

    it('should return universal fallback for unknown everything', () => {
      expect(resolveContextLimit(undefined, undefined)).toBe(128_000);
    });
  });
});
