/**
 * EffectInspector Component Tests
 *
 * Tests for the effect inspector panel that displays and edits
 * parameters for a selected effect.
 * TDD: RED phase - writing tests first
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EffectInspector } from './EffectInspector';
import type { Effect, ParamDef, ParamValue } from '@/types';

// =============================================================================
// Test Data
// =============================================================================

const createParamDef = (
  name: string,
  label: string,
  defaultValue: ParamValue,
  options?: Partial<ParamDef>
): ParamDef => ({
  name,
  label,
  default: defaultValue,
  ...options,
});

const mockEffect: Effect = {
  id: 'effect_001',
  effectType: 'brightness',
  enabled: true,
  params: { value: 0.5 },
  keyframes: {},
  order: 0,
};

const mockBrightnessParamDefs: ParamDef[] = [
  createParamDef('value', 'Brightness', { type: 'float', value: 0 }, { min: -1, max: 1, step: 0.01 }),
];

const mockBlurEffect: Effect = {
  id: 'effect_002',
  effectType: 'gaussian_blur',
  enabled: true,
  params: { radius: 10, sigma: 2 },
  keyframes: {},
  order: 1,
};

const mockBlurParamDefs: ParamDef[] = [
  createParamDef('radius', 'Radius', { type: 'int', value: 5 }, { min: 0, max: 100, step: 1 }),
  createParamDef('sigma', 'Sigma', { type: 'float', value: 1.0 }, { min: 0, max: 10, step: 0.1 }),
];

const mockWipeEffect: Effect = {
  id: 'effect_003',
  effectType: 'wipe',
  enabled: true,
  params: { duration: 1.0, direction: 'left' },
  keyframes: {},
  order: 0,
};

const mockWipeParamDefs: ParamDef[] = [
  createParamDef('duration', 'Duration', { type: 'float', value: 1.0 }, { min: 0.1, max: 10, step: 0.1 }),
];

// =============================================================================
// Rendering Tests
// =============================================================================

describe('EffectInspector', () => {
  describe('rendering', () => {
    it('should render the effect inspector container', () => {
      render(
        <EffectInspector
          effect={mockEffect}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByTestId('effect-inspector')).toBeInTheDocument();
    });

    it('should render effect name in header', () => {
      render(
        <EffectInspector
          effect={mockEffect}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
        />
      );

      // Header contains the effect name in a span with specific class
      const header = screen.getByTestId('effect-inspector').querySelector('.font-medium');
      expect(header).toHaveTextContent('Brightness');
    });

    it('should render empty state when no effect is selected', () => {
      render(
        <EffectInspector
          effect={null}
          paramDefs={[]}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByText(/no effect selected/i)).toBeInTheDocument();
    });

    it('should render parameter editors for each param', () => {
      render(
        <EffectInspector
          effect={mockBlurEffect}
          paramDefs={mockBlurParamDefs}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByText('Radius')).toBeInTheDocument();
      expect(screen.getByText('Sigma')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Parameter Value Display Tests
  // ===========================================================================

  describe('parameter values', () => {
    it('should display current parameter values', () => {
      render(
        <EffectInspector
          effect={mockBlurEffect}
          paramDefs={mockBlurParamDefs}
          onChange={vi.fn()}
        />
      );

      // Find inputs with current values
      const radiusInput = screen.getByLabelText('Radius') as HTMLInputElement;
      expect(radiusInput.value).toBe('10');
    });

    it('should use default value when param is not set', () => {
      const effectWithMissingParam: Effect = {
        ...mockBlurEffect,
        params: { radius: 10 }, // sigma is missing
      };

      render(
        <EffectInspector
          effect={effectWithMissingParam}
          paramDefs={mockBlurParamDefs}
          onChange={vi.fn()}
        />
      );

      const sigmaInput = screen.getByLabelText('Sigma') as HTMLInputElement;
      expect(sigmaInput.value).toBe('1'); // Default value
    });
  });

  // ===========================================================================
  // Parameter Change Tests
  // ===========================================================================

  describe('parameter changes', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should call onChange when parameter value changes', async () => {
      const onChange = vi.fn();
      render(
        <EffectInspector
          effect={mockEffect}
          paramDefs={mockBrightnessParamDefs}
          onChange={onChange}
        />
      );

      const input = screen.getByLabelText('Brightness');
      fireEvent.change(input, { target: { value: '0.75' } });
      fireEvent.blur(input);

      // Wait for debounce to complete
      vi.advanceTimersByTime(20);

      expect(onChange).toHaveBeenCalledWith('effect_001', { value: 0.75 });
    });

    it('should preserve other param values when one changes', async () => {
      const onChange = vi.fn();
      render(
        <EffectInspector
          effect={mockBlurEffect}
          paramDefs={mockBlurParamDefs}
          onChange={onChange}
        />
      );

      const radiusInput = screen.getByLabelText('Radius');
      fireEvent.change(radiusInput, { target: { value: '20' } });
      fireEvent.blur(radiusInput);

      // Wait for debounce to complete
      vi.advanceTimersByTime(20);

      expect(onChange).toHaveBeenCalledWith('effect_002', {
        radius: 20,
        sigma: 2, // Preserved
      });
    });
  });

  // ===========================================================================
  // Enable/Disable Tests
  // ===========================================================================

  describe('enable/disable toggle', () => {
    it('should render enable toggle', () => {
      render(
        <EffectInspector
          effect={mockEffect}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByRole('checkbox', { name: /enabled/i })).toBeInTheDocument();
    });

    it('should show correct enabled state', () => {
      render(
        <EffectInspector
          effect={mockEffect}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
        />
      );

      const toggle = screen.getByRole('checkbox', { name: /enabled/i });
      expect(toggle).toBeChecked();
    });

    it('should call onToggle when enabled state changes', () => {
      const onToggle = vi.fn();
      render(
        <EffectInspector
          effect={mockEffect}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
          onToggle={onToggle}
        />
      );

      const toggle = screen.getByRole('checkbox', { name: /enabled/i });
      fireEvent.click(toggle);

      expect(onToggle).toHaveBeenCalledWith('effect_001', false);
    });
  });

  // ===========================================================================
  // Delete Tests
  // ===========================================================================

  describe('delete action', () => {
    it('should render delete button when onDelete is provided', () => {
      render(
        <EffectInspector
          effect={mockEffect}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );

      expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
    });

    it('should not render delete button when onDelete is not provided', () => {
      render(
        <EffectInspector
          effect={mockEffect}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
        />
      );

      expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    });

    it('should call onDelete when delete button is clicked', () => {
      const onDelete = vi.fn();
      render(
        <EffectInspector
          effect={mockEffect}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
          onDelete={onDelete}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /delete/i }));

      expect(onDelete).toHaveBeenCalledWith('effect_001');
    });
  });

  // ===========================================================================
  // Reset Tests
  // ===========================================================================

  describe('reset action', () => {
    it('should render reset button', () => {
      render(
        <EffectInspector
          effect={mockEffect}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByRole('button', { name: /reset to defaults/i })).toBeInTheDocument();
    });

    it('should reset all params to default values when reset is clicked', () => {
      const onChange = vi.fn();
      render(
        <EffectInspector
          effect={mockBlurEffect}
          paramDefs={mockBlurParamDefs}
          onChange={onChange}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /reset to defaults/i }));

      expect(onChange).toHaveBeenCalledWith('effect_002', {
        radius: 5, // Default value from paramDef
        sigma: 1.0, // Default value from paramDef
      });
    });
  });

  // ===========================================================================
  // Read-Only Mode Tests
  // ===========================================================================

  describe('read-only mode', () => {
    it('should disable inputs when readOnly is true', () => {
      render(
        <EffectInspector
          effect={mockEffect}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
          readOnly
        />
      );

      const input = screen.getByLabelText('Brightness');
      expect(input).toBeDisabled();
    });

    it('should hide delete button in read-only mode', () => {
      render(
        <EffectInspector
          effect={mockEffect}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
          onDelete={vi.fn()}
          readOnly
        />
      );

      expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    });

    it('should disable enable toggle in read-only mode', () => {
      render(
        <EffectInspector
          effect={mockEffect}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
          readOnly
        />
      );

      const toggle = screen.getByRole('checkbox', { name: /enabled/i });
      expect(toggle).toBeDisabled();
    });
  });

  // ===========================================================================
  // Styling Tests
  // ===========================================================================

  describe('styling', () => {
    it('should apply custom className', () => {
      render(
        <EffectInspector
          effect={mockEffect}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
          className="custom-class"
        />
      );

      expect(screen.getByTestId('effect-inspector')).toHaveClass('custom-class');
    });
  });

  // ===========================================================================
  // Transition Effect Tests
  // ===========================================================================

  describe('transition effects', () => {
    it('should display transition effect parameters', () => {
      render(
        <EffectInspector
          effect={mockWipeEffect}
          paramDefs={mockWipeParamDefs}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByText('Wipe')).toBeInTheDocument();
      expect(screen.getByText('Duration')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Keyframe Editor Integration Tests
  // ===========================================================================

  describe('keyframe editor integration', () => {
    const effectWithKeyframes: Effect = {
      id: 'effect_kf',
      effectType: 'brightness',
      enabled: true,
      params: { value: 0.5 },
      keyframes: {
        value: [
          { timeOffset: 0, value: { type: 'float', value: 0 }, easing: 'linear' },
          { timeOffset: 1, value: { type: 'float', value: 1 }, easing: 'ease_out' },
        ],
      },
      order: 0,
    };

    it('should render keyframe toggle button for animatable params when showKeyframes is true', () => {
      render(
        <EffectInspector
          effect={mockEffect}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
          showKeyframes
          currentTime={0}
        />
      );

      expect(screen.getByRole('button', { name: /toggle keyframe/i })).toBeInTheDocument();
    });

    it('should not render keyframe toggle when showKeyframes is false', () => {
      render(
        <EffectInspector
          effect={mockEffect}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
          currentTime={0}
        />
      );

      expect(screen.queryByRole('button', { name: /toggle keyframe/i })).not.toBeInTheDocument();
    });

    it('should render KeyframeEditor when param has keyframes', () => {
      render(
        <EffectInspector
          effect={effectWithKeyframes}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
          showKeyframes
          currentTime={0.5}
          duration={2}
        />
      );

      expect(screen.getByTestId('keyframe-editor')).toBeInTheDocument();
    });

    it('should show keyframe markers in the editor', () => {
      render(
        <EffectInspector
          effect={effectWithKeyframes}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
          showKeyframes
          currentTime={0.5}
          duration={2}
        />
      );

      const markers = screen.getAllByTestId('keyframe-marker');
      expect(markers).toHaveLength(2);
    });

    it('should call onKeyframesChange when keyframes are modified', () => {
      const onKeyframesChange = vi.fn();
      render(
        <EffectInspector
          effect={effectWithKeyframes}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
          onKeyframesChange={onKeyframesChange}
          showKeyframes
          currentTime={0.5}
          duration={2}
        />
      );

      // Click add keyframe button
      fireEvent.click(screen.getByRole('button', { name: /add keyframe/i }));

      expect(onKeyframesChange).toHaveBeenCalledWith(
        'effect_kf',
        'value',
        expect.any(Array)
      );
    });

    it('should expand keyframe editor when toggle is clicked for param without keyframes', () => {
      render(
        <EffectInspector
          effect={mockEffect}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
          showKeyframes
          currentTime={0}
          duration={2}
        />
      );

      // Toggle keyframe for the param
      fireEvent.click(screen.getByRole('button', { name: /toggle keyframe/i }));

      // Now keyframe editor should be visible
      expect(screen.getByTestId('keyframe-editor')).toBeInTheDocument();
    });

    it('should not show keyframe features in read-only mode', () => {
      render(
        <EffectInspector
          effect={effectWithKeyframes}
          paramDefs={mockBrightnessParamDefs}
          onChange={vi.fn()}
          showKeyframes
          currentTime={0.5}
          duration={2}
          readOnly
        />
      );

      // Keyframe editor should be visible but read-only
      expect(screen.getByTestId('keyframe-editor')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /add keyframe/i })).not.toBeInTheDocument();
    });
  });
});
