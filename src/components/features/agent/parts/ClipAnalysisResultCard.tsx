import { convertFileSrc } from '@tauri-apps/api/core';

const CLIP_ANALYSIS_TOOLS = new Set([
  'analyze_timeline_clip',
  'sample_clip_frames',
  'read_clip_analysis',
  'inspect_timeline_range',
  'map_timeline_to_source',
  'describe_clip_frames',
  'read_clip_perception',
  'describe_timeline_range',
  'search_clip_evidence',
  'plan_semantic_clip_edit',
]);

interface ClipAnalysisQuality {
  status?: string;
  score?: number;
  semanticCoverage?: string;
  missingSignals?: string[];
  degradedSignals?: string[];
  recommendedActions?: string[];
}

interface ClipAnalysisSample {
  sampleId?: string;
  index?: number;
  timelineSec?: number;
  sourceSec?: number;
  frameIndex?: number | null;
  imagePath?: string;
  extractionStatus?: string;
  error?: string | null;
}

interface TimelineSourceMapping {
  timelineSec?: number;
  sourceSec?: number | null;
  frameIndex?: number | null;
  insideClip?: boolean;
  reason?: string;
}

interface ClipSemanticObservation {
  sampleId?: string;
  timelineSec?: number;
  sourceSec?: number;
  frameIndex?: number | null;
  imagePath?: string;
  description?: string;
  subjects?: string[];
  actions?: string[];
  visibleText?: string[];
  objects?: string[];
  setting?: string | null;
  editUsefulness?: string | null;
  confidence?: number;
  evidenceSource?: string;
  provider?: {
    provider?: string;
    model?: string;
  };
}

interface ClipEvidenceSearchHit {
  perceptionFingerprint?: string;
  clipFingerprint?: string;
  sequenceId?: string;
  trackId?: string;
  clipId?: string;
  assetId?: string;
  sampleId?: string;
  timelineSec?: number;
  sourceSec?: number;
  frameIndex?: number | null;
  imagePath?: string;
  description?: string;
  confidence?: number;
  evidenceSource?: string;
  matchedFields?: string[];
}

interface SemanticEditPlanDraft {
  commandType?: string;
  reason?: string;
  requiresResolution?: string[];
  risk?: string;
}

interface SemanticEditPlanEvidence {
  sampleId?: string;
  timelineSec?: number;
  sourceSec?: number;
  description?: string;
  matchedFields?: string[];
  confidence?: number;
}

interface SemanticEditSpatialTarget {
  targetId?: string;
  kind?: string;
  label?: string;
  sourceSec?: number;
  timeDeltaSec?: number;
  confidence?: number;
}

interface SemanticEditPlanRange {
  rangeId?: string;
  timelineStartSec?: number;
  timelineEndSec?: number;
  sourceStartSec?: number;
  sourceEndSec?: number;
  sampleIds?: string[];
  confidence?: number;
  matchedFields?: string[];
  evidence?: SemanticEditPlanEvidence[];
  spatialTargets?: SemanticEditSpatialTarget[];
  commandDrafts?: SemanticEditPlanDraft[];
  warnings?: string[];
}

interface ClipAnalysisData {
  summary?: string;
  source?: string;
  fingerprint?: string;
  perceptionFingerprint?: string;
  clipFingerprint?: string;
  sequenceId?: string;
  trackId?: string;
  clipId?: string;
  assetName?: string | null;
  quality?: ClipAnalysisQuality | null;
  sampleCount?: number;
  readySampleCount?: number;
  mappingCount?: number;
  samples?: ClipAnalysisSample[];
  mapping?: TimelineSourceMapping[];
  observationCount?: number;
  observations?: ClipSemanticObservation[];
  hits?: ClipEvidenceSearchHit[];
  ranges?: SemanticEditPlanRange[];
  action?: string;
  query?: string;
  errors?: string[];
  clips?: ClipAnalysisData[];
}

