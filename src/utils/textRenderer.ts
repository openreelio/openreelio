/**
 * Text Rendering Utilities
 *
 * Canvas 2D text rendering functions for text clips in preview.
 */

import type { TextClipData, TextStyle, Clip, Transform } from '@/types';
import { isTextClip } from '@/types';

// =============================================================================
// Text Data Extraction
// =============================================================================

export function getTextFontWeightNumber(style: Pick<TextStyle, 'fontWeight' | 'bold'>): number {
  const fontWeight = style.fontWeight;
  if (typeof fontWeight === 'number' && Number.isFinite(fontWeight)) {
    const normalized = Math.round(Math.max(100, Math.min(900, fontWeight)));
    return style.bold && normalized < 600 ? 700 : normalized;
  }

  return style.bold ? 700 : 400;
}

/**
 * Extracts TextClipData from a text clip.
 *
 * clip.effects contains EffectId[] (strings), not full Effect objects.
 * When available, callers can provide resolved text payloads via textDataByClipId.
 * Without resolved payloads, this falls back to clip label + default style.
 *
 * Returns undefined if not a text clip.
 */
export function extractTextDataFromClip(clip: Clip): TextClipData | undefined {
  return extractTextDataFromClipWithMap(clip);
}

/**
 * Extracts TextClipData from a text clip with optional resolved text map.
 */
export function extractTextDataFromClipWithMap(
  clip: Clip,
  textDataByClipId?: ReadonlyMap<string, TextClipData>,
): TextClipData | undefined {
  // Check if this is a text clip
  if (!isTextClip(clip.assetId)) {
    return undefined;
  }

  const resolvedTextData = textDataByClipId?.get(clip.id);
  if (resolvedTextData) {
    return resolvedTextData;
  }

  // Extract text content from label
  // The label is set to "Text: {content}" format when text clips are created
  let textContent = clip.label || 'Text';

  // Strip "Text: " prefix if present
  if (textContent.startsWith('Text: ')) {
    textContent = textContent.substring(6);
  }

  // Create TextClipData with extracted content and default styling fallback.
  return createBasicTextData(textContent);
}

function clampFinite(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, value));
}

function isIdentityTransform(transform: Transform): boolean {
  return (
    Math.abs(transform.position.x - 0.5) < 0.0001 &&
    Math.abs(transform.position.y - 0.5) < 0.0001 &&
    Math.abs(transform.scale.x - 1) < 0.0001 &&
    Math.abs(transform.scale.y - 1) < 0.0001 &&
    Math.abs(transform.rotationDeg) < 0.0001 &&
    Math.abs(transform.anchor.x - 0.5) < 0.0001 &&
    Math.abs(transform.anchor.y - 0.5) < 0.0001
  );
}

function effectiveTextOpacity(textOpacity: number, clipOpacity: number): number {
  const normalizedTextOpacity = clampFinite(textOpacity, 0, 1, 1);
  const normalizedClipOpacity = clampFinite(clipOpacity, 0, 1, 1);

  // Text commands mirror TextClipData.opacity into clip.opacity for generic layer
  // compatibility. Treat mirrored values as one opacity source instead of
  // multiplying them into a darker preview.
  if (Math.abs(normalizedTextOpacity - normalizedClipOpacity) < 0.001) {
    return normalizedTextOpacity;
  }

  return normalizedTextOpacity * normalizedClipOpacity;
}

function clipScaleFactor(transform: Transform): number {
  const scaleX = clampFinite(Math.abs(transform.scale.x), 0.01, 100, 1);
  const scaleY = clampFinite(Math.abs(transform.scale.y), 0.01, 100, 1);
  return Math.max(0.01, (scaleX + scaleY) / 2);
}

/**
 * Applies clip transform fields that should be visible in the inspector.
 *
 * Scale is intentionally not baked into TextClipData here. The text inspector
 * edits semantic text style, while preview resize persists as clip.transform
 * scale. Baking scale into fontSize would double-apply size on the next update.
 */
export function applyClipTransformToEditableTextData(
  clip: Clip,
  textData: TextClipData,
): TextClipData {
  const transform = clip.transform;
  const nextOpacity = effectiveTextOpacity(textData.opacity, clip.opacity);
  const hasCustomTransform = !isIdentityTransform(transform);

  if (
    !hasCustomTransform &&
    Math.abs(nextOpacity - textData.opacity) < 0.001
  ) {
    return textData;
  }

  return {
    ...textData,
    position: hasCustomTransform
      ? {
          x: clampFinite(transform.position.x, 0, 1, textData.position.x),
          y: clampFinite(transform.position.y, 0, 1, textData.position.y),
        }
      : textData.position,
    rotation:
      hasCustomTransform && Number.isFinite(transform.rotationDeg)
        ? transform.rotationDeg
        : textData.rotation,
    opacity: nextOpacity,
  };
}

