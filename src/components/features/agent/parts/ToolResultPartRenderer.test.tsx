/**
 * ToolResultPartRenderer Tests
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolResultPartRenderer } from './ToolResultPartRenderer';
import type { ToolResultPart } from '@/agents/engine/core/conversation';

describe('ToolResultPartRenderer', () => {
  it('should render a successful result', () => {
    const part: ToolResultPart = {
      type: 'tool_result',
      stepId: 'step-1',
      tool: 'split_clip',
      success: true,
      duration: 150,
      data: { newClipId: 'clip-2' },
    };
    render(<ToolResultPartRenderer part={part} />);

    expect(screen.getByTestId('tool-result-part')).toBeInTheDocument();
    expect(screen.getByText('split_clip')).toBeInTheDocument();
    expect(screen.getByText('150ms')).toBeInTheDocument();
  });

  it('should render a failed result', () => {
    const part: ToolResultPart = {
      type: 'tool_result',
      stepId: 'step-1',
      tool: 'split_clip',
      success: false,
      duration: 50,
      error: 'Clip not found',
    };
    render(<ToolResultPartRenderer part={part} />);

    expect(screen.getByTestId('tool-result-part')).toBeInTheDocument();
  });

  it('should expand to show error details when clicked', async () => {
    const part: ToolResultPart = {
      type: 'tool_result',
      stepId: 'step-1',
      tool: 'split_clip',
      success: false,
      duration: 50,
      error: 'Clip not found',
    };
    const user = userEvent.setup();
    render(<ToolResultPartRenderer part={part} />);

    await user.click(screen.getByText('split_clip'));

    expect(screen.getByText('Clip not found')).toBeInTheDocument();
  });

  it('should expand to show data when clicked', async () => {
    const part: ToolResultPart = {
      type: 'tool_result',
      stepId: 'step-1',
      tool: 'split_clip',
      success: true,
      duration: 100,
      data: { result: 'ok' },
    };
    const user = userEvent.setup();
    render(<ToolResultPartRenderer part={part} />);

    await user.click(screen.getByText('split_clip'));

    expect(screen.getByText(/"result": "ok"/)).toBeInTheDocument();
  });

  it('should render clip analysis evidence when expanded', async () => {
    const part: ToolResultPart = {
      type: 'tool_result',
      stepId: 'step-1',
      tool: 'analyze_timeline_clip',
      success: true,
      duration: 320,
      data: {
        fingerprint: 'clip_hash',
        clipId: 'clip-1',
        assetName: 'scene.mp4',
        quality: { status: 'ready', score: 100 },
        sampleCount: 1,
        readySampleCount: 1,
        summary: 'Clip analysis generated: 1 sample, 1 ready.',
        samples: [
          {
            sampleId: 'f0001',
            timelineSec: 1,
            sourceSec: 5,
            frameIndex: 150,
            imagePath: '/project/.openreelio/analysis/clips/clip_hash/frames/f0001.jpg',
            extractionStatus: 'ready',
          },
        ],
        errors: [],
      },
    };
    const user = userEvent.setup();
    render(<ToolResultPartRenderer part={part} />);

    await user.click(screen.getByText('analyze_timeline_clip'));

    expect(screen.getByText('Clip Evidence')).toBeInTheDocument();
    expect(screen.getByText('scene.mp4')).toBeInTheDocument();
    expect(screen.getByText('1/1 frames ready')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Sample f0001' })).toBeInTheDocument();
    expect(screen.getByText('S 5.000s · F 150')).toBeInTheDocument();
  });

  it('should render timeline range clip evidence summaries when expanded', async () => {
    const part: ToolResultPart = {
      type: 'tool_result',
      stepId: 'step-1',
      tool: 'inspect_timeline_range',
      success: true,
      duration: 420,
      data: {
        sequenceId: 'seq-1',
        startSec: 2,
        endSec: 4,
        count: 2,
        clips: [
          {
            fingerprint: 'clip_a',
            clipId: 'clip-a',
            assetName: 'a.mp4',
            quality: { status: 'ready', score: 100 },
            sampleCount: 2,
            readySampleCount: 2,
            samples: [],
          },
          {
            fingerprint: 'clip_b',
            clipId: 'clip-b',
            assetName: 'b.mp4',
            quality: { status: 'partial', score: 70 },
            sampleCount: 2,
            readySampleCount: 1,
            samples: [],
            errors: ['Failed to extract one sample.'],
          },
        ],
      },
    };
    const user = userEvent.setup();
    render(<ToolResultPartRenderer part={part} />);

    await user.click(screen.getByText('inspect_timeline_range'));

    expect(screen.getByText('2 clips')).toBeInTheDocument();
    expect(screen.getByText('a.mp4')).toBeInTheDocument();
    expect(screen.getByText('b.mp4')).toBeInTheDocument();
    expect(screen.getByText('Failed to extract one sample.')).toBeInTheDocument();
  });

  it('should render semantic clip observations when expanded', async () => {
    const part: ToolResultPart = {
      type: 'tool_result',
      stepId: 'step-1',
      tool: 'describe_clip_frames',
      success: true,
      duration: 510,
      data: {
        perceptionFingerprint: 'perception_hash',
        fingerprint: 'clip_hash',
        clipId: 'clip-1',
        assetId: 'asset-1',
        quality: {
          status: 'ready',
          semanticCoverage: 'sourceReuse',
          recommendedActions: [],
        },
        observationCount: 1,
        summary: 'Clip perception generated: 1 observation.',
        observations: [
          {
            sampleId: 'f0001',
            timelineSec: 1,
            sourceSec: 5,
            frameIndex: 150,
            imagePath: '/project/.openreelio/analysis/clips/clip_hash/frames/f0001.jpg',
            description: 'A presenter points at a Q4 chart.',
            visibleText: ['Q4'],
            objects: ['chart'],
            confidence: 0.92,
            evidenceSource: 'sourceAnalysis',
            provider: { provider: 'openai', model: 'gpt-4.1-mini' },
          },
        ],
        errors: [],
      },
    };
    const user = userEvent.setup();
    render(<ToolResultPartRenderer part={part} />);

    await user.click(screen.getByText('describe_clip_frames'));

    expect(screen.getByText('Clip Evidence')).toBeInTheDocument();
    expect(screen.getByText('1 observations')).toBeInTheDocument();
    expect(screen.getByText('A presenter points at a Q4 chart.')).toBeInTheDocument();
    expect(screen.getByText('sourceAnalysis')).toBeInTheDocument();
    expect(screen.getByText('openai')).toBeInTheDocument();
    expect(screen.getByText('92%')).toBeInTheDocument();
    expect(screen.getByText('Q4')).toBeInTheDocument();
    expect(screen.getByText('chart')).toBeInTheDocument();
  });

  it('should render semantic temporal edit plans when expanded', async () => {
    const part: ToolResultPart = {
      type: 'tool_result',
      stepId: 'step-1',
      tool: 'plan_semantic_clip_edit',
      success: true,
      duration: 280,
      data: {
        planId: 'semantic_edit_1',
        perceptionFingerprint: 'perception_hash',
        clipFingerprint: 'clip_hash',
        sequenceId: 'seq-1',
        trackId: 'V1',
        clipId: 'clip-1',
        assetId: 'asset-1',
        query: 'logo',
        action: 'blur',
        summary: 'Planned blur over 1 semantic range.',
        ranges: [
          {
            rangeId: 'range_001',
            timelineStartSec: 0.8,
            timelineEndSec: 1.2,
            sourceStartSec: 4.8,
            sourceEndSec: 5.2,
            sampleIds: ['f0001'],
            confidence: 0.92,
            matchedFields: ['visibleText'],
            evidence: [
              {
                sampleId: 'f0001',
                timelineSec: 1,
                sourceSec: 5,
                description: 'The product logo is visible.',
                confidence: 0.92,
                matchedFields: ['visibleText'],
              },
            ],
            spatialTargets: [
              {
                targetId: 'spatial_001',
                kind: 'object',
                label: 'product logo',
                sourceSec: 5,
                timeDeltaSec: 0,
                confidence: 0.95,
                boundingBox: { left: 0.1, top: 0.2, width: 0.3, height: 0.4 },
                maskShape: {
                  type: 'rectangle',
                  x: 0.25,
                  y: 0.4,
                  width: 0.33,
                  height: 0.43,
                  cornerRadius: 0.02,
                  rotation: 0,
                },
              },
            ],
            commandDrafts: [
              {
                commandType: 'SplitClip',
                reason: 'Isolate semantic range start.',
                requiresResolution: [],
                risk: 'low',
              },
              {
                commandType: 'AddEffect',
                reason: 'Apply blur to isolated range.',
                requiresResolution: ['isolatedClipId'],
                risk: 'needsResolution',
              },
              {
                commandType: 'AddMask',
                reason: 'Constrain blur to detected logo box.',
                requiresResolution: ['isolatedClipId', 'effectId'],
                risk: 'needsResolution',
              },
            ],
            warnings: ['Spatial annotation boxes are available; verify mask alignment.'],
          },
        ],
        quality: {
          status: 'partial',
          score: 92,
          matchedSampleCount: 1,
          rangeCount: 1,
          warnings: ['Semantic evidence has no bbox or mask bounds.'],
          recommendedActions: ['Review range before executing command drafts.'],
        },
        createdAt: '2026-05-29T00:00:00Z',
      },
    };
    const user = userEvent.setup();
    render(<ToolResultPartRenderer part={part} />);

    await user.click(screen.getByText('plan_semantic_clip_edit'));

    expect(screen.getByText('Temporal Edit Plan')).toBeInTheDocument();
    expect(screen.getByText('blur')).toBeInTheDocument();
    expect(screen.getByText('logo')).toBeInTheDocument();
    expect(screen.getAllByText('1 ranges')).toHaveLength(2);
    expect(screen.getByText('1 masks')).toBeInTheDocument();
    expect(screen.getByText('The product logo is visible.')).toBeInTheDocument();
    expect(screen.getByText('product logo')).toBeInTheDocument();
    expect(screen.getByText('AddEffect needs ID')).toBeInTheDocument();
    expect(screen.getByText('AddMask needs ID')).toBeInTheDocument();
    expect(
      screen.getByText('Spatial annotation boxes are available; verify mask alignment.'),
    ).toBeInTheDocument();
  });

  it('should apply custom className', () => {
    const part: ToolResultPart = {
      type: 'tool_result',
      stepId: 'step-1',
      tool: 'split_clip',
      success: true,
      duration: 100,
    };
    render(<ToolResultPartRenderer part={part} className="custom" />);

    expect(screen.getByTestId('tool-result-part')).toHaveClass('custom');
  });
});
