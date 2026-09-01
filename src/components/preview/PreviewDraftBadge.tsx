/**
 * PreviewDraftBadge Component
 *
 * Chip shown over a paused preview frame the live canvas cannot draw faithfully
 * and the render cache has not filled yet.
 *
 * The picture on screen is a best-effort guess in that state — an unsupported
 * blend mode folded down to normal, a transition drawn as a hard cut — so the
 * badge says so rather than letting the frame pass for the export composite.
 * It disappears the moment the segment's cached file lands, because a cached
 * frame *is* the export composite.
 */

import { AlertTriangle } from 'lucide-react';

/** Wording is deliberately explicit: "draft" alone reads as a proxy resolution hint. */
const DRAFT_LABEL = 'DRAFT — preview may differ from export';

/**
 * Renders the draft-frame warning chip.
 *
 * @returns The badge element
 */
export function PreviewDraftBadge(): JSX.Element {
  return (
    <div
      data-testid="preview-draft-badge"
      // Announced politely rather than as an alert: it reports the fidelity of
      // what is already on screen, and it appears and clears as the playhead
      // moves between segments.
      role="status"
      aria-live="polite"
      className="absolute left-2 top-2 flex items-center gap-1.5 rounded border border-amber-400/40 bg-amber-950/80 px-2 py-1 text-xs text-white shadow-lg backdrop-blur-sm"
      style={{ zIndex: 45 }}
      title="This frame was composited by the live preview, which cannot reproduce every export effect. Render the preview cache for an exact frame."
    >
      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{DRAFT_LABEL}</span>
    </div>
  );
}
