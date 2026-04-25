import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceLayoutStore } from '@/stores/workspaceLayoutStore';
import { DockableEditorLayout } from './DockableEditorLayout';

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

const panelContent = {
  explorer: <div>Explorer</div>,
  'source-monitor': <div>Source</div>,
  'program-monitor': <div>Program</div>,
  timeline: <div>Timeline</div>,
  inspector: <div>Inspector</div>,
  'ai-assistant': <div>AI</div>,
  history: <div>History</div>,
  transcript: <div>Transcript</div>,
};

function setViewport(width: number, height = 900): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: height,
  });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

describe('DockableEditorLayout', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setViewport(1440, 900);
    useWorkspaceLayoutStore.getState().resetLayout();
  });

  afterEach(() => {
    setViewport(originalInnerWidth, originalInnerHeight);
  });

  it('should render an empty left drop zone while dragging after the zone is emptied', () => {
    const store = useWorkspaceLayoutStore.getState();
    store.movePanel('explorer', 'right');
    store.startDrag('timeline');

    render(<DockableEditorLayout header={<div>Header</div>} panelContent={panelContent} />);

    const dropZone = screen.getByTestId('dock-zone-left-empty');
    expect(dropZone).toBeInTheDocument();

    fireEvent.drop(dropZone, {
      dataTransfer: { getData: () => 'timeline' },
      preventDefault: vi.fn(),
    });

    expect(useWorkspaceLayoutStore.getState().layout.zones.left.panelIds).toContain('timeline');
  });

  it('should render an empty bottom drop zone while dragging after the zone is emptied', () => {
    const store = useWorkspaceLayoutStore.getState();
    store.movePanel('history', 'right');
    store.movePanel('transcript', 'right');
    store.startDrag('timeline');

    render(<DockableEditorLayout header={<div>Header</div>} panelContent={panelContent} />);

    expect(screen.getByTestId('dock-zone-bottom-empty')).toBeInTheDocument();
  });

  it('should auto-collapse the right zone on constrained viewports', () => {
    setViewport(900, 800);

    render(<DockableEditorLayout header={<div>Header</div>} panelContent={panelContent} />);

    expect(screen.getByTestId('dock-zone-right').parentElement).toHaveStyle({ width: '40px' });
    expect(screen.queryByText('Inspector')).not.toBeInTheDocument();
  });

  it('should clamp expanded side widths so the center workspace remains usable', () => {
    const store = useWorkspaceLayoutStore.getState();
    store.setLeftWidth(600);
    store.setRightWidth(600);
    setViewport(1400, 900);

    render(<DockableEditorLayout header={<div>Header</div>} panelContent={panelContent} />);

    expect(screen.getByTestId('dock-zone-left').parentElement).toHaveStyle({ width: '476px' });
    expect(screen.getByTestId('dock-zone-right').parentElement).toHaveStyle({ width: '476px' });
  });
});
