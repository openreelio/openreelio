/**
 * Compact Tool Reference for Agent System Prompts
 *
 * Provides action-level documentation, workflow recipes, and CLI reference
 * that the LLM needs to correctly select and invoke tools. Designed to be
 * injected into the system prompt alongside meta-tool schemas.
 *
 * Sections are composed per agent role to avoid injecting irrelevant tools
 * (e.g., analyst agents don't receive editing tool docs).
 *
 * Token budget: ~700 tokens full, ~200-300 for specialized roles.
 */

// =============================================================================
// Role type (duplicated from system.ts to avoid circular dependency)
// =============================================================================

type ToolReferenceRole = 'editor' | 'analyst' | 'colorist' | 'audio';

// =============================================================================
// Sections
// =============================================================================

const QUERY_ACTIONS = `## Query Actions (meta-tool: query)
- get_timeline_info → timeline duration, track/clip counts, playhead position
- list_all_clips → all clips across all tracks with positions
- list_tracks → all tracks with type, clip count, lock/mute status
- get_clip_info(clipId) → detailed clip: position, duration, speed, effects, source range
- get_track_clips(trackId) → all clips on one track
- get_clips_at_time(time) → clips spanning a specific time point
- get_selected_clips → currently selected clips (full detail)
- get_playhead_position → current playhead seconds + total duration
- find_clips_by_asset(assetId) → clips using a specific asset
- find_gaps(trackId?, minDuration?) → empty spaces between clips
- find_overlaps(trackId?) → overlapping clips on same track
- get_asset_catalog → all assets with timeline usage status
- get_unused_assets(kind?) → assets not placed on timeline
- get_asset_info(assetId) → asset metadata (codec, resolution, duration)
- get_workspace_files(kind?) → media files in project folder
- find_workspace_file(query) → find file by name/path substring
- get_unregistered_files(kind?) → workspace files not yet imported as assets
- analyze_asset(assetId) → run backend analysis (shots/transcript/objects/faces/textOcr)
- analyze_workspace_video(file) → find file + analyze in one step
- get_analysis_status(assetId) → analysis progress check
- get_asset_annotation(assetId) → stored analysis results
- get_analysis_cost_estimate(assetId) → cost estimate for cloud analysis
- get_analysis_providers → available analysis backends`;

const EDIT_ACTIONS = `## Edit Actions (meta-tool: edit, all require sequenceId)
- insert_clip(trackId, assetId, timelineStart) → place asset on timeline
- insert_clip_from_file(file, trackId, timelineStart) → insert by filename (auto-imports)
- move_clip(trackId, clipId, newTimelineIn, newTrackId?) → reposition or cross-track move
- trim_clip(trackId, clipId, newSourceIn?, newSourceOut?) → adjust source boundaries
- split_clip(trackId, clipId, splitTime) → divide into two clips at time point
- delete_clip(trackId, clipId) → remove clip from timeline
- delete_clips_in_range(startTime, endTime, trackId?) → bulk remove by time range
- change_clip_speed(trackId, clipId, speed) → speed 0.1–10.0, duration auto-adjusts
- freeze_frame(trackId, clipId, frameTime, duration?) → still image at time (default 2s)
- ripple_edit(trackId, clipId, trimEnd) → trim clip end + shift all subsequent clips to close gap
- roll_edit(trackId, leftClipId, rightClipId, rollAmount) → move cut point between two adjacent clips (one extends, other shortens)
- slip_edit(trackId, clipId, offsetSeconds) → shift source window without moving clip on timeline
- slide_edit(trackId, clipId, slideAmount) → move clip on timeline, neighbors auto-adjust
- add_track(kind, name) → create video or audio track
- remove_track(trackId) → delete empty track (fails if clips exist)
- rename_track(trackId, name) → change track display name
- add_marker(time, label, color?) → timeline marker at position
- remove_marker(markerId) → delete marker
- list_markers(fromTime?, toTime?) → list markers in range
- navigate_to_marker(time) → move playhead to time`;

const AUDIO_ACTIONS = `## Audio Actions (meta-tool: audio, require sequenceId + trackId)
- adjust_volume(clipId?, volume) → set volume 0–200% (omit clipId for whole track)
- add_fade_in(clipId, duration) → fade-in at clip start
- add_fade_out(clipId, duration) → fade-out at clip end
- mute_clip(clipId, muted) → mute/unmute single clip
- mute_track(muted) → mute/unmute entire track
- normalize_audio(clipId, targetLevel?) → normalize to dB target (default -3dB)`;

