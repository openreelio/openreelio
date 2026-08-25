/**
 * ExportValidationNotice
 *
 * Presents what the export preflight found, grouped by severity. Errors block
 * the export outright; warnings only describe how the file will differ from the
 * timeline, so the user is offered the choice to export anyway.
 *
 * Every finding that knows its clip is rendered as a button that jumps to it.
 */

import { AlertTriangle, XCircle } from 'lucide-react';
import type { ExportFinding } from './types';
import type { JumpToClipHandler } from './useExportFindingNavigation';

/** Props for {@link ExportValidationNotice}. */
export interface ExportValidationNoticeProps {
  /** Findings returned by the preflight, in validator order */
  findings: ExportFinding[];
  /** Whether at least one finding is an error, which blocks the export */
  blocked: boolean;
  /** Reveal the clip a finding points at */
  onJumpToClip: JumpToClipHandler;
  /** Proceed with the export despite the warnings */
  onExportAnyway: () => void;
  /** Close without exporting */
  onCancel: () => void;
}

interface FindingListProps {
  findings: ExportFinding[];
  onJumpToClip: JumpToClipHandler;
  testId: string;
}

const ROW_BASE_CLASS = 'block w-full rounded-md px-3 py-2 text-left text-xs leading-relaxed';

const SEVERITY_ROW_CLASS: Record<ExportFinding['severity'], string> = {
  error: 'border border-red-500/30 bg-red-500/10 text-red-200',
  warning: 'border border-amber-500/30 bg-amber-500/10 text-amber-200',
};

function FindingList({ findings, onJumpToClip, testId }: FindingListProps): JSX.Element {
  return (
    <ul className="mt-2 space-y-1.5" data-testid={testId}>
      {findings.map((finding, index) => {
        const rowClass = `${ROW_BASE_CLASS} ${SEVERITY_ROW_CLASS[finding.severity]}`;
        const key = `${finding.severity}-${finding.clipId ?? 'sequence'}-${index}`;

        if (!finding.clipId) {
          return (
            <li key={key}>
              <p className={rowClass}>{finding.message}</p>
            </li>
          );
        }

        const clipId = finding.clipId;
        return (
          <li key={key}>
            <button
              type="button"
              className={`${rowClass} transition-colors hover:brightness-125 focus:outline-none focus:ring-1 focus:ring-primary-500`}
              data-testid={`export-finding-${clipId}`}
              onClick={() => onJumpToClip(clipId, finding.sequenceId)}
            >
              {finding.message}
              <span className="mt-1 block text-[11px] uppercase tracking-[0.08em] opacity-70">
                Go to clip
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Lists the preflight findings and offers the only actions that make sense for
 * their severity.
 */
export function ExportValidationNotice({
  findings,
  blocked,
  onJumpToClip,
  onExportAnyway,
  onCancel,
}: ExportValidationNoticeProps): JSX.Element {
  const errors = findings.filter((finding) => finding.severity === 'error');
  const warnings = findings.filter((finding) => finding.severity === 'warning');

  return (
    <div className="py-2" data-testid="export-validation-notice">
      <div className="flex items-start gap-3">
        {blocked ? (
          <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" aria-hidden="true" />
        ) : (
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden="true" />
        )}
        <div>
          <h3 className="text-sm font-medium text-editor-text">
            {blocked
              ? 'This sequence cannot be exported yet'
              : 'Export will differ from the timeline'}
          </h3>
          <p className="mt-1 text-xs text-editor-text-muted">
            {blocked
              ? 'Fix the problems below, then export again. Select a row to jump to the clip.'
              : 'The export can run, but these details will not survive the render. Select a row to jump to the clip.'}
          </p>
        </div>
      </div>

      {errors.length > 0 && (
        <section className="mt-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-red-400">
            Blocking ({errors.length})
          </p>
          <FindingList
            findings={errors}
            onJumpToClip={onJumpToClip}
            testId="export-validation-errors"
          />
        </section>
      )}

      {warnings.length > 0 && (
        <section className="mt-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-amber-400">
            Warnings ({warnings.length})
          </p>
          <FindingList
            findings={warnings}
            onJumpToClip={onJumpToClip}
            testId="export-validation-warnings"
          />
        </section>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          data-testid="export-validation-cancel"
          className="rounded-md border border-editor-border px-4 py-2 text-sm text-editor-text transition-colors hover:bg-editor-sidebar"
        >
          {blocked ? 'Close' : 'Cancel'}
        </button>
        {!blocked && (
          <button
            type="button"
            onClick={onExportAnyway}
            data-testid="export-validation-proceed"
            className="rounded-md bg-primary-600 px-4 py-2 text-sm text-white transition-colors hover:bg-primary-700"
          >
            Export anyway
          </button>
        )}
      </div>
    </div>
  );
}
