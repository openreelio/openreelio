#!/usr/bin/env npx tsx

/**
 * @fileoverview Version Sync Script for OpenReelio
 *
 * Single Source of Truth: package.json
 * Sync Targets: every entry in the target descriptor list (see getDefaultConfig),
 * currently the Tauri app manifests, the openreelio-core / openreelio-cli
 * crates, the published npm shim package and the distributed Claude Code
 * plugin manifest.
 *
 * Usage:
 *   npx tsx scripts/sync-version.ts --check   # Verify versions are synced (CI mode)
 *   npx tsx scripts/sync-version.ts --fix     # Auto-sync versions
 *   npx tsx scripts/sync-version.ts           # Same as --check
 *
 * Exit Codes:
 *   0 - Success (versions synced or fixed)
 *   1 - Error (versions mismatched in --check mode, or file error)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Semver regex pattern (simplified but sufficient for common cases)
const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Validates if a string is a valid semver version
 */
export function validateSemver(version: string): boolean {
  if (!version || typeof version !== 'string') {
    return false;
  }
  return SEMVER_REGEX.test(version);
}

/**
 * Reads version from package.json
 */
export function readPackageVersion(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const json = JSON.parse(content) as { version?: string };

  if (!json.version) {
    throw new Error(`version field not found in ${filePath}`);
  }

  return json.version;
}

/**
 * Reads version from Cargo.toml
 */
export function readCargoVersion(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');

  // Match version in [package] section
  // Pattern: version = "x.x.x"
  const match = content.match(/^\s*version\s*=\s*"([^"]+)"/m);

  if (!match) {
    throw new Error(`version field not found in ${filePath}`);
  }

  return match[1];
}

/**
 * Reads version from tauri.conf.json
 */
export function readTauriVersion(filePath: string): string {
  return readPackageVersion(filePath);
}

/** Scope whose sibling packages are released in lockstep with the app version */
const LOCKSTEP_DEPENDENCY_SCOPE = '@openreelio/';

/**
 * Updates the version field of a JSON manifest, preserving 2-space indentation
 */
