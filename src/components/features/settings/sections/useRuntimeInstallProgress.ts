import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

import {
  EXTERNAL_RUNTIME_INSTALL_PROGRESS_EVENT,
  type ExternalRuntimeInstallProgress,
} from './runtimeControlsShared';

/**
 * Subscribe to native runtime download/install progress for a single runtime.
 *
 * The listener is scoped to the in-flight job via `active` (an install or update
 * is running) so the progress line clears once the action settles. Both the
 * Codex and Claude Code panels share this effect verbatim.
 *
 * @param runtimeId Runtime whose progress events to keep (`codex` or `claude`).
 * @param active Whether an install/update is currently running.
 * @returns The latest progress payload, or null when idle.
 */
export function useRuntimeInstallProgress(
  runtimeId: 'codex' | 'claude',
  active: boolean,
): ExternalRuntimeInstallProgress | null {
  const [installProgress, setInstallProgress] = useState<ExternalRuntimeInstallProgress | null>(
    null,
  );

  useEffect(() => {
    if (!active) {
      setInstallProgress(null);
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<ExternalRuntimeInstallProgress>(
      EXTERNAL_RUNTIME_INSTALL_PROGRESS_EVENT,
      (event) => {
        if (cancelled || event.payload.runtimeId !== runtimeId) {
          return;
        }
        setInstallProgress(event.payload);
      },
    ).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [active, runtimeId]);

  return installProgress;
}