/**
 * Applies clip transform fields for rendered preview text.
 *
 * The current text model has semantic font styling but no separate transform
 * payload, so preview rendering folds scale into visible style dimensions.
 * Export keeps the original transform separately and can preserve more detail
 * through ASS/libass.
 */
export function applyClipTransformToRenderedTextData(
  clip: Clip,
  textData: TextClipData,
): TextClipData {
  const editableTextData = applyClipTransformToEditableTextData(clip, textData);

  if (isIdentityTransform(clip.transform)) {
    return editableTextData;
  }

  const scaleFactor = clipScaleFactor(clip.transform);

  return {
    ...editableTextData,
    style: {
      ...editableTextData.style,
      fontSize: Math.max(1, Math.round(editableTextData.style.fontSize * scaleFactor)),
      backgroundPadding: Math.max(
        0,
        Math.round(editableTextData.style.backgroundPadding * scaleFactor),
      ),
      letterSpacing: Math.round(editableTextData.style.letterSpacing * scaleFactor),
    },
    shadow: editableTextData.shadow
      ? {
          ...editableTextData.shadow,
          offsetX: Math.round(editableTextData.shadow.offsetX * scaleFactor),
          offsetY: Math.round(editableTextData.shadow.offsetY * scaleFactor),
          blur: Math.max(0, Math.round(editableTextData.shadow.blur * scaleFactor)),
        }
      : editableTextData.shadow,
    outline: editableTextData.outline
      ? {
          ...editableTextData.outline,
          width:
            editableTextData.outline.width <= 0
              ? 0
              : Math.max(1, Math.round(editableTextData.outline.width * scaleFactor)),
        }
      : editableTextData.outline,
  };
}

/**
 * Creates basic TextClipData from a simple string.
 */
function createBasicTextData(content: string): TextClipData {
  return {
    content,
    style: {
      fontFamily: 'Arial',
      fontSize: 48,
      fontWeight: 400,
      color: '#FFFFFF',
      backgroundPadding: 10,
      alignment: 'center',
      bold: false,
      italic: false,
      underline: false,
      lineHeight: 1.2,
      letterSpacing: 0,
    },
    position: { x: 0.5, y: 0.5 },
    rotation: 0,
    opacity: 1.0,
  };
}

// =============================================================================
// Canvas Rendering
// =============================================================================

/**
 * Renders text clip data to a canvas context.
 */
export function renderTextToCanvas(
  ctx: CanvasRenderingContext2D,
  textData: TextClipData,
  canvasWidth: number,
  canvasHeight: number,
  clipOpacity: number = 1.0,
): void {
  const { content, style, position, shadow, outline, rotation, opacity } = textData;

  // Save context state
  ctx.save();

  // Apply combined opacity
  ctx.globalAlpha = opacity * clipOpacity;

  // Calculate position in pixels
  const textX = position.x * canvasWidth;
  const textY = position.y * canvasHeight;

  // Apply rotation if needed
  if (rotation !== 0) {
    ctx.translate(textX, textY);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.translate(-textX, -textY);
  }

  // Build font string
  const fontStyle = style.italic ? 'italic ' : '';
  const fontWeight = `${getTextFontWeightNumber(style)} `;
  // Scale font size relative to canvas (assuming 1080p reference)
  const scaledFontSize = (style.fontSize * canvasHeight) / 1080;
  ctx.font = `${fontStyle}${fontWeight}${scaledFontSize}px ${style.fontFamily}`;

  // Set text alignment
  ctx.textAlign = style.alignment;
  ctx.textBaseline = 'middle';

  // Measure text for background
  const lines = content.split('\n');
  const lineHeight = scaledFontSize * style.lineHeight;

  // Draw background if specified
  if (style.backgroundColor) {
    drawTextBackground(ctx, lines, textX, textY, scaledFontSize, lineHeight, style);
  }

  // Apply shadow if present
  if (shadow) {
    ctx.shadowColor = shadow.color;
    ctx.shadowOffsetX = shadow.offsetX;
    ctx.shadowOffsetY = shadow.offsetY;
    ctx.shadowBlur = shadow.blur;
  }

  // Draw outline first (if present)
  if (outline && outline.width > 0) {
    ctx.strokeStyle = outline.color;
    ctx.lineWidth = outline.width * 2; // Double for better visibility
    ctx.lineJoin = 'round';

    drawTextLines(ctx, lines, textX, textY, lineHeight, style.letterSpacing, true);

    // Reset shadow for fill
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowBlur = 0;
  }

  // Draw text fill
  ctx.fillStyle = style.color;
  drawTextLines(ctx, lines, textX, textY, lineHeight, style.letterSpacing, false);

  // Draw underline if specified
  if (style.underline) {
    drawUnderlines(ctx, lines, textX, textY, scaledFontSize, lineHeight, style);
  }

  // Restore context state
  ctx.restore();
}

