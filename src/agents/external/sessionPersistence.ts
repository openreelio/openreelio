import { invoke } from '@tauri-apps/api/core';

import type { ExternalAgentRuntimeId, ExternalAgentSessionHandle } from './types';

export interface LoadExternalAgentSessionLinkInput {
  projectId: string;
  conversationSessionId: string;
  runtimeId: ExternalAgentRuntimeId | string;
}

export interface SaveExternalAgentSessionLinkInput {
  projectId: string;
  conversationSessionId: string;
  runtimeId: ExternalAgentRuntimeId | string;
  externalSession: ExternalAgentSessionHandle;
  metadata?: Record<string, unknown> | null;
}

export interface ExternalAgentSessionPersistence {
  load(input: LoadExternalAgentSessionLinkInput): Promise<ExternalAgentSessionHandle | null>;
  save(input: SaveExternalAgentSessionLinkInput): Promise<void>;
}

interface ExternalAgentSessionLinkDto {
  conversationSessionId: string;
  projectId: string;
  runtimeId: string;
  externalSessionId: string;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
}

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export class TauriExternalAgentSessionPersistence implements ExternalAgentSessionPersistence {
  constructor(private readonly invokeCommand: TauriInvoke = invoke) {}

  async load(
    input: LoadExternalAgentSessionLinkInput,
  ): Promise<ExternalAgentSessionHandle | null> {
    const link = (await this.invokeCommand('get_external_agent_session_link', {
      input: {
        conversationSessionId: input.conversationSessionId,
        runtimeId: input.runtimeId,
      },
    })) as ExternalAgentSessionLinkDto | null;

    if (!link || link.projectId !== input.projectId) {
      return null;
    }

    return {
      sessionId: link.externalSessionId,
      runtimeId: link.runtimeId,
    };
  }

  async save(input: SaveExternalAgentSessionLinkInput): Promise<void> {
    await this.invokeCommand('upsert_external_agent_session_link', {
      input: {
        conversationSessionId: input.conversationSessionId,
        projectId: input.projectId,
        runtimeId: input.runtimeId,
        externalSessionId: input.externalSession.sessionId,
        metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      },
    });
  }
}

export function createTauriExternalAgentSessionPersistence(
  invokeCommand?: TauriInvoke,
): ExternalAgentSessionPersistence {
  return new TauriExternalAgentSessionPersistence(invokeCommand);
}
