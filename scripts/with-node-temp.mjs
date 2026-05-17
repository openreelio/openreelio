#!/usr/bin/env node

/**
 * Runs a Node-based tool with a POSIX temp directory on WSL.
 *
 * Some tools, including tsx, create Unix sockets in the OS temp directory.
 * When Windows TEMP/TMP is inherited inside WSL, those sockets can land under
 * /mnt/c and fail with ENOTSUP. Keep this wrapper small and only adjust WSL.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

function isWsl() {
  if (process.platform !== 'linux') {
    return false;
  }

  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    return true;
  }

  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

function pointsAtWindowsMount(value) {
  return typeof value === 'string' && value.startsWith('/mnt/');
}

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error('Usage: node scripts/with-node-temp.mjs <command> [...args]');
  process.exit(1);
}

const env = { ...process.env };

if (
  isWsl() &&
  existsSync('/tmp') &&
  (pointsAtWindowsMount(env.TMPDIR) ||
    pointsAtWindowsMount(env.TMP) ||
    pointsAtWindowsMount(env.TEMP))
) {
  env.TMPDIR = '/tmp';
  env.TMP = '/tmp';
  env.TEMP = '/tmp';
}

const result = spawnSync(command, args, {
  env,
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
