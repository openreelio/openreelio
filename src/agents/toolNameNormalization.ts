const SEMANTIC_TOOL_ALIASES: Record<string, string> = {
  add_clip: 'insert_clip',
  add_text: 'add_text_clip',
  add_title: 'add_text_clip',
  add_subtitle: 'add_caption',
  delete_subtitle: 'delete_caption',
  delete_text: 'delete_text_clip',
  get_timeline: 'get_timeline_info',
  import_subtitles_from_file: 'import_captions_from_file',
  place_clip: 'insert_clip',
  place_text: 'add_text_clip',
  remove_clip: 'delete_clip',
  remove_text: 'delete_text_clip',
  style_text: 'update_text_clip',
  style_subtitle: 'style_caption',
  timeline_info: 'get_timeline_info',
  update_text: 'update_text_clip',
  update_subtitle: 'update_caption',
};

export function normalizeToolNameCandidate(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return '';
  }

  return trimmed
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .replace(/__+/g, '_')
    .toLowerCase();
}

export function canonicalizeToolNameCandidate(name: string): string {
  const normalized = normalizeToolNameCandidate(name);
  return SEMANTIC_TOOL_ALIASES[normalized] ?? normalized;
}
