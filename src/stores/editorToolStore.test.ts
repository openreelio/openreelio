/**
 * Editor Tool Store — Edit Mode Tests
 *
 * Tests for the edit mode (insert/overwrite) state management.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { TOOL_CONFIGS, getToolCursor, useEditorToolStore } from './editorToolStore';

describe('editorToolStore — editMode', () => {
  beforeEach(() => {
    act(() => {
      useEditorToolStore.getState().reset();
    });
  });

  it('should default to overwrite mode', () => {
    expect(useEditorToolStore.getState().editMode).toBe('overwrite');
  });

  it('should set edit mode to insert', () => {
    act(() => {
      useEditorToolStore.getState().setEditMode('insert');
    });

    expect(useEditorToolStore.getState().editMode).toBe('insert');
  });

  it('should set edit mode to overwrite', () => {
    act(() => {
      useEditorToolStore.getState().setEditMode('insert');
    });
    act(() => {
      useEditorToolStore.getState().setEditMode('overwrite');
    });

    expect(useEditorToolStore.getState().editMode).toBe('overwrite');
  });

  it('should toggle from overwrite to insert', () => {
    act(() => {
      useEditorToolStore.getState().toggleEditMode();
    });

    expect(useEditorToolStore.getState().editMode).toBe('insert');
  });

  it('should toggle from insert back to overwrite', () => {
    act(() => {
      useEditorToolStore.getState().setEditMode('insert');
    });
    act(() => {
      useEditorToolStore.getState().toggleEditMode();
    });

    expect(useEditorToolStore.getState().editMode).toBe('overwrite');
  });

  it('should reset edit mode to default (overwrite)', () => {
    act(() => {
      useEditorToolStore.getState().setEditMode('insert');
    });
    act(() => {
      useEditorToolStore.getState().reset();
    });

    expect(useEditorToolStore.getState().editMode).toBe('overwrite');
  });
});

describe('editorToolStore — text tool', () => {
  beforeEach(() => {
    act(() => {
      useEditorToolStore.getState().reset();
    });
  });

  it('exposes the text placement tool with a text cursor', () => {
    act(() => {
      useEditorToolStore.getState().setActiveTool('text');
    });

    expect(useEditorToolStore.getState().activeTool).toBe('text');
    expect(TOOL_CONFIGS.text.shortcut).toBe('T');
    expect(getToolCursor('text')).toBe('text');
  });
});

describe('editorToolStore — effectsClipboard', () => {
  beforeEach(() => {
    act(() => {
      useEditorToolStore.getState().reset();
    });
  });

  it('should store copied clip effects data', () => {
    const clipboardData: import('@/types').CopiedClipData = {
      sourceClipId: 'clip-1',
      effects: [
        {
          id: 'eff-1',
          effectType: 'brightness',
          enabled: true,
          params: { value: 0.5 },
          keyframes: {},
          order: 0,
        },
      ],
      transform: {
        position: { x: 0.5, y: 0.5 },
        scale: { x: 1, y: 1 },
        rotationDeg: 0,
        anchor: { x: 0.5, y: 0.5 },
      },
      opacity: 0.8,
      blendMode: 'normal',
      speed: 1,
      reverse: false,
      audio: { volumeDb: 0, pan: 0, muted: false },
    };

    act(() => {
      useEditorToolStore.getState().setEffectsClipboard(clipboardData);
    });

    expect(useEditorToolStore.getState().getEffectsClipboard()).toEqual(clipboardData);
  });

  it('should clear copied clip effects data', () => {
    const clipboardData: import('@/types').CopiedClipData = {
      sourceClipId: 'clip-1',
      effects: [],
      transform: {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotationDeg: 0,
        anchor: { x: 0.5, y: 0.5 },
      },
      opacity: 1,
      blendMode: 'normal',
      speed: 1,
      reverse: false,
      audio: { volumeDb: 0, pan: 0, muted: false },
    };

    act(() => {
      useEditorToolStore.getState().setEffectsClipboard(clipboardData);
      useEditorToolStore.getState().clearEffectsClipboard();
    });

    expect(useEditorToolStore.getState().getEffectsClipboard()).toBeNull();
  });
});
