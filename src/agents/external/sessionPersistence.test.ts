import { describe, expect, it, vi } from 'vitest';

import { TauriExternalAgentSessionPersistence } from './sessionPersistence';

describe('TauriExternalAgentSessionPersistence', () => {
  it('should load a durable external runtime session link for the active project', async () => {
    const invokeCommand = vi.fn().mockResolvedValue({
      conversationSessionId: 'session-1',
      projectId: 'project-1',
      runtimeId: 'codex',
      externalSessionId: 'thr_123',
      metadataJson: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    const persistence = new TauriExternalAgentSessionPersistence(invokeCommand);

    await expect(
      persistence.load({
        projectId: 'project-1',
        conversationSessionId: 'session-1',
        runtimeId: 'codex',
      }),
    ).resolves.toEqual({ sessionId: 'thr_123', runtimeId: 'codex' });

    expect(invokeCommand).toHaveBeenCalledWith('get_external_agent_session_link', {
      input: {
        conversationSessionId: 'session-1',
        runtimeId: 'codex',
      },
    });
  });

  it('should ignore links that belong to a different project', async () => {
    const invokeCommand = vi.fn().mockResolvedValue({
      conversationSessionId: 'session-1',
      projectId: 'other-project',
      runtimeId: 'codex',
      externalSessionId: 'thr_123',
      metadataJson: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    const persistence = new TauriExternalAgentSessionPersistence(invokeCommand);

    await expect(
      persistence.load({
        projectId: 'project-1',
        conversationSessionId: 'session-1',
        runtimeId: 'codex',
      }),
    ).resolves.toBeNull();
  });

  it('should save external runtime session links with metadata', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(undefined);
    const persistence = new TauriExternalAgentSessionPersistence(invokeCommand);

    await persistence.save({
      projectId: 'project-1',
      conversationSessionId: 'session-1',
      runtimeId: 'codex',
      externalSession: { sessionId: 'thr_123', runtimeId: 'codex' },
      metadata: { source: 'appServer' },
    });

    expect(invokeCommand).toHaveBeenCalledWith('upsert_external_agent_session_link', {
      input: {
        conversationSessionId: 'session-1',
        projectId: 'project-1',
        runtimeId: 'codex',
        externalSessionId: 'thr_123',
        metadataJson: '{"source":"appServer"}',
      },
    });
  });

  it('should reject runtime mismatches before persisting external session links', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(undefined);
    const persistence = new TauriExternalAgentSessionPersistence(invokeCommand);

    await expect(
      persistence.save({
        projectId: 'project-1',
        conversationSessionId: 'session-1',
        runtimeId: 'codex',
        externalSession: { sessionId: 'thr_123', runtimeId: 'other-runtime' },
      }),
    ).rejects.toThrow('Cannot persist other-runtime session under codex runtime');

    expect(invokeCommand).not.toHaveBeenCalled();
  });
});
