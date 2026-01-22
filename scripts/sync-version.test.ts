/**
 * @fileoverview Tests for version sync script
 * TDD: RED phase - These tests define the expected behavior
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import {
  readPackageVersion,
  readCargoVersion,
  readTauriVersion,
  updateCargoVersion,
  updateTauriVersion,
  checkVersionSync,
  syncVersions,
  validateSemver,
} from './sync-version';

// Test fixtures directory
const TEST_DIR = join(__dirname, '__test_fixtures__');
const TEST_PACKAGE_JSON = join(TEST_DIR, 'package.json');
const TEST_CARGO_TOML = join(TEST_DIR, 'Cargo.toml');
const TEST_TAURI_CONF = join(TEST_DIR, 'tauri.conf.json');

describe('Version Sync Script', () => {
  beforeEach(() => {
    // Create test fixtures directory
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }

    // Create test package.json
    writeFileSync(
      TEST_PACKAGE_JSON,
      JSON.stringify({ name: 'test', version: '1.2.3' }, null, 2)
    );

    // Create test Cargo.toml
    writeFileSync(
      TEST_CARGO_TOML,
      `[package]
name = "test"
version = "1.0.0"
edition = "2021"
`
    );

    // Create test tauri.conf.json
    writeFileSync(
      TEST_TAURI_CONF,
      JSON.stringify(
        {
          productName: 'Test',
          version: '1.0.0',
          identifier: 'com.test.app',
        },
        null,
        2
      )
    );
  });

  afterEach(() => {
    // Clean up test fixtures
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('validateSemver', () => {
    it('should accept valid semver strings', () => {
      expect(validateSemver('1.0.0')).toBe(true);
      expect(validateSemver('0.1.0')).toBe(true);
      expect(validateSemver('10.20.30')).toBe(true);
      expect(validateSemver('1.0.0-alpha')).toBe(true);
      expect(validateSemver('1.0.0-beta.1')).toBe(true);
      expect(validateSemver('1.0.0+build.123')).toBe(true);
    });

    it('should reject invalid semver strings', () => {
      expect(validateSemver('1.0')).toBe(false);
      expect(validateSemver('v1.0.0')).toBe(false);
      expect(validateSemver('1.0.0.0')).toBe(false);
      expect(validateSemver('abc')).toBe(false);
      expect(validateSemver('')).toBe(false);
    });
  });

  describe('readPackageVersion', () => {
    it('should read version from package.json', () => {
      const version = readPackageVersion(TEST_PACKAGE_JSON);
      expect(version).toBe('1.2.3');
    });

    it('should throw error if file not found', () => {
      expect(() => readPackageVersion('/nonexistent/package.json')).toThrow();
    });

    it('should throw error if version field missing', () => {
      writeFileSync(TEST_PACKAGE_JSON, JSON.stringify({ name: 'test' }));
      expect(() => readPackageVersion(TEST_PACKAGE_JSON)).toThrow(
        'version field not found'
      );
    });
  });

  describe('readCargoVersion', () => {
    it('should read version from Cargo.toml', () => {
      const version = readCargoVersion(TEST_CARGO_TOML);
      expect(version).toBe('1.0.0');
    });

    it('should throw error if file not found', () => {
      expect(() => readCargoVersion('/nonexistent/Cargo.toml')).toThrow();
    });

    it('should throw error if version field missing', () => {
      writeFileSync(TEST_CARGO_TOML, '[package]\nname = "test"\n');
      expect(() => readCargoVersion(TEST_CARGO_TOML)).toThrow(
        'version field not found'
      );
    });
  });

  describe('readTauriVersion', () => {
    it('should read version from tauri.conf.json', () => {
      const version = readTauriVersion(TEST_TAURI_CONF);
      expect(version).toBe('1.0.0');
    });

    it('should throw error if file not found', () => {
      expect(() => readTauriVersion('/nonexistent/tauri.conf.json')).toThrow();
    });

    it('should throw error if version field missing', () => {
      writeFileSync(TEST_TAURI_CONF, JSON.stringify({ productName: 'Test' }));
      expect(() => readTauriVersion(TEST_TAURI_CONF)).toThrow(
        'version field not found'
      );
    });
  });

  describe('updateCargoVersion', () => {
    it('should update version in Cargo.toml', () => {
      updateCargoVersion(TEST_CARGO_TOML, '2.0.0');
      const content = readFileSync(TEST_CARGO_TOML, 'utf-8');
      expect(content).toContain('version = "2.0.0"');
    });

    it('should preserve other fields in Cargo.toml', () => {
      updateCargoVersion(TEST_CARGO_TOML, '2.0.0');
      const content = readFileSync(TEST_CARGO_TOML, 'utf-8');
      expect(content).toContain('name = "test"');
      expect(content).toContain('edition = "2021"');
    });

    it('should throw error for invalid semver', () => {
      expect(() => updateCargoVersion(TEST_CARGO_TOML, 'invalid')).toThrow(
        'Invalid semver'
      );
    });
  });

  describe('updateTauriVersion', () => {
    it('should update version in tauri.conf.json', () => {
      updateTauriVersion(TEST_TAURI_CONF, '2.0.0');
      const content = JSON.parse(readFileSync(TEST_TAURI_CONF, 'utf-8'));
      expect(content.version).toBe('2.0.0');
    });

    it('should preserve other fields in tauri.conf.json', () => {
      updateTauriVersion(TEST_TAURI_CONF, '2.0.0');
      const content = JSON.parse(readFileSync(TEST_TAURI_CONF, 'utf-8'));
      expect(content.productName).toBe('Test');
      expect(content.identifier).toBe('com.test.app');
    });

    it('should throw error for invalid semver', () => {
      expect(() => updateTauriVersion(TEST_TAURI_CONF, 'invalid')).toThrow(
        'Invalid semver'
      );
    });
  });

  describe('checkVersionSync', () => {
    it('should return empty array when all versions match', () => {
      // Set all versions to the same value
      writeFileSync(
        TEST_PACKAGE_JSON,
        JSON.stringify({ name: 'test', version: '1.0.0' }, null, 2)
      );

      const result = checkVersionSync({
        packageJson: TEST_PACKAGE_JSON,
        cargoToml: TEST_CARGO_TOML,
        tauriConf: TEST_TAURI_CONF,
      });

      expect(result.synced).toBe(true);
      expect(result.mismatches).toEqual([]);
    });

    it('should return mismatches when versions differ', () => {
      const result = checkVersionSync({
        packageJson: TEST_PACKAGE_JSON, // version: 1.2.3
        cargoToml: TEST_CARGO_TOML, // version: 1.0.0
        tauriConf: TEST_TAURI_CONF, // version: 1.0.0
      });

      expect(result.synced).toBe(false);
      expect(result.sourceVersion).toBe('1.2.3');
      expect(result.mismatches).toHaveLength(2);
      expect(result.mismatches).toContainEqual({
        file: 'Cargo.toml',
        path: TEST_CARGO_TOML,
        currentVersion: '1.0.0',
        expectedVersion: '1.2.3',
      });
    });
  });

  describe('syncVersions', () => {
    it('should sync all versions to match package.json', () => {
      const result = syncVersions({
        packageJson: TEST_PACKAGE_JSON, // version: 1.2.3
        cargoToml: TEST_CARGO_TOML,
        tauriConf: TEST_TAURI_CONF,
      });

      expect(result.success).toBe(true);
      expect(result.updatedFiles).toHaveLength(2);

      // Verify the files were updated
      expect(readCargoVersion(TEST_CARGO_TOML)).toBe('1.2.3');
      expect(readTauriVersion(TEST_TAURI_CONF)).toBe('1.2.3');
    });

    it('should return success with no updates when already synced', () => {
      writeFileSync(
        TEST_PACKAGE_JSON,
        JSON.stringify({ name: 'test', version: '1.0.0' }, null, 2)
      );

      const result = syncVersions({
        packageJson: TEST_PACKAGE_JSON,
        cargoToml: TEST_CARGO_TOML,
        tauriConf: TEST_TAURI_CONF,
      });

      expect(result.success).toBe(true);
      expect(result.updatedFiles).toHaveLength(0);
    });
  });
});
