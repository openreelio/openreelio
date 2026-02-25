/**
 * System Prompt Assembly
 *
 * Assembles the full system prompt for agent loops by combining:
 * 1. Base prompt (agent role and capabilities)
 * 2. Environment context (project state, timeline, assets)
 * 3. Knowledge base (learned conventions and preferences)
 * 4. Tool descriptions (from registry)
 * 5. Language policy
 *
 * Follows the opencode pattern for structured prompt assembly.
 */

import type { AgentContext } from '../core/types';
import { buildFullEnvironmentPrompt } from './environment';
import { EDITOR_PROMPT, ANALYST_PROMPT, COLORIST_PROMPT, AUDIO_PROMPT } from './agentPrompts';

// =============================================================================
// Types
// =============================================================================

export type AgentRole = 'editor' | 'analyst' | 'colorist' | 'audio';

export interface SystemPromptOptions {
  /** Agent role (determines base prompt) */
  role: AgentRole;
  /** Current agent context with project/timeline state */
  context: AgentContext;
  /** Knowledge entries to inject */
  knowledge?: string[];
  /** Custom instructions (from project AGENTS.md or user config) */
  customInstructions?: string;
}

// =============================================================================
// Base Prompts by Role
// =============================================================================

const BASE_PROMPTS: Record<AgentRole, string> = {
  editor: EDITOR_PROMPT,
  analyst: ANALYST_PROMPT,
  colorist: COLORIST_PROMPT,
  audio: AUDIO_PROMPT,
};

// =============================================================================
// Language Policy
// =============================================================================

function buildLanguageSection(context: AgentContext): string | null {
  const policy = context.languagePolicy;
  if (!policy) return null;

  return [
    '<language_policy>',
    `Output Language: ${policy.outputLanguage}`,
    policy.detectInputLanguage
      ? 'Detect the user\'s language from their latest message and respond in that language.'
      : `Always respond in ${policy.outputLanguage}.`,
    'IMPORTANT: Never translate command names, tool names, IDs, JSON keys, or parameter names.',
    '</language_policy>',
  ].join('\n');
}

// =============================================================================
// Knowledge Section
// =============================================================================

function buildKnowledgeSection(knowledge: string[]): string | null {
  if (knowledge.length === 0) return null;

  return [
    '<knowledge>',
    'The following are learned patterns and preferences for this project:',
    ...knowledge.map((k) => `- ${k}`),
    '</knowledge>',
  ].join('\n');
}

// =============================================================================
// Assembly
// =============================================================================

/**
 * Assemble the full system prompt from all components.
 *
 * Assembly order:
 * 1. Base prompt (agent-specific role and capabilities)
 * 2. Environment context (project info, timeline state, assets)
 * 3. Knowledge base (learned conventions/preferences)
 * 4. Language policy
 * 5. Custom instructions
 */
export function assembleSystemPrompt(options: SystemPromptOptions): string {
  const { role, context, knowledge = [], customInstructions } = options;

  const sections: string[] = [];

  // 1. Base prompt
  sections.push(BASE_PROMPTS[role]);

  // 2. Environment context
  sections.push(buildFullEnvironmentPrompt(context));

  // 3. Knowledge base
  const knowledgeSection = buildKnowledgeSection(knowledge);
  if (knowledgeSection) sections.push(knowledgeSection);

  // 4. Language policy
  const languageSection = buildLanguageSection(context);
  if (languageSection) sections.push(languageSection);

  // 5. Custom instructions
  if (customInstructions) {
    sections.push([
      '<custom_instructions>',
      customInstructions,
      '</custom_instructions>',
    ].join('\n'));
  }

  return sections.join('\n\n');
}

/**
 * Build the compaction/summary prompt.
 */
export function buildCompactionPrompt(): string {
  return [
    'Summarize the conversation so far. Your summary will replace the conversation history.',
    'Use the following structure:',
    '',
    '## Goal',
    '[What the user is trying to accomplish]',
    '',
    '## Instructions',
    '[Important user instructions relevant to continuation]',
    '',
    '## Accomplished',
    '[What has been completed, in progress, remaining]',
    '',
    '## Timeline State',
    '[Current playhead, selected clips, track state, any relevant project state]',
    '',
    'Be concise but include all information needed to continue the conversation.',
  ].join('\n');
}
