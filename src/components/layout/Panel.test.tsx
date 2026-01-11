/**
 * Panel Component Tests
 *
 * Tests for the generic panel wrapper component using TDD methodology.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Panel } from './Panel';

describe('Panel', () => {
  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render children', () => {
      render(
        <Panel>
          <div data-testid="content">Panel Content</div>
        </Panel>
      );
      expect(screen.getByTestId('content')).toBeInTheDocument();
    });

    it('should render title when provided', () => {
      render(<Panel title="My Panel">Content</Panel>);
      expect(screen.getByText('My Panel')).toBeInTheDocument();
    });

    it('should not render title when not provided', () => {
      render(<Panel>Content</Panel>);
      expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    });

    it('should apply custom className', () => {
      const { container } = render(
        <Panel className="custom-class">Content</Panel>
      );
      const panel = container.firstChild as HTMLElement;
      expect(panel.className).toContain('custom-class');
    });
  });

  // ===========================================================================
  // Variant Tests
  // ===========================================================================

  describe('variants', () => {
    it('should apply default variant styling', () => {
      const { container } = render(<Panel>Content</Panel>);
      const panel = container.firstChild as HTMLElement;
      expect(panel.className).toContain('bg-editor-panel');
    });

    it('should apply sidebar variant styling', () => {
      const { container } = render(<Panel variant="sidebar">Content</Panel>);
      const panel = container.firstChild as HTMLElement;
      expect(panel.className).toContain('bg-editor-sidebar');
    });

    it('should apply dark variant styling', () => {
      const { container } = render(<Panel variant="dark">Content</Panel>);
      const panel = container.firstChild as HTMLElement;
      expect(panel.className).toContain('bg-editor-bg');
    });
  });

  // ===========================================================================
  // Padding Tests
  // ===========================================================================

  describe('padding', () => {
    it('should have default padding', () => {
      const { container } = render(<Panel>Content</Panel>);
      const panel = container.firstChild as HTMLElement;
      expect(panel.className).toContain('p-4');
    });

    it('should have no padding when noPadding is true', () => {
      const { container } = render(<Panel noPadding>Content</Panel>);
      const panel = container.firstChild as HTMLElement;
      expect(panel.className).not.toContain('p-4');
    });
  });

  // ===========================================================================
  // Border Tests
  // ===========================================================================

  describe('borders', () => {
    it('should not have border by default', () => {
      const { container } = render(<Panel>Content</Panel>);
      const panel = container.firstChild as HTMLElement;
      expect(panel.className).not.toContain('border');
    });

    it('should have border when bordered is true', () => {
      const { container } = render(<Panel bordered>Content</Panel>);
      const panel = container.firstChild as HTMLElement;
      expect(panel.className).toContain('border');
      expect(panel.className).toContain('border-editor-border');
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('accessibility', () => {
    it('should accept data-testid', () => {
      render(<Panel data-testid="my-panel">Content</Panel>);
      expect(screen.getByTestId('my-panel')).toBeInTheDocument();
    });

    it('should forward aria attributes', () => {
      render(
        <Panel aria-label="Main panel" role="region">
          Content
        </Panel>
      );
      expect(screen.getByRole('region')).toHaveAttribute('aria-label', 'Main panel');
    });
  });
});
