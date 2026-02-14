/**
 * Sidebar Component Tests
 *
 * Tests for the collapsible sidebar component using TDD methodology.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from './Sidebar';

const originalInnerWidth = window.innerWidth;

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  window.dispatchEvent(new Event('resize'));
}

describe('Sidebar', () => {
  beforeEach(() => {
    setViewportWidth(1280);
  });

  afterEach(() => {
    setViewportWidth(originalInnerWidth);
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render with title', () => {
      render(<Sidebar title="Project Explorer">Content</Sidebar>);
      expect(screen.getByText('Project Explorer')).toBeInTheDocument();
    });

    it('should render children', () => {
      render(
        <Sidebar title="Test">
          <div data-testid="child">Child Content</div>
        </Sidebar>,
      );
      expect(screen.getByTestId('child')).toBeInTheDocument();
    });

    it('should render on left side by default', () => {
      const { container } = render(<Sidebar title="Test">Content</Sidebar>);
      const sidebar = container.firstChild as HTMLElement;
      expect(sidebar.className).toContain('border-r');
    });

    it('should render on right side when position is right', () => {
      const { container } = render(
        <Sidebar title="Test" position="right">
          Content
        </Sidebar>,
      );
      const sidebar = container.firstChild as HTMLElement;
      expect(sidebar.className).toContain('border-l');
    });
  });

  // ===========================================================================
  // Collapse/Expand Tests
  // ===========================================================================

  describe('collapse/expand', () => {
    it('should be expanded by default', () => {
      render(<Sidebar title="Test">Content</Sidebar>);
      expect(screen.getByText('Content')).toBeVisible();
    });

    it('should collapse when toggle button is clicked', async () => {
      render(<Sidebar title="Test">Content</Sidebar>);

      const toggleButton = screen.getByRole('button', { name: /toggle/i });
      fireEvent.click(toggleButton);

      // Content should be hidden when collapsed
      expect(screen.queryByText('Content')).not.toBeInTheDocument();
    });

    it('should expand when toggle button is clicked while collapsed', async () => {
      render(
        <Sidebar title="Test" defaultCollapsed>
          Content
        </Sidebar>,
      );

      // Initially collapsed
      expect(screen.queryByText('Content')).not.toBeInTheDocument();

      const toggleButton = screen.getByRole('button', { name: /toggle/i });
      fireEvent.click(toggleButton);

      // Should be visible after expanding
      expect(screen.getByText('Content')).toBeVisible();
    });

    it('should call onCollapse callback when collapsed', () => {
      const onCollapse = vi.fn();
      render(
        <Sidebar title="Test" onCollapse={onCollapse}>
          Content
        </Sidebar>,
      );

      const toggleButton = screen.getByRole('button', { name: /toggle/i });
      fireEvent.click(toggleButton);

      expect(onCollapse).toHaveBeenCalledWith(true);
    });

    it('should respect defaultCollapsed prop', () => {
      render(
        <Sidebar title="Test" defaultCollapsed>
          Content
        </Sidebar>,
      );
      expect(screen.queryByText('Content')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Size Tests
  // ===========================================================================

  describe('sizing', () => {
    it('should have default width', () => {
      const { container } = render(<Sidebar title="Test">Content</Sidebar>);
      const sidebar = container.firstChild as HTMLElement;
      // Default width class should be present
      expect(sidebar.className).toContain('w-64');
    });

    it('should accept custom width', () => {
      const { container } = render(
        <Sidebar title="Test" width={320}>
          Content
        </Sidebar>,
      );
      const sidebar = container.firstChild as HTMLElement;
      expect(sidebar.style.width).toBe('320px');
    });

    it('should have collapsed width when collapsed', async () => {
      const { container } = render(
        <Sidebar title="Test" defaultCollapsed>
          Content
        </Sidebar>,
      );
      const sidebar = container.firstChild as HTMLElement;
      // Collapsed width should be minimal (icon width)
      expect(sidebar.className).toContain('w-10');
    });
  });

  describe('responsive behavior', () => {
    it('should auto-collapse on narrower viewports', () => {
      setViewportWidth(900);

      render(<Sidebar title="Responsive">Content</Sidebar>);

      expect(screen.queryByText('Content')).not.toBeInTheDocument();
    });

    it('should respect custom autoCollapseBreakpoint', () => {
      setViewportWidth(950);

      render(
        <Sidebar title="Responsive" autoCollapseBreakpoint={900}>
          Content
        </Sidebar>,
      );

      expect(screen.getByText('Content')).toBeVisible();
    });
  });
});
