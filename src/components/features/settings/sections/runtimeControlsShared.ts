/**
 * Shared, presentation-free helpers for the external-agent runtime controls
 * (Codex and Claude Code). Keeping these framework-agnostic lets both runtime
 * control components reuse the same auth/status formatting logic.
 */

/**
 * Returns true when an external-agent runtime is authenticated, either through
 * an interactive sign-in or a stored API key.
 */
export function isAuthenticated(authStatus?: string | null): boolean {
  return authStatus === 'signed-in' || authStatus === 'api-key';
}

/** Maps a runtime auth status to a short, user-facing label. */
export function formatAuthStatus(authStatus?: string | null): string {
  if (authStatus === 'signed-in') return 'Signed in';
  if (authStatus === 'api-key') return 'API key login';
  if (authStatus === 'signed-out') return 'Sign-in required';
  if (authStatus === 'error') return 'Auth error';
  return 'Checking';
}

/**
 * Detects native launcher failures (non-executable binary, wrong OS) so the UI
 * can surface reinstall guidance instead of raw platform errors.
 */
export function isLauncherExecutableError(message?: string | null): boolean {
  const normalized = message?.toLowerCase() ?? '';
  return (
    normalized.includes('win32') ||
    normalized.includes('os error 193') ||
    normalized.includes('%1') ||
    normalized.includes('not executable on this os')
  );
}

/**
 * Extracts a bare semver (e.g. `2.1.202`) from a CLI version label such as
 * `claude 2.1.202` or `codex-cli 0.144.4`. Returns null when no version is found.
 */
export function parseRuntimeSemver(label?: string | null): string | null {
  const match = label?.match(/\d+\.\d+(?:\.\d+)?/);
  return match ? match[0] : null;
}

/**
 * True when the installed runtime version differs from the app-pinned target,
 * signalling an update is available. Both versions must be known; when either is
 * missing no update is offered.
 */
export function isRuntimeUpdateAvailable(
  installedVersion?: string | null,
  pinnedVersion?: string | null,
): boolean {
  const installed = parseRuntimeSemver(installedVersion);
  const pinned = parseRuntimeSemver(pinnedVersion);
  if (!installed || !pinned) {
    return false;
  }
  return installed !== pinned;
}

/**
 * Maps a runtime provenance code to a user-facing label. `managed-legacy` marks
 * an older npm install still detected as a fallback; surface it so users know an
 * Update migrates them to the native binary.
 */
export function formatRuntimeSource(source?: string | null): string | null {
  if (!source) {
    return null;
  }
  if (source === 'managed-legacy') {
    return 'managed (legacy npm)';
  }
  return source;
}

/** Discrete stages emitted during a native runtime download/install. */
export type ExternalRuntimeInstallStage =
  | 'preparing'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'complete';

/**
 * Payload for the `external-runtime:install-progress` Tauri event, emitted while
 * a runtime native binary is downloaded and installed.
 */
export interface ExternalRuntimeInstallProgress {
  runtimeId: string;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  stage: ExternalRuntimeInstallStage;
}

/** Tauri event name for native runtime install/update progress updates. */
export const EXTERNAL_RUNTIME_INSTALL_PROGRESS_EVENT = 'external-runtime:install-progress';

const INSTALL_STAGE_LABELS: Record<ExternalRuntimeInstallStage, string> = {
  preparing: 'Preparing',
  downloading: 'Downloading',
  verifying: 'Verifying',
  installing: 'Installing',
  complete: 'Complete',
};

/**
 * Formats an install-progress payload into a short status line such as
 * `Downloading 45%` or `Verifying`. Returns null when no progress is active.
 */
export function formatInstallProgress(progress?: ExternalRuntimeInstallProgress | null): string | null {
  if (!progress) {
    return null;
  }
  const label = INSTALL_STAGE_LABELS[progress.stage] ?? progress.stage;
  if (progress.percent != null && Number.isFinite(progress.percent)) {
    return `${label} ${Math.round(progress.percent)}%`;
  }
  return label;
}

/**
 * Per-runtime strings that differentiate an otherwise identical set of
 * user-facing guidance helpers (Codex vs Claude Code).
 */
export interface RuntimeGuidanceConfig {
  /** Short product label used in the generic action-error fallback, e.g. `Claude`. */
  productName: string;
  /** Guidance shown when the native launcher binary cannot execute on this OS. */
  reinstallMessage: string;
  /** Matches backend "not installed/found" messages for this runtime. */
  notInstalledPattern: RegExp;
  /** Guidance shown when the runtime is not installed. */
  notInstalledMessage: string;
}

/**
 * The trio of user-facing message helpers each runtime-controls component uses
 * to translate raw backend errors into safe, actionable guidance.
 */
export interface RuntimeGuidance {
  /** Formats a thrown error, hiding raw diagnostics unless they are enabled. */
  formatActionError(error: unknown, showDiagnostics: boolean): string;
  /** Formats a backend result message against a fallback, honoring diagnostics. */
  formatRuntimeMessage(
    message: string | null | undefined,
    fallback: string,
    showDiagnostics: boolean,
  ): string;
  /** Maps a raw message to safe guidance, or null when none applies. */
  getSafeRuntimeGuidance(message?: string | null): string | null;
}

/**
 * Build the shared guidance trio for a runtime-controls component. Both the
 * Codex and Claude Code panels differ only in product strings, so this factory
 * removes the duplicated helper bodies that previously drifted between them.
 */
export function createRuntimeGuidance(config: RuntimeGuidanceConfig): RuntimeGuidance {
  const getSafeRuntimeGuidance = (message?: string | null): string | null => {
    if (!message) {
      return null;
    }
    if (isLauncherExecutableError(message)) {
      return config.reinstallMessage;
    }
    const downloadGuidance = nativeDownloadFailureGuidance(message);
    if (downloadGuidance) {
      return downloadGuidance;
    }
    if (config.notInstalledPattern.test(message)) {
      return config.notInstalledMessage;
    }
    return null;
  };

  const formatActionError = (error: unknown, showDiagnostics: boolean): string => {
    const message = error instanceof Error ? error.message : String(error);
    return showDiagnostics
      ? message
      : (getSafeRuntimeGuidance(message) ??
          `The ${config.productName} setup action could not be completed. Check your connection and try again.`);
  };

  const formatRuntimeMessage = (
    message: string | null | undefined,
    fallback: string,
    showDiagnostics: boolean,
  ): string => {
    if (showDiagnostics && message) {
      return message;
    }
    return getSafeRuntimeGuidance(message) ?? fallback;
  };

  return { formatActionError, formatRuntimeMessage, getSafeRuntimeGuidance };
}

/**
 * Guidance for a native download failure (network/proxy issues) surfaced when a
 * managed install/update cannot reach the official binary host.
 */
export function nativeDownloadFailureGuidance(message?: string | null): string | null {
  const normalized = message?.toLowerCase() ?? '';
  if (
    normalized.includes('network') ||
    normalized.includes('proxy') ||
    normalized.includes('connection') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('dns') ||
    normalized.includes('download failed') ||
    normalized.includes('failed to download') ||
    normalized.includes('unreachable')
  ) {
    return 'Check your network connection and try again.';
  }
  return null;
}
