/**
 * Tests for timelineScrollLogic utilities
 *
 * Tests the sophisticated viewport management functions inspired by Remotion.
 */

import { describe, it, expect } from 'vitest';
import {
  timeToPixels,
  pixelsToTime,
  getTimeFromViewportX,
  getViewportXFromTime,
  getViewportBounds,
  isTimeInViewport,
  ensureTimeInViewport,
  getAutoViewportMode,
  ensureTimeInViewportAuto,
  zoomWithCursorPreservation,
  zoomCenteredOnTime,
  zoomCenteredOnPlayhead,
  calculateFitToWindowZoom,
  fitTimeRangeToViewport,
  calculatePlayheadFollowScroll,
  snapTimeToFrame,
  snapPixelsToFrame,
  clamp,
  smoothZoom,
  calculateZoomStep,
  type ViewportState,
} from './timelineScrollLogic';

// =============================================================================
// Core Conversion Functions
// =============================================================================

describe('timeToPixels', () => {
  it('converts time to pixels correctly', () => {
    expect(timeToPixels(1, 100)).toBe(100);
    expect(timeToPixels(2.5, 100)).toBe(250);
    expect(timeToPixels(0, 100)).toBe(0);
  });

  it('handles different zoom levels', () => {
    expect(timeToPixels(1, 50)).toBe(50);
    expect(timeToPixels(1, 200)).toBe(200);
  });
});

describe('pixelsToTime', () => {
  it('converts pixels to time correctly', () => {
    expect(pixelsToTime(100, 100)).toBe(1);
    expect(pixelsToTime(250, 100)).toBe(2.5);
    expect(pixelsToTime(0, 100)).toBe(0);
  });

  it('handles zero zoom gracefully', () => {
    expect(pixelsToTime(100, 0)).toBe(0);
  });
});

describe('getTimeFromViewportX', () => {
  it('calculates time from viewport X position', () => {
    const state: ViewportState = { scrollX: 0, zoom: 100, viewportWidth: 500 };
    expect(getTimeFromViewportX(100, state)).toBe(1);
  });

  it('accounts for scroll offset', () => {
    const state: ViewportState = { scrollX: 200, zoom: 100, viewportWidth: 500 };
    expect(getTimeFromViewportX(100, state)).toBe(3); // (200 + 100) / 100
  });
});

describe('getViewportXFromTime', () => {
  it('calculates viewport X from time', () => {
    const state: ViewportState = { scrollX: 0, zoom: 100, viewportWidth: 500 };
    expect(getViewportXFromTime(1, state)).toBe(100);
  });

  it('accounts for scroll offset', () => {
    const state: ViewportState = { scrollX: 200, zoom: 100, viewportWidth: 500 };
    expect(getViewportXFromTime(3, state)).toBe(100); // 300 - 200
  });
});

// =============================================================================
// Viewport Bounds
// =============================================================================

describe('getViewportBounds', () => {
  it('calculates correct viewport bounds', () => {
    const state: ViewportState = { scrollX: 100, zoom: 100, viewportWidth: 500 };
    const bounds = getViewportBounds(state);

    expect(bounds.startTime).toBe(1);
    expect(bounds.endTime).toBe(6);
    expect(bounds.visibleDuration).toBe(5);
  });

  it('handles zero scroll', () => {
    const state: ViewportState = { scrollX: 0, zoom: 100, viewportWidth: 1000 };
    const bounds = getViewportBounds(state);

    expect(bounds.startTime).toBe(0);
    expect(bounds.endTime).toBe(10);
  });
});

describe('isTimeInViewport', () => {
  const state: ViewportState = { scrollX: 100, zoom: 100, viewportWidth: 500 };

  it('returns true for time in viewport', () => {
    expect(isTimeInViewport(3, state)).toBe(true);
    expect(isTimeInViewport(1, state)).toBe(true);
    expect(isTimeInViewport(6, state)).toBe(true);
  });

  it('returns false for time outside viewport', () => {
    expect(isTimeInViewport(0.5, state)).toBe(false);
    expect(isTimeInViewport(7, state)).toBe(false);
  });

  it('respects margin parameter', () => {
    // state = { scrollX: 100, zoom: 100, viewportWidth: 500 }
    // With margin=50: viewportStart=150px, viewportEnd=550px
    // 1.6s = 160px is within [150, 550]
    // 1.2s = 120px is outside (< 150)
    expect(isTimeInViewport(1.6, state, 50)).toBe(true);
    expect(isTimeInViewport(1.2, state, 50)).toBe(false);
  });
});

// =============================================================================
// Smart Scrolling
// =============================================================================

