#!/usr/bin/env npx tsx

/**
 * @fileoverview Version Sync Script for OpenReelio
 *
 * Single Source of Truth: package.json
 * Sync Targets: every entry in the target descriptor list (see getDefaultConfig),
 * currently the Tauri app manifests plus the openreelio-core / openreelio-cli
 * crates and the published npm shim package.
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

/**
 * Updates the version field of a JSON manifest, preserving 2-space indentation
 */
function updateJsonVersion(filePath: string, newVersion: string): void {
  if (!validateSemver(newVersion)) {
    throw new Error(`Invalid semver: ${newVersion}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const json = JSON.parse(content) as Record<string, unknown>;

  json.version = newVersion;

  writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n', 'utf-8');
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
 * Updates version in a package.json manifest
 */
export function updatePackageVersion(filePath: string, newVersion: string): void {
  updateJsonVersion(filePath, newVersion);
}

/** Manifest formats the sync script knows how to read and write */
export type VersionFileKind = 'package-json' | 'cargo-toml' | 'tauri-conf';

const VERSION_READERS: Record<VersionFileKind, (filePath: string) => string> = {
  'package-json': readPackageVersion,
  'cargo-toml': readCargoVersion,
  'tauri-conf': readTauriVersion,
};

const VERSION_WRITERS: Record<
  VersionFileKind,
  (filePath: string, newVersion: string) => void
> = {
  'package-json': updatePackageVersion,
  'cargo-toml': updateCargoVersion,
  'tauri-conf': updateTauriVersion,
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
function getDefaultConfig(): VersionSyncConfig {
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
          console.log(`  ${m.file}: ${m.currentVersion} (expected ${m.expectedVersion})`);
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
