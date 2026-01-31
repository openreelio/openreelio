/**
 * TabbedBottomPanel Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabbedBottomPanel, type BottomPanelTab } from './TabbedBottomPanel';

const mockTabs: BottomPanelTab[] = [
  {
    id: 'console',
    label: 'Console',
    content: <div data-testid="console-content">Console Content</div>,
  },
  {
    id: 'mixer',
    label: 'Mixer',
    content: <div data-testid="mixer-content">Mixer Content</div>,
  },
];

describe('TabbedBottomPanel', () => {
  describe('rendering', () => {
    it('should render with tabs', () => {
      render(<TabbedBottomPanel tabs={mockTabs} />);

      expect(screen.getByRole('tab', { name: /Console/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /Mixer/i })).toBeInTheDocument();
    });

    it('should render default tab content', () => {
      render(<TabbedBottomPanel tabs={mockTabs} defaultTab="console" />);

      expect(screen.getByTestId('console-content')).toBeInTheDocument();
    });

    it('should render first tab by default if no defaultTab provided', () => {
      render(<TabbedBottomPanel tabs={mockTabs} />);

      expect(screen.getByTestId('console-content')).toBeInTheDocument();
    });
  });

  describe('tab switching', () => {
    it('should switch tabs on click', () => {
      render(<TabbedBottomPanel tabs={mockTabs} defaultTab="console" />);

      // Click mixer tab
      fireEvent.click(screen.getByRole('tab', { name: /Mixer/i }));

      expect(screen.getByTestId('mixer-content')).toBeInTheDocument();
      expect(screen.queryByTestId('console-content')).not.toBeInTheDocument();
    });

    it('should call onTabChange when tab changes', () => {
      const onTabChange = vi.fn();
      render(
        <TabbedBottomPanel
          tabs={mockTabs}
          defaultTab="console"
          onTabChange={onTabChange}
        />
      );

      fireEvent.click(screen.getByRole('tab', { name: /Mixer/i }));

      expect(onTabChange).toHaveBeenCalledWith('mixer');
    });
  });

  describe('collapse behavior', () => {
    it('should start collapsed when defaultCollapsed is true', () => {
      render(
        <TabbedBottomPanel tabs={mockTabs} defaultCollapsed />
      );

      // Content should not be visible
      expect(screen.queryByTestId('console-content')).not.toBeInTheDocument();
    });

    it('should collapse when clicking the same tab', () => {
      render(<TabbedBottomPanel tabs={mockTabs} defaultTab="console" />);

      // Content visible initially
      expect(screen.getByTestId('console-content')).toBeInTheDocument();

      // Click same tab to collapse
      fireEvent.click(screen.getByRole('tab', { name: /Console/i }));

      // Content should be hidden
      expect(screen.queryByTestId('console-content')).not.toBeInTheDocument();
    });

    it('should expand and switch when clicking different tab while collapsed', () => {
      render(
        <TabbedBottomPanel tabs={mockTabs} defaultTab="console" defaultCollapsed />
      );

      // Click mixer tab to expand
      fireEvent.click(screen.getByRole('tab', { name: /Mixer/i }));

      // Mixer content should now be visible
      expect(screen.getByTestId('mixer-content')).toBeInTheDocument();
    });

    it('should call onCollapse when toggle button clicked', () => {
      const onCollapse = vi.fn();
      render(
        <TabbedBottomPanel tabs={mockTabs} onCollapse={onCollapse} />
      );

      fireEvent.click(screen.getByRole('button', { name: /collapse/i }));

      expect(onCollapse).toHaveBeenCalledWith(true);
    });
  });

  describe('accessibility', () => {
    it('should have proper aria-selected on active tab', () => {
      render(<TabbedBottomPanel tabs={mockTabs} defaultTab="console" />);

      const consoleTab = screen.getByRole('tab', { name: /Console/i });
      const mixerTab = screen.getByRole('tab', { name: /Mixer/i });

      expect(consoleTab).toHaveAttribute('aria-selected', 'true');
      expect(mixerTab).toHaveAttribute('aria-selected', 'false');
    });
  });
});