const EFFECTS_ACTIONS = `## Effects Actions (meta-tool: effects)
- add_effect(clipId, effectType, parameters?) → apply blur/brightness/contrast/saturation
- remove_effect(clipId, effectId) → remove one effect
- adjust_effect_param(clipId, effectId, paramName, paramValue) → tune effect parameter
- copy_effects(sourceClipId, targetClipId) → copy all effects between clips
- reset_effects(clipId) → remove all effects from clip
- add_transition(clipId, transitionType, duration) → dissolve/wipe/slide/zoom/fade
- remove_transition(transitionId) → remove transition
- set_transition_duration(transitionId, duration) → change transition length`;

const TEXT_ACTIONS = `## Text Actions (meta-tool: text, require sequenceId)
- add_caption(text, startTime, endTime) → add subtitle (track auto-created if needed)
- update_caption(captionId, text?, startTime?, endTime?) → edit caption
- delete_caption(captionId) → remove caption
- style_caption(captionId, fontSize?, fontFamily?, color?, position?) → style caption`;

const WORKSPACE_TOOLS = `## Workspace Tools (always available, not behind meta-tools)
- list_workspace_documents / read_workspace_document / write_workspace_document
- replace_workspace_document_text / create_workspace_folder
- rename_workspace_entry / move_workspace_entry / delete_workspace_entry`;

const BATCH_EXECUTION = `## Batch Execution (meta-tool: execute_plan)
Use for multi-step atomic edits. Each step: { id, toolName, params, dependsOn? }.
Stops on first failure; completed steps are NOT rolled back.`;

const EDITING_CONCEPTS = `## Editing Concepts
- Ripple: trim + shift subsequent clips to fill/accommodate
- Roll: move cut point between adjacent clips (total duration unchanged)
- Slip: change which part of source shows, clip stays in place on timeline
- Slide: move clip along timeline, neighbors stretch/shrink to compensate
- J-cut: audio from next clip starts before video transition
- L-cut: audio from current clip continues after video transitions to next`;

const COMMON_WORKFLOWS = `## Common Workflows
1. Import & arrange: get_workspace_files → insert_clip_from_file per file
2. Remove section: split_clip at start → split_clip at end → delete_clip middle
3. Remove silence: find_gaps → delete_clips_in_range or manual split+delete
4. Speed ramp: split_clip at boundaries → change_clip_speed on middle segment
5. Batch edit: use execute_plan with steps array for atomic multi-step operations`;

const CLI_REFERENCE = `## CLI (headless alternative)
openreelio-cli --path <dir> <group> <command> [--args]
Groups: project, asset, timeline, caption, plan, state, render
Key: plan execute --file <plan.json> for atomic batch operations
Run help-json for machine-readable full schema.`;

// =============================================================================
// Role → Sections Mapping
// =============================================================================

function getSectionsForRole(role: ToolReferenceRole): string[] {
  switch (role) {
    case 'editor':
      return [
        QUERY_ACTIONS, EDIT_ACTIONS, AUDIO_ACTIONS, EFFECTS_ACTIONS, TEXT_ACTIONS,
        WORKSPACE_TOOLS, BATCH_EXECUTION, EDITING_CONCEPTS, COMMON_WORKFLOWS, CLI_REFERENCE,
      ];
    case 'analyst':
      return [QUERY_ACTIONS, WORKSPACE_TOOLS, CLI_REFERENCE];
    case 'colorist':
      return [QUERY_ACTIONS, EFFECTS_ACTIONS, WORKSPACE_TOOLS, EDITING_CONCEPTS, CLI_REFERENCE];
    case 'audio':
      return [QUERY_ACTIONS, AUDIO_ACTIONS, WORKSPACE_TOOLS, CLI_REFERENCE];
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Build the tool reference section for the system prompt.
 * Filters sections to only include tools relevant to the given agent role.
 */
export function buildToolReference(role: ToolReferenceRole = 'editor'): string {
  const sections = getSectionsForRole(role);
  return `<tool_reference>\n\n${sections.join('\n\n')}\n\n</tool_reference>`;
}
