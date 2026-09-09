/**
 * PreviewDraftBadge Component
 *
 * Chip shown over a paused preview frame the live preview cannot draw
 * faithfully and the render cache has not filled yet.
 *
 * The picture on screen is a best-effort guess in that state — an unsupported
 * blend mode folded down to normal, a transition drawn as a hard cut, a caption
 * laid out by the browser rather than burned in by libass — so the badge says
 * so rather than letting the frame pass for the export composite. It disappears
 * the moment the segment's cached file lands, because a cached frame *is* the
 * export composite.
 */

import { AlertTriangle } from 'lucide-react';

/** Wording is deliberately explicit: "draft" alone reads as a proxy resolution hint. */
const DRAFT_LABEL = 'DRAFT — preview may differ from export';

const COMPOSITE_TITLE =
  'This frame was composited by the live preview, which cannot reproduce every export effect. ' +
  'Render the preview cache for an exact frame.';

/**
 * Why the frame on screen is a draft, which decides the badge's tooltip.
 *
 * `text` is a narrower claim than `composite` and worth making separately: the
 * preview now draws captions and text in the same faces the export embeds, so
 * the remaining difference is layout — line breaking above all, which the draft
 * does not do at all — not the typeface. Saying "may differ" without saying how
 * invites the reader to distrust the part that is now correct.
 */
export type PreviewDraftReason = 'composite' | 'text';

const TITLE_BY_REASON: Record<PreviewDraftReason, string> = {
  composite: COMPOSITE_TITLE,
  text:
    'Text and captions are drawn here by the browser in the same fonts the export embeds, ' +
    'but the export burns them in with libass: line breaks, kerning and antialiasing can differ. ' +
    'Render the preview cache for an exact frame.',
};

/** Props for {@link PreviewDraftBadge}. */
export interface PreviewDraftBadgeProps {
  /** What makes this frame a draft. Defaults to the whole-composite case. */
  reason?: PreviewDraftReason;
}

/**
 * Renders the draft-frame warning chip.
 *
 * @param props - Which kind of draft this frame is.
 * @returns The badge element
 */
export function PreviewDraftBadge({ reason = 'composite' }: PreviewDraftBadgeProps): JSX.Element {
  return (
    <div
      data-testid="preview-draft-badge"
      data-draft-reason={reason}
      // Announced politely rather than as an alert: it reports the fidelity of
      // what is already on screen, and it appears and clears as the playhead
      // moves between segments.
      role="status"
      aria-live="polite"
      className="absolute left-2 top-2 flex items-center gap-1.5 rounded border border-amber-400/40 bg-amber-950/80 px-2 py-1 text-xs text-white shadow-lg backdrop-blur-sm"
      style={{ zIndex: 45 }}
      title={TITLE_BY_REASON[reason]}
    >
      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{DRAFT_LABEL}</span>
    </div>
  );
}
