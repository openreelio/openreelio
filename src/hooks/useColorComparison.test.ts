/**
 * useColorComparison Hook Tests
 *
 * BDD tests for the before/after color comparison state management.
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useColorComparison } from './useColorComparison';

describe('useColorComparison', () => {
  describe('initialization', () => {
    it('should initialize with comparison disabled', () => {
      const { result } = renderHook(() => useColorComparison());
      expect(result.current.isEnabled).toBe(false);
    });

    it('should initialize with split mode as default', () => {
      const { result } = renderHook(() => useColorComparison());
      expect(result.current.mode).toBe('split');
    });

    it('should initialize with divider at 50%', () => {
      const { result } = renderHook(() => useColorComparison());
      expect(result.current.dividerPosition).toBe(50);
    });
  });

  describe('toggle', () => {
    it('should enable comparison when toggled from off', () => {
      const { result } = renderHook(() => useColorComparison());

      act(() => {
        result.current.toggle();
      });

      expect(result.current.isEnabled).toBe(true);
    });

    it('should disable comparison when toggled from on', () => {
      const { result } = renderHook(() => useColorComparison());

      act(() => {
        result.current.toggle();
      });
      act(() => {
        result.current.toggle();
      });

      expect(result.current.isEnabled).toBe(false);
    });
  });

  describe('mode switching', () => {
    it('should switch to wipe mode', () => {
      const { result } = renderHook(() => useColorComparison());

      act(() => {
        result.current.setMode('wipe');
      });

      expect(result.current.mode).toBe('wipe');
    });

    it('should switch to side-by-side mode', () => {
      const { result } = renderHook(() => useColorComparison());

      act(() => {
        result.current.setMode('side-by-side');
      });

      expect(result.current.mode).toBe('side-by-side');
    });

    it('should preserve mode across toggle cycles', () => {
      const { result } = renderHook(() => useColorComparison());

      act(() => {
        result.current.setMode('wipe');
      });
      act(() => {
        result.current.toggle();
      });
      act(() => {
        result.current.toggle();
      });

      expect(result.current.mode).toBe('wipe');
    });

    it('should switch back to split mode', () => {
      const { result } = renderHook(() => useColorComparison());

      act(() => {
        result.current.setMode('side-by-side');
      });
      act(() => {
        result.current.setMode('split');
      });

      expect(result.current.mode).toBe('split');
    });
  });

  describe('divider position', () => {
    it('should update divider position within valid range', () => {
      const { result } = renderHook(() => useColorComparison());

      act(() => {
        result.current.setDividerPosition(30);
      });

      expect(result.current.dividerPosition).toBe(30);
    });

    it('should clamp position to minimum 5%', () => {
      const { result } = renderHook(() => useColorComparison());

      act(() => {
        result.current.setDividerPosition(2);
      });

      expect(result.current.dividerPosition).toBe(5);
    });

    it('should clamp position to maximum 95%', () => {
      const { result } = renderHook(() => useColorComparison());

      act(() => {
        result.current.setDividerPosition(100);
      });

      expect(result.current.dividerPosition).toBe(95);
    });

    it('should clamp negative values to minimum', () => {
      const { result } = renderHook(() => useColorComparison());

      act(() => {
        result.current.setDividerPosition(-10);
      });

      expect(result.current.dividerPosition).toBe(5);
    });

    it('should accept boundary value 5', () => {
      const { result } = renderHook(() => useColorComparison());

      act(() => {
        result.current.setDividerPosition(5);
      });

      expect(result.current.dividerPosition).toBe(5);
    });

    it('should accept boundary value 95', () => {
      const { result } = renderHook(() => useColorComparison());

      act(() => {
        result.current.setDividerPosition(95);
      });

      expect(result.current.dividerPosition).toBe(95);
    });

    it('should preserve divider position across toggle cycles', () => {
      const { result } = renderHook(() => useColorComparison());

      act(() => {
        result.current.setDividerPosition(70);
      });
      act(() => {
        result.current.toggle();
      });
      act(() => {
        result.current.toggle();
      });

      expect(result.current.dividerPosition).toBe(70);
    });
  });
});
