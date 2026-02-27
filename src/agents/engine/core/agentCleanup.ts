/**
 * Agent Cleanup Registry
 *
 * A lightweight module-level registry that allows the agentic loop hook
 * to register its abort callback, and useAppLifecycle (or other lifecycle
 * handlers) to trigger a graceful agent shutdown on project close.
 *
 * This avoids coupling hooks directly to each other via props or context.
 */

type CleanupCallback = () => void;

let registeredAbort: CleanupCallback | null = null;

/**
 * Register an abort callback. Called by useAgenticLoop when it mounts.
 * Only one callback can be active at a time.
 */
export function registerAgentAbort(callback: CleanupCallback): void {
  registeredAbort = callback;
}

/**
 * Unregister the abort callback. Called by useAgenticLoop when it unmounts.
 */
export function unregisterAgentAbort(): void {
  registeredAbort = null;
}

/**
 * Trigger a graceful agent abort if one is running.
 * Called by useAppLifecycle during project close.
 * Returns true if an abort was triggered.
 */
export function abortRunningAgent(): boolean {
  if (registeredAbort) {
    registeredAbort();
    return true;
  }
  return false;
}
