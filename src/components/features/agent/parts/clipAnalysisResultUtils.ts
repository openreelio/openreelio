const CLIP_ANALYSIS_TOOLS = new Set([
  'analyze_timeline_clip',
  'sample_clip_frames',
  'read_clip_analysis',
  'inspect_timeline_range',
  'map_timeline_to_source',
  'describe_clip_frames',
  'read_clip_perception',
  'describe_timeline_range',
  'search_clip_evidence',
  'plan_semantic_clip_edit',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function canRenderClipAnalysisResult(tool: string, data: unknown): boolean {
  if (!CLIP_ANALYSIS_TOOLS.has(tool) || !isRecord(data)) {
    return false;
  }

  return (
    'fingerprint' in data ||
    'samples' in data ||
    'mapping' in data ||
    'clips' in data ||
    'observations' in data ||
    'hits' in data ||
    'ranges' in data ||
    tool === 'map_timeline_to_source'
  );
}