describe('ensureTimeInViewport', () => {
  const state: ViewportState = { scrollX: 0, zoom: 100, viewportWidth: 500 };

  it('returns current scrollX if time already visible', () => {
    expect(ensureTimeInViewport(2, 'center', state)).toBe(0);
  });

  it('scrolls to fit-left mode correctly', () => {
    const result = ensureTimeInViewport(10, 'fit-left', state, 0.1);
    // 10s = 1000px, margin = 50px (10% of 500), so scroll to 1000 - 50 = 950
    expect(result).toBe(950);
  });

  it('scrolls to fit-right mode correctly', () => {
    const result = ensureTimeInViewport(10, 'fit-right', state, 0.1);
    // 10s = 1000px, viewport = 500, margin = 50, so scroll to 1000 - 500 + 50 = 550
    expect(result).toBe(550);
  });

  it('scrolls to center mode correctly', () => {
    const result = ensureTimeInViewport(10, 'center', state);
    // 10s = 1000px, viewport center = 250, so scroll to 1000 - 250 = 750
    expect(result).toBe(750);
  });

  it('never returns negative scroll', () => {
    expect(ensureTimeInViewport(0, 'fit-left', state)).toBe(0);
    expect(ensureTimeInViewport(0, 'center', state)).toBe(0);
  });
});

describe('getAutoViewportMode', () => {
  const state: ViewportState = { scrollX: 100, zoom: 100, viewportWidth: 500 };
  // Visible range: 1s to 6s

  it('returns fit-left for time before viewport', () => {
    expect(getAutoViewportMode(0.5, state)).toBe('fit-left');
  });

  it('returns fit-right for time after viewport', () => {
    expect(getAutoViewportMode(7, state)).toBe('fit-right');
  });

  it('returns center for time in viewport', () => {
    expect(getAutoViewportMode(3, state)).toBe('center');
  });
});

describe('ensureTimeInViewportAuto', () => {
  it('automatically chooses correct mode', () => {
    const state: ViewportState = { scrollX: 100, zoom: 100, viewportWidth: 500 };

    // Time before viewport - should use fit-left
    const scrollForBefore = ensureTimeInViewportAuto(0.5, state);
    expect(scrollForBefore).toBeLessThan(100);

    // Time after viewport - should use fit-right
    const scrollForAfter = ensureTimeInViewportAuto(10, state);
    expect(scrollForAfter).toBeGreaterThan(100);
  });
});

// =============================================================================
// Zoom with Cursor Preservation
// =============================================================================

describe('zoomWithCursorPreservation', () => {
  it('preserves cursor position when zooming in', () => {
    // Cursor at viewport center (250px), at 2.5s
    const result = zoomWithCursorPreservation(100, 200, 250, 0);

    // At new zoom, 2.5s should still be at 250px from viewport left
    // 2.5s * 200 = 500px, so scrollX should be 500 - 250 = 250
    expect(result.zoom).toBe(200);
    expect(result.scrollX).toBe(250);
  });

  it('preserves cursor position when zooming out', () => {
    const result = zoomWithCursorPreservation(200, 100, 250, 250);

    // At old zoom (200), cursor at 250px from viewport, scrollX 250
    // Time at cursor: (250 + 250) / 200 = 2.5s
    // At new zoom (100), 2.5s = 250px, cursor should stay at 250
    // So scrollX = 250 - 250 = 0
    expect(result.zoom).toBe(100);
    expect(result.scrollX).toBe(0);
  });

  it('handles zero current zoom', () => {
    const result = zoomWithCursorPreservation(0, 100, 250, 0);
    expect(result.zoom).toBe(100);
    expect(result.scrollX).toBe(0);
  });

  it('never returns negative scroll', () => {
    const result = zoomWithCursorPreservation(200, 100, 50, 0);
    expect(result.scrollX).toBeGreaterThanOrEqual(0);
  });
});

describe('zoomCenteredOnTime', () => {
  it('centers zoom on specified time', () => {
    const result = zoomCenteredOnTime(100, 200, 5, 500);

    // 5s at zoom 200 = 1000px
    // Viewport center = 250px
    // ScrollX should be 1000 - 250 = 750
    expect(result.zoom).toBe(200);
    expect(result.scrollX).toBe(750);
  });

  it('never returns negative scroll for time 0', () => {
    const result = zoomCenteredOnTime(100, 200, 0, 500);
    expect(result.scrollX).toBeGreaterThanOrEqual(0);
  });
});

describe('zoomCenteredOnPlayhead', () => {
  it('keeps playhead at same position when in viewport', () => {
    // Playhead at 2s, zoom 100, scroll 0, viewport 500
    // Playhead viewportX = 200px (in viewport)
    const result = zoomCenteredOnPlayhead(100, 200, 2, 500, 0);

    // At new zoom, 2s should remain at 200px viewportX
    // 2s * 200 = 400px, so scrollX = 400 - 200 = 200
    expect(result.zoom).toBe(200);
    expect(result.scrollX).toBe(200);
  });

  it('centers on playhead when outside viewport', () => {
    // Playhead at 10s, zoom 100, scroll 0, viewport 500
    // Playhead viewportX = 1000px (outside viewport)
    const result = zoomCenteredOnPlayhead(100, 200, 10, 500, 0);

    // Should center viewport on playhead
    // 10s * 200 = 2000px, center = 2000 - 250 = 1750
    expect(result.zoom).toBe(200);
    expect(result.scrollX).toBe(1750);
  });
});

