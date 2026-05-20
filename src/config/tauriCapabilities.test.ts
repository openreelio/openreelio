import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface TauriCapability {
  permissions?: unknown;
}

function readDefaultCapabilityPermissions(): string[] {
  const capabilityPath = resolve(process.cwd(), 'src-tauri/capabilities/default.json');
  const capability = JSON.parse(readFileSync(capabilityPath, 'utf-8')) as TauriCapability;

  if (!Array.isArray(capability.permissions)) {
    throw new Error('Default Tauri capability permissions must be an array');
  }

  if (!capability.permissions.every((permission) => typeof permission === 'string')) {
    throw new Error('Default Tauri capability permissions must contain only strings');
  }

  return capability.permissions as string[];
}

describe('Tauri default capabilities', () => {
  it('allows both requesting and finalizing native window close', () => {
    const permissions = readDefaultCapabilityPermissions();

    expect(permissions).toContain('core:window:allow-close');
    expect(permissions).toContain('core:window:allow-destroy');
  });
});
