import { describe, expect, it } from 'vitest';

import { getToolOutputContract } from './toolOutputContracts';

describe('toolOutputContracts', () => {
  it('allows nested metadata and coverage paths for read_source_analysis_report', () => {
    const contract = getToolOutputContract('read_source_analysis_report');

    expect(contract?.validatePath?.('data.metadata.durationSec')).toBe(true);
    expect(contract?.validatePath?.('data.coverage.annotation')).toBe(true);
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
    expect(contract?.validatePath?.('data.visual.items[0].cameraAngle')).toBe(true);
    expect(contract?.validatePath?.('data.visual.items[0].summary')).toBe(true);
    expect(contract?.validatePath?.('data.semantic.sceneTimeline[0].summary')).toBe(true);
    expect(contract?.validatePath?.('data.semantic.usefulMoments[0].kind')).toBe(true);
  });

  it('keeps visual detail paths scoped to generate_source_analysis_report', () => {
    const readContract = getToolOutputContract('read_source_analysis_report');
    const generateContract = getToolOutputContract('generate_source_analysis_report');

    expect(readContract?.validatePath?.('data.visual.items[0].cameraAngle')).toBe(false);
    expect(readContract?.validatePath?.('data.semantic.sceneTimeline[0].summary')).toBe(false);
    expect(readContract?.validatePath?.('data.markdown')).toBe(false);
    expect(generateContract?.validatePath?.('data.markdown')).toBe(true);
    expect(generateContract?.validatePath?.('data.visual.items[0].cameraAngle')).toBe(true);
    expect(generateContract?.validatePath?.('data.semantic.sceneTimeline[0].summary')).toBe(true);
  });
});
