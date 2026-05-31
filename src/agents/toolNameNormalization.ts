const SEMANTIC_TOOL_ALIASES: Record<string, string> = {
  add_clip: 'insert_clip',
  add_lower_third: 'add_text_clip',
  add_lowerthird: 'add_text_clip',
  add_text: 'add_text_clip',
  add_text_overlay: 'add_text_clip',
  add_title: 'add_text_clip',
  add_subtitle: 'add_caption',
  auto_caption: 'auto_transcribe',
  auto_captions: 'auto_transcribe',
  auto_subtitle: 'auto_transcribe',
  auto_subtitles: 'auto_transcribe',
  batch_add_captions: 'add_captions_from_transcription',
  batch_add_subtitles: 'add_captions_from_transcription',
  caption_style: 'style_caption',
  change_text: 'update_text_clip',
  create_caption: 'add_caption',
  create_lower_third: 'add_text_clip',
  create_lowerthird: 'add_text_clip',
  create_subtitle: 'add_caption',
  create_text: 'add_text_clip',
  create_text_clip: 'add_text_clip',
  create_text_overlay: 'add_text_clip',
  create_title: 'add_text_clip',
  delete_subtitle: 'delete_caption',
  delete_text: 'delete_text_clip',
  delete_title: 'delete_text_clip',
  edit_text: 'update_text_clip',
  generate_caption: 'auto_transcribe',
  generate_captions: 'auto_transcribe',
  generate_subtitle: 'auto_transcribe',
  generate_subtitles: 'auto_transcribe',
  generate_timeline_captions: 'auto_transcribe_sequence',
  generate_timeline_subtitles: 'auto_transcribe_sequence',
  get_timeline: 'get_timeline_info',
  import_subtitle_file: 'import_captions_from_file',
  import_subtitles: 'import_captions_from_file',
  import_subtitles_from_file: 'import_captions_from_file',
  modify_text: 'update_text_clip',
  move_text: 'set_text_transform',
  move_title: 'set_text_transform',
  place_clip: 'insert_clip',
  place_text: 'add_text_clip',
  place_title: 'add_text_clip',
  remove_title: 'delete_text_clip',
  remove_clip: 'delete_clip',
  remove_text: 'delete_text_clip',
  reposition_text: 'set_text_transform',
  resize_text: 'set_text_transform',
  rotate_text: 'set_text_transform',
  style_text: 'update_text_clip',
  style_subtitle: 'style_caption',
  timeline_info: 'get_timeline_info',
  transcribe_captions: 'auto_transcribe',
  transcribe_subtitles: 'auto_transcribe',
  transcribe_timeline: 'auto_transcribe_sequence',
  transcribe_timeline_captions: 'auto_transcribe_sequence',
  transcribe_timeline_subtitles: 'auto_transcribe_sequence',
  transform_text: 'set_text_transform',
  update_text: 'update_text_clip',
  update_title: 'update_text_clip',
  update_subtitle: 'update_caption',
};

export function getSemanticToolAliasesForTargets(targets: readonly string[]): string[] {
  const targetSet = new Set(targets);
  return Object.entries(SEMANTIC_TOOL_ALIASES)
    .filter(([, target]) => targetSet.has(target))
    .map(([alias]) => alias);
}

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