interface ClipAnalysisResultCardProps {
  tool: string;
  data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asClipAnalysisData(value: unknown): ClipAnalysisData | null {
  if (!isRecord(value)) {
    return null;
  }

  return value as ClipAnalysisData;
}

export function canRenderClipAnalysisResult(tool: string, data: unknown): boolean {
  if (!CLIP_ANALYSIS_TOOLS.has(tool) || !isRecord(data)) {
    return false;
  }

  return (
    'fingerprint' in data ||
    'samples' in data ||
    'mapping' in data ||
    'clips' in data ||
    'observations' in data ||
    'hits' in data ||
    'ranges' in data ||
    tool === 'map_timeline_to_source'
  );
}

function formatSec(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(3)}s` : '-';
}

function resolveImageSrc(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

function formatConfidence(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : '-';
}

function StatusChip({ children, tone = 'default' }: { children: React.ReactNode; tone?: string }) {
  const toneClass =
    tone === 'ready'
      ? 'border-green-500/30 bg-green-500/10 text-green-300'
      : tone === 'warning'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
        : 'border-border-subtle bg-surface-base text-text-secondary';

  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] ${toneClass}`}>{children}</span>
  );
}

function CompactList({ values }: { values?: string[] }) {
  const items = Array.isArray(values) ? values.filter(Boolean).slice(0, 3) : [];
  if (items.length === 0) {
    return null;
  }

  return (
    <>
      {items.map((item) => (
        <StatusChip key={item}>{item}</StatusChip>
      ))}
    </>
  );
}

