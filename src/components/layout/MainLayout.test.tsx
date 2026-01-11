/**
 * MainLayout Component Tests
 *
 * Tests for the main application layout using TDD methodology.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MainLayout } from './MainLayout';

describe('MainLayout', () => {
  // ===========================================================================
  // Structure Tests
  // ===========================================================================

  describe('structure', () => {
    it('should render header', () => {
      render(
        <MainLayout
          header={<div data-testid="header">Header</div>}
          leftSidebar={<div>Left</div>}
          rightSidebar={<div>Right</div>}
          footer={<div>Footer</div>}
        >
          <div>Content</div>
        </MainLayout>
      );
      expect(screen.getByTestId('header')).toBeInTheDocument();
    });

    it('should render left sidebar', () => {
      render(
        <MainLayout
          header={<div>Header</div>}
          leftSidebar={<div data-testid="left-sidebar">Left</div>}
          rightSidebar={<div>Right</div>}
          footer={<div>Footer</div>}
        >
          <div>Content</div>
        </MainLayout>
      );
      expect(screen.getByTestId('left-sidebar')).toBeInTheDocument();
    });

    it('should render right sidebar', () => {
      render(
        <MainLayout
          header={<div>Header</div>}
          leftSidebar={<div>Left</div>}
          rightSidebar={<div data-testid="right-sidebar">Right</div>}
          footer={<div>Footer</div>}
        >
          <div>Content</div>
        </MainLayout>
      );
      expect(screen.getByTestId('right-sidebar')).toBeInTheDocument();
    });

    it('should render main content', () => {
      render(
        <MainLayout
          header={<div>Header</div>}
          leftSidebar={<div>Left</div>}
          rightSidebar={<div>Right</div>}
          footer={<div>Footer</div>}
        >
          <div data-testid="main-content">Content</div>
        </MainLayout>
      );
      expect(screen.getByTestId('main-content')).toBeInTheDocument();
    });

    it('should render footer', () => {
      render(
        <MainLayout
          header={<div>Header</div>}
          leftSidebar={<div>Left</div>}
          rightSidebar={<div>Right</div>}
          footer={<div data-testid="footer">Footer</div>}
        >
          <div>Content</div>
        </MainLayout>
      );
      expect(screen.getByTestId('footer')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Optional Elements Tests
  // ===========================================================================

  describe('optional elements', () => {
    it('should render without left sidebar', () => {
      render(
        <MainLayout
          header={<div>Header</div>}
          rightSidebar={<div>Right</div>}
          footer={<div>Footer</div>}
        >
          <div data-testid="content">Content</div>
        </MainLayout>
      );
      expect(screen.getByTestId('content')).toBeInTheDocument();
    });

    it('should render without right sidebar', () => {
      render(
        <MainLayout
          header={<div>Header</div>}
          leftSidebar={<div>Left</div>}
          footer={<div>Footer</div>}
        >
          <div data-testid="content">Content</div>
        </MainLayout>
      );
      expect(screen.getByTestId('content')).toBeInTheDocument();
    });

    it('should render without footer', () => {
      render(
        <MainLayout
          header={<div>Header</div>}
          leftSidebar={<div>Left</div>}
          rightSidebar={<div>Right</div>}
        >
          <div data-testid="content">Content</div>
        </MainLayout>
      );
      expect(screen.getByTestId('content')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Layout Tests
  // ===========================================================================

  describe('layout', () => {
    it('should fill viewport height', () => {
      const { container } = render(
        <MainLayout header={<div>Header</div>}>
          <div>Content</div>
        </MainLayout>
      );
      const layout = container.firstChild as HTMLElement;
      expect(layout.className).toContain('h-screen');
    });

    it('should use flex layout', () => {
      const { container } = render(
        <MainLayout header={<div>Header</div>}>
          <div>Content</div>
        </MainLayout>
      );
      const layout = container.firstChild as HTMLElement;
      expect(layout.className).toContain('flex');
      expect(layout.className).toContain('flex-col');
    });

    it('should apply editor background', () => {
      const { container } = render(
        <MainLayout header={<div>Header</div>}>
          <div>Content</div>
        </MainLayout>
      );
      const layout = container.firstChild as HTMLElement;
      expect(layout.className).toContain('bg-editor-bg');
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('accessibility', () => {
    it('should have proper landmark roles', () => {
      render(
        <MainLayout
          header={<div>Header</div>}
          leftSidebar={<div>Left</div>}
          rightSidebar={<div>Right</div>}
          footer={<div>Footer</div>}
        >
          <div>Content</div>
        </MainLayout>
      );

      expect(screen.getByRole('banner')).toBeInTheDocument(); // header
      expect(screen.getByRole('main')).toBeInTheDocument(); // main content area
      expect(screen.getByRole('contentinfo')).toBeInTheDocument(); // footer
    });
  });
});
