/**
 * Environment Context Builder
 *
 * Builds dynamic environment context for injection into system prompts.
 * Provides structured information about the current project, timeline,
 * playback state, and available resources.
 */

import type { AgentContext } from '../core/types';

// =============================================================================
// Types
// =============================================================================

export interface EnvironmentSection {
  tag: string;
  content: string;
}

// =============================================================================
// Formatters
// =============================================================================

function formatTimecode(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

// =============================================================================
// Environment Builder
// =============================================================================

/**
 * Build the <environment> section for the system prompt.
 */
export function buildEnvironmentContext(context: AgentContext): string {
  const lines = [
    '<environment>',
    `Project: ${context.projectId}`,
    `Timeline Duration: ${formatTimecode(context.timelineDuration ?? 0)}`,
    `Playhead: ${formatTimecode(context.playheadPosition ?? 0)}`,
    `Selected Clips: ${context.selectedClips?.length ?? 0}`,
    `Selected Tracks: ${context.selectedTracks?.length ?? 0}`,
    `Available Assets: ${context.availableAssets?.length ?? 0}`,
    `Available Tracks: ${context.availableTracks?.length ?? 0}`,
  ];

  if (context.projectStateVersion != null) {
    lines.push(`State Version: ${context.projectStateVersion}`);
  }

  lines.push('</environment>');
  return lines.join('\n');
}

/**
 * Build the <assets> section for the system prompt.
 * Limits to maxItems to avoid bloating the context.
 */
export function buildAssetContext(
  context: AgentContext,
  maxItems = 20,
): string | null {
  const assets = context.availableAssets;
  if (!assets || assets.length === 0) return null;

  const lines = ['<assets>'];
  const slice = assets.slice(0, maxItems);
  for (const asset of slice) {
    const duration = asset.duration ? `, ${formatTimecode(asset.duration)}` : '';
    lines.push(`- ${asset.name} (${asset.type}${duration}) [id: ${asset.id}]`);
  }
  if (assets.length > maxItems) {
    lines.push(`... and ${assets.length - maxItems} more assets`);
  }
  lines.push('</assets>');
  return lines.join('\n');
}

/**
 * Build the <tracks> section for the system prompt.
 */
export function buildTrackContext(context: AgentContext): string | null {
  const tracks = context.availableTracks;
  if (!tracks || tracks.length === 0) return null;

  const lines = ['<tracks>'];
  for (const track of tracks) {
    lines.push(`- ${track.name} (${track.type}, ${track.clipCount} clips) [id: ${track.id}]`);
  }
  lines.push('</tracks>');
  return lines.join('\n');
}

/**
 * Build the <selection> section when clips are selected.
 */
export function buildSelectionContext(context: AgentContext): string | null {
  const clips = context.selectedClips;
  if (!clips || clips.length === 0) return null;

  const lines = ['<selection>'];
  for (const clipId of clips) {
    lines.push(`- Clip: ${clipId}`);
  }
  lines.push('</selection>');
  return lines.join('\n');
}

/**
 * Build the <tools> section listing available tools.
 */
export function buildToolsContext(context: AgentContext): string | null {
  const tools = context.availableTools;
  if (!tools || tools.length === 0) return null;

  const lines = ['<available_tools>'];
  for (const tool of tools) {
    lines.push(`- ${tool}`);
  }
  lines.push('</available_tools>');
  return lines.join('\n');
}

/**
 * Build all environment sections as a single string.
 */
export function buildFullEnvironmentPrompt(context: AgentContext): string {
  const sections: string[] = [
    buildEnvironmentContext(context),
  ];

  const assets = buildAssetContext(context);
  if (assets) sections.push(assets);

  const tracks = buildTrackContext(context);
  if (tracks) sections.push(tracks);

  const selection = buildSelectionContext(context);
  if (selection) sections.push(selection);

  const tools = buildToolsContext(context);
  if (tools) sections.push(tools);

  return sections.join('\n\n');
}
