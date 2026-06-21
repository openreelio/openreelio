/**
 * Transcription Model Gate Tests
 *
 * Verifies the pure decision logic that prevents the direct (non-agent)
 * transcription UI from silently running with a weak Whisper model when a more
 * accurate recommended model is available.
 */

import { describe, it, expect } from 'vitest';
import type { TranscriptionStatus } from './useTranscription';
import type { TranscriptionModelDto } from '@/bindings';
import {
  decideTranscriptionGate,
  isWeakTranscriptionModel,
  resolveEffectiveModel,
  resolveRecommendedModel,
} from './transcriptionModelGate';

// =============================================================================
// Test Data
// =============================================================================

function makeModel(overrides: Partial<TranscriptionModelDto> & { id: string }): TranscriptionModelDto {
  return {
    id: overrides.id,
    displayName: overrides.displayName ?? overrides.id,
    filename: overrides.filename ?? `ggml-${overrides.id}.bin`,
    installed: overrides.installed ?? false,
    path: overrides.path ?? `/models/ggml-${overrides.id}.bin`,
    sizeBytes: overrides.sizeBytes ?? null,
    isDefault: overrides.isDefault ?? false,
    recommended: overrides.recommended ?? false,
    downloadUrl: overrides.downloadUrl ?? 'https://example.com/model.bin',
    estimatedSizeBytes: overrides.estimatedSizeBytes ?? 0,
    source: overrides.source ?? 'ggerganov/whisper.cpp',
    license: overrides.license ?? 'MIT',
  };
}

function makeStatus(overrides: Partial<TranscriptionStatus>): TranscriptionStatus {
  return {
    featureAvailable: overrides.featureAvailable ?? true,
    ready: overrides.ready ?? true,
    modelsDir: overrides.modelsDir ?? '/models',
    defaultModel: overrides.defaultModel ?? 'small',
    installedCount: overrides.installedCount ?? 0,
    models: overrides.models ?? [],
  };
}

const RECOMMENDED_ID = 'large-v3-turbo-q5_0';

// =============================================================================
// Tests
// =============================================================================

describe('transcriptionModelGate', () => {
  describe('isWeakTranscriptionModel', () => {
    it('should return true for tiny, base, and small', () => {
      expect(isWeakTranscriptionModel('tiny')).toBe(true);
      expect(isWeakTranscriptionModel('base')).toBe(true);
      expect(isWeakTranscriptionModel('small')).toBe(true);
    });

    it('should return false for non-weak and missing models', () => {
      expect(isWeakTranscriptionModel('large-v3')).toBe(false);
      expect(isWeakTranscriptionModel(RECOMMENDED_ID)).toBe(false);
      expect(isWeakTranscriptionModel(undefined)).toBe(false);
      expect(isWeakTranscriptionModel(null)).toBe(false);
    });
  });

  describe('resolveEffectiveModel', () => {
    it('should use the selected model when a concrete one is chosen', () => {
      const status = makeStatus({ defaultModel: 'small' });
      expect(resolveEffectiveModel('large-v3', status)).toBe('large-v3');
    });

    it('should fall back to defaultModel when selection is unset or auto', () => {
      const status = makeStatus({ defaultModel: 'small' });
      expect(resolveEffectiveModel(undefined, status)).toBe('small');
      expect(resolveEffectiveModel('auto', status)).toBe('small');
    });
  });

  describe('resolveRecommendedModel', () => {
    it('should prefer the turbo q5_0 model when present', () => {
      const status = makeStatus({
        models: [
          makeModel({ id: 'large-v3', recommended: true, installed: false }),
          makeModel({ id: RECOMMENDED_ID, recommended: true, installed: false }),
        ],
      });
      expect(resolveRecommendedModel(status)).toEqual({ id: RECOMMENDED_ID, installed: false });
    });

    it('should fall back to a non-weak recommended model', () => {
      const status = makeStatus({
        models: [
          makeModel({ id: 'small', recommended: true, installed: true }),
          makeModel({ id: 'large-v3', recommended: true, installed: true }),
        ],
      });
      expect(resolveRecommendedModel(status)).toEqual({ id: 'large-v3', installed: true });
    });

    it('should return null when no non-weak recommended model exists', () => {
      const status = makeStatus({
        models: [makeModel({ id: 'small', recommended: true, installed: true })],
      });
      expect(resolveRecommendedModel(status)).toBeNull();
    });
  });

  describe('decideTranscriptionGate', () => {
    it('should offer install when weak selected and recommended is not installed', () => {
      const status = makeStatus({
        defaultModel: 'small',
        models: [
          makeModel({ id: 'small', installed: true }),
          makeModel({ id: RECOMMENDED_ID, recommended: true, installed: false }),
        ],
      });

      const decision = decideTranscriptionGate('small', status);

      expect(decision).toEqual({
        kind: 'offer-install',
        weakModel: 'small',
        recommendedModel: RECOMMENDED_ID,
      });
    });

    it('should offer install when model is auto and the default is weak', () => {
      const status = makeStatus({
        defaultModel: 'small',
        models: [
          makeModel({ id: 'small', installed: true }),
          makeModel({ id: RECOMMENDED_ID, recommended: true, installed: false }),
        ],
      });

      const decision = decideTranscriptionGate(undefined, status);

      expect(decision).toEqual({
        kind: 'offer-install',
        weakModel: 'small',
        recommendedModel: RECOMMENDED_ID,
      });
    });

    it('should use the recommended model when it is already installed', () => {
      const status = makeStatus({
        defaultModel: 'small',
        models: [
          makeModel({ id: 'small', installed: true }),
          makeModel({ id: RECOMMENDED_ID, recommended: true, installed: true }),
        ],
      });

      const decision = decideTranscriptionGate('small', status);

      expect(decision).toEqual({ kind: 'use-recommended', model: RECOMMENDED_ID });
    });

    it('should proceed unchanged when a non-weak model is selected', () => {
      const status = makeStatus({
        defaultModel: 'small',
        models: [
          makeModel({ id: 'large-v3', installed: true }),
          makeModel({ id: RECOMMENDED_ID, recommended: true, installed: false }),
        ],
      });

      const decision = decideTranscriptionGate('large-v3', status);

      expect(decision).toEqual({ kind: 'proceed', model: 'large-v3' });
    });

    it('should proceed with the weak model when no better model exists', () => {
      const status = makeStatus({
        defaultModel: 'small',
        models: [makeModel({ id: 'small', installed: true })],
      });

      const decision = decideTranscriptionGate('small', status);

      expect(decision).toEqual({ kind: 'proceed', model: 'small' });
    });
  });
});
