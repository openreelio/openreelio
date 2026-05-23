import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

export interface TextPlacementCommitPayload {
  content: string;
  position: {
    x: number;
    y: number;
  };
}

export interface TextPlacementOverlayProps {
  active: boolean;
  aspectRatio: number;
  onCommit?: (payload: TextPlacementCommitPayload) => void | Promise<void>;
  zIndex?: number;
}

interface DraftTextPlacement {
  value: string;
  leftPx: number;
  topPx: number;
  position: TextPlacementCommitPayload['position'];
}

const INPUT_WIDTH_PX = 280;
const MIN_CONTENT_SIZE_PX = 1;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, value));
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  return Boolean(
    target.closest(
      'button, input, textarea, select, a, [role="button"], [data-text-placement-control]',
    ),
  );
}

function resolveContainedPosition(
  rect: DOMRect,
  clientX: number,
  clientY: number,
  aspectRatio: number,
): DraftTextPlacement {
  const safeAspectRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 16 / 9;
  const containerRatio =
    rect.width > 0 && rect.height > 0 ? rect.width / rect.height : safeAspectRatio;

  let contentWidth = Math.max(MIN_CONTENT_SIZE_PX, rect.width);
  let contentHeight = Math.max(MIN_CONTENT_SIZE_PX, rect.height);
  let contentLeft = 0;
  let contentTop = 0;

  if (containerRatio > safeAspectRatio) {
    contentHeight = Math.max(MIN_CONTENT_SIZE_PX, rect.height);
    contentWidth = Math.max(MIN_CONTENT_SIZE_PX, contentHeight * safeAspectRatio);
    contentLeft = (rect.width - contentWidth) / 2;
  } else {
    contentWidth = Math.max(MIN_CONTENT_SIZE_PX, rect.width);
    contentHeight = Math.max(MIN_CONTENT_SIZE_PX, contentWidth / safeAspectRatio);
    contentTop = (rect.height - contentHeight) / 2;
  }

  const relativeX = clientX - rect.left - contentLeft;
  const relativeY = clientY - rect.top - contentTop;
  const x = clamp01(relativeX / contentWidth);
  const y = clamp01(relativeY / contentHeight);

  return {
    value: '',
    leftPx: contentLeft + x * contentWidth,
    topPx: contentTop + y * contentHeight,
    position: { x, y },
  };
}

export function TextPlacementOverlay({
  active,
  aspectRatio,
  onCommit,
  zIndex,
}: TextPlacementOverlayProps): JSX.Element | null {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef<DraftTextPlacement | null>(null);
  const [draft, setDraft] = useState<DraftTextPlacement | null>(null);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    if (!active) {
      draftRef.current = null;
      setDraft(null);
    }
  }, [active]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [draft?.leftPx, draft?.topPx]);

  const commitDraft = useCallback(() => {
    const current = draftRef.current;
    if (!current) {
      return;
    }

    draftRef.current = null;
    setDraft(null);

    const content = current.value.trim();
    if (!content || !onCommit) {
      return;
    }

    try {
      const result = onCommit({
        content,
        position: current.position,
      });
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // The editor owns user-facing command errors; keep the overlay disposable.
    }
  }, [onCommit]);

  const cancelDraft = useCallback(() => {
    draftRef.current = null;
    setDraft(null);
  }, []);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!active || event.button !== 0 || isInteractiveTarget(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (draftRef.current) {
        return;
      }

      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }

      setDraft(resolveContainedPosition(rect, event.clientX, event.clientY, aspectRatio));
    },
    [active, aspectRatio],
  );

  const handleDraftChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setDraft((current) => (current ? { ...current, value } : current));
  }, []);

  const handleDraftKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      event.stopPropagation();

      if (event.key === 'Escape') {
        event.preventDefault();
        cancelDraft();
        return;
      }

      if (event.nativeEvent.isComposing) {
        return;
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        commitDraft();
      }
    },
    [cancelDraft, commitDraft],
  );

  if (!active) {
    return null;
  }

  return (
    <div
      data-testid="text-placement-overlay"
      className="absolute inset-0"
      style={{ cursor: 'text', zIndex }}
      onPointerDown={handlePointerDown}
    >
      {draft && (
        <textarea
          ref={inputRef}
          data-testid="text-placement-input"
          value={draft.value}
          rows={1}
          className="absolute resize-none rounded border border-teal-300 bg-black/55 px-2 py-1 text-center text-3xl font-semibold text-white shadow-lg outline-none ring-2 ring-teal-400/40 backdrop-blur-sm"
          style={{
            left: draft.leftPx,
            top: draft.topPx,
            width: INPUT_WIDTH_PX,
            minHeight: 48,
            transform: 'translate(-50%, -50%)',
          }}
          onChange={handleDraftChange}
          onKeyDown={handleDraftKeyDown}
          onBlur={commitDraft}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        />
      )}
    </div>
  );
}
