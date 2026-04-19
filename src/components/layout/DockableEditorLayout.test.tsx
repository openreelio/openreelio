import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceLayoutStore } from '@/stores/workspaceLayoutStore';
import { DockableEditorLayout } from './DockableEditorLayout';

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

describe('DockableEditorLayout', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorkspaceLayoutStore.getState().resetLayout();
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
});
