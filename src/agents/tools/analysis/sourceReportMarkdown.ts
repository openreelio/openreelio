/**
 * Analysis Tools - Source Report Markdown & Persistence
 *
 * Markdown rendering, workspace path resolution, and persistence of source
 * analysis reports.
 */

import { createLogger } from '@/services/logger';
import {
  readWorkspaceDocumentFromBackend,
  writeWorkspaceDocumentToBackend,
} from '@/services/workspaceGateway';
import { resolveWorkspaceAsset } from '../mediaAnalysisTools';
import { formatTimecode } from './shared';
import {
  type SourceAnalysisReport,
  type SourceAnalysisReportDocument,
  SOURCE_ANALYSIS_REPORT_SUFFIX,
  VISUAL_BREAKDOWN_MARKDOWN_LIMIT,
  buildSourceAnalysisReportPayload,
  indexSourceReportChunks,
} from './sourceReportData';
import { generateSourceAnalysisReportPayloadFromArgs } from './sourceSearch';

const logger = createLogger('AnalysisTools');

export function buildSourceAnalysisMarkdown(
  report: ReturnType<typeof buildSourceAnalysisReportPayload>,
): string {
  const lines = [
    `# Source Analysis Report: ${report.assetName}`,
    '',
    `- Asset ID: ${report.assetId}`,
    `- Bundle source: ${report.bundleSource}`,
    `- Generated at: ${report.generatedAt}`,
    `- Summary: ${report.summary}`,
  ];

  const semantic = report.semantic;
  const quality = report.quality;

  lines.push(
    '',
    '## Analysis Quality',
    '',
    `- Status: ${quality.status}`,
    `- Score: ${quality.score}/100`,
    `- Critical signals: ${
      quality.criticalSignals.length > 0 ? quality.criticalSignals.join(', ') : 'none'
    }`,
    `- Missing signals: ${
      quality.missingSignals.length > 0 ? quality.missingSignals.join(', ') : 'none'
    }`,
    `- Degraded signals: ${
      quality.degradedSignals.length > 0 ? quality.degradedSignals.join(', ') : 'none'
    }`,
  );

  if (quality.recommendedActions.length > 0) {
    lines.push('', '### Recommended Follow-Up', '');
    for (const action of quality.recommendedActions) {
      lines.push(`- ${action}`);
    }
  }

  if (
    semantic.whatIsHappening.length > 0 ||
    semantic.whoIsPresent.length > 0 ||
    semantic.whatIsHeard.length > 0 ||
    semantic.onScreenText.length > 0 ||
    semantic.likelySetting.length > 0 ||
    semantic.usefulMoments.length > 0
  ) {
    lines.push('', '## Executive Summary', '');

    for (const bullet of semantic.whatIsHappening) {
      lines.push(`- What is happening: ${bullet}`);
    }

    for (const bullet of semantic.whoIsPresent) {
      lines.push(`- Who is present: ${bullet}`);
    }

    for (const bullet of semantic.whatIsHeard) {
      lines.push(`- What is heard: ${bullet}`);
    }

    for (const bullet of semantic.onScreenText) {
      lines.push(`- On-screen text: ${bullet}`);
    }

    for (const bullet of semantic.likelySetting) {
      lines.push(`- Likely setting: ${bullet}`);
    }

    for (const moment of semantic.usefulMoments.slice(0, 3)) {
      lines.push(
        `- Best usable moment: ${formatTimecode(moment.startSec)}-${formatTimecode(moment.endSec)} | ${moment.kind} | ${moment.summary}`,
      );
    }
  }

  if (semantic.sceneTimeline.length > 0) {
    lines.push('', '## Scene Timeline', '');
    for (const scene of semantic.sceneTimeline) {
      lines.push(
        `- ${formatTimecode(scene.startSec)}-${formatTimecode(scene.endSec)} | ${scene.title} | ${scene.summary}`,
      );
      if (scene.keyframePath) {
        lines.push(`- Keyframe: ${scene.keyframePath}`);
        lines.push(formatMarkdownImage(`${scene.title} keyframe`, scene.keyframePath));
      }
    }
  }

  if (semantic.usefulMoments.length > 0) {
    lines.push('', '## Useful Moments', '');
    for (const moment of semantic.usefulMoments) {
      lines.push(
        `- ${formatTimecode(moment.startSec)}-${formatTimecode(moment.endSec)} | ${moment.kind} | ${moment.summary}`,
      );
      if (moment.keyframePath) {
        lines.push(`- Keyframe: ${moment.keyframePath}`);
        lines.push(formatMarkdownImage(`${moment.kind} moment keyframe`, moment.keyframePath));
      }
      lines.push(`- Why it stands out: ${moment.reason}`);
    }
  }

  if (semantic.whoIsPresent.length > 0 || report.speakerTurns.count > 0) {
    lines.push('', '## Who Is Present', '');
    for (const bullet of semantic.whoIsPresent) {
      lines.push(`- ${bullet}`);
    }
    for (const turn of report.speakerTurns.items.slice(0, 4)) {
      lines.push(
        `- ${formatTimecode(turn.startSec)}-${formatTimecode(turn.endSec)} | ${turn.label} | ${turn.excerpt}`,
      );
    }
  }

  if (semantic.whatIsHeard.length > 0 || report.speakerTurns.count > 0) {
    lines.push('', '## What Is Heard', '');
    for (const bullet of semantic.whatIsHeard) {
      lines.push(`- ${bullet}`);
    }
  }

  if (semantic.onScreenText.length > 0) {
    lines.push('', '## On-Screen Text', '');
    for (const bullet of semantic.onScreenText) {
      lines.push(`- ${bullet}`);
    }
  }

  if (semantic.likelySetting.length > 0) {
    lines.push('', '## Visual / Setting Cues', '');
    for (const bullet of semantic.likelySetting) {
      lines.push(`- ${bullet}`);
    }
  }

  lines.push(
    '',
    '## File Info',
    '',
    `- Kind: ${report.assetKind}`,
    `- Duration: ${report.metadata.durationLabel}`,
    `- Resolution: ${report.metadata.width ?? 'unknown'} x ${report.metadata.height ?? 'unknown'}`,
    `- FPS: ${report.metadata.fps ?? 'unknown'}`,
    `- Codec: ${report.metadata.codec ?? 'unknown'}`,
    `- Audio stream: ${report.metadata.hasAudio ? 'yes' : 'no'}`,
    '',
    '## Coverage',
    '',
    `- Shots: ${report.coverage.shots ? 'available' : 'missing'}`,
    `- Transcript: ${report.coverage.transcript ? 'available' : 'missing'}`,
    `- Audio profile: ${report.coverage.audio ? 'available' : 'missing'}`,
    `- Segments: ${report.coverage.segments ? 'available' : 'missing'}`,
    `- Visual analysis: ${report.coverage.visual ? 'available' : 'missing'}`,
    `- Annotations: ${report.coverage.annotation ? 'available' : 'missing'}`,
    '',
    '## Shot Summary',
    '',
    `- Shot count: ${report.shots.count}`,
    `- Average duration: ${report.shots.averageDurationSec ?? 'unknown'}s`,
    `- Fastest shot: ${report.shots.minDurationSec ?? 'unknown'}s`,
    `- Longest shot: ${report.shots.maxDurationSec ?? 'unknown'}s`,
  );

  if (report.transcript.segmentCount > 0 || report.transcript.fullText) {
    lines.push('', '## Transcript Summary', '');
    const providerLabel = formatPerceptionProvider(report.transcript.provider);
    if (providerLabel) {
      lines.push(`- Provider: ${providerLabel}`);
    }
    lines.push(`- Segment count: ${report.transcript.segmentCount}`);
    lines.push(`- Estimated word count: ${report.transcript.wordCount}`);
    lines.push(`- Word timings: ${report.transcript.wordTimingCount}`);
    lines.push(`- Speakers detected: ${report.transcript.speakerCount}`);
    lines.push(`- Speaker turns: ${report.transcript.speakerTurnCount}`);
    lines.push(`- Speaker segments: ${report.transcript.speakerSegmentCount}`);
    lines.push(
      `- Languages: ${report.transcript.languages.length > 0 ? report.transcript.languages.join(', ') : 'unknown'}`,
    );
    if (report.transcript.excerpt) {
      lines.push(`- Excerpt: ${report.transcript.excerpt}`);
    }
  }

  if (report.transcript.segments.length > 0) {
    lines.push('', '## Full Transcript', '');
    for (const line of report.transcript.segments) {
      lines.push(
        `- ${formatTimecode(line.startSec)}-${formatTimecode(line.endSec)} | ${formatTranscriptSpeaker(line)} | ${line.text}`,
      );
    }
  } else if (report.transcript.fullText) {
    lines.push('', '## Full Transcript', '', report.transcript.fullText);
  }

  if (report.transcript.speakerSegments.length > 0) {
    lines.push('', '## Speaker-Aware Transcript Segments', '');
    for (const segment of report.transcript.speakerSegments.slice(0, 24)) {
      lines.push(
        `- ${formatTimecode(segment.startSec)}-${formatTimecode(segment.endSec)} | ${segment.speakerId || 'unknown speaker'} | ${segment.text}`,
      );
    }
    if (report.transcript.speakerSegments.length > 24) {
      lines.push(
        `- ... ${report.transcript.speakerSegments.length - 24} more speaker-aware transcript segments omitted from Markdown preview`,
      );
    }
  }

  if (report.moments.count > 0) {
    lines.push('', '## Moments', '');
    for (const moment of report.moments.items.slice(0, 12)) {
      lines.push(
        `- ${formatTimecode(moment.startSec)}-${formatTimecode(moment.endSec)} | ${moment.summary}`,
      );
      if (moment.keyframePath) {
        lines.push(`- Keyframe: ${moment.keyframePath}`);
      }
    }
    if (report.moments.count > 12) {
      lines.push(`- ... ${report.moments.count - 12} more moments omitted from Markdown preview`);
    }
  }

  if (report.coverage.audio) {
    lines.push('', '## Audio Summary', '');
    lines.push(`- BPM: ${report.audio.bpm ?? 'unknown'}`);
    lines.push(`- Peak dB: ${report.audio.peakDb ?? 'unknown'}`);
    lines.push(`- Spectral centroid: ${report.audio.spectralCentroidHz ?? 'unknown'} Hz`);
    lines.push(`- Silence regions: ${report.audio.silenceRegionCount}`);
    lines.push(`- Silence duration: ${report.audio.silenceDurationSec}s`);
    lines.push(`- Silence share: ${report.audio.silenceSharePercent}%`);
    lines.push(`- Speech regions: ${report.audio.speechRegionCount}`);
    lines.push(`- Speech duration: ${report.audio.speechDurationSec}s`);
    lines.push(`- Speech share: ${report.audio.speechSharePercent}%`);
    lines.push(`- Longest speech region: ${report.audio.longestSpeechRegionSec ?? 'unknown'}s`);
    lines.push(`- Longest silence region: ${report.audio.longestSilenceRegionSec ?? 'unknown'}s`);
  }

  if (report.speakerTurns.count > 0) {
    lines.push('', '## Speaker Turns', '');
    for (const turn of report.speakerTurns.items.slice(0, 8)) {
      lines.push(
        `- ${formatTimecode(turn.startSec)}-${formatTimecode(turn.endSec)} | ${turn.label} | ${turn.segmentCount} segments | ${turn.wordCount} words${turn.audioCue ? ` | ${turn.audioCue}` : ''}`,
      );
      lines.push(`- Excerpt: ${turn.excerpt}`);
    }
    if (report.speakerTurns.count > 8) {
      lines.push(
        `- ... ${report.speakerTurns.count - 8} more speaker turns omitted from Markdown preview`,
      );
    }
  }

  if (report.segments.distribution.length > 0) {
    lines.push('', '## Segment Mix', '');
    for (const segment of report.segments.distribution.slice(0, 6)) {
      lines.push(
        `- ${segment.label}: ${segment.count} segments, ${segment.durationSec}s (${segment.sharePercent}%)`,
      );
    }
  }

  if (report.visual.sampleCount > 0) {
    lines.push('', '## Visual Cues', '');
    lines.push(`- Frame samples analyzed: ${report.visual.sampleCount}`);
    lines.push(`- Average complexity: ${report.visual.averageComplexity ?? 'unknown'}`);
    if (report.visual.topCameraAngles.length > 0) {
      lines.push(
        `- Dominant camera angles: ${report.visual.topCameraAngles.map((entry) => `${entry.label} (${entry.count})`).join(', ')}`,
      );
    }
    if (report.visual.topMotionDirections.length > 0) {
      lines.push(
        `- Dominant motion: ${report.visual.topMotionDirections.map((entry) => `${entry.label} (${entry.count})`).join(', ')}`,
      );
    }
  }

  if (report.visual.items.length > 0) {
    lines.push('', '## Visual Breakdown', '');
    for (const item of report.visual.items.slice(0, VISUAL_BREAKDOWN_MARKDOWN_LIMIT)) {
      lines.push(
        `- ${formatTimecode(item.startSec)}-${formatTimecode(item.endSec)} | ${item.summary}`,
      );
      if (item.keyframePath) {
        lines.push(`- Keyframe: ${item.keyframePath}`);
        lines.push(formatMarkdownImage(`Shot ${item.shotIndex + 1} keyframe`, item.keyframePath));
      }
    }
    if (report.visual.items.length > VISUAL_BREAKDOWN_MARKDOWN_LIMIT) {
      lines.push(
        `- ... ${report.visual.items.length - VISUAL_BREAKDOWN_MARKDOWN_LIMIT} more visual entries omitted from Markdown preview`,
      );
    }
  }

  if (report.visual.observations.length > 0) {
    lines.push('', '## Frame Observations', '');
    for (const observation of report.visual.observations.slice(0, 24)) {
      lines.push(
        `- ${formatTimecode(observation.startSec)}-${formatTimecode(observation.endSec)} | Shot ${observation.shotIndex + 1} | ${observation.description || 'No description available'}`,
      );
      if (observation.subjects.length > 0) {
        lines.push(`- Subjects: ${observation.subjects.join(', ')}`);
      }
      if (observation.actions.length > 0) {
        lines.push(`- Actions: ${observation.actions.join(', ')}`);
      }
      if (observation.setting) {
        lines.push(`- Setting: ${observation.setting}`);
      }
      if (observation.visibleText.length > 0) {
        lines.push(`- Visible text: ${observation.visibleText.join(' | ')}`);
      }
      if (observation.objects.length > 0) {
        lines.push(`- Objects: ${observation.objects.join(', ')}`);
      }
      if (observation.editUsefulness) {
        lines.push(`- Edit usefulness: ${observation.editUsefulness}`);
      }
      const providerLabel = formatPerceptionProvider(observation.provider);
      if (providerLabel) {
        lines.push(
          `- Provider: ${providerLabel}${observation.confidence !== null ? ` | confidence ${observation.confidence}` : ''}`,
        );
      }
      if (observation.imagePath) {
        lines.push(`- Image: ${observation.imagePath}`);
        lines.push(
          formatMarkdownImage(
            `Shot ${observation.shotIndex + 1} observation`,
            observation.imagePath,
          ),
        );
      }
    }
    if (report.visual.observations.length > 24) {
      lines.push(
        `- ... ${report.visual.observations.length - 24} more frame observations omitted from Markdown preview`,
      );
    }
  }

  if (report.visual.contactSheet) {
    lines.push('', '## Visual Artifacts', '');
    lines.push(`- Contact sheet: ${report.visual.contactSheet.path}`);
    lines.push(formatMarkdownImage('Contact sheet', report.visual.contactSheet.path));
    lines.push(
      `- Layout: ${report.visual.contactSheet.frameCount} frames in ${report.visual.contactSheet.columns}x${report.visual.contactSheet.rows} grid`,
    );
  }

  if (report.visual.keyframes.length > 0) {
    lines.push('', '## Keyframe Gallery', '');
    for (const keyframe of report.visual.keyframes.slice(0, 24)) {
      lines.push(
        `- ${formatTimecode(keyframe.startSec)}-${formatTimecode(keyframe.endSec)} | ${keyframe.label}${keyframe.keyframeSelectionMethod ? ` | ${keyframe.keyframeSelectionMethod}` : ''}`,
      );
      lines.push(formatMarkdownImage(keyframe.label, keyframe.keyframePath));
    }
    if (report.visual.keyframes.length > 24) {
      lines.push(
        `- ... ${report.visual.keyframes.length - 24} more keyframes omitted from Markdown preview`,
      );
    }
  }

  if (report.chapters.count > 0) {
    lines.push('', '## Chapters', '');
    for (const chapter of report.chapters.items) {
      lines.push(
        `- ${formatTimecode(chapter.startSec)}-${formatTimecode(chapter.endSec)} | ${chapter.title} | ${chapter.shotCount} shots${chapter.dominantSegmentType ? ` | ${chapter.dominantSegmentType}` : ''}`,
      );
      lines.push(`- Summary: ${chapter.summary}`);
    }
  }

  if (report.highlights.count > 0) {
    lines.push('', '## Candidate Highlights', '');
    for (const highlight of report.highlights.items) {
      lines.push(
        `- ${formatTimecode(highlight.startSec)}-${formatTimecode(highlight.endSec)} | score ${highlight.score} | ${highlight.reason}`,
      );
      if (highlight.quote) {
        lines.push(`- Quote: ${highlight.quote}`);
      }
    }
  }

  if (report.annotations.availableTypes.length > 0 || report.annotations.objectDetectionCount > 0) {
    lines.push('', '## Annotation Signals', '');
    lines.push(
      `- Available types: ${report.annotations.availableTypes.length > 0 ? report.annotations.availableTypes.join(', ') : 'none'}`,
    );
    lines.push(
      `- Providers: ${report.annotations.providers.length > 0 ? report.annotations.providers.join(', ') : 'unknown'}`,
    );
    lines.push(`- Object detections: ${report.annotations.objectDetectionCount}`);
    lines.push(`- Face detections: ${report.annotations.faceDetectionCount}`);
    lines.push(`- OCR detections: ${report.annotations.ocrTextCount}`);
    if (report.annotations.topObjectLabels.length > 0) {
      lines.push(
        `- Top object labels: ${report.annotations.topObjectLabels.map((entry) => `${entry.label} (${entry.count})`).join(', ')}`,
      );
    }
    if (report.annotations.ocrPreview.length > 0) {
      lines.push(`- OCR preview: ${report.annotations.ocrPreview.join(' | ')}`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push('', '## Warnings', '');
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join('\n');
}

export function stripFileExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

export function sanitizeReportFileStem(value: string): string {
  const sanitized = stripFileExtension(value)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return sanitized.length > 0 ? sanitized : 'source-analysis-report';
}

export function normalizeWorkspaceRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').trim().replace(/^\.\//, '');
}

export function buildSiblingSourceAnalysisReportRelativePath(relativePath: string): string {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const segments = normalized.split('/').filter(Boolean);
  const fileName = segments.pop() ?? normalized;
  const stem = sanitizeReportFileStem(fileName);
  const reportFileName = `${stem}${SOURCE_ANALYSIS_REPORT_SUFFIX}`;
  return segments.length > 0 ? `${segments.join('/')}/${reportFileName}` : reportFileName;
}

export function buildDefaultSourceAnalysisReportRelativePath(report: SourceAnalysisReport): string {
  if (typeof report.assetRelativePath === 'string' && report.assetRelativePath.trim().length > 0) {
    return buildSiblingSourceAnalysisReportRelativePath(report.assetRelativePath);
  }

  return `analysis-reports/${sanitizeReportFileStem(report.assetName || report.assetId)}${SOURCE_ANALYSIS_REPORT_SUFFIX}`;
}

export function formatMarkdownImagePath(path: string): string {
  const normalized = path.trim();
  if (/[\s()]/.test(normalized)) {
    return `<${normalized.replace(/>/g, '%3E')}>`;
  }

  return normalized;
}

export function formatMarkdownImage(alt: string, path: string): string {
  return `![${alt.replace(/\[|\]/g, '')}](${formatMarkdownImagePath(path)})`;
}

export function formatTranscriptSpeaker(line: {
  speakerId: string | null;
  speakerTurnId: string | null;
}): string {
  if (line.speakerId) {
    return line.speakerId;
  }

  if (line.speakerTurnId) {
    return line.speakerTurnId;
  }

  return 'unknown speaker';
}

export function formatPerceptionProvider(
  provider:
    | {
        provider?: string;
        model?: string;
        analyzedAt?: string;
      }
    | null
    | undefined,
): string | null {
  if (!provider) {
    return null;
  }

  const providerName =
    typeof provider.provider === 'string' && provider.provider.trim().length > 0
      ? provider.provider.trim()
      : 'unknown';
  const model =
    typeof provider.model === 'string' && provider.model.trim().length > 0
      ? provider.model.trim()
      : 'unknown';
  const analyzedAt =
    typeof provider.analyzedAt === 'string' && provider.analyzedAt.trim().length > 0
      ? provider.analyzedAt.trim()
      : null;

  return analyzedAt ? `${providerName}/${model} at ${analyzedAt}` : `${providerName}/${model}`;
}

export async function persistSourceAnalysisMarkdownReport(
  report: SourceAnalysisReport,
  requestedOutputPath?: string | null,
): Promise<SourceAnalysisReportDocument> {
  const relativePath =
    typeof requestedOutputPath === 'string' && requestedOutputPath.trim().length > 0
      ? requestedOutputPath.trim()
      : buildDefaultSourceAnalysisReportRelativePath(report);
  const assetRelativePath =
    typeof report.assetRelativePath === 'string' && report.assetRelativePath.trim().length > 0
      ? report.assetRelativePath
      : null;

  if (
    assetRelativePath &&
    normalizeWorkspaceRelativePath(relativePath).toLowerCase() ===
      normalizeWorkspaceRelativePath(assetRelativePath).toLowerCase()
  ) {
    throw new Error('outputPath cannot overwrite the source asset');
  }

  const content = buildSourceAnalysisMarkdown(report);

  try {
    await writeWorkspaceDocumentToBackend(relativePath, content, true);

    try {
      const document = await readWorkspaceDocumentFromBackend(relativePath, {
        failureLogLevel: 'debug',
      });

      return {
        relativePath: document.relativePath,
        content: document.content,
        sizeBytes: document.sizeBytes,
        modifiedAtUnixSec: document.modifiedAtUnixSec,
        persisted: true,
        persistenceError: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Source analysis Markdown report was written but could not be re-read', {
        assetId: report.assetId,
        relativePath,
        error: message,
      });

      return {
        relativePath,
        content,
        sizeBytes: content.length,
        modifiedAtUnixSec: null,
        persisted: true,
        persistenceError: message,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to persist source analysis Markdown report', {
      assetId: report.assetId,
      relativePath,
      error: message,
    });

    return {
      relativePath,
      content,
      sizeBytes: content.length,
      modifiedAtUnixSec: null,
      persisted: false,
      persistenceError: message,
    };
  }
}

export async function prepareSourceAnalysisReportArtifacts(
  args: Record<string, unknown>,
): Promise<{ report: SourceAnalysisReport; document: SourceAnalysisReportDocument }> {
  const report = await generateSourceAnalysisReportPayloadFromArgs(args);

  try {
    await indexSourceReportChunks(report);
  } catch (error) {
    logger.warn('source analysis report could not index report chunks', {
      assetId: report.assetId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const requestedOutputPath =
    typeof args.outputPath === 'string' && args.outputPath.trim().length > 0
      ? args.outputPath.trim()
      : null;
  const document = await persistSourceAnalysisMarkdownReport(report, requestedOutputPath);
  return { report, document };
}

export async function resolveSourceAnalysisArgs(
  args: Record<string, unknown>,
): Promise<{ resolvedArgs: Record<string, unknown>; requestedFile: string | null }> {
  const assetId = typeof args.assetId === 'string' ? args.assetId.trim() : '';
  if (assetId.length > 0) {
    return { resolvedArgs: args, requestedFile: null };
  }

  const file = typeof args.file === 'string' ? args.file.trim() : '';
  if (file.length === 0) {
    throw new Error('assetId or file is required');
  }

  const resolved = await resolveWorkspaceAsset(file);
  return {
    resolvedArgs: {
      ...args,
      assetId: resolved.assetId,
    },
    requestedFile: resolved.relativePath,
  };
}

// =============================================================================
// Tool Definitions
// =============================================================================
