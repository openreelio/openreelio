/**
 * Transcription Model Gate
 *
 * Pure decision logic that prevents the direct (non-agent) transcription UI from
 * silently running with a weak Whisper model (tiny/base/small) when a far more
 * accurate recommended model is available but not yet installed.
 *
 * The backend resolves an unspecified model via `default_for_dir` = best INSTALLED
 * model, so with only a weak model installed it would silently transcribe with that
 * weak model (which produces garbage on sung or non-English audio). This module
 * derives the recommended model from the status `models` list and decides whether
 * the caller must offer the user an install-recommended-first choice.
 */

import type { TranscriptionStatus } from './useTranscription';

/** Whisper models considered too weak for accurate subtitles. */
export const WEAK_TRANSCRIPTION_MODELS: readonly string[] = ['tiny', 'base', 'small'];

/**
 * Preferred recommended model ID. The backend marks one or more models as
 * `recommended`; when present we prefer this high-accuracy turbo model.
 */
export const PREFERRED_RECOMMENDED_MODEL = 'large-v3-turbo-q5_0';

/** Whether the given model ID is one of the weak models. */
export function isWeakTranscriptionModel(modelId: string | null | undefined): boolean {
  if (!modelId) {
    return false;
  }
  return WEAK_TRANSCRIPTION_MODELS.includes(modelId);
}

/**
 * Resolve the recommended (high-accuracy) model from a transcription status.
 *
 * Preference order:
 * 1. The {@link PREFERRED_RECOMMENDED_MODEL} if the backend lists it.
 * 2. The first non-weak model flagged `recommended`.
 * 3. The first non-weak model flagged `recommended` even if not listed above.
 *
 * Returns `null` when no suitable recommended model exists in the inventory.
 */
export function resolveRecommendedModel(status: TranscriptionStatus): {
  id: string;
  installed: boolean;
} | null {
  const preferred = status.models.find((model) => model.id === PREFERRED_RECOMMENDED_MODEL);
  if (preferred) {
    return { id: preferred.id, installed: preferred.installed };
  }

  const recommendedNonWeak = status.models.find(
    (model) => model.recommended && !isWeakTranscriptionModel(model.id),
  );
  if (recommendedNonWeak) {
    return { id: recommendedNonWeak.id, installed: recommendedNonWeak.installed };
  }

  return null;
}

/**
 * The model that WILL actually be used given the user's selection and status.
 *
 * - When the dialog selected a concrete model, that is the effective model.
 * - When the selection is unset or `'auto'`, the backend uses `status.defaultModel`.
 */
export function resolveEffectiveModel(
  selectedModel: string | null | undefined,
  status: TranscriptionStatus,
): string {
  if (selectedModel && selectedModel !== 'auto') {
    return selectedModel;
  }
  return status.defaultModel;
}

/** Possible outcomes of the transcription model gate. */
export type TranscriptionGateDecision =
  | {
      /** Proceed with the effective model as-is (already non-weak, or no better option). */
      kind: 'proceed';
      model: string;
    }
  | {
      /** Recommended model is installed; transcribe with it instead of the weak default. */
      kind: 'use-recommended';
      model: string;
    }
  | {
      /** Weak effective model + recommended not installed; offer install-or-confirm. */
      kind: 'offer-install';
      /** The weak model that would otherwise be used. */
      weakModel: string;
      /** The recommended model to install and then use. */
      recommendedModel: string;
    };

/**
 * Decide what to do before invoking transcription via the direct UI path.
 *
 * @param selectedModel - The model the dialog selected, or `undefined`/`'auto'`.
 * @param status - The transcription status read immediately before invoking.
 */
export function decideTranscriptionGate(
  selectedModel: string | null | undefined,
  status: TranscriptionStatus,
): TranscriptionGateDecision {
  const effectiveModel = resolveEffectiveModel(selectedModel, status);

  // A non-weak effective model is fine — never interfere.
  if (!isWeakTranscriptionModel(effectiveModel)) {
    return { kind: 'proceed', model: effectiveModel };
  }

  const recommended = resolveRecommendedModel(status);
  if (!recommended) {
    // No better model exists in the inventory; nothing we can do but proceed.
    return { kind: 'proceed', model: effectiveModel };
  }

  if (recommended.installed) {
    // A better model is already installed — silently upgrade to it.
    return { kind: 'use-recommended', model: recommended.id };
  }

  // Weak model would be used and a better one is available but not installed.
  return {
    kind: 'offer-install',
    weakModel: effectiveModel,
    recommendedModel: recommended.id,
  };
}
