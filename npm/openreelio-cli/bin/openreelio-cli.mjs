#!/usr/bin/env node

/**
 * @fileoverview `openreelio-cli` npm launcher.
 *
 * This package ships no binary of its own. The platform binary arrives through
 * one of the `@openreelio/cli-*` optional dependencies, which npm installs only
 * when their `os`/`cpu` fields match the host. This launcher locates that
 * sibling package and execs the binary inside it.
 *
 * Deliberately there is no install script: npm v12 disables lifecycle scripts
 * for dependencies by default, so a postinstall download would silently fail
 * for a growing share of users.
 *
 * Contract:
 * - stdout/stderr belong entirely to the CLI. This launcher prints nothing on
 *   the happy path, because callers parse stdout as a single JSON object.
 * - The child's exit code is propagated verbatim. `openreelio-cli verify` uses
 *   0 (passed), 1 (threshold breached) and 2 (could not run), and agents branch
 *   on those values.
 * - Failures inside the launcher itself exit with 2 ("the tool could not run").
 */

import { spawnSync } from 'node:child_process';
import { existsSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';
import { dirname, join } from 'node:path';

/** Exit code used when the launcher cannot start the real CLI. */
const EXIT_LAUNCH_FAILURE = 2;

/** Environment variable that overrides platform package resolution. */
const BINARY_OVERRIDE_ENV = 'OPENREELIO_CLI_BINARY';

/** Release targets published to npm, keyed by `${process.platform}-${process.arch}`. */
const PLATFORM_PACKAGES = {
  'win32-x64': { packageName: '@openreelio/cli-win32-x64', binaryName: 'openreelio-cli.exe' },
  'darwin-x64': { packageName: '@openreelio/cli-darwin-x64', binaryName: 'openreelio-cli' },
  'darwin-arm64': { packageName: '@openreelio/cli-darwin-arm64', binaryName: 'openreelio-cli' },
  'linux-x64': { packageName: '@openreelio/cli-linux-x64', binaryName: 'openreelio-cli' },
};

const RELEASES_URL = 'https://github.com/openreelio/openreelio/releases';

const require = createRequire(import.meta.url);

/**
 * Fails the process with a message on stderr, never stdout.
 *
 * @param {string[]} lines Message lines, printed in order.
 * @returns {never}
 */
function fail(lines) {
  // writeSync, not process.stderr.write: stderr is async when it is a pipe, and
  // process.exit() would discard a buffered message.
  writeSync(process.stderr.fd, `${lines.join('\n')}\n`);
  process.exit(EXIT_LAUNCH_FAILURE);
}

/**
 * Detects a musl-based Linux host. Release builds are glibc (gnu) only, so this
 * turns an opaque "package not found" into an actionable message.
 *
 * @returns {boolean} True when the host looks like musl libc.
 */
function isLikelyMuslLinux() {
  if (process.platform !== 'linux') {
    return false;
  }

  try {
    const report = process.report?.getReport();
    const header = typeof report === 'object' && report !== null ? report.header : undefined;
    // glibcVersionRuntime is absent on musl builds of Node.
    return Boolean(header) && !('glibcVersionRuntime' in header);
  } catch {
    return false;
  }
}

/**
 * Builds the diagnostic shown when the platform package cannot be resolved.
 *
 * @param {string} packageName Expected optional dependency.
 * @returns {string[]} Message lines.
 */
function missingPlatformPackageMessage(packageName) {
  const lines = [
    `openreelio-cli: the platform package "${packageName}" is not installed.`,
    `  host: ${process.platform}-${process.arch}`,
    '',
    'This package resolves its binary from an optional dependency, so the most',
    'common causes are:',
    '  - the install disabled optional dependencies',
    '    (npm --omit=optional / --no-optional, yarn --ignore-optional,',
    '     pnpm --no-optional, or NPM_CONFIG_OPTIONAL=false in CI)',
    '  - a lockfile generated on a different OS or CPU was installed verbatim',
    '  - the package was vendored or copied without its dependencies',
  ];

  if (isLikelyMuslLinux()) {
    lines.push(
      '  - this host appears to use musl libc; published builds are glibc (gnu) only',
    );
  }

  lines.push(
    '',
    'Fixes:',
    '  - reinstall with optional dependencies enabled: npm install openreelio-cli',
    `  - or download a standalone build from ${RELEASES_URL}`,
    `    and point ${BINARY_OVERRIDE_ENV} at it`,
  );

  return lines;
}

/**
 * Resolves the absolute path of the OpenReelio CLI binary for this host.
 *
 * @returns {string} Absolute path to the executable.
 */
function resolveBinaryPath() {
  const override = process.env[BINARY_OVERRIDE_ENV];
  if (override) {
    if (!existsSync(override)) {
      fail([
        `openreelio-cli: ${BINARY_OVERRIDE_ENV} points at a missing file.`,
        `  ${override}`,
      ]);
    }
    return override;
  }

  const hostKey = `${process.platform}-${process.arch}`;
  const target = PLATFORM_PACKAGES[hostKey];
  if (!target) {
    fail([
      `openreelio-cli: unsupported platform/arch "${hostKey}".`,
      `  supported: ${Object.keys(PLATFORM_PACKAGES).join(', ')}`,
      '',
      `Build from source or download a standalone archive from ${RELEASES_URL},`,
      `then point ${BINARY_OVERRIDE_ENV} at the binary.`,
    ]);
  }

  let packageJsonPath;
  try {
    packageJsonPath = require.resolve(`${target.packageName}/package.json`);
  } catch {
    fail(missingPlatformPackageMessage(target.packageName));
  }

  const binaryPath = join(dirname(packageJsonPath), 'bin', target.binaryName);
  if (!existsSync(binaryPath)) {
    fail([
      `openreelio-cli: "${target.packageName}" is installed but its binary is missing.`,
      `  expected: ${binaryPath}`,
      '',
      'Reinstall the package, or download a standalone build from',
      `${RELEASES_URL} and point ${BINARY_OVERRIDE_ENV} at it.`,
    ]);
  }

  return binaryPath;
}

const binaryPath = resolveBinaryPath();
const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: 'inherit',
  // shell: false keeps arguments verbatim; edit commands routinely carry
  // quotes, spaces and filter expressions that a shell would mangle.
  shell: false,
});

if (result.error) {
  fail([
    `openreelio-cli: failed to start ${binaryPath}`,
    `  ${result.error.message}`,
  ]);
}

if (typeof result.status === 'number') {
  process.exit(result.status);
}

if (result.signal) {
  // Mirror the shell convention so callers can tell a signal from a normal exit.
  const signalNumber = osConstants.signals[result.signal] ?? 0;
  process.exit(128 + signalNumber);
}

process.exit(EXIT_LAUNCH_FAILURE);
