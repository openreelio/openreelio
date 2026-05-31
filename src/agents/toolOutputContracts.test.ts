import { describe, expect, it } from 'vitest';

import { getToolOutputContract } from './toolOutputContracts';

describe('toolOutputContracts', () => {
  it('allows nested metadata and coverage paths for read_source_analysis_report', () => {
    const contract = getToolOutputContract('read_source_analysis_report');

    expect(contract?.validatePath?.('data.metadata.durationSec')).toBe(true);
    expect(contract?.validatePath?.('data.coverage.annotation')).toBe(true);
    expect(contract?.validatePath?.('data.quality.status')).toBe(true);
    expect(contract?.validatePath?.('data.sectionCounts.highlights')).toBe(true);
    expect(contract?.validatePath?.('data.requestedFile')).toBe(true);
    expect(contract?.validatePath?.('data.warnings[0]')).toBe(true);
    expect(contract?.validatePath?.('data.errors.transcript')).toBe(true);
    expect(contract?.validatePath?.('data.persistenceError')).toBe(true);
  });

  it('allows nested metadata and error paths for generate_source_analysis_report', () => {
    const contract = getToolOutputContract('generate_source_analysis_report');

    expect(contract?.validatePath?.('data.metadata.codec')).toBe(true);
    expect(contract?.validatePath?.('data.coverage.visual')).toBe(true);
    expect(contract?.validatePath?.('data.errors.visual')).toBe(true);
    expect(contract?.validatePath?.('data.quality.score')).toBe(true);
    expect(contract?.validatePath?.('data.transcript.segments[0].text')).toBe(true);
    expect(contract?.validatePath?.('data.visual.items[0].cameraAngle')).toBe(true);
    expect(contract?.validatePath?.('data.visual.items[0].summary')).toBe(true);
    expect(contract?.validatePath?.('data.semantic.sceneTimeline[0].summary')).toBe(true);
    expect(contract?.validatePath?.('data.semantic.usefulMoments[0].kind')).toBe(true);
  });

  it('keeps visual detail paths scoped to generate_source_analysis_report', () => {
    const readContract = getToolOutputContract('read_source_analysis_report');
    const generateContract = getToolOutputContract('generate_source_analysis_report');

    expect(readContract?.validatePath?.('data.visual.items[0].cameraAngle')).toBe(false);
    expect(readContract?.validatePath?.('data.transcript.segments[0].text')).toBe(false);
    expect(readContract?.validatePath?.('data.semantic.sceneTimeline[0].summary')).toBe(false);
    expect(readContract?.validatePath?.('data.markdown')).toBe(false);
    expect(generateContract?.validatePath?.('data.markdown')).toBe(true);
    expect(generateContract?.validatePath?.('data.visual.items[0].cameraAngle')).toBe(true);
    expect(generateContract?.validatePath?.('data.semantic.sceneTimeline[0].summary')).toBe(true);
  });

  it('allows clip-local analysis paths for frame samples and mappings', () => {
    const contract = getToolOutputContract('analyze_timeline_clip');

    expect(contract?.validatePath?.('data.fingerprint')).toBe(true);
    expect(contract?.validatePath?.('data.quality.status')).toBe(true);
    expect(contract?.validatePath?.('data.mapping[0].sourceSec')).toBe(true);
    expect(contract?.validatePath?.('data.mapping[0].frameIndex')).toBe(true);
    expect(contract?.validatePath?.('data.samples[0].imagePath')).toBe(true);
    expect(contract?.validatePath?.('data.samples[0].signals.clipProgress')).toBe(true);
    expect(contract?.validatePath?.('data.bundle.samplePolicy.mode')).toBe(true);
    expect(contract?.validatePath?.('data.unknownField')).toBe(false);
  });

  it('allows timeline range inspection clip paths', () => {
    const contract = getToolOutputContract('inspect_timeline_range');

    expect(contract?.validatePath?.('data.count')).toBe(true);
    expect(contract?.validatePath?.('data.clips[0].fingerprint')).toBe(true);
    expect(contract?.validatePath?.('data.clips[0].samples[0].imagePath')).toBe(true);
  });

  it('allows semantic clip perception observation paths', () => {
    const contract = getToolOutputContract('describe_clip_frames');

    expect(contract?.validatePath?.('data.perceptionFingerprint')).toBe(true);
    expect(contract?.validatePath?.('data.quality.semanticCoverage')).toBe(true);
    expect(contract?.validatePath?.('data.observations[0].description')).toBe(true);
    expect(contract?.validatePath?.('data.observations[0].visibleText[0]')).toBe(true);
    expect(contract?.validatePath?.('data.observations[0].provider.model')).toBe(true);
    expect(contract?.validatePath?.('data.bundle.observations[0].description')).toBe(true);
    expect(contract?.validatePath?.('data.samples[0].imagePath')).toBe(false);
  });

  it('allows semantic timeline range and clip evidence search paths', () => {
    const rangeContract = getToolOutputContract('describe_timeline_range');
    const searchContract = getToolOutputContract('search_clip_evidence');

    expect(rangeContract?.validatePath?.('data.clips[0].perceptionFingerprint')).toBe(true);
    expect(rangeContract?.validatePath?.('data.clips[0].observations[0].description')).toBe(true);
    expect(searchContract?.validatePath?.('data.hits[0].description')).toBe(true);
    expect(searchContract?.validatePath?.('data.hits[0].matchedFields[0]')).toBe(true);
  });

  it('allows semantic temporal edit plan paths', () => {
    const contract = getToolOutputContract('plan_semantic_clip_edit');

    expect(contract?.validatePath?.('data.ranges[0].timelineStartSec')).toBe(true);
    expect(contract?.validatePath?.('data.ranges[0].evidence[0].description')).toBe(true);
    expect(contract?.validatePath?.('data.ranges[0].spatialTargets[0].boundingBox.left')).toBe(
      true,
    );
    expect(contract?.validatePath?.('data.ranges[0].spatialTargets[0].maskShape.type')).toBe(true);
    expect(contract?.validatePath?.('data.ranges[0].commandDrafts[0].commandType')).toBe(true);
    expect(contract?.validatePath?.('data.ranges[0].commandDrafts[0].payload.clipId')).toBe(true);
    expect(contract?.validatePath?.('data.ranges[0].warnings[0]')).toBe(true);
  });
});