/**
 * Draws text background rectangle.
 */
function drawTextBackground(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  textX: number,
  textY: number,
  _scaledFontSize: number, // Reserved for future use (e.g., padding calculations)
  lineHeight: number,
  style: TextStyle,
): void {
  if (!style.backgroundColor) return;

  const padding = style.backgroundPadding;
  const totalHeight = lines.length * lineHeight;
  const startY = textY - totalHeight / 2;

  // Find max line width
  let maxWidth = 0;
  for (const line of lines) {
    const metrics = ctx.measureText(line);
    maxWidth = Math.max(maxWidth, metrics.width);
  }

  // Calculate background rect
  let bgX: number;
  switch (style.alignment) {
    case 'left':
      bgX = textX - padding;
      break;
    case 'right':
      bgX = textX - maxWidth - padding;
      break;
    default:
      bgX = textX - maxWidth / 2 - padding;
  }

  ctx.fillStyle = style.backgroundColor;
  ctx.fillRect(bgX, startY - padding, maxWidth + padding * 2, totalHeight + padding * 2);
}

/**
 * Draws multi-line text.
 */
function drawTextLines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  textX: number,
  textY: number,
  lineHeight: number,
  letterSpacing: number,
  isStroke: boolean,
): void {
  const totalHeight = lines.length * lineHeight;
  let currentY = textY - totalHeight / 2 + lineHeight / 2;

  for (const line of lines) {
    if (letterSpacing !== 0) {
      // Draw with letter spacing
      drawTextWithLetterSpacing(ctx, line, textX, currentY, letterSpacing, isStroke);
    } else {
      // Normal text drawing
      if (isStroke) {
        ctx.strokeText(line, textX, currentY);
      } else {
        ctx.fillText(line, textX, currentY);
      }
    }
    currentY += lineHeight;
  }
}

/**
 * Draws text with custom letter spacing.
 */
function drawTextWithLetterSpacing(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  letterSpacing: number,
  isStroke: boolean,
): void {
  const chars = text.split('');
  let currentX = x;

  // Adjust starting X for alignment
  const totalWidth = chars.reduce((sum, char) => {
    return sum + ctx.measureText(char).width + letterSpacing;
  }, -letterSpacing);

  if (ctx.textAlign === 'center') {
    currentX -= totalWidth / 2;
  } else if (ctx.textAlign === 'right') {
    currentX -= totalWidth;
  }

  // Save and reset alignment for character-by-character drawing
  const savedAlign = ctx.textAlign;
  ctx.textAlign = 'left';

  for (const char of chars) {
    if (isStroke) {
      ctx.strokeText(char, currentX, y);
    } else {
      ctx.fillText(char, currentX, y);
    }
    currentX += ctx.measureText(char).width + letterSpacing;
  }

  ctx.textAlign = savedAlign;
}

/**
 * Draws underlines for text.
 */
function drawUnderlines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  textX: number,
  textY: number,
  scaledFontSize: number,
  lineHeight: number,
  style: TextStyle,
): void {
  const totalHeight = lines.length * lineHeight;
  let currentY = textY - totalHeight / 2 + lineHeight / 2 + scaledFontSize * 0.15;

  ctx.strokeStyle = style.color;
  ctx.lineWidth = Math.max(1, scaledFontSize / 20);

  for (const line of lines) {
    const metrics = ctx.measureText(line);
    let startX: number;

    switch (style.alignment) {
      case 'left':
        startX = textX;
        break;
      case 'right':
        startX = textX - metrics.width;
        break;
      default:
        startX = textX - metrics.width / 2;
    }

    ctx.beginPath();
    ctx.moveTo(startX, currentY);
    ctx.lineTo(startX + metrics.width, currentY);
    ctx.stroke();

    currentY += lineHeight;
  }
}
