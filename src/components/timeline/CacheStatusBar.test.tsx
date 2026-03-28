import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CacheStatusBar } from './CacheStatusBar';
import type { CacheSegmentStatusDto } from '../../bindings';

describe('CacheStatusBar', () => {
  const makeSegments = (states: string[]): CacheSegmentStatusDto[] =>
    states.map((state, i) => ({
      startSec: i * 5,
      endSec: (i + 1) * 5,
      state: state as CacheSegmentStatusDto['state'],
    }));

  it('should render nothing when duration is zero', () => {
    const { container } = render(
      <CacheStatusBar segments={[]} duration={0} zoom={10} scrollX={0} />
    );
    expect(container.querySelector('[data-testid="cache-status-bar"]')).toBeNull();
  });

  it('should render segment bars for non-empty states', () => {
    const segments = makeSegments(['cached', 'stale', 'empty']);
    render(
      <CacheStatusBar segments={segments} duration={15} zoom={10} scrollX={0} />
    );

    const bar = screen.getByTestId('cache-status-bar');
    expect(bar).toBeTruthy();

    // Should have 2 visible bars (cached + stale, empty is transparent/null)
    const children = bar.querySelectorAll('[title]');
    expect(children.length).toBe(2);
  });

  it('should render a visible segment for cached state', () => {
    const segments = makeSegments(['cached']);
    render(
      <CacheStatusBar segments={segments} duration={5} zoom={10} scrollX={0} />
    );

    // Cached segment should be visible with its title describing the state
    const segment = screen.getByTitle('cached: 0.0s - 5.0s');
    expect(segment).toBeTruthy();
  });

  it('should display correct title with time range', () => {
    const segments = makeSegments(['stale']);
    render(
      <CacheStatusBar segments={segments} duration={5} zoom={10} scrollX={0} />
    );

    const segment = screen.getByTitle('stale: 0.0s - 5.0s');
    expect(segment).toBeTruthy();
  });

  it('should position segments correctly based on zoom', () => {
    const segments = makeSegments(['cached', 'cached']);
    render(
      <CacheStatusBar segments={segments} duration={10} zoom={20} scrollX={0} />
    );

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
});
