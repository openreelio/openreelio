import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceLayoutStore } from '@/stores/workspaceLayoutStore';
import { useDockableAIPanel } from './useDockableAIPanel';

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

describe('useDockableAIPanel', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorkspaceLayoutStore.getState().resetLayout();
    setViewportWidth(1600);
  });

  afterEach(() => {
    setViewportWidth(originalInnerWidth);
  });

  it('should open and close the AI panel with the global shortcut', () => {
    const { result } = renderHook(() =>
      useDockableAIPanel({ autoCollapseBreakpoint: 1200, initialWidth: 360 }),
    );

    expect(result.current.isOpen).toBe(false);
    expect(useWorkspaceLayoutStore.getState().layout.zones.right.activePanelId).toBe('inspector');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: '/' }));
    });

    expect(result.current.isOpen).toBe(true);
    expect(useWorkspaceLayoutStore.getState().layout.zones.right.activePanelId).toBe(
      'ai-assistant',
    );

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: '/' }));
    });

    expect(result.current.isOpen).toBe(false);
    expect(useWorkspaceLayoutStore.getState().layout.zones.right.activePanelId).toBe('inspector');
  });

  it('should restore the previous panel when the AI panel closes', () => {
    const { result } = renderHook(() => useDockableAIPanel({ autoCollapseBreakpoint: 1200 }));

    act(() => {
      useWorkspaceLayoutStore.getState().setActivePanel('right', 'ai-assistant');
    });

    expect(result.current.isOpen).toBe(true);

    act(() => {
      result.current.toggle();
    });

    expect(useWorkspaceLayoutStore.getState().layout.zones.right.activePanelId).toBe('inspector');
  });

  it('should keep the AI panel selected when the viewport shrinks below the breakpoint', () => {
    const { result } = renderHook(() => useDockableAIPanel({ autoCollapseBreakpoint: 1200 }));

    act(() => {
      result.current.toggle();
    });

    expect(result.current.isOpen).toBe(true);

    setViewportWidth(900);

    expect(result.current.isOpen).toBe(true);
    expect(useWorkspaceLayoutStore.getState().layout.zones.right.activePanelId).toBe(
      'ai-assistant',
    );
  });

  it('should allow manually opening the AI panel on a narrow viewport', () => {
    setViewportWidth(900);

    const { result } = renderHook(() => useDockableAIPanel({ autoCollapseBreakpoint: 1200 }));

    act(() => {
      result.current.toggle();
    });

    expect(result.current.isOpen).toBe(true);
    expect(useWorkspaceLayoutStore.getState().layout.zones.right.activePanelId).toBe(
      'ai-assistant',
    );
    expect(useWorkspaceLayoutStore.getState().layout.zones.right.collapsed).toBe(false);
  });

  it('should restore the AI panel into the default zone when missing from the layout', () => {
    useWorkspaceLayoutStore.setState((state) => ({
      ...state,
      layout: {
        ...state.layout,
        zones: {
          ...state.layout.zones,
          right: {
            ...state.layout.zones.right,
            panelIds: state.layout.zones.right.panelIds.filter(
              (panelId) => panelId !== 'ai-assistant',
            ),
            activePanelId: 'inspector',
          },
          bottom: {
            ...state.layout.zones.bottom,
            panelIds: state.layout.zones.bottom.panelIds.filter(
              (panelId) => panelId !== 'ai-assistant',
            ),
            activePanelId:
              state.layout.zones.bottom.activePanelId === 'ai-assistant'
                ? 'history'
                : state.layout.zones.bottom.activePanelId,
          },
        },
      },
    }));

    const { result } = renderHook(() => useDockableAIPanel({ autoCollapseBreakpoint: 1200 }));

    act(() => {
      result.current.toggle();
    });

    const { layout } = useWorkspaceLayoutStore.getState();
    expect(layout.zones.right.panelIds).toContain('ai-assistant');
    expect(layout.zones.right.activePanelId).toBe('ai-assistant');
    expect(result.current.isOpen).toBe(true);
  });

  it('should target the zone that currently owns the AI panel', () => {
    const store = useWorkspaceLayoutStore.getState();
    store.movePanel('ai-assistant', 'bottom');
    store.setActivePanel('bottom', 'history');

    const { result } = renderHook(() => useDockableAIPanel({ autoCollapseBreakpoint: 1200 }));

    act(() => {
      result.current.toggle();
    });

    const { layout } = useWorkspaceLayoutStore.getState();
    expect(layout.zones.bottom.activePanelId).toBe('ai-assistant');
    expect(layout.zones.bottom.collapsed).toBe(false);
  });
});
