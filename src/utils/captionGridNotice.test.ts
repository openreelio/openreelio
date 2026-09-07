import { describe, it, expect } from 'vitest';
import { parseCaptionGridNotice, formatCaptionGridNotice } from './captionGridNotice';

describe('captionGridNotice', () => {
  describe('parseCaptionGridNotice', () => {
    it('should read a count and a drop count when the backend reports both', () => {
      expect(parseCaptionGridNotice({ count: 41, dropped: 2 })).toEqual({ count: 41, dropped: 2 });
    });

    it('should default dropped to zero when the payload omits it', () => {
      expect(parseCaptionGridNotice({ count: 41 })).toEqual({ count: 41, dropped: 0 });
    });

    it('should return null when nothing happened, so nothing is announced', () => {
      expect(parseCaptionGridNotice({ count: 0, dropped: 0 })).toBeNull();
    });

    it('should return null for a payload that is not a pair of counts', () => {
      expect(parseCaptionGridNotice(null)).toBeNull();
      expect(parseCaptionGridNotice('41')).toBeNull();
      expect(parseCaptionGridNotice({})).toBeNull();
      expect(parseCaptionGridNotice({ count: -1 })).toBeNull();
      expect(parseCaptionGridNotice({ count: Number.NaN })).toBeNull();
      expect(parseCaptionGridNotice({ count: 1, dropped: 'two' })).toBeNull();
    });
  });

  describe('formatCaptionGridNotice', () => {
    it('should say only what happened when no cue was dropped', () => {
      expect(formatCaptionGridNotice({ count: 41, dropped: 0 })).toBe(
        '41 captions moved onto the sequence frame grid.',
      );
    });

    it('should name the dropped cues when the grid gave up on some', () => {
      expect(formatCaptionGridNotice({ count: 41, dropped: 2 })).toContain('2 captions dropped');
    });

    it('should report drops alone when nothing else moved', () => {
      expect(formatCaptionGridNotice({ count: 0, dropped: 1 })).toBe(
        '1 caption dropped: the frame grid could not keep them in order.',
      );
    });

    it('should speak of one caption in the singular', () => {
      expect(formatCaptionGridNotice({ count: 1, dropped: 0 })).toBe(
        '1 caption moved onto the sequence frame grid.',
      );
    });
  });
});
