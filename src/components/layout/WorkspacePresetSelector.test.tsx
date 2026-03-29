import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceLayoutStore } from '@/stores/workspaceLayoutStore';
import { WorkspacePresetSelector } from './WorkspacePresetSelector';

describe('WorkspacePresetSelector', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorkspaceLayoutStore.getState().resetLayout();
    useWorkspaceLayoutStore.setState({
      activePresetId: null,
      customPresets: [],
    });
  });

  it('should delete a custom preset without applying it first', async () => {
    const store = useWorkspaceLayoutStore.getState();
    const customPresetId = store.saveCustomPreset('Review Layout');
    store.applyPreset('editing');

    const user = userEvent.setup();
    render(<WorkspacePresetSelector />);

    await user.click(screen.getByRole('button', { name: /workspace/i }));
    await user.click(screen.getByRole('button', { name: /delete review layout/i }));

    const state = useWorkspaceLayoutStore.getState();
    expect(state.customPresets.some((preset) => preset.id === customPresetId)).toBe(false);
    expect(state.activePresetId).toBe('editing');
  });
});
