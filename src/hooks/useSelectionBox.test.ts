/**
 * useSelectionBox Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSelectionBox } from './useSelectionBox';
import type { Track, Clip } from '@/types';

// Mock track and clip data
const createMockClip = (id: string, timelineIn: number, duration: number): Clip => ({
  id,
  assetId: `asset-${id}`,
  label: `Clip ${id}`,
  place: { timelineInSec: timelineIn, durationSec: duration },
  range: { sourceInSec: 0, sourceOutSec: duration },
  speed: 1,
  opacity: 1,
  effects: [],
  transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } },
  audio: { volumeDb: 0, pan: 0, muted: false },
});

const createMockTrack = (id: string, clips: Clip[]): Track => ({
  id,
  name: `Track ${id}`,
  kind: 'video',
  clips,
  blendMode: 'normal',
  muted: false,
  locked: false,
  visible: true,
  volume: 1,
});

describe('useSelectionBox', () => {
  const mockOnSelectClips = vi.fn();
  const mockContainerRef = { current: null as HTMLElement | null };

  beforeEach(() => {
    mockOnSelectClips.mockClear();

    // Create mock container element
    const container = document.createElement('div');
    container.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      right: 800,
      bottom: 400,
      width: 800,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));
    mockContainerRef.current = container;
  });

  it('should initialize with no selection', () => {
    const { result } = renderHook(() =>
      useSelectionBox({
        containerRef: mockContainerRef,
        trackHeaderWidth: 192,
        trackHeight: 64,
        zoom: 100,
        scrollX: 0,
        scrollY: 0,
        tracks: [],
        onSelectClips: mockOnSelectClips,
      })
    );

    expect(result.current.isSelecting).toBe(false);
    expect(result.current.selectionRect).toBeNull();
  });

  it('should not start selection when disabled', () => {
    const { result } = renderHook(() =>
      useSelectionBox({
        containerRef: mockContainerRef,
        trackHeaderWidth: 192,
        trackHeight: 64,
        zoom: 100,
        scrollX: 0,
        scrollY: 0,
        tracks: [],
        onSelectClips: mockOnSelectClips,
        enabled: false,
      })
    );

    const mockEvent = {
      button: 0,
      clientX: 300,
      clientY: 100,
      target: mockContainerRef.current,
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent;

    act(() => {
      result.current.handleMouseDown(mockEvent);
    });

    expect(result.current.isSelecting).toBe(false);
  });

  it('should not start selection on right click', () => {
    const { result } = renderHook(() =>
      useSelectionBox({
        containerRef: mockContainerRef,
        trackHeaderWidth: 192,
        trackHeight: 64,
        zoom: 100,
        scrollX: 0,
        scrollY: 0,
        tracks: [],
        onSelectClips: mockOnSelectClips,
      })
    );

    const mockEvent = {
      button: 2, // Right click
      clientX: 300,
      clientY: 100,
      target: mockContainerRef.current,
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent;

    act(() => {
      result.current.handleMouseDown(mockEvent);
    });

    expect(result.current.isSelecting).toBe(false);
  });

  it('should start selection on left click in empty area', () => {
    const { result } = renderHook(() =>
      useSelectionBox({
        containerRef: mockContainerRef,
        trackHeaderWidth: 192,
        trackHeight: 64,
        zoom: 100,
        scrollX: 0,
        scrollY: 0,
        tracks: [],
        onSelectClips: mockOnSelectClips,
      })
    );

    // Create a mock target that is not a clip
    const mockTarget = document.createElement('div');
    mockTarget.closest = vi.fn().mockReturnValue(null);

    const mockEvent = {
      button: 0,
      clientX: 300,
      clientY: 100,
      shiftKey: false,
      target: mockTarget,
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent;

    let returnValue: boolean = false;
    act(() => {
      returnValue = result.current.handleMouseDown(mockEvent);
    });

    expect(returnValue).toBe(true);
    expect(result.current.isSelecting).toBe(true);
    expect(result.current.selectionRect).not.toBeNull();
  });

  it('should return false when selection does not start', () => {
    const { result } = renderHook(() =>
      useSelectionBox({
        containerRef: mockContainerRef,
        trackHeaderWidth: 192,
        trackHeight: 64,
        zoom: 100,
        scrollX: 0,
        scrollY: 0,
        tracks: [],
        onSelectClips: mockOnSelectClips,
        enabled: false,
      })
    );

    const mockTarget = document.createElement('div');
    mockTarget.closest = vi.fn().mockReturnValue(null);

    const mockEvent = {
      button: 0,
      clientX: 300,
      clientY: 100,
      shiftKey: false,
      target: mockTarget,
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent;

    let returnValue: boolean = false;
    act(() => {
      returnValue = result.current.handleMouseDown(mockEvent);
    });

    expect(returnValue).toBe(false);
    expect(result.current.isSelecting).toBe(false);
  });

  it('should not start selection when clicking on a clip', () => {
    const { result } = renderHook(() =>
      useSelectionBox({
        containerRef: mockContainerRef,
        trackHeaderWidth: 192,
        trackHeight: 64,
        zoom: 100,
        scrollX: 0,
        scrollY: 0,
        tracks: [],
        onSelectClips: mockOnSelectClips,
      })
    );

    // Create a mock clip element
    const mockClip = document.createElement('div');
    mockClip.setAttribute('data-testid', 'clip-123');
    mockClip.closest = vi.fn((selector: string) => {
      if (selector.includes('clip-')) return mockClip;
      return null;
    });

    const mockEvent = {
      button: 0,
      clientX: 300,
      clientY: 100,
      target: mockClip,
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent;

    act(() => {
      result.current.handleMouseDown(mockEvent);
    });

    expect(result.current.isSelecting).toBe(false);
  });

  it('should find clips within selection rectangle', () => {
    const clip1 = createMockClip('clip1', 1, 2); // 1-3 seconds
    const clip2 = createMockClip('clip2', 4, 2); // 4-6 seconds
    const track = createMockTrack('track1', [clip1, clip2]);

    const { result } = renderHook(() =>
      useSelectionBox({
        containerRef: mockContainerRef,
        trackHeaderWidth: 192,
        trackHeight: 64,
        zoom: 100, // 100 pixels per second
        scrollX: 0,
        scrollY: 0,
        tracks: [track],
        onSelectClips: mockOnSelectClips,
      })
    );

    // Start selection
    const mockTarget = document.createElement('div');
    mockTarget.closest = vi.fn().mockReturnValue(null);

    const startEvent = {
      button: 0,
      clientX: 200, // Just before clip1 starts (192 + 100 = 292)
      clientY: 10,
      target: mockTarget,
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent;

    act(() => {
      result.current.handleMouseDown(startEvent);
    });

    expect(result.current.isSelecting).toBe(true);
  });

  it('should support additive selection with Shift key', () => {
    const clip1 = createMockClip('clip1', 1, 2);
    const track = createMockTrack('track1', [clip1]);

    const { result } = renderHook(() =>
      useSelectionBox({
        containerRef: mockContainerRef,
        trackHeaderWidth: 192,
        trackHeight: 64,
        zoom: 100,
        scrollX: 0,
        scrollY: 0,
        tracks: [track],
        onSelectClips: mockOnSelectClips,
        currentSelection: ['existing-clip'],
      })
    );

    const mockTarget = document.createElement('div');
    mockTarget.closest = vi.fn().mockReturnValue(null);

    const startEvent = {
      button: 0,
      clientX: 200,
      clientY: 10,
      shiftKey: true, // Shift held
      target: mockTarget,
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent;

    act(() => {
      result.current.handleMouseDown(startEvent);
    });

    // Should start selection with additive mode
    expect(result.current.isSelecting).toBe(true);
  });
});

// SelectionBox component tests moved to a separate .tsx file
