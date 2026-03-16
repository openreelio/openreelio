/**
 * Editor Tool Store — Edit Mode Tests
 *
 * Tests for the edit mode (insert/overwrite) state management.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { useEditorToolStore } from './editorToolStore';

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