function SemanticObservationGrid({ observations }: { observations: ClipSemanticObservation[] }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {observations.slice(0, 4).map((observation, index) => (
        <figure
          key={observation.sampleId ?? `${observation.imagePath ?? 'observation'}-${index}`}
          className="overflow-hidden rounded-md border border-border-subtle bg-surface-base"
        >
          {observation.imagePath ? (
            <img
              src={resolveImageSrc(observation.imagePath)}
              alt={`Observation ${observation.sampleId ?? index + 1}`}
              className="aspect-video w-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex aspect-video items-center justify-center text-xs text-text-tertiary">
              No frame
            </div>
          )}
          <figcaption className="space-y-1 px-2 py-1.5 text-[11px] text-text-secondary">
            {observation.description && (
              <p className="line-clamp-2 text-xs leading-snug text-text-primary">
                {observation.description}
              </p>
            )}
            <div>
              T {formatSec(observation.timelineSec)} → S {formatSec(observation.sourceSec)}
              {typeof observation.frameIndex === 'number' ? ` · F ${observation.frameIndex}` : ''}
            </div>
            <div className="flex flex-wrap gap-1">
              {observation.evidenceSource && <StatusChip>{observation.evidenceSource}</StatusChip>}
              {observation.provider?.provider && (
                <StatusChip>{observation.provider.provider}</StatusChip>
              )}
              <StatusChip>{formatConfidence(observation.confidence)}</StatusChip>
              <CompactList values={observation.visibleText} />
              <CompactList values={observation.objects} />
              <CompactList values={observation.actions} />
            </div>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

function ClipSearchEvidenceView({ hits }: { hits: ClipEvidenceSearchHit[] }) {
  return (
    <section className="space-y-2 border-t border-border-subtle pt-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-text-primary">Search Hits</span>
        <StatusChip>{hits.length} matches</StatusChip>
      </div>
      <div className="space-y-2">
        {hits.slice(0, 5).map((hit, index) => (
          <div
            key={`${hit.perceptionFingerprint ?? 'hit'}-${hit.sampleId ?? index}`}
            className="rounded-md border border-border-subtle bg-surface-base px-2 py-1.5"
          >
            <p className="text-xs leading-snug text-text-primary">
              {hit.description ?? 'Clip evidence match'}
            </p>
            <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-text-secondary">
              {hit.clipId && <StatusChip>{hit.clipId}</StatusChip>}
              <StatusChip>T {formatSec(hit.timelineSec)}</StatusChip>
              <StatusChip>S {formatSec(hit.sourceSec)}</StatusChip>
              <StatusChip>{formatConfidence(hit.confidence)}</StatusChip>
              <CompactList values={hit.matchedFields} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SemanticEditPlanView({ plan }: { plan: ClipAnalysisData }) {
  const ranges = Array.isArray(plan.ranges) ? plan.ranges : [];

  return (
    <section className="space-y-2 border-t border-border-subtle pt-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-text-primary">Temporal Edit Plan</span>
        {plan.action && <StatusChip>{plan.action}</StatusChip>}
        {plan.query && <StatusChip>{plan.query}</StatusChip>}
        <StatusChip>{ranges.length} ranges</StatusChip>
      </div>

      {plan.summary && (
        <p className="text-xs leading-relaxed text-text-secondary">{plan.summary}</p>
      )}

      <div className="space-y-2">
        {ranges.slice(0, 5).map((range, index) => {
          const evidence = Array.isArray(range.evidence) ? range.evidence : [];
          const spatialTargets = Array.isArray(range.spatialTargets) ? range.spatialTargets : [];
          const commandDrafts = Array.isArray(range.commandDrafts) ? range.commandDrafts : [];
          const warnings = Array.isArray(range.warnings) ? range.warnings : [];
          const firstEvidence = evidence[0];
          const rangeKey = range.rangeId ?? `${range.timelineStartSec ?? 'range'}-${index}`;

          return (
            <div
              key={rangeKey}
              className="rounded-md border border-border-subtle bg-surface-base px-2 py-1.5"
            >
              <div className="flex flex-wrap gap-1 text-[11px] text-text-secondary">
                <StatusChip>
                  T {formatSec(range.timelineStartSec)} → {formatSec(range.timelineEndSec)}
                </StatusChip>
                <StatusChip>{formatConfidence(range.confidence)}</StatusChip>
                {spatialTargets.length > 0 && (
                  <StatusChip>{spatialTargets.length} masks</StatusChip>
                )}
                <CompactList values={range.matchedFields} />
              </div>

              {firstEvidence?.description && (
                <p className="mt-1 text-xs leading-snug text-text-primary">
                  {firstEvidence.description}
                </p>
              )}

              {spatialTargets.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {spatialTargets.slice(0, 3).map((target, targetIndex) => (
                    <StatusChip
                      key={target.targetId ?? `${target.label ?? 'target'}-${targetIndex}`}
                    >
                      {target.label ?? target.kind ?? 'mask target'}
                    </StatusChip>
                  ))}
                </div>
              )}

              {commandDrafts.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {commandDrafts.slice(0, 4).map((draft, draftIndex) => {
                    const requiresResolution = Array.isArray(draft.requiresResolution)
                      ? draft.requiresResolution.length > 0
                      : false;
                    const label = `${draft.commandType ?? 'Draft'}${
                      requiresResolution ? ' needs ID' : ''
                    }`;

                    return (
                      <StatusChip key={`${draft.commandType ?? 'draft'}-${draftIndex}`}>
                        {label}
                      </StatusChip>
                    );
                  })}
                </div>
              )}

              {warnings.length > 0 && (
                <div className="mt-1 rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1 text-xs text-amber-200">
                  {warnings[0]}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ClipEvidenceView({ clip }: { clip: ClipAnalysisData }) {
  const samples = Array.isArray(clip.samples) ? clip.samples : [];
  const mapping = Array.isArray(clip.mapping) ? clip.mapping : [];
  const observations = Array.isArray(clip.observations) ? clip.observations : [];
  const errors = Array.isArray(clip.errors) ? clip.errors : [];
  const recommendedActions = Array.isArray(clip.quality?.recommendedActions)
    ? clip.quality.recommendedActions
    : [];
  const readySampleCount =
    typeof clip.readySampleCount === 'number'
      ? clip.readySampleCount
      : samples.filter((sample) => sample.extractionStatus === 'ready').length;
  const sampleCount = typeof clip.sampleCount === 'number' ? clip.sampleCount : samples.length;
  const qualityStatus = clip.quality?.status ?? 'unknown';
  const qualityTone =
    qualityStatus === 'ready' ? 'ready' : qualityStatus === 'unknown' ? 'default' : 'warning';

  return (
    <section className="space-y-2 border-t border-border-subtle pt-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-text-primary">
          {clip.assetName ?? clip.clipId ?? 'Clip'}
        </span>
        {clip.clipId && <StatusChip>{clip.clipId}</StatusChip>}
        <StatusChip tone={qualityTone}>
          {qualityStatus}
          {typeof clip.quality?.score === 'number' ? ` ${clip.quality.score}/100` : ''}
        </StatusChip>
        {clip.quality?.semanticCoverage && <StatusChip>{clip.quality.semanticCoverage}</StatusChip>}
        {observations.length > 0 ? (
          <StatusChip>{observations.length} observations</StatusChip>
        ) : (
          <StatusChip>
            {readySampleCount}/{sampleCount} frames ready
          </StatusChip>
        )}
      </div>

      {clip.summary && (
        <p className="text-xs leading-relaxed text-text-secondary">{clip.summary}</p>
      )}

      {observations.length > 0 && <SemanticObservationGrid observations={observations} />}

      {samples.length > 0 && observations.length === 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {samples.slice(0, 4).map((sample, index) => (
            <figure
              key={sample.sampleId ?? `${sample.imagePath ?? 'sample'}-${index}`}
              className="overflow-hidden rounded-md border border-border-subtle bg-surface-base"
            >
              {sample.imagePath ? (
                <img
                  src={resolveImageSrc(sample.imagePath)}
                  alt={`Sample ${sample.sampleId ?? index + 1}`}
                  className="aspect-video w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="flex aspect-video items-center justify-center text-xs text-text-tertiary">
                  No frame
                </div>
              )}
              <figcaption className="space-y-0.5 px-2 py-1 text-[11px] text-text-secondary">
                <div>T {formatSec(sample.timelineSec)}</div>
                <div>
                  S {formatSec(sample.sourceSec)}
                  {typeof sample.frameIndex === 'number' ? ` · F ${sample.frameIndex}` : ''}
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {mapping.length > 0 && samples.length === 0 && (
        <div className="space-y-1 text-xs text-text-secondary">
          {mapping.slice(0, 4).map((entry, index) => (
            <div key={`${entry.timelineSec ?? index}-${entry.frameIndex ?? 'none'}`}>
              T {formatSec(entry.timelineSec)} → S {formatSec(entry.sourceSec)}
              {typeof entry.frameIndex === 'number' ? ` · frame ${entry.frameIndex}` : ''}
              {entry.insideClip === false ? ` · ${entry.reason ?? 'outside clip'}` : ''}
            </div>
          ))}
        </div>
      )}

      {recommendedActions.length > 0 && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-xs text-amber-200">
          {recommendedActions[0]}
          {recommendedActions.length > 1 ? ` (+${recommendedActions.length - 1} more)` : ''}
        </div>
      )}

      {errors.length > 0 && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-xs text-amber-200">
          {errors[0]}
          {errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}
        </div>
      )}
    </section>
  );
}

export function ClipAnalysisResultCard({ tool, data }: ClipAnalysisResultCardProps) {
  if (!canRenderClipAnalysisResult(tool, data)) {
    return null;
  }

  const root = asClipAnalysisData(data);
  if (!root) {
    return null;
  }

  const hits = Array.isArray(root.hits) ? root.hits : [];
  const ranges = Array.isArray(root.ranges) ? root.ranges : [];
  const clips = Array.isArray(root.clips) ? root.clips : [root];

  return (
    <div className="mt-2 space-y-3 rounded-lg border border-border-subtle bg-surface-elevated/70 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-[0.08em] text-text-tertiary">
          Clip Evidence
        </span>
        <StatusChip>{tool}</StatusChip>
        {typeof root.clips?.length === 'number' && (
          <StatusChip>{root.clips.length} clips</StatusChip>
        )}
        {hits.length > 0 && <StatusChip>{hits.length} hits</StatusChip>}
        {ranges.length > 0 && <StatusChip>{ranges.length} ranges</StatusChip>}
      </div>
      <div className="space-y-3">
        {ranges.length > 0 ? (
          <SemanticEditPlanView plan={root} />
        ) : hits.length > 0 ? (
          <ClipSearchEvidenceView hits={hits} />
        ) : (
          clips
            .slice(0, 3)
            .map((clip, index) => (
              <ClipEvidenceView
                key={clip.perceptionFingerprint ?? clip.fingerprint ?? clip.clipId ?? index}
                clip={clip}
              />
            ))
        )}
      </div>
    </div>
  );
}
