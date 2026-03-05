/**
 * System Prompt Assembly Tests
 */

import { describe, it, expect } from 'vitest';
import { assembleSystemPrompt, buildCompactionPrompt } from './system';
import { createEmptyContext } from '../core/types';

function makeContext(overrides: Record<string, unknown> = {}) {
  const base = createEmptyContext('test-project');
  return { ...base, ...overrides };
}

describe('assembleSystemPrompt', () => {
  it('should include base editor prompt', () => {
    const result = assembleSystemPrompt({
      role: 'editor',
      context: makeContext(),
    });

    expect(result).toContain('AI video editing assistant');
    expect(result).toContain('Capabilities');
  });

  it('should include analyst prompt for analyst role', () => {
    const result = assembleSystemPrompt({
      role: 'analyst',
      context: makeContext(),
    });

    expect(result).toContain('analysis assistant');
    expect(result).toContain('READ-ONLY');
  });

  it('should include colorist prompt for colorist role', () => {
    const result = assembleSystemPrompt({
      role: 'colorist',
      context: makeContext(),
    });

    expect(result).toContain('color grading');
  });

  it('should include audio prompt for audio role', () => {
    const result = assembleSystemPrompt({
      role: 'audio',
      context: makeContext(),
    });

    expect(result).toContain('audio engineering');
  });

  it('should include environment context', () => {
    const result = assembleSystemPrompt({
      role: 'editor',
      context: makeContext({ timelineDuration: 120 }),
    });

    expect(result).toContain('<environment>');
    expect(result).toContain('Project: test-project');
  });

  it('should include tool reference with all sections for editor role', () => {
    const result = assembleSystemPrompt({
      role: 'editor',
      context: makeContext(),
    });

    expect(result).toContain('<tool_reference>');
    expect(result).toContain('## Query Actions');
    expect(result).toContain('## Edit Actions');
    expect(result).toContain('## Audio Actions');
    expect(result).toContain('## Effects Actions');
    expect(result).toContain('## Text Actions');
    expect(result).toContain('## Common Workflows');
    expect(result).toContain('</tool_reference>');
  });

  it('should include only query tools for analyst role', () => {
    const result = assembleSystemPrompt({
      role: 'analyst',
      context: makeContext(),
    });

    expect(result).toContain('<tool_reference>');
    expect(result).toContain('## Query Actions');
    expect(result).not.toContain('## Edit Actions');
    expect(result).not.toContain('## Audio Actions');
    expect(result).not.toContain('## Effects Actions');
    expect(result).toContain('</tool_reference>');
  });

  it('should include knowledge entries when provided', () => {
    const result = assembleSystemPrompt({
      role: 'editor',
      context: makeContext(),
      knowledge: [
        'User prefers warm tones',
        'Always normalize audio to -6dB',
      ],
    });

    expect(result).toContain('<knowledge>');
    expect(result).toContain('warm tones');
    expect(result).toContain('-6dB');
    expect(result).toContain('</knowledge>');
  });

  it('should not include knowledge section when empty', () => {
    const result = assembleSystemPrompt({
      role: 'editor',
      context: makeContext(),
      knowledge: [],
    });

    expect(result).not.toContain('<knowledge>');
  });

  it('should include language policy when present', () => {
    const result = assembleSystemPrompt({
      role: 'editor',
      context: makeContext({
        languagePolicy: {
          uiLanguage: 'ko-KR',
          outputLanguage: 'Korean',
          detectInputLanguage: true,
          allowUserLanguageOverride: true,
        },
      }),
    });

    expect(result).toContain('<language_policy>');
    expect(result).toContain('Korean');
    expect(result).toContain('Detect the user');
    expect(result).toContain('</language_policy>');
  });

  it('should include custom instructions when provided', () => {
    const result = assembleSystemPrompt({
      role: 'editor',
      context: makeContext(),
      customInstructions: 'Always use 24fps for this project.',
    });

    expect(result).toContain('<custom_instructions>');
    expect(result).toContain('Always use 24fps');
    expect(result).toContain('</custom_instructions>');
  });

  it('should assemble sections in correct order', () => {
    const result = assembleSystemPrompt({
      role: 'editor',
      context: makeContext({
        availableAssets: [{ id: 'a1', name: 'Test.mp4', type: 'video' }],
        languagePolicy: {
          uiLanguage: 'en-US',
          outputLanguage: 'English',
          detectInputLanguage: false,
          allowUserLanguageOverride: false,
        },
      }),
      knowledge: ['Always fade transitions'],
      customInstructions: 'Custom rule here',
    });

    // Verify ordering: base → environment → tool_reference → knowledge → language → custom
    const baseIdx = result.indexOf('AI video editing assistant');
    const envIdx = result.indexOf('<environment>');
    const toolRefIdx = result.indexOf('<tool_reference>');
    const knowledgeIdx = result.indexOf('<knowledge>');
    const langIdx = result.indexOf('<language_policy>');
    const customIdx = result.indexOf('<custom_instructions>');

    expect(baseIdx).toBeLessThan(envIdx);
    expect(envIdx).toBeLessThan(toolRefIdx);
    expect(toolRefIdx).toBeLessThan(knowledgeIdx);
    expect(knowledgeIdx).toBeLessThan(langIdx);
    expect(langIdx).toBeLessThan(customIdx);
  });
});

describe('buildCompactionPrompt', () => {
  it('should include summary structure', () => {
    const result = buildCompactionPrompt();

    expect(result).toContain('## Goal');
    expect(result).toContain('## Instructions');
    expect(result).toContain('## Accomplished');
    expect(result).toContain('## Timeline State');
  });
});
