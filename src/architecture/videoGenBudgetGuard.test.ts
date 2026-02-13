/**
 * Video Generation Budget Guard
 *
 * Architecture rule:
 * - The `generate_video` agent tool must ALWAYS call cost estimation
 *   before submitting a generation request.
 * - This prevents accidental cost overruns by ensuring the agent
 *   (and any future callers) see the estimated price before committing.
 *
 * Rationale:
 * Video generation is a paid API call (Seedance 2.0). Without a mandatory
 * cost-estimation step, the agentic engine could submit expensive jobs
 * without budget awareness, leading to unexpected charges.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const GENERATION_TOOLS_PATH = path.resolve(
  process.cwd(),
  'src/agents/tools/generationTools.ts',
);

describe('Video generation budget guard', () => {
  it('generate_video handler calls cost estimation before submission', () => {
    const content = fs.readFileSync(GENERATION_TOOLS_PATH, 'utf8');

    // Find the generate_video handler block
    const handlerMatch = content.match(
      /name:\s*['"]generate_video['"]/,
    );
    expect(handlerMatch).not.toBeNull();

    // Extract text from the generate_video tool definition to the next tool
    // definition (or end of array)
    const startIdx = handlerMatch!.index!;
    const restContent = content.slice(startIdx);

    // Find the next tool definition boundary or end of GENERATION_TOOLS array
    const nextToolMatch = restContent
      .slice(1) // skip past current match
      .match(/\n\s*\{\s*\n\s*name:\s*['"]/);
    const handlerBlock = nextToolMatch
      ? restContent.slice(0, nextToolMatch.index! + 1)
      : restContent;

    // Verify cost estimation call exists in the handler
    const estimateCallIdx = handlerBlock.indexOf('estimate_generation_cost');
    expect(estimateCallIdx).toBeGreaterThan(
      -1,
      // Message if assertion fails:
    );

    // Verify submission call exists in the handler
    const submitCallIdx = handlerBlock.indexOf('submitGeneration');
    expect(submitCallIdx).toBeGreaterThan(-1);

    // Verify cost estimation happens BEFORE submission
    expect(
      estimateCallIdx < submitCallIdx,
      'estimate_generation_cost must be called BEFORE submitGeneration ' +
        'in the generate_video handler to enforce budget awareness',
    ).toBe(true);
  });

  it('generate_video tool is categorized as generation (high risk)', () => {
    const content = fs.readFileSync(GENERATION_TOOLS_PATH, 'utf8');

    // Extract the generate_video tool definition
    const startIdx = content.indexOf("name: 'generate_video'");
    expect(startIdx).toBeGreaterThan(-1);

    const restContent = content.slice(startIdx);
    const nextToolMatch = restContent
      .slice(1)
      .match(/\n\s*\{\s*\n\s*name:\s*['"]/);
    const toolBlock = nextToolMatch
      ? restContent.slice(0, nextToolMatch.index! + 1)
      : restContent;

    // Must have category: 'generation'
    expect(toolBlock).toMatch(/category:\s*['"]generation['"]/);
  });

  it('all generation tools have category generation', () => {
    const content = fs.readFileSync(GENERATION_TOOLS_PATH, 'utf8');

    // Find all tool definitions in the GENERATION_TOOLS array
    const toolNameMatches = [
      ...content.matchAll(/name:\s*['"](\w+)['"]/g),
    ];

    expect(toolNameMatches.length).toBeGreaterThanOrEqual(4);

    // Each tool must have category: 'generation'
    for (const match of toolNameMatches) {
      const startIdx = match.index!;
      const restContent = content.slice(startIdx);

      // Find the next tool or end of array
      const nextToolMatch = restContent
        .slice(1)
        .match(/\n\s*\{\s*\n\s*name:\s*['"]/);
      const toolBlock = nextToolMatch
        ? restContent.slice(0, nextToolMatch.index! + 1)
        : restContent;

      expect(
        /category:\s*['"]generation['"]/.test(toolBlock),
        `Tool "${match[1]}" must have category 'generation'`,
      ).toBe(true);
    }
  });
});
