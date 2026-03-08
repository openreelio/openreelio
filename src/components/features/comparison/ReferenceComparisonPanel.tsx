import { memo, useMemo } from 'react';
import type { ContentSegment, SegmentType } from '@/bindings';
import { useReferenceComparison } from '@/hooks/useReferenceComparison';
import type { OutputStructureSegment } from '@/utils/referenceComparison';
import { PacingCurveChart } from './PacingCurveChart';
import { TransitionDiffTable } from './TransitionDiffTable';

type StructureSegment = ContentSegment | OutputStructureSegment;
type StructureSegmentType = SegmentType | 'output';

/** Props for the ReferenceComparisonPanel component */
export interface ReferenceComparisonPanelProps {
  /** ESD ID to compare against; when omitted, the latest ESD is used if available */
  esdId?: string;
  /** Optional CSS class name */
  className?: string;
}

const SEG_COLORS: Record<StructureSegmentType, string> = {
  talk: 'bg-blue-500',
  performance: 'bg-purple-500',
  reaction: 'bg-green-500',
  transition: 'bg-yellow-500',
  establishing: 'bg-teal-500',
  montage: 'bg-red-500',
  output: 'bg-slate-500',
};

const SEG_LABELS: Record<StructureSegmentType, string> = {
  talk: 'Talk',
  performance: 'Performance',
  reaction: 'Reaction',
  transition: 'Transition',
  establishing: 'Establishing',
  montage: 'Montage',
  output: 'Output',
};

interface StructureBarProps {
  /** Label for this bar */
  label: string;
  /** Segments to visualize */
  segments: StructureSegment[];
  /** Total duration used for width normalization */
  totalDuration: number;
}

const StructureBar = memo(function StructureBar({
  label,
  segments,
  totalDuration,
}: StructureBarProps) {
  if (totalDuration <= 0 || segments.length === 0) {
    return (
      <div className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-[10px] text-editor-text-muted">{label}</span>
        <div className="flex h-4 flex-1 items-center justify-center rounded bg-editor-border/50 text-[10px] text-editor-text-muted">
          No data
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[10px] text-editor-text-muted">{label}</span>
      <div className="flex h-4 flex-1 overflow-hidden rounded">
        {segments.map((segment, index) => {
          const widthPercent = ((segment.endSec - segment.startSec) / totalDuration) * 100;
          if (widthPercent < 0.5) return null;
          return (
            <div
              key={`${segment.segmentType}-${index}`}
              className={`${SEG_COLORS[segment.segmentType]} opacity-80 transition-opacity hover:opacity-100`}
              style={{ width: `${widthPercent}%` }}
              title={`${SEG_LABELS[segment.segmentType]}: ${(segment.endSec - segment.startSec).toFixed(1)}s`}
            />
          );
        })}
      </div>
    </div>
  );
});

const SegmentLegend = memo(function SegmentLegend({ types }: { types: SegmentType[] }) {
  if (types.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {types.map((type) => (
        <div key={type} className="flex items-center gap-1">
          <span className={`h-2 w-2 rounded-sm ${SEG_COLORS[type]}`} />
          <span className="text-[10px] text-editor-text-muted">{SEG_LABELS[type]}</span>
        </div>
      ))}
    </div>
  );
});

const EmptyState = ({ className }: { className: string }) => (
  <div
    className={`flex h-full items-center justify-center text-sm text-editor-text-muted ${className}`}
    data-testid="comparison-empty"
  >
    Analyze a reference video to compare editing styles
  </div>
);

const LoadingState = ({ className }: { className: string }) => (
  <div
    className={`flex h-full items-center justify-center text-sm text-editor-text-muted ${className}`}
    data-testid="comparison-loading"
  >
    <span className="mr-2 h-2 w-2 rounded-full bg-primary-400 animate-pulse" />
    Loading style document...
  </div>
);

const ErrorState = ({ className, error }: { className: string; error: string }) => (
  <div
    className={`flex h-full items-center justify-center text-sm text-red-400 ${className}`}
    data-testid="comparison-error"
  >
    {error}
  </div>
);

export const ReferenceComparisonPanel = memo(function ReferenceComparisonPanel({
  esdId,
  className = '',
}: ReferenceComparisonPanelProps) {
  const {
    esd,
    referenceCurve,
    outputCurve,
    outputStructure,
    correlation,
    transitionDiffs,
    isLoading,
    error,
  } = useReferenceComparison(esdId);
  const referenceDuration = useMemo(
    () =>
      esd?.contentMap.length ? Math.max(...esd.contentMap.map((segment) => segment.endSec)) : 0,
    [esd],
  );
  const outputDuration = useMemo(
    () =>
      outputStructure.length ? Math.max(...outputStructure.map((segment) => segment.endSec)) : 0,
    [outputStructure],
  );
  const segmentTypes = useMemo(
    () => (!esd ? [] : Array.from(new Set(esd.contentMap.map((segment) => segment.segmentType)))),
    [esd],
  );

  if (!isLoading && !error && !esd) return <EmptyState className={className} />;
  if (isLoading) return <LoadingState className={className} />;
  if (error) return <ErrorState className={className} error={error} />;
  if (!esd) return null;

  return (
    <div
      className={`flex h-full flex-col gap-3 overflow-auto p-3 ${className}`}
      data-testid="reference-comparison-panel"
    >
      <section>
        <h3 className="mb-2 text-xs font-medium text-editor-text">Content Structure</h3>
        <StructureBar
          label="Reference"
          segments={esd.contentMap}
          totalDuration={referenceDuration}
        />
        <div className="mt-2">
          <StructureBar label="Output" segments={outputStructure} totalDuration={outputDuration} />
        </div>
        <div className="mt-2">
          <SegmentLegend types={segmentTypes} />
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-xs font-medium text-editor-text">Pacing Comparison</h3>
        <PacingCurveChart
          referenceCurve={referenceCurve}
          outputCurve={outputCurve}
          correlation={correlation}
          width={380}
          height={160}
        />
      </section>
      <section>
        <h3 className="mb-2 text-xs font-medium text-editor-text">Transition Types</h3>
        <TransitionDiffTable rows={transitionDiffs} />
      </section>
    </div>
  );
});

export default ReferenceComparisonPanel;
