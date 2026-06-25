/**
 * Analysis Tools - Source Report & Style Tools
 *
 * Tool definitions for source analysis report generation/search, external
 * diarization, source selects, style documents, and edit-structure comparison.
 */

import { type ToolDefinition } from '../../ToolRegistry';
import { getToolOutputContract } from '../../toolOutputContracts';
import { createLogger } from '@/services/logger';
import { invoke } from '@tauri-apps/api/core';
import type { AnalysisBundle, EditingStyleDocument, EsdSummary } from '@/bindings';
import { getTimelineSnapshot } from '../storeAccessor';
import { calculatePearsonCorrelation, getPrimaryTrackClips } from '@/utils/referenceComparison';
import { getClipTimelineEndSec } from '@/utils/clipTiming';
import { useProjectStore } from '@/stores/projectStore';
import { insertAgentMediaClip } from '../mediaInsertion';
import { roundTo, resolveAnalysisOptions } from './shared';
import { type SourceAnalysisSection, saveRetrievalMemoryEntries } from './sourceReportData';
import {
  searchSourceAnalysisReport,
  generateSourceAnalysisReportPayloadFromArgs,
  searchSourceLibraryMatches,
  searchIndexedSourceLibraryMatches,
  buildSourceSelectSegments,
  resolveSelectsSequence,
  resolveExistingSelectsTrack,
  ensureSelectsTrack,
  rollbackInsertedSelectClips,
  rollbackCreatedSelectsTrack,
} from './sourceSearch';
import {
  prepareSourceAnalysisReportArtifacts,
  resolveSourceAnalysisArgs,
} from './sourceReportMarkdown';

const logger = createLogger('AnalysisTools');

