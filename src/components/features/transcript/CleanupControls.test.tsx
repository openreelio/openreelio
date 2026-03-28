/**
 * CleanupControls Component Tests
 *
 * BDD-style integration tests for silence/filler detection controls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CleanupControls, type CleanupControlsProps } from './CleanupControls';
import type { DetectedRegion } from '@/types';

function createDefaultProps(overrides?: Partial<CleanupControlsProps>): CleanupControlsProps {
  return {
    detectedRegions: [],
    isDetecting: false,
    isRemoving: false,
    mode: null,
    totalDurationSec: 0,
    error: null,
    onDetectSilence: vi.fn().mockResolvedValue(undefined),
    onDetectFillers: vi.fn().mockResolvedValue(undefined),
    onRemoveDetected: vi.fn().mockResolvedValue(undefined),
    onClearDetection: vi.fn(),
    readOnly: false,
    ...overrides,
  };
}

const mockRegions: DetectedRegion[] = [
  { startSec: 1.0, endSec: 2.5, regionType: 'silence', label: 'silence' },
  { startSec: 5.0, endSec: 6.0, regionType: 'filler_word', label: 'um' },
];

describe('CleanupControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Feature: Button Rendering
  // -------------------------------------------------------------------------

  describe('Button Rendering', () => {
    it('should render silence and filler detection buttons', () => {
      render(<CleanupControls {...createDefaultProps()} />);
      expect(screen.getByRole('button', { name: /detect silence/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /detect filler/i })).toBeInTheDocument();
    });

    it('should disable buttons when detecting', () => {
      render(<CleanupControls {...createDefaultProps({ isDetecting: true, mode: 'silence' })} />);
      expect(screen.getByRole('button', { name: /detect silence/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /detect filler/i })).toBeDisabled();
    });

    it('should disable buttons in read-only mode', () => {
      render(<CleanupControls {...createDefaultProps({ readOnly: true })} />);
      expect(screen.getByRole('button', { name: /detect silence/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /detect filler/i })).toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  // Feature: Detection Triggers
  // -------------------------------------------------------------------------

  describe('Detection Triggers', () => {
    it('should call onDetectSilence when silence button clicked', () => {
      const props = createDefaultProps();
      render(<CleanupControls {...props} />);
      fireEvent.click(screen.getByRole('button', { name: /detect silence/i }));
      expect(props.onDetectSilence).toHaveBeenCalled();
    });

    it('should call onDetectFillers when filler button clicked', () => {
      const props = createDefaultProps();
      render(<CleanupControls {...props} />);
      fireEvent.click(screen.getByRole('button', { name: /detect filler/i }));
      expect(props.onDetectFillers).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Feature: Detection Results Display
  // -------------------------------------------------------------------------

  describe('Detection Results', () => {
    it('should show region count and duration when regions detected', () => {
      render(<CleanupControls {...createDefaultProps({
        detectedRegions: mockRegions,
        totalDurationSec: 2.5,
      })} />);
      expect(screen.getByText(/2 found/)).toBeInTheDocument();
      expect(screen.getByText(/2\.5s/)).toBeInTheDocument();
    });

    it('should show Remove All button when regions detected', () => {
      render(<CleanupControls {...createDefaultProps({
        detectedRegions: mockRegions,
        totalDurationSec: 2.5,
      })} />);
      expect(screen.getByRole('button', { name: /remove.*2.*detected/i })).toBeInTheDocument();
    });

    it('should call onRemoveDetected when Remove All clicked', () => {
      const props = createDefaultProps({
        detectedRegions: mockRegions,
        totalDurationSec: 2.5,
      });
      render(<CleanupControls {...props} />);
      fireEvent.click(screen.getByRole('button', { name: /remove.*2.*detected/i }));
      expect(props.onRemoveDetected).toHaveBeenCalled();
    });

    it('should call onClearDetection when clear button clicked', () => {
      const props = createDefaultProps({
        detectedRegions: mockRegions,
        totalDurationSec: 2.5,
      });
      render(<CleanupControls {...props} />);
      fireEvent.click(screen.getByRole('button', { name: /clear detection/i }));
      expect(props.onClearDetection).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Feature: Settings Panel
  // -------------------------------------------------------------------------

  describe('Settings Panel', () => {
    it('should toggle settings panel visibility', () => {
      render(<CleanupControls {...createDefaultProps()} />);
      const settingsBtn = screen.getByRole('button', { name: /toggle detection settings/i });

      // Initially hidden
      expect(screen.queryByLabelText(/silence threshold/i)).not.toBeInTheDocument();

      // Click to show
      fireEvent.click(settingsBtn);
      expect(screen.getByLabelText(/silence threshold/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/minimum silence duration/i)).toBeInTheDocument();

      // Click to hide
      fireEvent.click(settingsBtn);
      expect(screen.queryByLabelText(/silence threshold/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Feature: Error Display
  // -------------------------------------------------------------------------

  describe('Error Display', () => {
    it('should show error message when error is set', () => {
      render(<CleanupControls {...createDefaultProps({ error: 'FFmpeg not found' })} />);
      expect(screen.getByText('FFmpeg not found')).toBeInTheDocument();
    });

    it('should not show error when error is null', () => {
      const { container } = render(<CleanupControls {...createDefaultProps()} />);
      expect(container.querySelector('.text-red-400')).not.toBeInTheDocument();
    });
  });
});
