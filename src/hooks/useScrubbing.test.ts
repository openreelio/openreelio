/**
 * useScrubbing Hook Tests
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useScrubbing } from './useScrubbing';

// =============================================================================
// Test Utilities
// =============================================================================

const createMockMouseEvent = (
  target: HTMLElement,
  options: Partial<{
    clientX: number;
    clientY: number;
  }> = {}
): React.MouseEvent => {
  return {
    preventDefault: vi.fn(),
    target,
    clientX: options.clientX ?? 100,
    clientY: options.clientY ?? 50,
  } as unknown as React.MouseEvent;
};

const createMockNativeMouseEvent = (
  options: Partial<{
    clientX: number;
    clientY: number;
  }> = {}
): MouseEvent => {
  return {
    clientX: options.clientX ?? 100,
    clientY: options.clientY ?? 50,
  } as unknown as MouseEvent;
};

// =============================================================================
// Tests
// =============================================================================

describe('useScrubbing', () => {
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>;
  let removeEventListenerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    addEventListenerSpy = vi.spyOn(document, 'addEventListener');
    removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
  });

  afterEach(() => {
    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
    vi.clearAllMocks();
  });

  const createDefaultOptions = () => ({
    isPlaying: false,
    togglePlayback: vi.fn(),
    seek: vi.fn(),
    calculateTimeFromMouseEvent: vi.fn().mockReturnValue({ time: 5, snapPoint: null }),
    onSnapChange: vi.fn(),
  });

  describe('initial state', () => {
    it('should return isScrubbing as false initially', () => {
      const { result } = renderHook(() => useScrubbing(createDefaultOptions()));
      expect(result.current.isScrubbing).toBe(false);
    });

    it('should return handleScrubStart function', () => {
      const { result } = renderHook(() => useScrubbing(createDefaultOptions()));
      expect(typeof result.current.handleScrubStart).toBe('function');
    });
  });

  describe('handleScrubStart', () => {
    it('should not start scrubbing when clicking on clips', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useScrubbing(options));

      // Create a clip element
      const clip = document.createElement('div');
      clip.setAttribute('data-testid', 'clip-123');
      const event = createMockMouseEvent(clip);

      act(() => {
        result.current.handleScrubStart(event);
      });

      expect(result.current.isScrubbing).toBe(false);
      expect(options.seek).not.toHaveBeenCalled();
    });

    it('should not start scrubbing when clicking on buttons', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useScrubbing(options));

      const button = document.createElement('button');
      const event = createMockMouseEvent(button);

      act(() => {
        result.current.handleScrubStart(event);
      });

      expect(result.current.isScrubbing).toBe(false);
      expect(options.seek).not.toHaveBeenCalled();
    });

    it('should not start scrubbing when clicking on track-header', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useScrubbing(options));

      const trackHeader = document.createElement('div');
      trackHeader.setAttribute('data-testid', 'track-header');
      const event = createMockMouseEvent(trackHeader);

      act(() => {
        result.current.handleScrubStart(event);
      });

      expect(result.current.isScrubbing).toBe(false);
      expect(options.seek).not.toHaveBeenCalled();
    });

    it('should start scrubbing when clicking on non-interactive elements', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useScrubbing(options));

      const target = document.createElement('div');
      target.setAttribute('data-testid', 'some-other-element');
      const event = createMockMouseEvent(target);

      act(() => {
        result.current.handleScrubStart(event);
      });

      expect(result.current.isScrubbing).toBe(true);
      expect(options.seek).toHaveBeenCalledWith(5);
    });

    it('should start scrubbing when clicking on timeline-tracks-area', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useScrubbing(options));

      const target = document.createElement('div');
      target.setAttribute('data-testid', 'timeline-tracks-area');
      const event = createMockMouseEvent(target);

      act(() => {
        result.current.handleScrubStart(event);
      });

      expect(result.current.isScrubbing).toBe(true);
      expect(options.seek).toHaveBeenCalledWith(5);
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('should start scrubbing when clicking on track-content', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useScrubbing(options));

      const target = document.createElement('div');
      target.setAttribute('data-testid', 'track-content');
      const event = createMockMouseEvent(target);

      act(() => {
        result.current.handleScrubStart(event);
      });

      expect(result.current.isScrubbing).toBe(true);
    });

    it('should start scrubbing when clicking inside track-content', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useScrubbing(options));

      const parent = document.createElement('div');
      parent.setAttribute('data-testid', 'track-content');
      const child = document.createElement('span');
      parent.appendChild(child);
      document.body.appendChild(parent);

      const event = createMockMouseEvent(child);

      act(() => {
        result.current.handleScrubStart(event);
      });

      expect(result.current.isScrubbing).toBe(true);

      document.body.removeChild(parent);
    });

    it('should pause playback when starting to scrub while playing', () => {
      const options = { ...createDefaultOptions(), isPlaying: true };
      const { result } = renderHook(() => useScrubbing(options));

      const target = document.createElement('div');
      target.setAttribute('data-testid', 'timeline-tracks-area');
      const event = createMockMouseEvent(target);

      act(() => {
        result.current.handleScrubStart(event);
      });

      expect(options.togglePlayback).toHaveBeenCalled();
    });

    it('should not pause playback when starting to scrub while paused', () => {
      const options = { ...createDefaultOptions(), isPlaying: false };
      const { result } = renderHook(() => useScrubbing(options));

      const target = document.createElement('div');
      target.setAttribute('data-testid', 'timeline-tracks-area');
      const event = createMockMouseEvent(target);

      act(() => {
        result.current.handleScrubStart(event);
      });

      expect(options.togglePlayback).not.toHaveBeenCalled();
    });

    it('should add document event listeners when starting to scrub', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useScrubbing(options));

      const target = document.createElement('div');
      target.setAttribute('data-testid', 'timeline-tracks-area');
      const event = createMockMouseEvent(target);

      act(() => {
        result.current.handleScrubStart(event);
      });

      expect(addEventListenerSpy).toHaveBeenCalledWith(
        'mousemove',
        expect.any(Function)
      );
      expect(addEventListenerSpy).toHaveBeenCalledWith(
        'mouseup',
        expect.any(Function)
      );
    });
  });

  describe('mousemove during scrubbing', () => {
    it('should update seek position on mouse move', () => {
      const options = createDefaultOptions();
      let callCount = 0;
      options.calculateTimeFromMouseEvent.mockImplementation(() => {
        callCount++;
        return { time: callCount === 1 ? 5 : 10, snapPoint: null };
      });

      const { result } = renderHook(() => useScrubbing(options));

      const target = document.createElement('div');
      target.setAttribute('data-testid', 'timeline-tracks-area');
      const event = createMockMouseEvent(target);

      act(() => {
        result.current.handleScrubStart(event);
      });

      // Get the mousemove handler
      const mousemoveCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'mousemove'
      );
      const mousemoveHandler = mousemoveCall?.[1] as (e: MouseEvent) => void;

      act(() => {
        mousemoveHandler(createMockNativeMouseEvent({ clientX: 200 }));
      });

      expect(options.seek).toHaveBeenCalledWith(10);
    });
  });

  describe('mouseup to end scrubbing', () => {
    it('should end scrubbing on mouseup', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useScrubbing(options));

      const target = document.createElement('div');
      target.setAttribute('data-testid', 'timeline-tracks-area');
      const event = createMockMouseEvent(target);

      act(() => {
        result.current.handleScrubStart(event);
      });

      expect(result.current.isScrubbing).toBe(true);

      // Get the mouseup handler
      const mouseupCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'mouseup'
      );
      const mouseupHandler = mouseupCall?.[1] as () => void;

      act(() => {
        mouseupHandler();
      });

      expect(result.current.isScrubbing).toBe(false);
    });

    it('should resume playback if it was playing before scrubbing', () => {
      const options = { ...createDefaultOptions(), isPlaying: true };
      const { result } = renderHook(() => useScrubbing(options));

      const target = document.createElement('div');
      target.setAttribute('data-testid', 'timeline-tracks-area');
      const event = createMockMouseEvent(target);

      act(() => {
        result.current.handleScrubStart(event);
      });

      expect(options.togglePlayback).toHaveBeenCalledTimes(1);

      const mouseupCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'mouseup'
      );
      const mouseupHandler = mouseupCall?.[1] as () => void;

      act(() => {
        mouseupHandler();
      });

      // Should be called twice: once to pause, once to resume
      expect(options.togglePlayback).toHaveBeenCalledTimes(2);
    });

    it('should not resume playback if it was not playing before scrubbing', () => {
      const options = { ...createDefaultOptions(), isPlaying: false };
      const { result } = renderHook(() => useScrubbing(options));

      const target = document.createElement('div');
      target.setAttribute('data-testid', 'timeline-tracks-area');
      const event = createMockMouseEvent(target);

      act(() => {
        result.current.handleScrubStart(event);
      });

      const mouseupCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'mouseup'
      );
      const mouseupHandler = mouseupCall?.[1] as () => void;

      act(() => {
        mouseupHandler();
      });

      expect(options.togglePlayback).not.toHaveBeenCalled();
    });

    it('should call onSnapChange with null on mouseup', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useScrubbing(options));

      const target = document.createElement('div');
      target.setAttribute('data-testid', 'timeline-tracks-area');
      const event = createMockMouseEvent(target);

      act(() => {
        result.current.handleScrubStart(event);
      });

      const mouseupCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'mouseup'
      );
      const mouseupHandler = mouseupCall?.[1] as () => void;

      act(() => {
        mouseupHandler();
      });

      expect(options.onSnapChange).toHaveBeenCalledWith(null);
    });

    it('should remove document event listeners on mouseup', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useScrubbing(options));

      const target = document.createElement('div');
      target.setAttribute('data-testid', 'timeline-tracks-area');
      const event = createMockMouseEvent(target);

      act(() => {
        result.current.handleScrubStart(event);
      });

      const mouseupCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'mouseup'
      );
      const mouseupHandler = mouseupCall?.[1] as () => void;

      act(() => {
        mouseupHandler();
      });

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'mousemove',
        expect.any(Function)
      );
      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'mouseup',
        expect.any(Function)
      );
    });
  });

  describe('cleanup on unmount', () => {
    it('should remove event listeners on unmount', () => {
      const options = createDefaultOptions();
      const { result, unmount } = renderHook(() => useScrubbing(options));

      const target = document.createElement('div');
      target.setAttribute('data-testid', 'timeline-tracks-area');
      const event = createMockMouseEvent(target);

      act(() => {
        result.current.handleScrubStart(event);
      });

      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'mousemove',
        expect.any(Function)
      );
      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'mouseup',
        expect.any(Function)
      );
    });
  });

  describe('edge cases', () => {
    it('should handle null time from calculateTimeFromMouseEvent', () => {
      const options = createDefaultOptions();
      options.calculateTimeFromMouseEvent.mockReturnValue({ time: null, snapPoint: null });

      const { result } = renderHook(() => useScrubbing(options));

      const target = document.createElement('div');
      target.setAttribute('data-testid', 'timeline-tracks-area');
      const event = createMockMouseEvent(target);

      act(() => {
        result.current.handleScrubStart(event);
      });

      expect(options.seek).not.toHaveBeenCalled();
    });

    it('should work without onSnapChange callback', () => {
      const options = { ...createDefaultOptions(), onSnapChange: undefined };
      const { result } = renderHook(() => useScrubbing(options));

      const target = document.createElement('div');
      target.setAttribute('data-testid', 'timeline-tracks-area');
      const event = createMockMouseEvent(target);

      act(() => {
        result.current.handleScrubStart(event);
      });

      // Should not throw
      expect(result.current.isScrubbing).toBe(true);
    });
  });
});
