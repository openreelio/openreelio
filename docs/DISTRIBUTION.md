# Distribution & Code Signing Guide

This document explains distribution options for OpenReelio releases.

## Table of Contents

1. [Open Source Distribution (No OS Code Signing)](#open-source-distribution-no-os-code-signing)
2. [User Installation Guide](#user-installation-guide)
3. [Code Signing (Optional - When Funded)](#code-signing-optional---when-funded)
4. [GitHub Secrets Setup](#github-secrets-setup)
5. [Windows Code Signing](#windows-code-signing)
6. [macOS Code Signing & Notarization](#macos-code-signing--notarization)
7. [Tauri Updater Signing](#tauri-updater-signing)
8. [Release Process](#release-process)
9. [npm Distribution (CLI)](#npm-distribution-cli)
10. [Troubleshooting](#troubleshooting)

---

## Open Source Distribution (No OS Code Signing)

**OS code signing is optional for open source projects.** Windows Authenticode and Apple Developer ID certificates remove operating system warnings, but they are paid credentials and are not required for GitHub Releases distribution.

**Tauri updater signing is different and required.** The updater's minisign key pair is free, but release builds must be signed with `TAURI_SIGNING_PRIVATE_KEY` so installed apps can verify update artifacts.

### What Happens Without Signing?

| Platform    | User Experience                                  | User Action Required                                  |
| ----------- | ------------------------------------------------ | ----------------------------------------------------- |
| **Windows** | SmartScreen warning: "Windows protected your PC" | Click "More info" → "Run anyway"                      |
| **macOS**   | Gatekeeper blocks: "cannot be opened"            | Right-click → "Open" or System Preferences → Security |
| **Linux**   | No warning                                       | None                                                  |

### Recommended Approach for Open Source

1. **Ship without OS code signing** - Most users understand open source warnings
2. **Document bypass steps** - Clear instructions in README
3. **Keep Tauri updater signing enabled** - Required for automatic updates
4. **Add OS code signing later** - When funding/sponsorship is available

### Bundled Runtime Tools

Pre-built installers must include all non-user-installable runtime tools. The release workflow currently bundles and verifies:

| Tool           | Why it is bundled             | Verification               |
| -------------- | ----------------------------- | -------------------------- |
| FFmpeg         | Video/audio processing        | `ffmpeg -version`          |
| FFprobe        | Media metadata/probing        | `ffprobe -version`         |
| OpenReelio CLI | Local MCP/runtime integration | `openreelio-cli --version` |

Codex CLI is not bundled as a guaranteed runtime dependency. If a feature requires a Codex account or external Codex CLI, keep that feature optional or provide a first-party bundled runtime before making it part of the default install path.

Release CI prepares FFmpeg/FFprobe with `scripts/prepare-bundled-ffmpeg.mjs` before the Tauri bundle step, then verifies each binary. This avoids requiring users to install FFmpeg separately and avoids a duplicate Rust release build just to fetch runtime tools.

FFmpeg download sources live in a single manifest, `scripts/ffmpeg-sources.json`, shared by the release script and the `src-tauri/build.rs` dev auto-download path. Per target triple:

| Target                     | Provider                        | Fallback                | Checksum                    |
| -------------------------- | ------------------------------- | ----------------------- | --------------------------- |
| `x86_64-pc-windows-msvc`   | gyan.dev (release essentials)   | BtbN GitHub builds      | SHA-256 sidecar (both)      |
| `x86_64-apple-darwin`      | martin-riedl.de (amd64 release) | evermeet.cx             | SHA-256 sidecar (primary)   |
| `aarch64-apple-darwin`     | martin-riedl.de (arm64 release) | osxexperts.net          | SHA-256 sidecar (primary)   |
| `x86_64-unknown-linux-gnu` | johnvansickle.com (static)      | BtbN GitHub builds      | SHA-256 sidecar (fallback)  |

macOS installers ship architecture-native binaries: the `aarch64-apple-darwin` build bundles native arm64 FFmpeg/FFprobe instead of x86_64 builds running under Rosetta. Downloads with a checksum source are verified; URLs without one require `OPENREELIO_ALLOW_UNVERIFIED_FFMPEG=1` (set in the release workflow).

---

## User Installation Guide

Include these instructions in your README.md:

### Windows Installation

1. Download the `.msi` or `.exe` installer
2. When you see "Windows protected your PC":
   - Click **"More info"**
   - Click **"Run anyway"**
3. Follow the installation wizard

### macOS Installation

1. Download the `.dmg` file
2. If you see "cannot be opened because it is from an unidentified developer":
   - **Right-click** (or Ctrl+click) the app
   - Select **"Open"** from the menu
   - Click **"Open"** in the dialog
3. Or go to **System Preferences → Security & Privacy → General** and click "Open Anyway"

### Linux Installation

1. Download the `.AppImage` file
2. Make it executable: `chmod +x OpenReelio-*.AppImage`
3. Run: `./OpenReelio-*.AppImage`

---

## Code Signing (Optional - When Funded)

Code signing removes OS warnings and provides a more professional experience. Consider this when:

- You receive sponsorship/funding
- Enterprise users require signed binaries
- Download numbers increase significantly

### Cost Summary

| Item                         | Cost     | Frequency |
| ---------------------------- | -------- | --------- |
| Apple Developer Program      | $99      | Annual    |
| Windows Standard Certificate | $200-500 | Annual    |
| Windows EV Certificate       | $400-700 | Annual    |

**Minimum**: ~$300/year (Apple + Standard Windows)
**Recommended**: ~$500-800/year (Apple + EV Windows)

---

## Prerequisites (For Code Signing)

Before setting up code signing, ensure you have:

- Access to the OpenReelio GitHub repository with admin permissions
- Code signing certificates for Windows and/or macOS
- Apple Developer account (for macOS notarization)

---

## GitHub Secrets Setup

All sensitive signing credentials are stored as GitHub repository secrets. Navigate to:

**Settings > Secrets and variables > Actions > New repository secret**

### Required Secrets

| Secret Name                          | Description                                                                | Platform |
| ------------------------------------ | -------------------------------------------------------------------------- | -------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Tauri updater signing key; required for automatic updates                  | All      |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Tauri signing key password, if any                                         | All      |
| `WINDOWS_CERTIFICATE`                | Optional base64-encoded PFX certificate for OS code signing                | Windows  |
| `WINDOWS_CERTIFICATE_PASSWORD`       | Optional PFX certificate password                                          | Windows  |
| `WINDOWS_CERTIFICATE_NAME`           | Optional certificate subject name, e.g. `OpenReelio`                       | Windows  |
| `APPLE_CERTIFICATE`                  | Optional base64-encoded P12 certificate for OS code signing                | macOS    |
| `APPLE_CERTIFICATE_PASSWORD`         | Optional P12 certificate password                                          | macOS    |
| `APPLE_ID`                           | Optional Apple ID email for notarization                                   | macOS    |
| `APPLE_ID_PASSWORD`                  | Optional app-specific password from appleid.apple.com                      | macOS    |
| `APPLE_TEAM_ID`                      | Optional Apple Developer Team ID                                           | macOS    |
| `APPLE_SIGNING_IDENTITY`             | Optional certificate identity, e.g. `Developer ID Application: OpenReelio` | macOS    |

---

## Windows Code Signing

### Option 1: Standard Code Signing Certificate

1. **Purchase a Code Signing Certificate**
   - Providers: DigiCert, Sectigo, GlobalSign, Comodo
   - Standard certificates cost ~$200-500/year
   - EV certificates (~$400-700/year) provide instant SmartScreen reputation

2. **Export Certificate as PFX**

   ```powershell
   # Export from certificate store
   $cert = Get-ChildItem -Path Cert:\CurrentUser\My | Where-Object { $_.Subject -like "*OpenReelio*" }
   Export-PfxCertificate -Cert $cert -FilePath certificate.pfx -Password (ConvertTo-SecureString -String "your-password" -Force -AsPlainText)
   ```

3. **Convert to Base64**

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx")) | Set-Content certificate.txt
   ```

4. **Add to GitHub Secrets**
   - `WINDOWS_CERTIFICATE`: Content of certificate.txt
   - `WINDOWS_CERTIFICATE_PASSWORD`: Your PFX password
   - `WINDOWS_CERTIFICATE_NAME`: Certificate subject name

### Option 2: Azure Trusted Signing (Cloud-Based)

For organizations, consider Azure Trusted Signing:

- No hardware token required
- Integrates with GitHub Actions
- See: https://learn.microsoft.com/en-us/azure/trusted-signing/

---

## macOS Code Signing & Notarization

### 1. Obtain Developer ID Certificate

1. Join Apple Developer Program ($99/year)
2. Create a "Developer ID Application" certificate:
   - Open Keychain Access
   - Certificate Assistant > Request a Certificate from a Certificate Authority
   - Upload CSR to developer.apple.com
   - Download and install the certificate

### 2. Export Certificate as P12

```bash
# Export from Keychain Access or use command line
security export -k login.keychain-db -t identities -f pkcs12 -o certificate.p12 -P "your-password"
```

### 3. Convert to Base64

```bash
base64 -i certificate.p12 -o certificate.txt
```

### 4. Create App-Specific Password

1. Go to https://appleid.apple.com
2. Sign in and navigate to "App-Specific Passwords"
3. Generate a new password for "OpenReelio Notarization"

### 5. Add to GitHub Secrets

- `APPLE_CERTIFICATE`: Content of certificate.txt
- `APPLE_CERTIFICATE_PASSWORD`: Your P12 password
- `APPLE_ID`: Your Apple ID email
- `APPLE_ID_PASSWORD`: App-specific password from step 4
- `APPLE_TEAM_ID`: Your Team ID (found in developer.apple.com)
- `APPLE_SIGNING_IDENTITY`: "Developer ID Application: Your Name (TEAM_ID)"

---

## Tauri Updater Signing

The Tauri updater requires a separate signing key to verify update integrity.

### Generate Signing Key

```bash
# Generate a new key pair
npx tauri signer generate -w ~/.tauri/openreelio.key

# This creates:
# - ~/.tauri/openreelio.key (private key - KEEP SECRET)
# - ~/.tauri/openreelio.key.pub (public key - goes in tauri.conf.json)
```

### Configure tauri.conf.json

The public key is already configured in `src-tauri/tauri.conf.json`:

```json
{
  "plugins": {
    "updater": {
      "pubkey": "YOUR_PUBLIC_KEY_HERE",
      "endpoints": ["https://github.com/openreelio/openreelio/releases/latest/download/latest.json"]
    }
  }
}
```

### Add Private Key to GitHub Secrets

- `TAURI_SIGNING_PRIVATE_KEY`: Contents of ~/.tauri/openreelio.key
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: Password used when generating (if any)

---

## Release Process

### 1. Prepare Release

```bash
# Update package.json/package-lock.json without creating a tag yet
npm version patch --no-git-tag-version  # or minor, major

# Sync Cargo.toml and tauri.conf.json to package.json
npm run version:sync
npm run version:check

# Commit version bump
git add .
git commit -m "chore: bump version to x.x.x"
git push origin main
```

### 2. Create Release Tag

```bash
# Create and push a version tag that exactly matches package.json
git tag v0.1.0
git push origin v0.1.0
```

### 3. Automatic Build

The GitHub Actions workflow will automatically:

1. Verify the Git tag version matches `package.json`, `Cargo.toml`, and `tauri.conf.json`
2. Generate release notes from GitHub's release notes API, the raw commit history, and the contributor shortlog
3. Create a draft release
4. Attach the complete raw commit history as a release asset when the release body would exceed GitHub's body limit
5. Build for Windows, macOS (Intel + ARM), and Linux
6. Bundle and verify FFmpeg, FFprobe, and OpenReelio CLI in each installer
7. Enable Tauri updater artifact generation for the release build
8. Sign updater artifacts with the Tauri updater private key
9. Leave OS code signing/notarization optional for a later paid-certificate workflow
10. Generate the GitHub Releases `latest.json` updater manifest
11. Upload all artifacts to the release

### 4. Publish Release

1. Go to GitHub Releases
2. Review the draft release
3. Edit release notes
4. Click "Publish release"

---

## npm Distribution (CLI)

The headless CLI is also published to npm so agents and CI can reach it with a
single `npx openreelio-cli`. The installers are unaffected; this is a second
delivery path for the same binary.

### Published packages

| Package                        | Contents                                      |
| ------------------------------ | --------------------------------------------- |
| `openreelio-cli`               | Launcher only (`bin/openreelio-cli.mjs`)      |
| `@openreelio/cli-win32-x64`    | `x86_64-pc-windows-msvc` binary               |
| `@openreelio/cli-darwin-x64`   | `x86_64-apple-darwin` binary                  |
| `@openreelio/cli-darwin-arm64` | `aarch64-apple-darwin` binary                 |
| `@openreelio/cli-linux-x64`    | `x86_64-unknown-linux-gnu` binary             |

The shim lists all four platform packages as `optionalDependencies`; npm
installs only the one whose `os`/`cpu` matches the host, and the launcher
resolves its binary through `require.resolve`. `OPENREELIO_CLI_BINARY`
overrides that lookup with an explicit path.

### Why there is no postinstall download

npm v12 disables dependency lifecycle scripts by default, so the classic
"postinstall downloads a binary" pattern now fails silently for a growing share
of installs. The binary therefore has to arrive as package *content*. This is
the same shape esbuild, Biome and turbo use.

Consequences worth remembering:

- Neither the shim nor the platform packages define **any** install script.
- Platform packages declare no `bin` and no `exports` field: the shim owns the
  command name, and an `exports` map would block resolution of
  `@openreelio/cli-<platform>/package.json`.
- Installs that pass `--omit=optional` / `--no-optional` get a clear error
  naming the missing package instead of a mystery `ENOENT`.

**Known limitation:** Linux is glibc only. The release matrix builds no musl
target, so Alpine users must download a standalone archive and set
`OPENREELIO_CLI_BINARY`. Adding a musl package means adding a musl target to
`release.yml` first, then registering it in the generator's `TARGETS` table.

### Assets to packages: the flow

```
release.yml (build-tauri)
  └─ openreelio-cli-<version>-<triple>.zip|.tar.gz  + .sha256   (draft release)
release.yml (publish-release)
  └─ draft flipped to published -> download URLs resolve
npm-publish.yml (workflow_run: Release completed)
  ├─ gh release download 'openreelio-cli-*'
  ├─ sha256sum --check, then extract to dist/cli-assets/<triple>/
  ├─ node scripts/build-npm-platform-packages.mjs   (verifies .sha256 again,
  │    stamps versions, writes 4 platform packages + a stamped shim copy)
  ├─ npm publish each @openreelio/cli-* package
  └─ npm publish openreelio-cli
```

Platform packages are published **before** the shim, because the shim pins them
exactly.

Run the generator locally to inspect what would be published:

```bash
cargo build --release -p openreelio-cli
node scripts/build-npm-platform-packages.mjs \
  --only win32-x64 \
  --binary win32-x64=target/release/openreelio-cli.exe \
  --shim-out npm/platform-packages/generated/openreelio-cli
```

Generate the non-Windows packages on Linux or macOS: `npm pack` records the file
mode, and a Windows host cannot set the executable bit.

### Why npm publishing is a separate workflow

The platform packages embed assets from the release, which only become
downloadable once `publish-release` flips the draft. npm work must run strictly
afterwards.

The trigger is `workflow_run` on the **Release** workflow rather than
`release: published`, because GitHub does not start new workflow runs from
events raised with the built-in `GITHUB_TOKEN` — and `publish-release`
publishes the draft with exactly that token.

### Setup TODO (not done yet)

npm publishing is **inert until both steps below are completed**. Merging the
workflow cannot publish anything.

1. **Enable the workflow.** Create repository variable
   `NPM_PUBLISH_ENABLED = true` (Settings → Secrets and variables → Actions →
   Variables). Without it, the automatic path is skipped and a manual run
   refuses to publish (`dry_run: true` still packs and uploads tarballs as a
   build artifact, which is the safe way to inspect output).

2. **Set up authentication.** Preferred: **Trusted Publishing (OIDC)** — on
   npmjs.com, configure a GitHub Actions trusted publisher for each of the five
   packages, pointing at repository `openreelio/openreelio` and workflow
   `npm-publish.yml`. It needs npm ≥ 11.5.1 (the workflow installs it) and
   `id-token: write` (already granted), and attaches provenance automatically.

   Chicken-and-egg caveat: a trusted publisher can only be configured on a
   package that already exists, so the **first** publish of each package must
   use the fallback — an npm automation token stored as secret `NPM_TOKEN`. The
   workflow uses it only when present, so it can be deleted once trusted
   publishing is live.

### Version discipline

`npm/openreelio-cli/package.json` is a `version:check` target, so the shim
version is enforced against `package.json` in CI. `npm run version:sync` also
repins the shim's `@openreelio/*` `optionalDependencies` to the new version, and
the publish workflow re-stamps both the shim and the platform packages from the
release tag, so a published shim can never point at platform versions that were
never released.

---

## Troubleshooting

### Windows SmartScreen Warning

If users see SmartScreen warnings despite signing:

- Ensure using an EV certificate (provides instant reputation)
- Standard certificates require building reputation over time
- Users can click "More info" > "Run anyway"

### macOS Notarization Failures

Common issues:

- **Invalid credentials**: Verify Apple ID and app-specific password
- **Hardened runtime issues**: Check entitlements
- **Unsigned code**: Ensure all bundled binaries are signed

Check notarization status:

```bash
xcrun notarytool history --apple-id YOUR_APPLE_ID --password YOUR_PASSWORD --team-id YOUR_TEAM_ID
```

### Tauri Updater Not Working

1. Verify `latest.json` is accessible at the endpoint URL
2. Check that signatures (.sig files) were generated
3. Ensure the public key in `tauri.conf.json` matches the private key

### Certificate Expiration

Certificates typically expire after 1-3 years:

- Set calendar reminders before expiration
- Budget for renewal costs
- Have a plan for re-signing releases

---

## Cost Summary

| Item                          | Cost       | Frequency |
| ----------------------------- | ---------- | --------- |
| Apple Developer Program       | $99        | Annual    |
| Windows Standard Code Signing | $200-500   | Annual    |
| Windows EV Code Signing       | $400-700   | Annual    |
| Azure Trusted Signing         | ~$10/month | Monthly   |

**Minimum setup cost**: ~$300/year (Apple + Standard Windows)
**Recommended setup cost**: ~$500-800/year (Apple + EV Windows)

---

## Security Best Practices

1. **Never commit private keys** to the repository
2. **Rotate secrets** if they may have been exposed
3. **Use environment-specific keys** for development vs production
4. **Enable 2FA** on all developer accounts
5. **Audit secret access** regularly in GitHub settings
6. **Document key recovery** procedures for team continuity
