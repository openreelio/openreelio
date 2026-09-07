import { describe, expect, it } from 'vitest';

import type { AnalysisBundle, AudioProfile } from '@/bindings';

import { buildSourceAnalysisReportPayload } from './sourceReportData';
import { buildSourceAnalysisMarkdown } from './sourceReportMarkdown';

/**
 * Builds a bundle whose only interesting content is its audio profile.
 *
 * @param audioProfile - Profile to attach to the bundle.
 * @returns A bundle the report builder accepts.
 */
function bundleWithAudio(audioProfile: AudioProfile): AnalysisBundle {
  return {
    assetId: 'asset-1',
    shots: null,
    transcript: null,
    audioProfile,
    segments: null,
    frameAnalysis: null,
    metadata: { durationSec: 12, hasAudio: true },
    analyzedAt: '2026-03-07T00:00:00Z',
  };
}

/** A profile carrying regions and loudness numbers from a completed pass. */
const MEASURED_PROFILE: AudioProfile = {
  measurementVersion: 1,
  loudnessMeasured: true,
  bpm: 120,
  spectralCentroidHz: 1400,
  loudnessProfile: [-18.2, -16.8, -17.4],
  peakDb: -3.1,
  integratedLufs: -16.4,
  loudnessRangeLu: 5.2,
  truePeakDbtp: -1.9,
  silenceRegions: [{ startSec: 10, endSec: 11 }],
  speechRegions: [{ startSec: 0, endSec: 10 }],
};

describe('buildSourceAnalysisReportPayload', () => {
  it('should report the loudness numbers when the profile carries a current measurement', () => {
    const report = buildSourceAnalysisReportPayload({
      asset: null,
      bundle: bundleWithAudio(MEASURED_PROFILE),
      annotation: null,
      bundleSource: 'cached',
    });

    expect(report.coverage.loudness).toBe(true);
    expect(report.audio.hasLoudnessMeasurement).toBe(true);
    expect(report.audio.peakDb).toBe(-3.1);
    expect(report.audio.integratedLufs).toBe(-16.4);
    expect(report.audio.loudnessSampleCount).toBe(3);
    expect(buildSourceAnalysisMarkdown(report)).toContain('- Loudness measurement: available');
  });

  it('should null the loudness numbers when no pass measured them', () => {
    // This is the shape a cleared or never-run measurement leaves: the regions
    // survive, the levels do not. Reporting `peakDb` here would hand an agent
    // the silence floor as if it were a measured level.
    const report = buildSourceAnalysisReportPayload({
      asset: null,
      bundle: bundleWithAudio({
        ...MEASURED_PROFILE,
        loudnessMeasured: false,
        loudnessProfile: [],
        peakDb: -90,
        integratedLufs: null,
        loudnessRangeLu: null,
        truePeakDbtp: null,
      }),
      annotation: null,
      bundleSource: 'cached',
    });

    expect(report.coverage.audio).toBe(true);
    expect(report.coverage.loudness).toBe(false);
    expect(report.audio.hasLoudnessMeasurement).toBe(false);
    expect(report.audio.peakDb).toBeNull();
    expect(report.audio.integratedLufs).toBeNull();
    expect(report.audio.truePeakDbtp).toBeNull();
    expect(report.audio.loudnessRangeLu).toBeNull();
    expect(report.audio.loudnessSampleCount).toBe(0);
    // The regions came from other passes and are still reported.
    expect(report.audio.silenceRegionCount).toBe(1);
    expect(report.audio.speechRegionCount).toBe(1);
    expect(buildSourceAnalysisMarkdown(report)).toContain(
      '- Loudness measurement: missing (run `analysis audio`)',
    );
  });

  it('should treat a profile from a superseded measurement as unmeasured', () => {
    const report = buildSourceAnalysisReportPayload({
      asset: null,
      bundle: bundleWithAudio({ ...MEASURED_PROFILE, measurementVersion: 0 }),
      annotation: null,
      bundleSource: 'cached',
    });

    expect(report.coverage.loudness).toBe(false);
    expect(report.audio.peakDb).toBeNull();
  });
});