export function updateJsonVersion(filePath: string, newVersion: string): void {
  if (!validateSemver(newVersion)) {
    throw new Error(`Invalid semver: ${newVersion}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const json = JSON.parse(content) as Record<string, unknown>;

  json.version = newVersion;

  writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n', 'utf-8');
}

/**
 * Repins `@openreelio/*` optional dependencies to the given version.
 *
 * The npm shim pins its platform packages exactly, and those packages are
 * published from the same tag. Left alone, a version bump would ship a shim
 * pointing at platform packages that do not exist yet; npm treats a missing
 * optional dependency as a soft failure, so the breakage would only surface
 * when a user runs the command.
 */
function repinLockstepOptionalDependencies(
  json: Record<string, unknown>,
  newVersion: string
): void {
  const optionalDependencies = json.optionalDependencies;
  if (typeof optionalDependencies !== 'object' || optionalDependencies === null) {
    return;
  }

  for (const name of Object.keys(optionalDependencies)) {
    if (name.startsWith(LOCKSTEP_DEPENDENCY_SCOPE)) {
      (optionalDependencies as Record<string, string>)[name] = newVersion;
    }
  }
}

/**
 * Lists `@openreelio/*` optional dependencies of a package manifest that are not
 * pinned to the given version.
 *
 * The version field and the lockstep pins can drift apart — a manual edit, or a
 * pin added after the last bump — so a manifest whose version already matches
 * can still ship stale pins. Checking must catch that, not just fixing.
 */
export function findStaleLockstepPins(filePath: string, expectedVersion: string): string[] {
  const json = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  const optionalDependencies = json.optionalDependencies;

  if (typeof optionalDependencies !== 'object' || optionalDependencies === null) {
    return [];
  }

  return Object.entries(optionalDependencies as Record<string, string>)
    .filter(
      ([name, range]) =>
        name.startsWith(LOCKSTEP_DEPENDENCY_SCOPE) && range !== expectedVersion
    )
    .map(([name]) => name);
}

/**
 * Updates version in Cargo.toml
 */
export function updateCargoVersion(filePath: string, newVersion: string): void {
  if (!validateSemver(newVersion)) {
    throw new Error(`Invalid semver: ${newVersion}`);
  }

  const content = readFileSync(filePath, 'utf-8');

  // Replace version in [package] section
  const updatedContent = content.replace(
    /^(\s*version\s*=\s*)"[^"]+"/m,
    `$1"${newVersion}"`
  );

  writeFileSync(filePath, updatedContent, 'utf-8');
}

/**
 * Updates version in tauri.conf.json
 */
export function updateTauriVersion(filePath: string, newVersion: string): void {
  updateJsonVersion(filePath, newVersion);
}

/**
 * Updates version in a package.json manifest, keeping `@openreelio/*` optional
 * dependencies pinned to the same version
 */
export function updatePackageVersion(filePath: string, newVersion: string): void {
  if (!validateSemver(newVersion)) {
    throw new Error(`Invalid semver: ${newVersion}`);
  }

  const json = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;

  json.version = newVersion;
  repinLockstepOptionalDependencies(json, newVersion);

  writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n', 'utf-8');
}

/**
 * Manifest formats the sync script knows how to read and write.
 *
 * `json-version` is the generic case: any JSON manifest carrying a top-level
 * `version` field and no lockstep dependency pins.
 */
export type VersionFileKind =
  | 'package-json'
  | 'cargo-toml'
  | 'tauri-conf'
  | 'json-version';

const VERSION_READERS: Record<VersionFileKind, (filePath: string) => string> = {
  'package-json': readPackageVersion,
  'cargo-toml': readCargoVersion,
  'tauri-conf': readTauriVersion,
  'json-version': readPackageVersion,
};

const VERSION_WRITERS: Record<
  VersionFileKind,
  (filePath: string, newVersion: string) => void
> = {
  'package-json': updatePackageVersion,
  'cargo-toml': updateCargoVersion,
  'tauri-conf': updateTauriVersion,
  'json-version': updateJsonVersion,
};

/** A single file that must carry the same version as package.json */
export interface VersionTarget {
  /** Human-readable label used in reports (repo-relative path is clearest) */
  file: string;
  /** Absolute path to the manifest */
  path: string;
  /** Manifest format, selects the reader/writer pair */
  kind: VersionFileKind;
  /**
   * When true, a missing file is reported as skipped instead of failing.
   * Used for manifests that are generated or land in a later change.
   */
  optional?: boolean;
}

export interface VersionSyncConfig {
  /** Single source of truth */
  packageJson: string;
  /** Files that must match the source version */
  targets: VersionTarget[];
}

export interface VersionMismatch {
  file: string;
  path: string;
  kind: VersionFileKind;
  currentVersion: string;
  expectedVersion: string;
  /**
   * Set when the version field itself matches but something else in the file is
   * out of sync, so reports can say what actually has to change.
   */
  detail?: string;
}

export interface SkippedTarget {
  file: string;
  path: string;
  reason: string;
}

export interface CheckResult {
  synced: boolean;
  sourceVersion: string;
  mismatches: VersionMismatch[];
  skipped: SkippedTarget[];
}

/**
 * Checks if all version files are in sync with package.json
 */
export function checkVersionSync(config: VersionSyncConfig): CheckResult {
  const sourceVersion = readPackageVersion(config.packageJson);
  const mismatches: VersionMismatch[] = [];
  const skipped: SkippedTarget[] = [];

  for (const target of config.targets) {
    if (target.optional && !existsSync(target.path)) {
      skipped.push({
        file: target.file,
        path: target.path,
        reason: 'file not present',
      });
      continue;
    }

    const currentVersion = VERSION_READERS[target.kind](target.path);
    if (currentVersion !== sourceVersion) {
      mismatches.push({
        file: target.file,
        path: target.path,
        kind: target.kind,
        currentVersion,
        expectedVersion: sourceVersion,
      });
      continue;
    }

    // A manifest can carry the right version and still pin its lockstep
    // siblings at an older one; the writer repins them, so report it as a
    // mismatch to get the writer invoked.
    if (target.kind === 'package-json') {
      const stalePins = findStaleLockstepPins(target.path, sourceVersion);
      if (stalePins.length > 0) {
        mismatches.push({
          file: target.file,
          path: target.path,
          kind: target.kind,
          currentVersion,
          expectedVersion: sourceVersion,
          detail: `stale ${LOCKSTEP_DEPENDENCY_SCOPE}* pins: ${stalePins.join(', ')}`,
        });
      }
    }
  }

  return {
    synced: mismatches.length === 0,
    sourceVersion,
    mismatches,
    skipped,
  };
}

export interface SyncResult {
  success: boolean;
  version: string;
  updatedFiles: string[];
  skipped: SkippedTarget[];
}

/**
 * Syncs all version files to match package.json
 */
export function syncVersions(config: VersionSyncConfig): SyncResult {
  const checkResult = checkVersionSync(config);
  const updatedFiles: string[] = [];

  for (const mismatch of checkResult.mismatches) {
    VERSION_WRITERS[mismatch.kind](mismatch.path, checkResult.sourceVersion);
    updatedFiles.push(mismatch.file);
  }

  return {
    success: true,
    version: checkResult.sourceVersion,
    updatedFiles,
    skipped: checkResult.skipped,
  };
}

/**
 * Gets the default sync configuration relative to project root
 */
export function getDefaultConfig(): VersionSyncConfig {
  const projectRoot = resolve(__dirname, '..');
  return {
    packageJson: resolve(projectRoot, 'package.json'),
    targets: [
      {
        file: 'src-tauri/Cargo.toml',
        path: resolve(projectRoot, 'src-tauri', 'Cargo.toml'),
        kind: 'cargo-toml',
      },
      {
        file: 'src-tauri/tauri.conf.json',
        path: resolve(projectRoot, 'src-tauri', 'tauri.conf.json'),
        kind: 'tauri-conf',
      },
      {
        file: 'crates/openreelio-core/Cargo.toml',
        path: resolve(projectRoot, 'crates', 'openreelio-core', 'Cargo.toml'),
        kind: 'cargo-toml',
      },
      {
        file: 'crates/openreelio-cli/Cargo.toml',
        path: resolve(projectRoot, 'crates', 'openreelio-cli', 'Cargo.toml'),
        kind: 'cargo-toml',
      },
      {
        // The npm distribution shim is optional so version:check stays green
        // both before and after that package lands.
        file: 'npm/openreelio-cli/package.json',
        path: resolve(projectRoot, 'npm', 'openreelio-cli', 'package.json'),
        kind: 'package-json',
        optional: true,
      },
      {
        // The Claude Code plugin manifest is published from the same tag, so a
        // stale version here advertises the wrong CLI to every agent host.
        file: 'distribution/skills/.claude-plugin/plugin.json',
        path: resolve(
          projectRoot,
          'distribution',
          'skills',
          '.claude-plugin',
          'plugin.json'
        ),
        kind: 'json-version',
      },
    ],
  };
}

/**
 * CLI entry point
 */
function main(): void {
  const args = process.argv.slice(2);
  const mode = args.includes('--fix') ? 'fix' : 'check';

  const config = getDefaultConfig();

  console.log('OpenReelio Version Sync');
  console.log('========================');
  console.log(`Source: package.json`);
  console.log(`Mode: ${mode}\n`);

  const reportSkipped = (skipped: SkippedTarget[]): void => {
    for (const target of skipped) {
      console.log(`  - Skipped ${target.file} (${target.reason})`);
    }
  };

  try {
    if (mode === 'check') {
      const result = checkVersionSync(config);

      console.log(`Source version: ${result.sourceVersion}`);
      reportSkipped(result.skipped);

      if (result.synced) {
        console.log('\n✓ All versions are in sync!');
        process.exit(0);
      } else {
        console.log('\n✗ Version mismatch detected:\n');
        for (const m of result.mismatches) {
          console.log(
            m.detail
              ? `  ${m.file}: ${m.detail} (expected ${m.expectedVersion})`
              : `  ${m.file}: ${m.currentVersion} (expected ${m.expectedVersion})`
          );
        }
        console.log('\nRun with --fix to sync versions.');
        process.exit(1);
      }
    } else {
      // Fix mode
      const result = syncVersions(config);

      console.log(`Target version: ${result.version}`);
      reportSkipped(result.skipped);

      if (result.updatedFiles.length === 0) {
        console.log('\n✓ All versions already in sync!');
      } else {
        console.log('\n✓ Updated files:');
        for (const file of result.updatedFiles) {
          console.log(`  - ${file}`);
        }
      }
      process.exit(0);
    }
  } catch (error) {
    console.error(`\n✗ Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

// Run CLI if executed directly
const isMain = process.argv[1]?.includes('sync-version');
if (isMain) {
  main();
}
