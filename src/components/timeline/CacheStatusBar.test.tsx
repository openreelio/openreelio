import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { CacheStatusBar } from './CacheStatusBar';
import { useRenderCacheStore } from '@/stores/renderCacheStore';
import type { CacheSegmentStatusDto } from '../../bindings';

describe('CacheStatusBar', () => {
  // Reset before rendering rather than after: the store is shared, and writing
  // to it while a component from the previous case is still mounted would be
  // an unwrapped React update.
  beforeEach(() => {
    useRenderCacheStore.getState()._resetForTests();
  });

  const makeSegments = (states: string[]): CacheSegmentStatusDto[] =>
    states.map((state, i) => ({
      index: i,
      startSec: i * 5,
      endSec: (i + 1) * 5,
      state: state as CacheSegmentStatusDto['state'],
      fingerprint: '0',
      cachedPath: null,
      flagged: false,
      flagReasons: [],
    }));

  it('should render nothing when duration is zero', () => {
    const { container } = render(
      <CacheStatusBar segments={[]} duration={0} zoom={10} scrollX={0} />,
    );
    expect(container.querySelector('[data-testid="cache-status-bar"]')).toBeNull();
  });

  it('should render segment bars for non-empty states', () => {
    const segments = makeSegments(['cached', 'stale', 'empty']);
    render(<CacheStatusBar segments={segments} duration={15} zoom={10} scrollX={0} />);

    const bar = screen.getByTestId('cache-status-bar');
    expect(bar).toBeTruthy();

    // Should have 2 visible bars (cached + stale, empty is transparent/null)
    const children = bar.querySelectorAll('[title]');
    expect(children.length).toBe(2);
  });

  it('should render a visible segment for cached state', () => {
    const segments = makeSegments(['cached']);
    render(<CacheStatusBar segments={segments} duration={5} zoom={10} scrollX={0} />);

    // Cached segment should be visible with its title describing the state
    const segment = screen.getByTitle('cached: 0.0s - 5.0s');
    expect(segment).toBeTruthy();
  });

  it('should display correct title with time range', () => {
    const segments = makeSegments(['stale']);
    render(<CacheStatusBar segments={segments} duration={5} zoom={10} scrollX={0} />);

    const segment = screen.getByTitle('stale: 0.0s - 5.0s');
    expect(segment).toBeTruthy();
  });

  it('should position segments correctly based on zoom', () => {
    const segments = makeSegments(['cached', 'cached']);
    render(<CacheStatusBar segments={segments} duration={10} zoom={20} scrollX={0} />);

    const bar = screen.getByTestId('cache-status-bar');
    const children = bar.querySelectorAll('[title]');
    expect(children.length).toBe(2);

    // First segment: left=0, width=100 (5 sec * 20 px/sec)
    const first = children[0] as HTMLElement;
    expect(first.style.left).toBe('0px');
    expect(first.style.width).toBe('100px');

    // Second segment: left=100, width=100
    const second = children[1] as HTMLElement;
    expect(second.style.left).toBe('100px');
    expect(second.style.width).toBe('100px');
  });

  describe('flagged segments', () => {
    const flaggedEmpty = (): CacheSegmentStatusDto[] => [
      {
        index: 0,
        startSec: 0,
        endSec: 5,
        state: 'empty',
        fingerprint: '0',
        cachedPath: null,
        flagged: true,
        flagReasons: ['blend_mode', 'speed'],
      },
    ];

    it('should render a needs-render bar when an empty segment is flagged', () => {
      render(<CacheStatusBar segments={flaggedEmpty()} duration={5} zoom={10} scrollX={0} />);

      const bar = screen.getByTestId('cache-status-bar');
      const children = bar.querySelectorAll('[title]');
      expect(children.length).toBe(1);
      expect((children[0] as HTMLElement).style.backgroundColor).toBe('rgba(239, 68, 68, 0.35)');
    });

    it('should render nothing when an empty segment is not flagged', () => {
      const segments = makeSegments(['empty']);

      render(<CacheStatusBar segments={segments} duration={5} zoom={10} scrollX={0} />);

      const bar = screen.getByTestId('cache-status-bar');
      expect(bar.querySelectorAll('[title]').length).toBe(0);
    });

    it('should list the flag reasons in the tooltip', () => {
      render(<CacheStatusBar segments={flaggedEmpty()} duration={5} zoom={10} scrollX={0} />);

      const bar = screen.getByTestId('cache-status-bar');
      const title = (bar.querySelector('[title]') as HTMLElement).title;
      expect(title).toContain('needs render (blend_mode, speed)');
    });

    it('should give errors a hue distinct from needs-render, not a dimmer red', () => {
      // The bar is 6px tall: two reds separated only by alpha are
      // indistinguishable at that size.
      const { container } = render(
        <CacheStatusBar segments={makeSegments(['error'])} duration={5} zoom={10} scrollX={0} />,
      );
      const errorColor = (container.querySelector('[title]') as HTMLElement).style.backgroundColor;

      cleanup();
      render(<CacheStatusBar segments={flaggedEmpty()} duration={5} zoom={10} scrollX={0} />);
      const needsRenderColor = (
        screen.getByTestId('cache-status-bar').querySelector('[title]') as HTMLElement
      ).style.backgroundColor;

      expect(errorColor).toBe('rgba(217, 70, 239, 0.7)');
      expect(errorColor).not.toBe(needsRenderColor);
    });
  });

  describe('fill errors', () => {
    it('should surface a failed fill in the bar tooltip', () => {
      useRenderCacheStore.setState({ error: 'ffmpeg exited with 1' });

      render(
        <CacheStatusBar segments={makeSegments(['cached'])} duration={5} zoom={10} scrollX={0} />,
      );

      expect(screen.getByTestId('cache-status-bar').title).toBe(
        'Render cache error: ffmpeg exited with 1',
      );
    });

    it('should carry no bar tooltip while the cache is healthy', () => {
      render(
        <CacheStatusBar segments={makeSegments(['cached'])} duration={5} zoom={10} scrollX={0} />,
      );

      expect(screen.getByTestId('cache-status-bar').hasAttribute('title')).toBe(false);
    });
  });
});