// =============================================================================
// Fit to Window
// =============================================================================

describe('calculateFitToWindowZoom', () => {
  it('calculates correct zoom to fit duration', () => {
    // 10s duration in 1000px viewport with 20px padding each side
    const zoom = calculateFitToWindowZoom(10, 1000, 20);
    expect(zoom).toBe(96); // (1000 - 40) / 10
  });

  it('handles zero duration', () => {
    const zoom = calculateFitToWindowZoom(0, 1000, 20);
    expect(zoom).toBe(100); // Default
  });

  it('handles small viewport', () => {
    const zoom = calculateFitToWindowZoom(10, 30, 20);
    expect(zoom).toBe(100); // Default when viewport too small
  });
});

describe('fitTimeRangeToViewport', () => {
  it('calculates zoom and scroll for time range', () => {
    const result = fitTimeRangeToViewport(5, 10, 1000, 20);

    // Duration = 5s, available = 960px, zoom = 192
    expect(result.zoom).toBe(192);
    // Scroll = 5s * 192 - 20 = 940
    expect(result.scrollX).toBe(940);
  });

  it('handles zero duration range', () => {
    const result = fitTimeRangeToViewport(5, 5, 1000, 20);
    expect(result.zoom).toBe(100);
    expect(result.scrollX).toBe(0);
  });
});

// =============================================================================
// Playhead Following
// =============================================================================

describe('calculatePlayheadFollowScroll', () => {
  it('returns null when playhead is well inside viewport', () => {
    const state: ViewportState = { scrollX: 0, zoom: 100, viewportWidth: 500 };
    const result = calculatePlayheadFollowScroll(2, state, 0.2);
    expect(result).toBeNull();
  });

  it('returns new scroll when playhead approaches right edge', () => {
    const state: ViewportState = { scrollX: 0, zoom: 100, viewportWidth: 500 };
    // Playhead at 4.5s = 450px, right margin at 400px (500 - 20%)
    const result = calculatePlayheadFollowScroll(4.5, state, 0.2);
    expect(result).not.toBeNull();
    expect(result).toBeGreaterThan(0);
  });

  it('returns new scroll when playhead is before viewport', () => {
    const state: ViewportState = { scrollX: 500, zoom: 100, viewportWidth: 500 };
    // Playhead at 2s = 200px, viewport starts at 500px
    const result = calculatePlayheadFollowScroll(2, state, 0.2);
    expect(result).not.toBeNull();
    expect(result).toBeLessThan(500);
  });
});

// =============================================================================
// Snapping Helpers
// =============================================================================

describe('snapTimeToFrame', () => {
  it('snaps to nearest frame boundary', () => {
    expect(snapTimeToFrame(1.016, 30)).toBeCloseTo(1, 2); // 30.48 frames -> 30 frames
    expect(snapTimeToFrame(1.017, 30)).toBeCloseTo(1.033, 2); // 30.51 frames -> 31 frames
  });

  it('handles 24fps', () => {
    expect(snapTimeToFrame(1.020, 24)).toBeCloseTo(1, 2); // 24.48 frames -> 24 frames
  });

  it('handles zero fps', () => {
    expect(snapTimeToFrame(1.5, 0)).toBe(1.5);
  });
});

describe('snapPixelsToFrame', () => {
  it('snaps pixels to frame boundary', () => {
    const snapped = snapPixelsToFrame(101.6, 100, 30);
    expect(snapped).toBeCloseTo(100, 0); // 1.016s -> 1s -> 100px
  });
});

// =============================================================================
// Utility Functions
// =============================================================================

describe('clamp', () => {
  it('clamps value within bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});

describe('smoothZoom', () => {
  it('interpolates zoom exponentially', () => {
    const mid = smoothZoom(100, 200, 0.5);
    // Exponential interpolation: exp(log(100) + 0.5*(log(200)-log(100)))
    // ≈ 141.4
    expect(mid).toBeCloseTo(141.4, 0);
  });

  it('returns exact values at boundaries', () => {
    // Use toBeCloseTo for floating point comparisons due to Math.exp(Math.log()) precision
    expect(smoothZoom(100, 200, 0)).toBeCloseTo(100, 10);
    expect(smoothZoom(100, 200, 1)).toBeCloseTo(200, 10);
  });
});

describe('calculateZoomStep', () => {
  it('calculates zoom step correctly', () => {
    expect(calculateZoomStep(100, 1, 1.2)).toBeCloseTo(120);
    expect(calculateZoomStep(100, -1, 1.2)).toBeCloseTo(83.33, 1);
    expect(calculateZoomStep(100, 2, 1.2)).toBeCloseTo(144);
  });
});
