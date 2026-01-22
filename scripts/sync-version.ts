#!/usr/bin/env npx tsx

/**
 * @fileoverview Version Sync Script for OpenReelio
 *
 * Single Source of Truth: package.json
 * Sync Targets: Cargo.toml, tauri.conf.json
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
  if (!validateSemver(newVersion)) {
    throw new Error(`Invalid semver: ${newVersion}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const json = JSON.parse(content) as Record<string, unknown>;

  json.version = newVersion;

  // Preserve formatting with 2-space indentation
  writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n', 'utf-8');
}

export interface VersionMismatch {
  file: string;
  path: string;
  currentVersion: string;
  expectedVersion: string;
}

export interface CheckResult {
  synced: boolean;
  sourceVersion: string;
  mismatches: VersionMismatch[];
}

export interface FilePaths {
  packageJson: string;
  cargoToml: string;
  tauriConf: string;
}

/**
 * Checks if all version files are in sync with package.json
 */
export function checkVersionSync(paths: FilePaths): CheckResult {
  const sourceVersion = readPackageVersion(paths.packageJson);
  const mismatches: VersionMismatch[] = [];

  // Check Cargo.toml
  const cargoVersion = readCargoVersion(paths.cargoToml);
  if (cargoVersion !== sourceVersion) {
    mismatches.push({
      file: 'Cargo.toml',
      path: paths.cargoToml,
      currentVersion: cargoVersion,
      expectedVersion: sourceVersion,
    });
  }

  // Check tauri.conf.json
  const tauriVersion = readTauriVersion(paths.tauriConf);
  if (tauriVersion !== sourceVersion) {
    mismatches.push({
      file: 'tauri.conf.json',
      path: paths.tauriConf,
      currentVersion: tauriVersion,
      expectedVersion: sourceVersion,
    });
  }

  return {
    synced: mismatches.length === 0,
    sourceVersion,
    mismatches,
  };
}

export interface SyncResult {
  success: boolean;
  version: string;
  updatedFiles: string[];
}

/**
 * Syncs all version files to match package.json
 */
export function syncVersions(paths: FilePaths): SyncResult {
  const checkResult = checkVersionSync(paths);
  const updatedFiles: string[] = [];

  if (checkResult.synced) {
    return {
      success: true,
      version: checkResult.sourceVersion,
      updatedFiles,
    };
  }

  // Update mismatched files
  for (const mismatch of checkResult.mismatches) {
    if (mismatch.file === 'Cargo.toml') {
      updateCargoVersion(mismatch.path, checkResult.sourceVersion);
    } else if (mismatch.file === 'tauri.conf.json') {
      updateTauriVersion(mismatch.path, checkResult.sourceVersion);
    }
    updatedFiles.push(mismatch.file);
  }

  return {
    success: true,
    version: checkResult.sourceVersion,
    updatedFiles,
  };
}

/**
 * Gets default file paths relative to project root
 */
function getDefaultPaths(): FilePaths {
  const projectRoot = resolve(__dirname, '..');
  return {
    packageJson: resolve(projectRoot, 'package.json'),
    cargoToml: resolve(projectRoot, 'src-tauri', 'Cargo.toml'),
    tauriConf: resolve(projectRoot, 'src-tauri', 'tauri.conf.json'),
  };
}

/**
 * CLI entry point
 */
function main(): void {
  const args = process.argv.slice(2);
  const mode = args.includes('--fix') ? 'fix' : 'check';

  const paths = getDefaultPaths();

  console.log('OpenReelio Version Sync');
  console.log('========================');
  console.log(`Source: package.json`);
  console.log(`Mode: ${mode}\n`);

  try {
    if (mode === 'check') {
      const result = checkVersionSync(paths);

      console.log(`Source version: ${result.sourceVersion}`);

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
      const result = syncVersions(paths);

      console.log(`Target version: ${result.version}`);

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
