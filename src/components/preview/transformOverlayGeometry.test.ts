import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measureTextBounds } from './transformOverlayGeometry';
import { renderTextToCanvas } from '@/utils/textRenderer';
import { DEFAULT_TEXT_STYLE, type TextClipData, type TextStyle } from '@/types';
import { PLAY_RES_Y } from '@/utils/previewCoords';

/**
 * Feature: the selection box frames the glyphs the renderer actually draws
 *
 *   Scenario: a letter-spaced line contains an astral emoji
 *     Given a text clip whose style sets a non-zero letter spacing
 *     When the transform overlay measures it
 *     Then the width it reports is the width `renderTextToCanvas` lays down
 *
 * The two paths measure differently the moment letter spacing is on: the
 * renderer stops drawing the line as one run and lays out drawable characters
 * (code points) with a gap between each pair, so a measurement that counted
 * UTF-16 code units — two per emoji — or kept whole-run kerning would place the
 * handles somewhere other than the text.
 */

const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = PLAY_RES_Y;

const LETTER_ADVANCE = 10;
const EMOJI_ADVANCE = 20;
const KERN_PER_PAIR = 0.5;

/**
 * Advance width of one drawable character in the stand-in font.
 *
 * An emoji is deliberately wider than a letter: the defect under test is about
 * which units get counted, so counting the wrong ones has to change the answer.
 */
function characterAdvance(character: string): number {
  return (character.codePointAt(0) ?? 0) > 0xffff ? EMOJI_ADVANCE : LETTER_ADVANCE;
}

/**
 * What `measureText` answers in the stand-in font.
 *
 * A run of more than one character kerns; a single character cannot. That is
 * the second half of the divergence — a whole-line measurement carries kerning
 * the per-character draw path never applies.
 */
function measureRun(text: string): number {
  const characters = Array.from(text);
  const advance = characters.reduce((sum, character) => sum + characterAdvance(character), 0);

  return characters.length > 1 ? advance - (characters.length - 1) * KERN_PER_PAIR : advance;
}

interface DrawnGlyph {
  text: string;
  x: number;
}

interface RecordingContext {
  ctx: CanvasRenderingContext2D;
  glyphs: DrawnGlyph[];
}

/**
 * A canvas 2D context that measures in the stand-in font and records its fills.
 *
 * Canvas is an external boundary and jsdom has no real one; this is the thin
 * stand-in the mock policy allows, and it is shared by both paths under test so
 * neither can be measured against a different font than the other.
 */
function createRecordingContext(): RecordingContext {
  const glyphs: DrawnGlyph[] = [];

  const ctx = {
    font: '',
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter' as CanvasLineJoin,
    globalAlpha: 1,
    shadowColor: '',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    shadowBlur: 0,
    save: (): void => undefined,
    restore: (): void => undefined,
    translate: (): void => undefined,
    rotate: (): void => undefined,
    beginPath: (): void => undefined,
    moveTo: (): void => undefined,
    lineTo: (): void => undefined,
    stroke: (): void => undefined,
    fillRect: (): void => undefined,
    measureText: (text: string): TextMetrics => ({ width: measureRun(text) }) as TextMetrics,
    fillText: (text: string, x: number): void => {
      glyphs.push({ text, x });
    },
    strokeText: (): void => undefined,
  };

  return { ctx: ctx as unknown as CanvasRenderingContext2D, glyphs };
}

function createTextData(content: string, style: Partial<TextStyle> = {}): TextClipData {
  return {
    content,
    style: {
      ...DEFAULT_TEXT_STYLE,
      alignment: 'left',
      letterSpacing: 0,
      ...style,
    },
    position: { x: 0.5, y: 0.5 },
    rotation: 0,
    opacity: 1,
  };
}

/** The horizontal extent the renderer's fills actually cover. */
function drawnWidth(glyphs: readonly DrawnGlyph[]): number {
  const first = glyphs[0];
  const last = glyphs[glyphs.length - 1];

  return last.x + measureRun(last.text) - first.x;
}

describe('transformOverlayGeometry', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = ((): CanvasRenderingContext2D =>
      createRecordingContext().ctx) as unknown as typeof originalGetContext;
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  describe('measureTextBounds', () => {
    it('should report the width the renderer draws when the line is letter-spaced', () => {
      const textData = createTextData('Cut \u{1F3AC}\u{1F525}\u{1F389}', { letterSpacing: 2 });

      const { ctx, glyphs } = createRecordingContext();
      renderTextToCanvas(ctx, textData, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Seven drawable characters, not the ten UTF-16 code units the string
      // stores: the renderer draws code points, so the overlay counts them.
      expect(glyphs).toHaveLength(7);
      expect(measureTextBounds(textData, CANVAS_HEIGHT).width).toBe(Math.ceil(drawnWidth(glyphs)));
    });

    it('should not count an astral emoji as two letter-spacing gaps', () => {
      const textData = createTextData('ab\u{1F3AC}', { letterSpacing: 4 });

      // Three drawable characters: two gaps, and no whole-run kerning, because
      // that is exactly how the glyphs are laid down.
      expect(measureTextBounds(textData, CANVAS_HEIGHT).width).toBe(
        LETTER_ADVANCE * 2 + EMOJI_ADVANCE + 2 * 4,
      );
    });

    it('should measure an unspaced line as the single run the renderer draws', () => {
      const content = 'Cut \u{1F3AC}\u{1F525}\u{1F389}';
      const textData = createTextData(content, { letterSpacing: 0 });

      const { ctx, glyphs } = createRecordingContext();
      renderTextToCanvas(ctx, textData, CANVAS_WIDTH, CANVAS_HEIGHT);

      // No spacing means the renderer draws the line in one `fillText`, so the
      // whole-run measurement — kerning and all — is the matching one.
      expect(glyphs).toHaveLength(1);
      expect(measureTextBounds(textData, CANVAS_HEIGHT).width).toBe(Math.ceil(measureRun(content)));
    });
  });
});
