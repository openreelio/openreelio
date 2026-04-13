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
  });
});
