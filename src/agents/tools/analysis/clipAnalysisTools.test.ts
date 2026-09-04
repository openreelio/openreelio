/**
 * Clip Analysis Tools Tests
 *
 * Covers how caller arguments are normalised into the perception options the
 * backend receives. The Tauri IPC boundary is the only thing mocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { CLIP_ANALYSIS_TOOLS } from './clipAnalysisTools';
import type { ClipPerceptionOptions, ClipPerceptionResponse } from '@/bindings';

const describeClipFrames = CLIP_ANALYSIS_TOOLS.find((tool) => tool.name === 'describe_clip_frames');

function perceptionResponse(): ClipPerceptionResponse {
  return {
    source: 'generated',
    bundle: {
      schemaVersion: 1,
      perceptionFingerprint: 'perception_test',
      clipFingerprint: 'clip_test',
      sequenceId: 'seq_001',
      trackId: 'V1',
      clipId: 'clip_1',
      assetId: 'asset_1',
      source: 'generated',
      provider: null,
      model: null,
      promptVersion: 1,
      options: {
        detail: 'low',
        reuseSourceAnalysis: true,
        allowCloud: false,
        forceRefresh: false,
        includeContactSheet: false,
      },
      observations: [],
      quality: {
        status: 'ready',
        semanticCoverage: 'semantic',
        matchedObservationCount: 0,
        providerObservationCount: 0,
        fallbackObservationCount: 0,
        missingSampleIds: [],
        recommendedActions: [],
      },
      errors: [],
      createdAt: '2026-09-05T00:00:00Z',
    },
  } as unknown as ClipPerceptionResponse;
}

/** Runs the tool against a cached bundle and returns the options it sent. */
async function sentPerceptionOptions(
  args: Record<string, unknown>,
): Promise<ClipPerceptionOptions> {
  if (!describeClipFrames) {
    throw new Error('describe_clip_frames tool is not registered');
  }

  const result = await describeClipFrames.handler({ fingerprint: 'clip_test', ...args }, {});
  expect(result.success).toBe(true);

  const call = vi.mocked(invoke).mock.calls.at(-1);
  expect(call?.[0]).toBe('enrich_clip_perception');
  return (call?.[1] as { options: ClipPerceptionOptions }).options;
}

describe('describe_clip_frames', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(perceptionResponse());
  });

  it('should ask the backend for a contact sheet when includeContactSheet is set', async () => {
    await expect(sentPerceptionOptions({ includeContactSheet: true })).resolves.toMatchObject({
      includeContactSheet: true,
    });
  });

  it('should accept includeContactSheet nested under options', async () => {
    await expect(
      sentPerceptionOptions({ options: { includeContactSheet: true } }),
    ).resolves.toMatchObject({ includeContactSheet: true });
  });

  it('should not ask for a contact sheet when the caller says nothing', async () => {
    await expect(sentPerceptionOptions({})).resolves.toMatchObject({
      includeContactSheet: false,
    });
  });
});
