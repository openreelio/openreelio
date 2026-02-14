import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useResponsiveSidebarState } from './useResponsiveSidebarState';

const originalInnerWidth = window.innerWidth;

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

describe('useResponsiveSidebarState', () => {
  beforeEach(() => {
    setViewportWidth(1600);
  });

  afterEach(() => {
    setViewportWidth(originalInnerWidth);
  });

  it('keeps sidebar expanded above breakpoint', () => {
    const { result } = renderHook(() =>
      useResponsiveSidebarState({ autoCollapseBreakpoint: 1200, initialWidth: 360 }),
    );

    expect(result.current.collapsed).toBe(false);
    expect(result.current.width).toBe(360);
  });

  it('auto-collapses sidebar below breakpoint', () => {
    setViewportWidth(900);

    const { result } = renderHook(() =>
      useResponsiveSidebarState({ autoCollapseBreakpoint: 1200 }),
    );

    expect(result.current.collapsed).toBe(true);
  });

  it('toggles and updates width', () => {
    const { result } = renderHook(() =>
      useResponsiveSidebarState({ autoCollapseBreakpoint: 1200 }),
    );

    act(() => {
      result.current.toggleCollapsed();
      result.current.setWidth(420);
    });

    expect(result.current.collapsed).toBe(true);
    expect(result.current.width).toBe(420);
  });
});