async function findExistingEsdForAsset(assetId: string): Promise<EditingStyleDocument | null> {
  try {
    const summaries = await invoke<EsdSummary[]>('list_esds');
    const latestSummary = summaries
      .filter((summary) => summary.sourceAssetId === assetId)
      .sort((left, right) => {
        const leftTime = Date.parse(left.createdAt);
        const rightTime = Date.parse(right.createdAt);

        if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
          return right.createdAt.localeCompare(left.createdAt);
        }

        return rightTime - leftTime;
      })[0];

    if (!latestSummary) {
      return null;
    }

    return await invoke<EditingStyleDocument | null>('get_esd', {
      esdId: latestSummary.id,
    });
  } catch (error) {
    logger.warn('Unable to reuse existing style document; falling back to regeneration', {
      assetId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function buildStyleDocumentResult(
  esd: EditingStyleDocument,
  analysisSource: 'cached' | 'generated' | 'existing_esd',
): {
  esdId: string;
  name: string;
  assetId: string;
  analysisSource: 'cached' | 'generated' | 'existing_esd';
  tempoClassification: string;
  shotCount: number;
  pacingPointCount: number;
  summary: string;
} {
  const reuseNotice =
    analysisSource === 'existing_esd' ? ' Reused the latest existing ESD for this asset.' : '';

  return {
    esdId: esd.id,
    name: esd.name,
    assetId: esd.sourceAssetId,
    analysisSource,
    tempoClassification: esd.rhythmProfile.tempoClassification,
    shotCount: esd.rhythmProfile.shotDurations.length,
    pacingPointCount: esd.pacingCurve.length,
    summary: `Created ESD "${esd.name}" - ${esd.rhythmProfile.tempoClassification} tempo, ${esd.rhythmProfile.shotDurations.length} shots.${reuseNotice}`,
  };
}

export const SOURCE_REPORT_TOOLS: ToolDefinition[] = [
  // ---------------------------------------------------------------------------
  // Analyze Reference Video
  // ---------------------------------------------------------------------------
  {
    name: 'analyze_reference_video',
    description:
      'Run full analysis on a reference video (shots, audio, segments, visual) and return a summary bundle',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Asset ID of the reference video to analyze' },
        options: {
          type: 'object',
          description: 'Optional analysis flags passed to the backend pipeline',
        },
        shots: { type: 'boolean', description: 'Include shot detection (default: true)' },
        transcript: { type: 'boolean', description: 'Include transcript (default: true)' },
        audio: { type: 'boolean', description: 'Include audio profiling (default: true)' },
        segments: { type: 'boolean', description: 'Include content segmentation (default: true)' },
        visual: { type: 'boolean', description: 'Include visual frame analysis (default: true)' },
        localOnly: {
          type: 'boolean',
          description: 'Skip Vision API work and use local analysis where supported',
        },
      },
      required: ['assetId'],
    },
    handler: async (args) => {
      try {
        const assetId = args.assetId as string;
        if (!assetId) {
          return { success: false, error: 'assetId is required' };
        }
        const options = resolveAnalysisOptions(args as Record<string, unknown>);
        const bundle = await invoke<AnalysisBundle>('analyze_video_full', { assetId, options });
        const shotCount = bundle.shots?.length ?? 0;
        const segmentCount = bundle.segments?.length ?? 0;
        const hasAudio = bundle.audioProfile !== null;
        const hasTranscript = bundle.transcript !== null;
        const errorCount = Object.keys(bundle.errors ?? {}).length;
        logger.debug('analyze_reference_video completed', { assetId, shotCount });
        return {
          success: true,
          result: {
            assetId,
            shotCount,
            segmentCount,
            hasAudioProfile: hasAudio,
            hasTranscript,
            errorCount,
            analyzedAt: bundle.analyzedAt,
            summary: `Analyzed ${shotCount} shots, ${segmentCount} segments. Audio: ${hasAudio ? 'yes' : 'no'}, Transcript: ${hasTranscript ? 'yes' : 'no'}.${errorCount > 0 ? ` Partial failures: ${errorCount}.` : ''}`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('analyze_reference_video failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Read Source Analysis Report
  // ---------------------------------------------------------------------------
  {
    name: 'read_source_analysis_report',
    description:
      'Read the canonical Markdown source-analysis report for a video asset. If needed, generate or refresh the underlying analysis first and persist the report beside the asset by default (or to outputPath when provided)',
    category: 'analysis',
    outputContract: getToolOutputContract('read_source_analysis_report') ?? undefined,
    parameters: {
      type: 'object',
      properties: {
        assetId: {
          type: 'string',
          description: 'Asset ID of the source video to inspect',
        },
        file: {
          type: 'string',
          description: 'Workspace-relative media path or filename to resolve into an asset',
        },
        outputPath: {
          type: 'string',
          description:
            'Optional workspace-relative Markdown output path. When omitted, the report is created next to the asset as <asset-name>.analysis.md',
        },
        refresh: {
          type: 'boolean',
          description: 'Force regeneration instead of reusing a compatible cached bundle',
        },
        includeAnnotation: {
          type: 'boolean',
          description:
            'Include stored annotation/OCR/object summaries when available (default: true)',
        },
        options: {
          type: 'object',
          description: 'Optional analysis flags used if a new bundle must be generated',
        },
        shots: { type: 'boolean', description: 'Include shot detection (default: true)' },
        transcript: { type: 'boolean', description: 'Include transcript (default: true)' },
        audio: { type: 'boolean', description: 'Include audio profiling (default: true)' },
        segments: { type: 'boolean', description: 'Include content segmentation (default: true)' },
        visual: { type: 'boolean', description: 'Include visual analysis (default: true)' },
        localOnly: {
          type: 'boolean',
          description: 'Skip Vision API work and use local analysis where supported',
        },
      },
      required: [],
    },
    handler: async (args) => {
      try {
        const { resolvedArgs, requestedFile } = await resolveSourceAnalysisArgs(
          args as Record<string, unknown>,
        );
        const { report, document } = await prepareSourceAnalysisReportArtifacts(resolvedArgs);

        logger.debug('read_source_analysis_report completed', {
          assetId: report.assetId,
          requestedFile,
          persisted: document.persisted,
        });

        return {
          success: true,
          result: {
            assetId: report.assetId,
            assetName: report.assetName,
            requestedFile,
            content: document.content,
            relativePath: document.relativePath,
            reportPath: document.relativePath,
            sizeBytes: document.sizeBytes,
            modifiedAtUnixSec: document.modifiedAtUnixSec,
            persisted: document.persisted,
            persistenceError: document.persistenceError,
            bundleSource: report.bundleSource,
            generatedAt: report.generatedAt,
            summary: report.summary,
            metadata: report.metadata,
            coverage: report.coverage,
            quality: report.quality,
            sectionCounts: {
              moments: report.moments.count,
              chapters: report.chapters.count,
              highlights: report.highlights.count,
              speakerTurns: report.speakerTurns.count,
              visual: report.visual.items.length + report.visual.observations.length,
            },
            warnings: report.warnings,
            errors: report.errors,
            document,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('read_source_analysis_report failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Generate Source Analysis Report
  // ---------------------------------------------------------------------------
  {
    name: 'generate_source_analysis_report',
    description:
      'Build a rich source-footage analysis report for one asset by combining bundle, annotation, and asset metadata into JSON plus Markdown with moments, chapters, and candidate highlights. Also persists the Markdown report beside the asset by default.',
    category: 'analysis',
    outputContract: getToolOutputContract('generate_source_analysis_report') ?? undefined,
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Asset ID of the source video to inspect' },
        outputPath: {
          type: 'string',
          description:
            'Optional workspace-relative Markdown output path. When omitted, the report is created next to the asset as <asset-name>.analysis.md',
        },
        refresh: {
          type: 'boolean',
          description: 'Force regeneration instead of reusing a compatible cached bundle',
        },
        includeAnnotation: {
          type: 'boolean',
          description:
            'Include stored annotation/OCR/object summaries when available (default: true)',
        },
        options: {
          type: 'object',
          description: 'Optional analysis flags used if a new bundle must be generated',
        },
        shots: { type: 'boolean', description: 'Include shot detection (default: true)' },
        transcript: { type: 'boolean', description: 'Include transcript (default: true)' },
        audio: { type: 'boolean', description: 'Include audio profiling (default: true)' },
        segments: { type: 'boolean', description: 'Include content segmentation (default: true)' },
        visual: { type: 'boolean', description: 'Include visual frame analysis (default: true)' },
        localOnly: {
          type: 'boolean',
          description: 'Skip Vision API work and use local analysis where supported',
        },
      },
      required: ['assetId'],
    },
    handler: async (args) => {
      try {
        const { report, document } = await prepareSourceAnalysisReportArtifacts(
          args as Record<string, unknown>,
        );

        logger.debug('generate_source_analysis_report completed', {
          assetId: report.assetId,
          bundleSource: report.bundleSource,
          shotCount: report.shots.count,
          transcriptSegments: report.transcript.segmentCount,
        });

        return {
          success: true,
          result: {
            ...report,
            content: document.content,
            relativePath: document.relativePath,
            markdown: document.content,
            reportPath: document.relativePath,
            sizeBytes: document.sizeBytes,
            modifiedAtUnixSec: document.modifiedAtUnixSec,
            persisted: document.persisted,
            persistenceError: document.persistenceError,
            document,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('generate_source_analysis_report failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Import External Diarization
  // ---------------------------------------------------------------------------
  {
    name: 'import_external_diarization',
    description:
      'Import external diarization JSON for a source asset and merge speaker IDs into the cached transcript bundle',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Asset ID of the source video to update' },
        inputPath: {
          type: 'string',
          description: 'Path to the diarization JSON file (absolute or project-relative)',
        },
      },
      required: ['assetId', 'inputPath'],
    },
    handler: async (args) => {
      try {
        const assetId = args.assetId as string;
        const inputPath = args.inputPath as string;
        if (!assetId) {
          return { success: false, error: 'assetId is required' };
        }
        if (!inputPath) {
          return { success: false, error: 'inputPath is required' };
        }

        const result = await invoke<{
          assetId: string;
          transcriptSegmentCount: number;
          speakerCount: number;
          speakerTurnCount: number;
        }>('import_diarization_json', {
          assetId,
          inputPath,
        });

        logger.debug('import_external_diarization completed', {
          assetId: result.assetId,
          speakerCount: result.speakerCount,
          speakerTurnCount: result.speakerTurnCount,
        });

        return {
          success: true,
          result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('import_external_diarization failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Run External Diarization
  // ---------------------------------------------------------------------------
  {
    name: 'run_external_diarization',
    description:
      'Run an external diarization executable against normalized source audio, then import the resulting diarization JSON into the cached transcript bundle',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Asset ID of the source video to update' },
        executable: {
          type: 'string',
          description: 'Executable path for the external diarization runner',
        },
        args: {
          type: 'array',
          description: 'Runner arguments. Supported placeholders: {audioPath} and {outputPath}',
          items: { type: 'string' },
        },
      },
      required: ['assetId', 'executable', 'args'],
    },
    handler: async (args) => {
      try {
        const assetId = args.assetId as string;
        const executable = args.executable as string;
        const runnerArgs = Array.isArray(args.args)
          ? args.args.filter((value): value is string => typeof value === 'string')
          : [];
        if (!assetId) {
          return { success: false, error: 'assetId is required' };
        }
        if (!executable) {
          return { success: false, error: 'executable is required' };
        }
        if (runnerArgs.length === 0) {
          return { success: false, error: 'args is required' };
        }

        const result = await invoke<{
          assetId: string;
          inputAudioPath: string;
          outputJsonPath: string;
          transcriptSegmentCount: number;
          speakerCount: number;
          speakerTurnCount: number;
        }>('run_external_diarization', {
          assetId,
          executable,
          args: runnerArgs,
        });

        logger.debug('run_external_diarization completed', {
          assetId: result.assetId,
          speakerCount: result.speakerCount,
          speakerTurnCount: result.speakerTurnCount,
        });

        return {
          success: true,
          result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('run_external_diarization failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Search Source Analysis Report
  // ---------------------------------------------------------------------------
  {
    name: 'search_source_analysis_report',
    description:
      'Search moments, chapters, highlights, speaker turns, and visual breakdown entries within a source analysis report to find the most relevant time ranges for a query',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Asset ID of the source video to inspect' },
        query: { type: 'string', description: 'Search text to match against report sections' },
        sections: {
          type: 'array',
          description:
            'Optional sections to search: moments, chapters, highlights, speakerTurns, visual',
          items: { type: 'string' },
        },
        limit: { type: 'number', description: 'Maximum number of matches to return (default: 5)' },
        refresh: {
          type: 'boolean',
          description: 'Force regeneration instead of reusing a compatible cached bundle',
        },
        includeAnnotation: {
          type: 'boolean',
          description:
            'Include stored annotation/OCR/object summaries when available (default: true)',
        },
        options: {
          type: 'object',
          description: 'Optional analysis flags used if a new bundle must be generated',
        },
        shots: { type: 'boolean', description: 'Include shot detection (default: true)' },
        transcript: { type: 'boolean', description: 'Include transcript (default: true)' },
        audio: { type: 'boolean', description: 'Include audio profiling (default: true)' },
        segments: { type: 'boolean', description: 'Include content segmentation (default: true)' },
        visual: { type: 'boolean', description: 'Include visual frame analysis (default: true)' },
        localOnly: {
          type: 'boolean',
          description: 'Skip Vision API work and use local analysis where supported',
        },
      },
      required: ['assetId', 'query'],
    },
    handler: async (args) => {
      try {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) {
          return { success: false, error: 'query is required' };
        }

        const report = await generateSourceAnalysisReportPayloadFromArgs(
          args as Record<string, unknown>,
        );
        const rawSections = Array.isArray(args.sections)
          ? args.sections.filter(
              (value): value is SourceAnalysisSection =>
                value === 'moments' ||
                value === 'chapters' ||
                value === 'highlights' ||
                value === 'speakerTurns' ||
                value === 'visual',
            )
          : [];
        const sections: SourceAnalysisSection[] =
          rawSections.length > 0
            ? rawSections
            : ['moments', 'chapters', 'highlights', 'speakerTurns', 'visual'];
        const limit =
          typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
            ? Math.min(Math.floor(args.limit), 50)
            : 5;
        const matches = searchSourceAnalysisReport(report, query, sections, limit);

        logger.debug('search_source_analysis_report completed', {
          assetId: report.assetId,
          query,
          sections,
          matchCount: matches.length,
        });

        return {
          success: true,
          result: {
            assetId: report.assetId,
            assetName: report.assetName,
            query,
            sections,
            count: matches.length,
            matches,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('search_source_analysis_report failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Search Source Library
  // ---------------------------------------------------------------------------
  {
    name: 'search_source_library',
    description:
      'Search moments, chapters, highlights, speaker turns, and visual breakdown entries across multiple video assets to find the best source ranges for a query',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search text to match against source analysis sections',
        },
        assetIds: {
          type: 'array',
          description: 'Optional asset IDs to restrict search scope',
          items: { type: 'string' },
        },
        unusedOnly: {
          type: 'boolean',
          description: 'Restrict search to assets not currently used on any timeline',
        },
        sections: {
          type: 'array',
          description:
            'Optional sections to search: moments, chapters, highlights, speakerTurns, visual',
          items: { type: 'string' },
        },
        limit: { type: 'number', description: 'Maximum number of matches to return (default: 8)' },
        assetLimit: {
          type: 'number',
          description: 'Maximum number of candidate assets to inspect (default: 20)',
        },
        analyzeMissing: {
          type: 'boolean',
          description:
            'Generate fresh analysis for assets without cached bundle data (default: false)',
        },
        useSemantic: {
          type: 'boolean',
          description: 'Use embedding-backed hybrid reranking on top of indexed report chunks',
        },
        includeAnnotation: {
          type: 'boolean',
          description:
            'Include stored annotation/OCR/object summaries when available (default: true)',
        },
        options: {
          type: 'object',
          description: 'Optional analysis flags used if a new bundle must be generated',
        },
        shots: { type: 'boolean', description: 'Include shot detection (default: true)' },
        transcript: { type: 'boolean', description: 'Include transcript (default: true)' },
        audio: { type: 'boolean', description: 'Include audio profiling (default: true)' },
        segments: { type: 'boolean', description: 'Include content segmentation (default: true)' },
        visual: { type: 'boolean', description: 'Include visual frame analysis (default: true)' },
        localOnly: {
          type: 'boolean',
          description: 'Skip Vision API work and use local analysis where supported',
        },
      },
      required: ['query'],
    },
    handler: async (args) => {
      try {
        const result = await searchSourceLibraryMatches(args as Record<string, unknown>);

        logger.debug('search_source_library completed', {
          query: result.query,
          sections: result.sections,
          candidateAssetCount: result.searchedAssetCount,
          matchCount: result.count,
        });

        return {
          success: true,
          result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('search_source_library failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Search Indexed Source Library
  // ---------------------------------------------------------------------------
  {
    name: 'search_indexed_source_library',
    description:
      'Index source report chunks and search them through a backend hybrid lexical retrieval layer for faster library-wide source discovery',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search text to match against indexed source report chunks',
        },
        assetIds: {
          type: 'array',
          description: 'Optional asset IDs to restrict search scope',
          items: { type: 'string' },
        },
        unusedOnly: {
          type: 'boolean',
          description: 'Restrict search to assets not currently used on any timeline',
        },
        sections: {
          type: 'array',
          description:
            'Optional sections to search: moments, chapters, highlights, speakerTurns, visual',
          items: { type: 'string' },
        },
        limit: { type: 'number', description: 'Maximum number of matches to return (default: 8)' },
        assetLimit: {
          type: 'number',
          description: 'Maximum number of candidate assets to inspect (default: 20)',
        },
        analyzeMissing: {
          type: 'boolean',
          description:
            'Generate fresh analysis for assets without cached bundle data (default: false)',
        },
        useSemantic: {
          type: 'boolean',
          description: 'Use embedding-backed hybrid reranking on top of indexed report chunks',
        },
        includeAnnotation: {
          type: 'boolean',
          description:
            'Include stored annotation/OCR/object summaries when available (default: true)',
        },
      },
      required: ['query'],
    },
    handler: async (args) => {
      try {
        const result = await searchIndexedSourceLibraryMatches(args as Record<string, unknown>);

        logger.debug('search_indexed_source_library completed', {
          query: result.query,
          sections: result.sections,
          candidateAssetCount: result.searchedAssetCount,
          matchCount: result.count,
        });

        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('search_indexed_source_library failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Build Source Selects
  // ---------------------------------------------------------------------------
  {
    name: 'build_source_selects',
    description:
      'Turn ranked source matches, including speaker turns when relevant, into a timeline-ready selects stringout plan, and optionally apply it to a video track',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search text used to find source candidates across the library',
        },
        sequenceId: {
          type: 'string',
          description: 'Optional target sequence ID for the selects plan',
        },
        trackId: {
          type: 'string',
          description: 'Optional target video track ID for applying selects',
        },
        trackName: {
          type: 'string',
          description: 'Target video track name when creating or reusing a selects track',
        },
        timelineStart: {
          type: 'number',
          description: 'Optional timeline start position for the first selects clip',
        },
        unusedOnly: {
          type: 'boolean',
          description: 'Restrict source search to assets not currently used on any timeline',
        },
        assetIds: {
          type: 'array',
          description: 'Optional asset IDs to restrict search scope',
          items: { type: 'string' },
        },
        sections: {
          type: 'array',
          description:
            'Optional sections to search: moments, chapters, highlights, speakerTurns, visual',
          items: { type: 'string' },
        },
        limit: {
          type: 'number',
          description: 'Number of selects to keep after dedupe (default: 6)',
        },
        assetLimit: {
          type: 'number',
          description: 'Maximum number of candidate assets to inspect (default: 20)',
        },
        paddingSec: {
          type: 'number',
          description:
            'Extra source padding to add before and after each matched range (default: 0.25)',
        },
        gapSec: {
          type: 'number',
          description: 'Gap between planned selects clips on the timeline (default: 0.25)',
        },
        analyzeMissing: {
          type: 'boolean',
          description:
            'Generate fresh analysis for assets without cached bundle data (default: false)',
        },
        useIndexedSearch: {
          type: 'boolean',
          description: 'Use indexed report-chunk retrieval instead of direct report scanning',
        },
        includeAnnotation: {
          type: 'boolean',
          description:
            'Include stored annotation/OCR/object summaries when available (default: true)',
        },
        apply: {
          type: 'boolean',
          description: 'Apply the selects stringout directly to the target sequence and track',
        },
      },
      required: ['query'],
    },
    handler: async (args) => {
      try {
        const requestedSelectCount =
          typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
            ? Math.min(Math.floor(args.limit), 24)
            : 6;
        const paddingSec =
          typeof args.paddingSec === 'number' &&
          Number.isFinite(args.paddingSec) &&
          args.paddingSec >= 0
            ? args.paddingSec
            : 0.25;
        const gapSec =
          typeof args.gapSec === 'number' && Number.isFinite(args.gapSec) && args.gapSec >= 0
            ? args.gapSec
            : 0.25;
        const sourceSearchArgs = {
          ...args,
          analyzeMissing: args.analyzeMissing === true,
          limit: Math.min(requestedSelectCount * 3, 50),
        } as Record<string, unknown>;
        const searchResult =
          args.useIndexedSearch === true
            ? await searchIndexedSourceLibraryMatches(sourceSearchArgs)
            : await searchSourceLibraryMatches(sourceSearchArgs);
        const selects = buildSourceSelectSegments(searchResult.matches, {
          paddingSec,
          gapSec,
        }).slice(0, requestedSelectCount);

        const { sequenceId, sequence } = resolveSelectsSequence(
          typeof args.sequenceId === 'string' ? args.sequenceId : undefined,
        );
        const requestedTrackName =
          typeof args.trackName === 'string' && args.trackName.trim().length > 0
            ? args.trackName.trim()
            : 'Source Selects';
        const existingTrack = resolveExistingSelectsTrack({
          sequence,
          trackId: typeof args.trackId === 'string' ? args.trackId : undefined,
          trackName: requestedTrackName,
        });

        const timelinePlan: {
          sequenceId: string;
          targetTrackId: string | null;
          targetTrackName: string;
          timelineStartSec: number;
          gapSec: number;
          steps: Array<{
            action: string;
            assetId?: string;
            assetName?: string;
            timelineStartSec?: number;
            sourceInSec?: number;
            sourceOutSec?: number;
            trackId?: string | null;
            trackName?: string;
          }>;
        } = (() => {
          const timelineStart =
            typeof args.timelineStart === 'number' &&
            Number.isFinite(args.timelineStart) &&
            args.timelineStart >= 0
              ? args.timelineStart
              : existingTrack
                ? Math.max(0, ...existingTrack.clips.map((clip) => getClipTimelineEndSec(clip)))
                : 0;

          return {
            sequenceId,
            targetTrackId: existingTrack?.id ?? null,
            targetTrackName: requestedTrackName,
            timelineStartSec: roundTo(timelineStart) ?? 0,
            gapSec,
            steps: [
              ...(existingTrack ? [] : [{ action: 'add_track', trackName: requestedTrackName }]),
              ...selects.map((select) => ({
                action: 'insert_clip',
                assetId: select.assetId,
                assetName: select.assetName,
                timelineStartSec: select.timelineStartSec + timelineStart,
                sourceInSec: select.sourceInSec,
                sourceOutSec: select.sourceOutSec,
                trackId: existingTrack?.id ?? null,
                trackName: requestedTrackName,
              })),
            ],
          };
        })();

        let applied: {
          sequenceId: string;
          trackId: string | null;
          createdTrack: boolean;
          insertedClipCount: number;
        } | null = null;

        await saveRetrievalMemoryEntries(
          searchResult.query,
          selects.map((select) => ({
            assetId: select.assetId,
            sectionType: select.sectionType,
            index: select.index,
            sourceInSec: select.sourceInSec,
            sourceOutSec: select.sourceOutSec,
          })),
        );

        if (args.apply === true) {
          const { sequence } = resolveSelectsSequence(
            typeof args.sequenceId === 'string' ? args.sequenceId : undefined,
          );
          if (selects.length === 0) {
            applied = {
              sequenceId,
              trackId: existingTrack?.id ?? null,
              createdTrack: false,
              insertedClipCount: 0,
            };
          } else {
            const ensuredTrack = await ensureSelectsTrack({
              sequenceId,
              trackId: typeof args.trackId === 'string' ? args.trackId : undefined,
              trackName: requestedTrackName,
            });
            const refreshedSequence =
              useProjectStore.getState().sequences.get(sequenceId) ?? sequence;
            const targetTrack = refreshedSequence.tracks.find(
              (track) => track.id === ensuredTrack.trackId,
            );
            const baseTimelineStart =
              typeof args.timelineStart === 'number' &&
              Number.isFinite(args.timelineStart) &&
              args.timelineStart >= 0
                ? args.timelineStart
                : targetTrack
                  ? Math.max(0, ...targetTrack.clips.map((clip) => getClipTimelineEndSec(clip)))
                  : 0;
            const createdClipRefs: Array<{ trackId: string; clipId: string }> = [];
            const createdAudioTrackIds: string[] = [];

            try {
              for (const select of selects) {
                const insert = await insertAgentMediaClip({
                  sequenceId,
                  trackId: ensuredTrack.trackId,
                  assetId: select.assetId,
                  timelineStart: baseTimelineStart + select.timelineStartSec,
                  sourceIn: select.sourceInSec,
                  sourceOut: select.sourceOutSec,
                });
                createdClipRefs.push({
                  trackId: ensuredTrack.trackId,
                  clipId: insert.clipId,
                });
                if (insert.linkedAudio) {
                  createdClipRefs.push({
                    trackId: insert.linkedAudio.trackId,
                    clipId: insert.linkedAudio.clipId,
                  });
                  if (insert.linkedAudio.createdTrack) {
                    createdAudioTrackIds.push(insert.linkedAudio.trackId);
                  }
                }
              }
            } catch (error) {
              const rollbackFailures = await rollbackInsertedSelectClips(
                sequenceId,
                createdClipRefs,
              );
              for (const audioTrackId of [...createdAudioTrackIds].reverse()) {
                const trackRollbackFailure = await rollbackCreatedSelectsTrack(
                  sequenceId,
                  audioTrackId,
                );
                if (trackRollbackFailure) {
                  rollbackFailures.push(trackRollbackFailure);
                }
              }
              if (ensuredTrack.createdTrack) {
                const trackRollbackFailure = await rollbackCreatedSelectsTrack(
                  sequenceId,
                  ensuredTrack.trackId,
                );
                if (trackRollbackFailure) {
                  rollbackFailures.push(trackRollbackFailure);
                }
              }
              const message = error instanceof Error ? error.message : String(error);
              if (rollbackFailures.length > 0) {
                throw new Error(
                  `Failed to apply source selects: ${message}. Rollback failed for ${rollbackFailures.length} operation(s).`,
                );
              }
              throw new Error(
                `Failed to apply source selects: ${message}. Rolled back ${createdClipRefs.length} clip(s).`,
              );
            }

            applied = {
              sequenceId,
              trackId: ensuredTrack.trackId,
              createdTrack: ensuredTrack.createdTrack,
              insertedClipCount: selects.length,
            };
          }
        }

        return {
          success: true,
          result: {
            query: searchResult.query,
            sections: searchResult.sections,
            searchedAssetCount: searchResult.searchedAssetCount,
            skippedAssetCount: searchResult.skippedAssetCount,
            skippedAssets: searchResult.skippedAssets,
            count: selects.length,
            selects,
            timelinePlan,
            applied,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('build_source_selects failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Generate Style Document
  // ---------------------------------------------------------------------------
  {
    name: 'generate_style_document',
    description:
      'Generate an Editing Style Document (ESD) from a previously analyzed reference video',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Asset ID of the analyzed reference video' },
      },
      required: ['assetId'],
    },
    handler: async (args) => {
      try {
        const assetId = args.assetId as string;
        if (!assetId) {
          return { success: false, error: 'assetId is required' };
        }
        const existingEsd = await findExistingEsdForAsset(assetId);
        if (existingEsd) {
          logger.debug('generate_style_document reused existing ESD', {
            assetId,
            esdId: existingEsd.id,
          });
          return {
            success: true,
            result: buildStyleDocumentResult(existingEsd, 'existing_esd'),
          };
        }
        const cachedBundle = await invoke<AnalysisBundle | null>('get_analysis_bundle', {
          assetId,
        });
        const bundle =
          cachedBundle ??
          (await invoke<AnalysisBundle>('analyze_video_full', {
            assetId,
            options: resolveAnalysisOptions({}),
          }));
        const esd = await invoke<EditingStyleDocument>('generate_esd', { bundle });
        logger.debug('generate_style_document completed', { assetId, esdId: esd.id });
        return {
          success: true,
          result: buildStyleDocumentResult(esd, cachedBundle ? 'cached' : 'generated'),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('generate_style_document failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Compare Edit Structure
  // ---------------------------------------------------------------------------
  {
    name: 'compare_edit_structure',
    description:
      'Compare an ESD pacing curve with the current timeline to show structural similarity and differences',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        esdId: {
          type: 'string',
          description: 'ID of the Editing Style Document to compare against',
        },
      },
      required: ['esdId'],
    },
    handler: async (args) => {
      try {
        const esdId = args.esdId as string;
        if (!esdId) {
          return { success: false, error: 'esdId is required' };
        }
        const esd = await invoke<EditingStyleDocument | null>('get_esd', { esdId });
        if (!esd) {
          return { success: false, error: `ESD not found: ${esdId}` };
        }
        const snapshot = getTimelineSnapshot();
        if (!snapshot.sequenceId) {
          return { success: false, error: 'No active timeline found' };
        }

        const primaryTrackClips = getPrimaryTrackClips(
          snapshot.tracks.map((track) => ({
            id: track.id,
            kind: track.kind,
            visible: track.visible,
          })),
          snapshot.clips.map((clip) => ({
            trackId: clip.trackId,
            timelineInSec: clip.timelineIn,
            durationSec: clip.duration,
          })),
        );
        const outputDurations = primaryTrackClips.map((clip) => clip.durationSec);
        const refDurations = esd.rhythmProfile.shotDurations;
        const correlation = calculatePearsonCorrelation(refDurations, outputDurations);

        logger.debug('compare_edit_structure completed', { esdId, correlation });
        return {
          success: true,
          result: {
            esdId,
            esdName: esd.name,
            referenceShots: refDurations.length,
            outputShots: outputDurations.length,
            primaryTrackId: primaryTrackClips[0]?.trackId ?? null,
            correlation: Math.round(correlation * 1000) / 1000,
            correlationPercent: `${Math.round(correlation * 100)}%`,
            shotCountDiff: outputDurations.length - refDurations.length,
            summary: `Pacing correlation: ${Math.round(correlation * 100)}% - Reference: ${refDurations.length} shots, Output: ${outputDurations.length} shots on the primary video track.`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('compare_edit_structure failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
];
