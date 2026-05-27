import type {
  AssetAnnotation,
  BoundingBox,
  FaceDetection,
  ObjectDetection,
  TextDetection,
} from '@/bindings';
import type { Sequence, TextClipAlignment, TextClipData, TextPosition } from '@/types';

export type TextPlacementIntent = 'default' | 'title' | 'subtitle' | 'lower_third' | 'callout';

export interface TextPlacementOptions {
  intent: TextPlacementIntent;
  safeMargin: number;
  avoidFaces: boolean;
  avoidObjects: boolean;
  avoidText: boolean;
}

export interface TextPlacementObstacle {
  type: 'face' | 'object' | 'ocr' | 'existing_text';
  box: BoundingBox;
  weight: number;
  label?: string;
  confidence?: number;
}

export interface ExistingTextPlacement {
  textData: TextClipData;
  weight?: number;
}

export interface TextPlacementDecision {
  position: TextPosition;
  candidate: string;
  score: number;
  reason: string;
  obstacleCount: number;
}

interface PlacementCandidate {
  id: string;
  position: TextPosition;
  alignment?: TextClipAlignment;
  priority: number;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

const DEFAULT_SAFE_MARGIN = 0.08;

export function parseTextPlacementOptions(args: Record<string, unknown>): TextPlacementOptions {
  const placementArg = objectArg(args.placement);
  const rawIntent =
    readString(args.placementIntent) ??
    readString(args.intent) ??
    readString(placementArg?.intent) ??
    (typeof args.placement === 'string' ? args.placement : undefined);

  return {
    intent: normalizePlacementIntent(rawIntent),
    safeMargin: clampFinite(
      numberArg(args.safeMargin) ?? numberArg(placementArg?.safeMargin),
      0.02,
      0.2,
      DEFAULT_SAFE_MARGIN,
    ),
    avoidFaces: booleanArg(args.avoidFaces) ?? booleanArg(placementArg?.avoidFaces) ?? true,
    avoidObjects: booleanArg(args.avoidObjects) ?? booleanArg(placementArg?.avoidObjects) ?? true,
    avoidText: booleanArg(args.avoidText) ?? booleanArg(placementArg?.avoidText) ?? true,
  };
}

export function shouldAutoPlaceText(args: Record<string, unknown>, isCreate: boolean): boolean {
  if (args.autoPlacement === false || args.placement === false) {
    return false;
  }

  if (
    args.autoPlacement === true ||
    args.placement !== undefined ||
    args.placementIntent !== undefined ||
    args.intent !== undefined
  ) {
    return true;
  }

  return isCreate && !hasExplicitTextPosition(args);
}

export function hasExplicitTextPosition(args: Record<string, unknown>): boolean {
  if (args.position !== undefined || args.x !== undefined || args.y !== undefined) {
    return true;
  }

  return args.xPercent !== undefined || args.yPercent !== undefined;
}

export function resolveSmartTextPlacement({
  textData,
  sequence,
  options,
  obstacles,
  existingText,
}: {
  textData: TextClipData;
  sequence: Sequence;
  options: TextPlacementOptions;
  obstacles: TextPlacementObstacle[];
  existingText: ExistingTextPlacement[];
}): TextPlacementDecision {
  const estimatedRect = estimateTextRect(textData, sequence);
  const safeRect = {
    left: options.safeMargin,
    top: options.safeMargin,
    right: 1 - options.safeMargin,
    bottom: 1 - options.safeMargin,
  };
  const existingObstacles = existingText.map(
    (entry): TextPlacementObstacle => ({
      type: 'existing_text',
      box: rectToBox(estimateTextRect(entry.textData, sequence)),
      weight: entry.weight ?? 4,
      label: 'existing text',
    }),
  );
  const effectiveObstacles = [
    ...obstacles.filter((obstacle) => shouldUseObstacle(obstacle, options)),
    ...(options.avoidText ? existingObstacles : []),
  ];

  const candidates = buildPlacementCandidates(options.intent, textData.style.alignment);
  let best: {
    candidate: PlacementCandidate;
    rect: Rect;
    score: number;
    reason: string;
  } | null = null;

  for (const candidate of candidates) {
    const rect = rectAtPosition(
      estimatedRect,
      candidate.position,
      candidate.alignment ?? textData.style.alignment,
    );
    const score = scoreCandidate(rect, candidate, safeRect, effectiveObstacles);
    if (!best || score > best.score) {
      best = {
        candidate,
        rect,
        score,
        reason: summarizeCandidate(candidate, score, effectiveObstacles.length),
      };
    }
  }

  const fallback = candidates[0];
  const selected = best?.candidate ?? fallback;
  return {
    position: clampPositionForRect(
      selected.position,
      best?.rect ??
        rectAtPosition(
          estimatedRect,
          selected.position,
          selected.alignment ?? textData.style.alignment,
        ),
      safeRect,
      selected.alignment ?? textData.style.alignment,
    ),
    candidate: selected.id,
    score: round(best?.score ?? 0),
    reason: best?.reason ?? `Selected ${selected.id} from default ${options.intent} placement.`,
    obstacleCount: effectiveObstacles.length,
  };
}

export function annotationToTextPlacementObstacles(
  annotation: AssetAnnotation | null | undefined,
  sourceTimeSec: number,
  toleranceSec: number,
): TextPlacementObstacle[] {
  if (!annotation) {
    return [];
  }

  const obstacles: TextPlacementObstacle[] = [];
  const addDetection = (
    type: TextPlacementObstacle['type'],
    timeSec: number,
    box: BoundingBox | null | undefined,
    confidence: number,
    weight: number,
    label?: string,
  ) => {
    if (!box || Math.abs(timeSec - sourceTimeSec) > toleranceSec) {
      return;
    }
    obstacles.push({
      type,
      box: clampBox(box),
      confidence,
      weight: weight * Math.max(0.35, Math.min(1, confidence || 1)),
      label,
    });
  };

  for (const face of annotation.analysis.faces?.results ?? []) {
    const detection = face as FaceDetection;
    addDetection('face', detection.timeSec, detection.boundingBox, detection.confidence, 6, 'face');
  }

  for (const object of annotation.analysis.objects?.results ?? []) {
    const detection = object as ObjectDetection;
    const labels = detection.labels ?? [];
    const isPerson = labels.some((label) => /person|face|head|speaker|host|presenter/i.test(label));
    addDetection(
      'object',
      detection.timeSec,
      detection.boundingBox,
      detection.confidence,
      isPerson ? 4 : 1.5,
      labels.slice(0, 3).join(', '),
    );
  }

  for (const text of annotation.analysis.textOcr?.results ?? []) {
    const detection = text as TextDetection;
    addDetection(
      'ocr',
      detection.timeSec,
      detection.boundingBox,
      detection.confidence,
      5,
      detection.text,
    );
  }

  return obstacles;
}

export function estimateTextRect(textData: TextClipData, sequence: Sequence): Rect {
  const canvas = sequence.format.canvas;
  const style = textData.style;
  const lines = textData.content.split(/\r?\n/);
  const maxLineLength = Math.max(1, ...lines.map((line) => line.length));
  const lineCount = Math.max(1, lines.length);
  const fontSize = clampFinite(style.fontSize, 1, 500, 48);
  const padding = clampFinite(style.backgroundPadding, 0, 500, 0);
  const letterSpacing = clampFinite(style.letterSpacing, -500, 500, 0);
  const widthPx = Math.min(
    canvas.width * 0.86,
    Math.max(fontSize * 3, maxLineLength * (fontSize * 0.56 + letterSpacing) + padding * 2),
  );
  const heightPx = Math.min(
    canvas.height * 0.4,
    lineCount * fontSize * clampFinite(style.lineHeight, 0.1, 10, 1.2) + padding * 2,
  );
  const width = clampFinite(widthPx / canvas.width, 0.08, 0.86, 0.35);
  const height = clampFinite(heightPx / canvas.height, 0.035, 0.4, 0.08);

  return rectAtPosition(
    { left: 0, top: 0, right: width, bottom: height, width, height },
    textData.position,
    style.alignment,
  );
}

function buildPlacementCandidates(
  intent: TextPlacementIntent,
  alignment: TextClipAlignment,
): PlacementCandidate[] {
  switch (intent) {
    case 'subtitle':
      return [
        candidate('bottom_center', 0.5, 0.85, alignment, 10),
        candidate('upper_center', 0.5, 0.18, alignment, 8),
        candidate('lower_left', 0.12, 0.78, 'left', 5),
        candidate('lower_right', 0.88, 0.78, 'right', 5),
      ];
    case 'title':
      return [
        candidate('center', 0.5, 0.5, alignment, 10),
        candidate('upper_center', 0.5, 0.24, alignment, 8),
        candidate('lower_center', 0.5, 0.74, alignment, 6),
      ];
    case 'lower_third':
      return [
        candidate('lower_left', 0.1, 0.78, 'left', 10),
        candidate('lower_right', 0.9, 0.78, 'right', 9),
        candidate('lower_center', 0.5, 0.8, alignment, 6),
        candidate('upper_left', 0.1, 0.22, 'left', 5),
      ];
    case 'callout':
      return [
        candidate('upper_left', 0.12, 0.22, 'left', 9),
        candidate('upper_right', 0.88, 0.22, 'right', 9),
        candidate('middle_left', 0.1, 0.5, 'left', 7),
        candidate('middle_right', 0.9, 0.5, 'right', 7),
      ];
    default:
      return [
        candidate('center', 0.5, 0.5, alignment, 8),
        candidate('bottom_center', 0.5, 0.85, alignment, 7),
        candidate('upper_center', 0.5, 0.2, alignment, 6),
        candidate('lower_left', 0.12, 0.78, 'left', 5),
        candidate('lower_right', 0.88, 0.78, 'right', 5),
      ];
  }
}

function scoreCandidate(
  rect: Rect,
  candidate: PlacementCandidate,
  safeRect: Pick<Rect, 'left' | 'top' | 'right' | 'bottom'>,
  obstacles: TextPlacementObstacle[],
): number {
  let score = candidate.priority;

  if (
    rect.left < safeRect.left ||
    rect.right > safeRect.right ||
    rect.top < safeRect.top ||
    rect.bottom > safeRect.bottom
  ) {
    score -= 8;
  }

  for (const obstacle of obstacles) {
    const overlap = intersectionArea(rect, boxToRect(obstacle.box));
    if (overlap <= 0) {
      continue;
    }
    const normalizedOverlap = overlap / Math.max(0.001, rect.width * rect.height);
    score -= normalizedOverlap * obstacle.weight * 10;
  }

  return score;
}

function clampPositionForRect(
  position: TextPosition,
  rect: Rect,
  safeRect: Pick<Rect, 'left' | 'top' | 'right' | 'bottom'>,
  alignment: TextClipAlignment,
): TextPosition {
  let x = position.x;
  if (alignment === 'left') {
    x = clampFinite(x, safeRect.left, safeRect.right - rect.width, position.x);
  } else if (alignment === 'right') {
    x = clampFinite(x, safeRect.left + rect.width, safeRect.right, position.x);
  } else {
    x = clampFinite(x, safeRect.left + rect.width / 2, safeRect.right - rect.width / 2, position.x);
  }

  return {
    x,
    y: clampFinite(
      position.y,
      safeRect.top + rect.height / 2,
      safeRect.bottom - rect.height / 2,
      position.y,
    ),
  };
}

function shouldUseObstacle(
  obstacle: TextPlacementObstacle,
  options: TextPlacementOptions,
): boolean {
  if (obstacle.type === 'face') {
    return options.avoidFaces;
  }
  if (obstacle.type === 'object') {
    return options.avoidObjects;
  }
  if (obstacle.type === 'ocr' || obstacle.type === 'existing_text') {
    return options.avoidText;
  }
  return true;
}

function normalizePlacementIntent(value: string | undefined): TextPlacementIntent {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (normalized === 'title') return 'title';
  if (normalized === 'subtitle' || normalized === 'caption') return 'subtitle';
  if (normalized === 'lower_third' || normalized === 'lowerthird') return 'lower_third';
  if (normalized === 'callout' || normalized === 'label') return 'callout';
  return 'default';
}

function candidate(
  id: string,
  x: number,
  y: number,
  alignment: TextClipAlignment,
  priority: number,
): PlacementCandidate {
  return { id, position: { x, y }, alignment, priority };
}

function rectAtPosition(rect: Rect, position: TextPosition, alignment: TextClipAlignment): Rect {
  let left = position.x - rect.width / 2;
  if (alignment === 'left') {
    left = position.x;
  } else if (alignment === 'right') {
    left = position.x - rect.width;
  }
  const top = position.y - rect.height / 2;
  return {
    left,
    top,
    right: left + rect.width,
    bottom: top + rect.height,
    width: rect.width,
    height: rect.height,
  };
}

function intersectionArea(left: Rect, right: Rect): number {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  return width * height;
}

function boxToRect(box: BoundingBox): Rect {
  const left = box.left;
  const top = box.top;
  const width = box.width;
  const height = box.height;
  return { left, top, right: left + width, bottom: top + height, width, height };
}

function rectToBox(rect: Rect): BoundingBox {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function clampBox(box: BoundingBox): BoundingBox {
  const left = clampFinite(box.left, 0, 1, 0);
  const top = clampFinite(box.top, 0, 1, 0);
  const width = clampFinite(box.width, 0, 1 - left, 0);
  const height = clampFinite(box.height, 0, 1 - top, 0);
  return { left, top, width, height };
}

function summarizeCandidate(
  candidate: PlacementCandidate,
  score: number,
  obstacleCount: number,
): string {
  if (obstacleCount === 0) {
    return `Selected ${candidate.id} from default placement candidates.`;
  }
  return `Selected ${candidate.id} after scoring ${obstacleCount} visual obstacle(s); score ${round(score)}.`;
}

function objectArg(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanArg(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function clampFinite(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
