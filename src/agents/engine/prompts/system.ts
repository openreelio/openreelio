/**
 * System Prompt Assembly
 *
 * Assembles the full system prompt for agent loops by combining:
 * 1. Base prompt (agent role and capabilities)
 * 2. Environment context (project state, timeline, assets)
 * 3. Tool reference (action docs, workflow recipes, CLI guide)
 * 4. Knowledge base (learned conventions and preferences)
 * 5. Language policy
 * 6. Custom instructions
 *
 * Follows the opencode pattern for structured prompt assembly.
 */

import type { AgentContext } from '../core/types';
import { buildFullEnvironmentPrompt } from './environment';
import {
  EDITOR_PROMPT,
  PLANNER_PROMPT,
  ANALYST_PROMPT,
  VERIFIER_PROMPT,
  COLORIST_PROMPT,
  AUDIO_PROMPT,
  CAPTIONER_PROMPT,
} from './agentPrompts';
import { buildToolReference } from './toolReference';
import type { AgentRole } from './agentRoles';

// =============================================================================
// Types
// =============================================================================

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

export interface ProjectPromptAddendumOptions {
  knowledge?: string[];
  customInstructions?: string;
}

// =============================================================================
// Base Prompts by Role
// =============================================================================

const BASE_PROMPTS: Record<AgentRole, string> = {
  editor: EDITOR_PROMPT,
  planner: PLANNER_PROMPT,
  analyst: ANALYST_PROMPT,
  verifier: VERIFIER_PROMPT,
  colorist: COLORIST_PROMPT,
  audio: AUDIO_PROMPT,
  captioner: CAPTIONER_PROMPT,
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
      ? "Detect the user's language from their latest message and respond in that language."
      : `Always respond in ${policy.outputLanguage}.`,
    'IMPORTANT: Never translate command names, tool names, IDs, JSON keys, or parameter names.',
    '</language_policy>',
  ].join('\n');
}

// =============================================================================
// Knowledge Section
// =============================================================================

function sanitizePromptText(value: string): string {
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');

  return normalized.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildKnowledgeSection(knowledge: string[]): string | null {
  if (knowledge.length === 0) return null;

  return [
    '<knowledge>',
    'The following are learned patterns and preferences for this project:',
    ...knowledge.map((entry) => `- ${sanitizePromptText(entry)}`),
    '</knowledge>',
  ].join('\n');
}

function buildCustomInstructionsSection(customInstructions?: string): string | null {
  if (!customInstructions) {
    return null;
  }

  return [
    '<custom_instructions>',
    sanitizePromptText(customInstructions),
    '</custom_instructions>',
  ].join('\n');
}

export function buildProjectPromptAddendum(options: ProjectPromptAddendumOptions): string | null {
  const { knowledge = [], customInstructions } = options;
  const sections: string[] = [];

  const knowledgeSection = buildKnowledgeSection(knowledge);
  if (knowledgeSection) {
    sections.push(knowledgeSection);
  }

  const customInstructionsSection = buildCustomInstructionsSection(customInstructions);
  if (customInstructionsSection) {
    sections.push(customInstructionsSection);
  }

  return sections.length > 0 ? sections.join('\n\n') : null;
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
 * 3. Tool reference (action descriptions, workflows, CLI guide)
 * 4. Knowledge base (learned conventions/preferences)
 * 5. Language policy
 * 6. Custom instructions
 */
export function assembleSystemPrompt(options: SystemPromptOptions): string {
  const { role, context, knowledge = [], customInstructions } = options;

  const sections: string[] = [];

  // 1. Base prompt
  sections.push(BASE_PROMPTS[role]);

  // 2. Environment context
  sections.push(buildFullEnvironmentPrompt(context));

  // 3. Tool reference (action docs, workflows, CLI — filtered by role)
  sections.push(buildToolReference(role));

  // 4. Knowledge base
  const knowledgeSection = buildKnowledgeSection(knowledge);
  if (knowledgeSection) sections.push(knowledgeSection);

  // 5. Language policy
  const languageSection = buildLanguageSection(context);
  if (languageSection) sections.push(languageSection);

  // 6. Custom instructions
  const customInstructionsSection = buildCustomInstructionsSection(customInstructions);
  if (customInstructionsSection) sections.push(customInstructionsSection);

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
