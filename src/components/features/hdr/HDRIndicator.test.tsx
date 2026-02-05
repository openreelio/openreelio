/**
 * HDRIndicator Component Tests
 *
 * TDD tests for HDR format badge display on assets.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HDRIndicator } from './HDRIndicator';
import type { DetectedHdrInfo } from '@/types';

describe('HDRIndicator', () => {
  // ==========================================================================
  // Rendering Tests
  // ==========================================================================

  describe('rendering', () => {
    it('renders nothing for SDR content', () => {
      const info: DetectedHdrInfo = {
        isHdr: false,
        formatName: 'SDR',
      };

      const { container } = render(<HDRIndicator info={info} />);
      expect(container.firstChild).toBeNull();
    });

    it('renders HDR10 badge for HDR10 content', () => {
      const info: DetectedHdrInfo = {
        isHdr: true,
        primaries: 'bt2020',
        transfer: 'pq',
        formatName: 'HDR10',
      };

      render(<HDRIndicator info={info} />);
      expect(screen.getByText('HDR10')).toBeInTheDocument();
    });

    it('renders HLG badge for HLG content', () => {
      const info: DetectedHdrInfo = {
        isHdr: true,
        primaries: 'bt2020',
        transfer: 'hlg',
        formatName: 'HLG',
      };

      render(<HDRIndicator info={info} />);
      expect(screen.getByText('HLG')).toBeInTheDocument();
    });

    it('renders generic HDR badge for unknown HDR format', () => {
      const info: DetectedHdrInfo = {
        isHdr: true,
        formatName: 'HDR',
      };

      render(<HDRIndicator info={info} />);
      expect(screen.getByText('HDR')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // Styling Tests
  // ==========================================================================

  describe('styling', () => {
    it('applies correct color for HDR10', () => {
      const info: DetectedHdrInfo = {
        isHdr: true,
        primaries: 'bt2020',
        transfer: 'pq',
        formatName: 'HDR10',
      };

      render(<HDRIndicator info={info} />);
      const badge = screen.getByTestId('hdr-indicator');
      expect(badge).toHaveClass('bg-orange-500');
    });

    it('applies correct color for HLG', () => {
      const info: DetectedHdrInfo = {
        isHdr: true,
        primaries: 'bt2020',
        transfer: 'hlg',
        formatName: 'HLG',
      };

      render(<HDRIndicator info={info} />);
      const badge = screen.getByTestId('hdr-indicator');
      expect(badge).toHaveClass('bg-purple-500');
    });

    it('applies correct color for generic HDR', () => {
      const info: DetectedHdrInfo = {
        isHdr: true,
        formatName: 'HDR',
      };

      render(<HDRIndicator info={info} />);
      const badge = screen.getByTestId('hdr-indicator');
      expect(badge).toHaveClass('bg-blue-500');
    });

    it('applies small size variant', () => {
      const info: DetectedHdrInfo = {
        isHdr: true,
        formatName: 'HDR10',
      };

      render(<HDRIndicator info={info} size="sm" />);
      const badge = screen.getByTestId('hdr-indicator');
      expect(badge).toHaveClass('text-xs');
    });

    it('applies large size variant', () => {
      const info: DetectedHdrInfo = {
        isHdr: true,
        formatName: 'HDR10',
      };

      render(<HDRIndicator info={info} size="lg" />);
      const badge = screen.getByTestId('hdr-indicator');
      expect(badge).toHaveClass('text-sm');
    });

    it('applies custom className', () => {
      const info: DetectedHdrInfo = {
        isHdr: true,
        formatName: 'HDR10',
      };

      render(<HDRIndicator info={info} className="custom-class" />);
      const badge = screen.getByTestId('hdr-indicator');
      expect(badge).toHaveClass('custom-class');
    });
  });

  // ==========================================================================
  // Tooltip Tests
  // ==========================================================================

  describe('tooltip', () => {
    it('shows detailed info in tooltip for HDR10', () => {
      const info: DetectedHdrInfo = {
        isHdr: true,
        primaries: 'bt2020',
        transfer: 'pq',
        bitDepth: 10,
        maxCll: 1000,
        maxFall: 400,
        formatName: 'HDR10',
      };

      render(<HDRIndicator info={info} showTooltip />);
      const badge = screen.getByTestId('hdr-indicator');
      expect(badge).toHaveAttribute('title');
      expect(badge.getAttribute('title')).toContain('1000');
      expect(badge.getAttribute('title')).toContain('10-bit');
    });

    it('does not show tooltip when showTooltip is false', () => {
      const info: DetectedHdrInfo = {
        isHdr: true,
        formatName: 'HDR10',
      };

      render(<HDRIndicator info={info} showTooltip={false} />);
      const badge = screen.getByTestId('hdr-indicator');
      expect(badge).not.toHaveAttribute('title');
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    it('handles undefined optional fields', () => {
      const info: DetectedHdrInfo = {
        isHdr: true,
        formatName: 'HDR10',
      };

      render(<HDRIndicator info={info} />);
      expect(screen.getByText('HDR10')).toBeInTheDocument();
    });

    it('handles null info gracefully', () => {
      const { container } = render(<HDRIndicator info={null} />);
      expect(container.firstChild).toBeNull();
    });

    it('handles undefined info gracefully', () => {
      const { container } = render(<HDRIndicator info={undefined} />);
      expect(container.firstChild).toBeNull();
    });
  });
});
