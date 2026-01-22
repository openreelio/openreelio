#!/usr/bin/env npx tsx

/**
 * Generate Tauri Signing Keys for Auto-Update
 *
 * This script helps generate the key pair required for signing updates.
 * The public key goes in tauri.conf.json, and the private key is stored
 * as a GitHub secret.
 *
 * Usage:
 *   npx tsx scripts/generate-signing-keys.ts
 *
 * After running:
 *   1. Copy the PUBLIC KEY to src-tauri/tauri.conf.json plugins.updater.pubkey
 *   2. Add the PRIVATE KEY as GitHub secret: TAURI_SIGNING_PRIVATE_KEY
 *   3. Add the PASSWORD (if any) as GitHub secret: TAURI_SIGNING_PRIVATE_KEY_PASSWORD
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEYS_DIR = join(homedir(), '.tauri');
const KEY_FILE = join(KEYS_DIR, 'openreelio.key');
const PUBKEY_FILE = join(KEYS_DIR, 'openreelio.key.pub');

console.log('OpenReelio Signing Key Generator');
console.log('=================================\n');

// Check if keys already exist
if (existsSync(KEY_FILE) && existsSync(PUBKEY_FILE)) {
  console.log('Keys already exist at:');
  console.log(`  Private: ${KEY_FILE}`);
  console.log(`  Public:  ${PUBKEY_FILE}\n`);

  const pubkey = readFileSync(PUBKEY_FILE, 'utf-8').trim();
  console.log('Public Key (for tauri.conf.json):');
  console.log(`  "${pubkey}"\n`);

  console.log('To regenerate, delete the existing keys first.\n');
  process.exit(0);
}

// Create keys directory
if (!existsSync(KEYS_DIR)) {
  mkdirSync(KEYS_DIR, { recursive: true });
}

console.log('Generating new signing key pair...\n');

try {
  // Generate keys using Tauri CLI
  execSync(`npx tauri signer generate -w "${KEY_FILE}"`, {
    stdio: 'inherit',
  });

  console.log('\n');

  if (existsSync(PUBKEY_FILE)) {
    const pubkey = readFileSync(PUBKEY_FILE, 'utf-8').trim();

    console.log('Keys generated successfully!\n');
    console.log('=== PUBLIC KEY ===');
    console.log(pubkey);
    console.log('==================\n');

    console.log('Next Steps:');
    console.log('');
    console.log('1. Update src-tauri/tauri.conf.json:');
    console.log('   "plugins": {');
    console.log('     "updater": {');
    console.log(`       "pubkey": "${pubkey}",`);
    console.log('       ...');
    console.log('     }');
    console.log('   }');
    console.log('');
    console.log('2. Add GitHub repository secrets:');
    console.log('   - TAURI_SIGNING_PRIVATE_KEY: Contents of ' + KEY_FILE);
    console.log('   - TAURI_SIGNING_PRIVATE_KEY_PASSWORD: The password you entered (if any)');
    console.log('');
    console.log('3. Keep your private key secure!');
    console.log(`   Location: ${KEY_FILE}`);
    console.log('   Never commit this to version control.');
    console.log('');
  } else {
    console.error('Public key file was not created. Please check Tauri CLI installation.');
    process.exit(1);
  }
} catch (error) {
  console.error('Failed to generate keys:', error);
  console.error('\nMake sure @tauri-apps/cli is installed:');
  console.error('  npm install -D @tauri-apps/cli');
  process.exit(1);
}
