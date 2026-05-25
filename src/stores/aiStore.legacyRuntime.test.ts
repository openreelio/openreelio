import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAIStore, type EditScript } from './aiStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));

const LEGACY_DISABLED_MESSAGE = 'Legacy API AI request-response path is disabled';

function resetAIStore(): void {
  useAIStore.setState((state) => ({
    ...state,
    currentProposal: null,
    proposalHistory: [],
    chatMessages: [],
    isGenerating: false,
    isCancelled: false,
    error: null,
  }));
}

function createEditScript(): EditScript {
  return {
    intent: 'Add a cut',
    commands: [
      {
        commandType: 'SplitClip',
        params: {
          sequenceId: 'seq-1',
          trackId: 'track-1',
          clipId: 'clip-1',
          splitTime: 5,
        },
      },
    ],
    requires: [],
    qcRules: [],
    risk: {
      copyright: 'none',
      nsfw: 'none',
    },
    explanation: 'Split the selected clip.',
  };
}

describe('aiStore legacy runtime guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn(() => 'proposal-1'),
    });
    resetAIStore();
  });

  it('blocks legacy edit-script generation before invoking backend AI commands', async () => {
    await expect(useAIStore.getState().generateEditScript('Split this clip')).rejects.toThrow(
      LEGACY_DISABLED_MESSAGE,
    );

    expect(invoke).not.toHaveBeenCalledWith('generate_edit_script_with_ai', expect.anything());
    expect(invoke).not.toHaveBeenCalledWith('analyze_intent', expect.anything());
    expect(useAIStore.getState().error).toContain(LEGACY_DISABLED_MESSAGE);
  });

  it('blocks legacy chat before invoking chat_with_ai', async () => {
    await expect(useAIStore.getState().sendMessage('Can you edit this?')).rejects.toThrow(
      LEGACY_DISABLED_MESSAGE,
    );

    expect(invoke).not.toHaveBeenCalledWith('chat_with_ai', expect.anything());
    expect(useAIStore.getState().error).toContain(LEGACY_DISABLED_MESSAGE);
  });

  it('blocks legacy edit-script application before invoking apply_edit_script', async () => {
    const editScript = createEditScript();
    useAIStore.getState().createProposal(editScript);

    await expect(useAIStore.getState().applyEditScript(editScript)).rejects.toThrow(
      LEGACY_DISABLED_MESSAGE,
    );

    expect(invoke).not.toHaveBeenCalledWith('apply_edit_script', expect.anything());
    expect(useAIStore.getState().currentProposal?.status).toBe('failed');
    expect(useAIStore.getState().currentProposal?.error).toContain(LEGACY_DISABLED_MESSAGE);
  });
});
