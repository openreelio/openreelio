/**
 * Build-time application version helpers.
 *
 * The native app reports its current version through Tauri. This value is the
 * frontend fallback so browser/E2E runs and failed IPC calls still display the
 * packaged version instead of a stale hardcoded string.
 */

import packageManifest from '../../package.json';

const PACKAGE_VERSION =
  typeof packageManifest.version === 'string' && packageManifest.version.trim().length > 0
    ? packageManifest.version.trim()
    : '0.0.0';

export const APP_VERSION =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__.trim().length > 0
    ? __APP_VERSION__.trim()
    : PACKAGE_VERSION;

export function normalizeAppVersion(version: string | null | undefined): string {
  const normalized = version?.trim();

  if (!normalized || normalized === 'unknown' || normalized === 'web') {
    return APP_VERSION;
  }

  return normalized;
}

export function formatAppVersion(version: string | null | undefined = APP_VERSION): string {
  const normalized = normalizeAppVersion(version);
  return normalized.startsWith('v') ? normalized : `v${normalized}`;
}
