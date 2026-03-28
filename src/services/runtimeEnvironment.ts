/**
 * Runtime environment helpers for desktop-only features.
 *
 * Tests must opt in explicitly when they need desktop-only hooks. This avoids
 * broad Vitest detection leaking asynchronous IPC behavior into unrelated suites.
 */

import { isTauriRuntime } from '@/services/framePaths';

declare global {
  var __OPENREELIO_ENABLE_TAURI_TEST_RUNTIME__: boolean | undefined;
}

/** Explicit test-only override for desktop runtime behavior. */
export const DESKTOP_RUNTIME_TEST_FLAG = '__OPENREELIO_ENABLE_TAURI_TEST_RUNTIME__' as const;

/** Returns true when desktop-only IPC features are safe to use. */
export function isDesktopRuntimeAvailable(): boolean {
  return isTauriRuntime() || Boolean(globalThis.__OPENREELIO_ENABLE_TAURI_TEST_RUNTIME__);
}
