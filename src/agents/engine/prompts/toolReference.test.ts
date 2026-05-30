import { describe, expect, it } from 'vitest';

import { buildToolReference } from './toolReference';

describe('toolReference', () => {
  it('documents the clip-local precision inspection workflow for editors', () => {
    const reference = buildToolReference('editor');

    expect(reference).toContain('analyze_timeline_clip');
    expect(reference).toContain('sample_clip_frames');
    expect(reference).toContain('map_timeline_to_source');
    expect(reference).toContain('inspect_timeline_range');
    expect(reference).toContain('describe_clip_frames');
    expect(reference).toContain('read_clip_perception');
    expect(reference).toContain('search_clip_evidence');
    expect(reference).toContain('plan_semantic_clip_edit');
    expect(reference).toContain('Precise timeline clip editing');
    expect(reference).toContain('data.observations[n].description');
    expect(reference).toContain('data.ranges[n].spatialTargets');
    expect(reference).toContain('AddMask maps to add_mask');
    expect(reference).toContain('data.ranges[n].warnings');
    expect(reference).toContain('read_source_analysis_report/search_source_analysis_report');
  });
});
