/**
 * External project change detection helpers.
 *
 * A project directory is shared: `openreelio-cli`, an agent or a second app
 * window can append to the same `ops.jsonl`. When that happens the backend
 * refuses further mutations instead of silently interleaving them, and the app
 * must offer a reload rather than a generic error.
 */

/**
 * Stable marker embedded in the backend's external-change error message.
 *
 * Keep in sync with `EXTERNAL_CHANGE_DETECTED_CODE` in
 * `src-tauri/src/core/error.rs`. IPC flattens the Rust error to a string, so
 * this token is the contract between the two sides.
 */
export const EXTERNAL_CHANGE_DETECTED_CODE = 'ExternalChangeDetected';

/**
 * Tauri event emitted by the workspace watcher when another process changed the
 * active project's state files.
 */
export const PROJECT_EXTERNAL_CHANGE_EVENT = 'project:external-change';

/**
 * How an external change was noticed.
 *
 * - `watcher`: the filesystem watcher reported a project state file change.
 * - `command`: a mutation was refused by the backend guard.
 */
export type ExternalChangeSource = 'watcher' | 'command';

/** Store-level record of a detected external change. */
export interface ExternalChangeNotice {
  /** Where the detection came from. */
  source: ExternalChangeSource;
  /** Operation count on disk, when the detection reported one. */
  opCount?: number;
}

/** Payload of {@link PROJECT_EXTERNAL_CHANGE_EVENT}. */
export interface ExternalChangeEventPayload {
  /** Number of operations currently present in the on-disk ops log. */
  opCount: number;
  /** Number of operations this app session expected to find. */
  expectedOpCount?: number;
  /** Project-root-relative path of the state file that changed. */
  relativePath?: string;
}

/**
 * Returns `true` when the given value is a backend external-change error.
 *
 * @param error - Rejection value from an `invoke` call.
 */
export function isExternalChangeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(EXTERNAL_CHANGE_DETECTED_CODE);
}

/**
 * Parses an unvalidated {@link PROJECT_EXTERNAL_CHANGE_EVENT} payload.
 *
 * Returns `null` for anything that is not a usable payload so a malformed event
 * cannot put the UI into a state the user cannot leave.
 *
 * @param payload - Raw event payload from Tauri.
 */
export function parseExternalChangeEvent(payload: unknown): ExternalChangeEventPayload | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  const { opCount, expectedOpCount, relativePath } = candidate;

  if (typeof opCount !== 'number' || !Number.isFinite(opCount)) {
    return null;
  }

  return {
    opCount,
    expectedOpCount:
      typeof expectedOpCount === 'number' && Number.isFinite(expectedOpCount)
        ? expectedOpCount
        : undefined,
    relativePath: typeof relativePath === 'string' ? relativePath : undefined,
  };
}
