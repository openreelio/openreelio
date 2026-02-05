/**
 * useChromaKey Hook Tests
 *
 * TDD: RED phase - Writing tests first for chroma key state management.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChromaKey } from './useChromaKey';

describe('useChromaKey', () => {
  const mockOnChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Initialization Tests
  // ===========================================================================

  describe('initialization', () => {
    it('should initialize with default values', () => {
      const { result } = renderHook(() => useChromaKey());

      expect(result.current.params.keyColor).toBe('#00FF00');
      expect(result.current.params.similarity).toBe(0.3);
      expect(result.current.params.softness).toBe(0.1);
      expect(result.current.params.spillSuppression).toBe(0);
      expect(result.current.params.edgeFeather).toBe(0);
    });

    it('should initialize with provided values', () => {
      const { result } = renderHook(() =>
        useChromaKey({
          initialParams: {
            keyColor: '#0000FF',
            similarity: 0.5,
            softness: 0.2,
            spillSuppression: 0.3,
            edgeFeather: 1.5,
          },
        })
      );

      expect(result.current.params.keyColor).toBe('#0000FF');
      expect(result.current.params.similarity).toBe(0.5);
      expect(result.current.params.softness).toBe(0.2);
      expect(result.current.params.spillSuppression).toBe(0.3);
      expect(result.current.params.edgeFeather).toBe(1.5);
    });
  });

  // ===========================================================================
  // Parameter Update Tests
  // ===========================================================================

  describe('parameter updates', () => {
    it('should update key color', () => {
      const { result } = renderHook(() => useChromaKey({ onChange: mockOnChange }));

      act(() => {
        result.current.updateParam('keyColor', '#FF0000');
      });

      expect(result.current.params.keyColor).toBe('#FF0000');
      expect(mockOnChange).toHaveBeenCalledWith(
        expect.objectContaining({ keyColor: '#FF0000' })
      );
    });

    it('should update similarity', () => {
      const { result } = renderHook(() => useChromaKey({ onChange: mockOnChange }));

      act(() => {
        result.current.updateParam('similarity', 0.7);
      });

      expect(result.current.params.similarity).toBe(0.7);
    });

    it('should update softness', () => {
      const { result } = renderHook(() => useChromaKey({ onChange: mockOnChange }));

      act(() => {
        result.current.updateParam('softness', 0.5);
      });

      expect(result.current.params.softness).toBe(0.5);
    });

    it('should update spill suppression', () => {
      const { result } = renderHook(() => useChromaKey({ onChange: mockOnChange }));

      act(() => {
        result.current.updateParam('spillSuppression', 0.8);
      });

      expect(result.current.params.spillSuppression).toBe(0.8);
    });

    it('should update edge feather', () => {
      const { result } = renderHook(() => useChromaKey({ onChange: mockOnChange }));

      act(() => {
        result.current.updateParam('edgeFeather', 3.0);
      });

      expect(result.current.params.edgeFeather).toBe(3.0);
    });
  });

  // ===========================================================================
  // Clamp Tests
  // ===========================================================================

  describe('value clamping', () => {
    it('should clamp similarity to 0-1 range', () => {
      const { result } = renderHook(() => useChromaKey());

      act(() => {
        result.current.updateParam('similarity', 1.5);
      });
      expect(result.current.params.similarity).toBe(1);

      act(() => {
        result.current.updateParam('similarity', -0.5);
      });
      expect(result.current.params.similarity).toBe(0);
    });

    it('should clamp softness to 0-1 range', () => {
      const { result } = renderHook(() => useChromaKey());

      act(() => {
        result.current.updateParam('softness', 2.0);
      });
      expect(result.current.params.softness).toBe(1);
    });

    it('should clamp spill suppression to 0-1 range', () => {
      const { result } = renderHook(() => useChromaKey());

      act(() => {
        result.current.updateParam('spillSuppression', 1.5);
      });
      expect(result.current.params.spillSuppression).toBe(1);
    });

    it('should clamp edge feather to 0-10 range', () => {
      const { result } = renderHook(() => useChromaKey());

      act(() => {
        result.current.updateParam('edgeFeather', 15);
      });
      expect(result.current.params.edgeFeather).toBe(10);

      act(() => {
        result.current.updateParam('edgeFeather', -5);
      });
      expect(result.current.params.edgeFeather).toBe(0);
    });
  });

  // ===========================================================================
  // Reset Tests
  // ===========================================================================

  describe('reset', () => {
    it('should reset all values to defaults', () => {
      const { result } = renderHook(() => useChromaKey({ onChange: mockOnChange }));

      // Change some values
      act(() => {
        result.current.updateParam('keyColor', '#FF0000');
        result.current.updateParam('similarity', 0.9);
        result.current.updateParam('spillSuppression', 0.5);
      });

      // Reset
      act(() => {
        result.current.reset();
      });

      expect(result.current.params.keyColor).toBe('#00FF00');
      expect(result.current.params.similarity).toBe(0.3);
      expect(result.current.params.spillSuppression).toBe(0);
      expect(mockOnChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          keyColor: '#00FF00',
          similarity: 0.3,
        })
      );
    });
  });

  // ===========================================================================
  // Preset Tests
  // ===========================================================================

  describe('presets', () => {
    it('should apply green screen preset', () => {
      const { result } = renderHook(() => useChromaKey({ onChange: mockOnChange }));

      act(() => {
        result.current.applyPreset('green');
      });

      expect(result.current.params.keyColor).toBe('#00FF00');
      expect(result.current.params.similarity).toBeGreaterThan(0);
    });

    it('should apply blue screen preset', () => {
      const { result } = renderHook(() => useChromaKey({ onChange: mockOnChange }));

      act(() => {
        result.current.applyPreset('blue');
      });

      expect(result.current.params.keyColor).toBe('#0000FF');
    });

    it('should apply magenta preset', () => {
      const { result } = renderHook(() => useChromaKey({ onChange: mockOnChange }));

      act(() => {
        result.current.applyPreset('magenta');
      });

      expect(result.current.params.keyColor).toBe('#FF00FF');
    });
  });

  // ===========================================================================
  // Sample Color Tests
  // ===========================================================================

  describe('sample color', () => {
    it('should have isSampling state', () => {
      const { result } = renderHook(() => useChromaKey());

      expect(result.current.isSampling).toBe(false);
    });

    it('should enable sampling mode', () => {
      const { result } = renderHook(() => useChromaKey());

      act(() => {
        result.current.startSampling();
      });

      expect(result.current.isSampling).toBe(true);
    });

    it('should cancel sampling mode', () => {
      const { result } = renderHook(() => useChromaKey());

      act(() => {
        result.current.startSampling();
      });

      act(() => {
        result.current.cancelSampling();
      });

      expect(result.current.isSampling).toBe(false);
    });

    it('should apply sampled color and exit sampling mode', () => {
      const { result } = renderHook(() => useChromaKey({ onChange: mockOnChange }));

      act(() => {
        result.current.startSampling();
      });

      act(() => {
        result.current.applySampledColor('#FF5500');
      });

      expect(result.current.isSampling).toBe(false);
      expect(result.current.params.keyColor).toBe('#FF5500');
      expect(mockOnChange).toHaveBeenCalledWith(
        expect.objectContaining({ keyColor: '#FF5500' })
      );
    });
  });

  // ===========================================================================
  // FFmpeg Filter Generation Tests
  // ===========================================================================

  describe('FFmpeg filter string', () => {
    it('should generate valid chromakey filter string', () => {
      const { result } = renderHook(() =>
        useChromaKey({
          initialParams: {
            keyColor: '#00FF00',
            similarity: 0.3,
            softness: 0.1,
            spillSuppression: 0,
            edgeFeather: 0,
          },
        })
      );

      expect(result.current.ffmpegFilter).toContain('chromakey');
      expect(result.current.ffmpegFilter).toContain('color=0x00FF00');
    });

    it('should include similarity in filter', () => {
      const { result } = renderHook(() =>
        useChromaKey({
          initialParams: {
            keyColor: '#00FF00',
            similarity: 0.5,
            softness: 0.1,
            spillSuppression: 0,
            edgeFeather: 0,
          },
        })
      );

      expect(result.current.ffmpegFilter).toContain('similarity=0.5');
    });

    it('should include blend (softness) in filter', () => {
      const { result } = renderHook(() =>
        useChromaKey({
          initialParams: {
            keyColor: '#00FF00',
            similarity: 0.3,
            softness: 0.2,
            spillSuppression: 0,
            edgeFeather: 0,
          },
        })
      );

      expect(result.current.ffmpegFilter).toContain('blend=0.2');
    });
  });

  // ===========================================================================
  // Dirty State Tests
  // ===========================================================================

  describe('dirty state', () => {
    it('should not be dirty initially', () => {
      const { result } = renderHook(() => useChromaKey());

      expect(result.current.isDirty).toBe(false);
    });

    it('should be dirty after parameter change', () => {
      const { result } = renderHook(() => useChromaKey());

      act(() => {
        result.current.updateParam('similarity', 0.5);
      });

      expect(result.current.isDirty).toBe(true);
    });

    it('should not be dirty after reset', () => {
      const { result } = renderHook(() => useChromaKey());

      act(() => {
        result.current.updateParam('similarity', 0.5);
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.isDirty).toBe(false);
    });
  });
});
