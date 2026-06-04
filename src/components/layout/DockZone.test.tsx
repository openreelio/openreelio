/**
 * DockZone Component Tests
 *
 * BDD-style tests for the tabbed dock zone with drag-drop support.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DockZone } from './DockZone';
import type { PanelId } from '@/stores/workspaceLayoutStore';

function createDefaultProps(overrides: Partial<React.ComponentProps<typeof DockZone>> = {}) {
  return {
    zoneId: 'left' as const,
    panelIds: ['explorer', 'inspector'] as PanelId[],
    activePanelId: 'explorer' as PanelId,
    collapsed: false,
    renderPanel: vi.fn((panelId: PanelId) => (
      <div data-testid={`panel-content-${panelId}`}>{panelId} content</div>
    )),
    onTabClick: vi.fn(),
    onToggleCollapse: vi.fn(),
    onDragStart: vi.fn(),
    onDrop: vi.fn(),
    onDragEnd: vi.fn(),
    isDragging: false,
    draggedPanelId: null,
    ...overrides,
  };
}

describe('DockZone', () => {
  describe('tab rendering', () => {
    it('should render tabs for all panels in the zone', () => {
      render(<DockZone {...createDefaultProps()} />);
      expect(screen.getByRole('tab', { name: /Project Explorer/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /Inspector/i })).toBeInTheDocument();
    });

    it('should mark active tab with aria-selected', () => {
      render(<DockZone {...createDefaultProps()} />);
      const activeTab = screen.getByRole('tab', { name: /Project Explorer/i });
      expect(activeTab).toHaveAttribute('aria-selected', 'true');

      const inactiveTab = screen.getByRole('tab', { name: /Inspector/i });
      expect(inactiveTab).toHaveAttribute('aria-selected', 'false');
    });

    it('should call onTabClick when tab is clicked', () => {
      const onTabClick = vi.fn();
      render(<DockZone {...createDefaultProps({ onTabClick })} />);

      fireEvent.click(screen.getByRole('tab', { name: /Inspector/i }));
      expect(onTabClick).toHaveBeenCalledWith('inspector');
    });
  });

  describe('panel content', () => {
    it('should render active panel content', () => {
      render(<DockZone {...createDefaultProps()} />);
      expect(screen.getByTestId('panel-content-explorer')).toBeInTheDocument();
      expect(screen.queryByTestId('panel-content-inspector')).not.toBeInTheDocument();
    });

    it('should not render content when collapsed', () => {
      render(<DockZone {...createDefaultProps({ collapsed: true })} />);
      expect(screen.queryByTestId('panel-content-explorer')).not.toBeInTheDocument();
    });

    it('should keep configured active panel content mounted when collapsed', () => {
      render(
        <DockZone
          {...createDefaultProps({
            activePanelId: 'explorer',
            collapsed: true,
            keepMountedPanelIds: ['explorer'],
          })}
        />,
      );

      const content = screen.getByTestId('panel-content-explorer');
      expect(content).toBeInTheDocument();
      expect(content.parentElement).toHaveAttribute('aria-hidden', 'true');
      expect(content.parentElement).toHaveClass('hidden');
    });
  });

  describe('collapse toggle', () => {
    it('should call onToggleCollapse when collapse button is clicked', () => {
      const onToggleCollapse = vi.fn();
      render(<DockZone {...createDefaultProps({ onToggleCollapse })} />);

      fireEvent.click(screen.getByLabelText('Collapse panel'));
      expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    });

    it('should show expand label when collapsed', () => {
      render(<DockZone {...createDefaultProps({ collapsed: true })} />);
      expect(screen.getByLabelText('Expand panel')).toBeInTheDocument();
    });

    it('should render a compact icon rail when a horizontal zone is collapsed', () => {
      render(
        <DockZone
          {...createDefaultProps({
            collapsed: true,
            collapseDirection: 'horizontal',
          })}
        />,
      );

      expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
      expect(screen.getByRole('tab', { name: /Project Explorer/i })).toBeInTheDocument();
      expect(screen.queryByText('Project Explorer')).not.toBeInTheDocument();
    });
  });

  describe('drag and drop', () => {
    it('should avoid native HTML5 dragging on tab buttons', () => {
      render(<DockZone {...createDefaultProps()} />);
      const tab = screen.getByRole('tab', { name: /Project Explorer/i });
      expect(tab).toHaveAttribute('draggable', 'false');
    });

    it('should call onDragStart when tab drag begins', () => {
      const onDragStart = vi.fn();
      render(<DockZone {...createDefaultProps({ onDragStart })} />);

      const tab = screen.getByRole('tab', { name: /Project Explorer/i });
      fireEvent.dragStart(tab, { dataTransfer: { setData: vi.fn(), effectAllowed: '' } });
      expect(onDragStart).toHaveBeenCalledWith('explorer');
    });

    it('should call onDrop when panel is dropped into zone', () => {
      const onDrop = vi.fn();
      render(
        <DockZone
          {...createDefaultProps({
            onDrop,
            isDragging: true,
            draggedPanelId: 'timeline',
          })}
        />,
      );

      const zone = screen.getByTestId('dock-zone-left');
      fireEvent.drop(zone, {
        dataTransfer: { getData: () => 'timeline' },
        preventDefault: vi.fn(),
      });
      expect(onDrop).toHaveBeenCalledWith('timeline');
    });

    it('should move panels through pointer-driven tab drag', () => {
      const onDragStart = vi.fn();
      const onDragEnd = vi.fn();
      const onDrop = vi.fn();

      render(
        <>
          <DockZone
            {...createDefaultProps({
              zoneId: 'left',
              panelIds: ['explorer'],
              activePanelId: 'explorer',
              onDragStart,
              onDragEnd,
            })}
          />
          <DockZone
            {...createDefaultProps({
              zoneId: 'right',
              panelIds: ['timeline'],
              activePanelId: 'timeline',
              onDrop,
            })}
          />
        </>,
      );

      const targetZone = screen.getByTestId('dock-zone-right');
      targetZone.getBoundingClientRect = vi.fn().mockReturnValue({
        x: 200,
        y: 0,
        top: 0,
        left: 200,
        width: 300,
        height: 200,
        right: 500,
        bottom: 200,
        toJSON: () => ({}),
      });

      const tab = screen.getByRole('tab', { name: /Project Explorer/i });
      fireEvent.pointerDown(tab, { button: 0, pointerId: 4, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(document, { pointerId: 4, clientX: 250, clientY: 50 });
      fireEvent.pointerUp(document, { pointerId: 4, clientX: 250, clientY: 50 });

      expect(onDragStart).toHaveBeenCalledWith('explorer');
      expect(onDrop).toHaveBeenCalledWith('explorer');
      expect(onDragEnd).toHaveBeenCalledTimes(1);
    });
  });

  describe('empty zone', () => {
    it('should not render when empty and not dragging', () => {
      const { container } = render(
        <DockZone {...createDefaultProps({ panelIds: [], activePanelId: null })} />,
      );
      expect(container.innerHTML).toBe('');
    });

    it('should show drop target when empty and dragging', () => {
      render(
        <DockZone
          {...createDefaultProps({
            panelIds: [],
            activePanelId: null,
            isDragging: true,
            draggedPanelId: 'explorer',
          })}
        />,
      );
      expect(screen.getByText('Drop panel here')).toBeInTheDocument();
    });
  });

  describe('hidden tabs', () => {
    it('should hide tab bar when showTabs is false', () => {
      render(<DockZone {...createDefaultProps({ showTabs: false })} />);
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
      // Content should still render
      expect(screen.getByTestId('panel-content-explorer')).toBeInTheDocument();
    });
  });
});
