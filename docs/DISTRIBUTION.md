# Distribution & Code Signing Guide

This document explains distribution options for OpenReelio releases.

## Table of Contents

1. [Open Source Distribution (No Signing)](#open-source-distribution-no-signing)
2. [User Installation Guide](#user-installation-guide)
3. [Code Signing (Optional - When Funded)](#code-signing-optional---when-funded)
4. [GitHub Secrets Setup](#github-secrets-setup)
5. [Windows Code Signing](#windows-code-signing)
6. [macOS Code Signing & Notarization](#macos-code-signing--notarization)
7. [Tauri Updater Signing](#tauri-updater-signing)
8. [Release Process](#release-process)
9. [Troubleshooting](#troubleshooting)

---

## Open Source Distribution (No Signing)

**Code signing is OPTIONAL for open source projects.** Many popular open source applications distribute without code signing, including early versions of VS Code, Obsidian, and most Electron/Tauri apps.

### What Happens Without Signing?

| Platform | User Experience | User Action Required |
|----------|-----------------|---------------------|
| **Windows** | SmartScreen warning: "Windows protected your PC" | Click "More info" → "Run anyway" |
| **macOS** | Gatekeeper blocks: "cannot be opened" | Right-click → "Open" or System Preferences → Security |
| **Linux** | No warning | None |

### Recommended Approach for Open Source

1. **Ship without signing** - Most users understand open source warnings
2. **Document bypass steps** - Clear instructions in README
3. **Add signing later** - When funding/sponsorship is available

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

| Item | Cost | Frequency |
|------|------|-----------|
| Apple Developer Program | $99 | Annual |
| Windows Standard Certificate | $200-500 | Annual |
| Windows EV Certificate | $400-700 | Annual |

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

| Secret Name | Description | Platform |
|-------------|-------------|----------|
| `WINDOWS_CERTIFICATE` | Base64-encoded PFX certificate | Windows |
| `WINDOWS_CERTIFICATE_PASSWORD` | PFX certificate password | Windows |
| `WINDOWS_CERTIFICATE_NAME` | Certificate subject name (e.g., "OpenReelio") | Windows |
| `APPLE_CERTIFICATE` | Base64-encoded P12 certificate | macOS |
| `APPLE_CERTIFICATE_PASSWORD` | P12 certificate password | macOS |
| `APPLE_ID` | Apple ID email for notarization | macOS |
| `APPLE_ID_PASSWORD` | App-specific password (from appleid.apple.com) | macOS |
| `APPLE_TEAM_ID` | Apple Developer Team ID | macOS |
| `APPLE_SIGNING_IDENTITY` | Certificate identity (e.g., "Developer ID Application: OpenReelio") | macOS |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater signing key | All |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Tauri signing key password (if any) | All |

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
      "endpoints": [
        "https://github.com/openreelio/openreelio/releases/latest/download/latest.json"
      ]
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
# Update version in package.json and tauri.conf.json
npm version patch  # or minor, major

# Commit version bump
git add .
git commit -m "chore: bump version to x.x.x"
git push origin main
```

### 2. Create Release Tag

```bash
# Create and push a version tag
git tag v0.1.0
git push origin v0.1.0
```

### 3. Automatic Build

The GitHub Actions workflow will automatically:
1. Create a draft release
2. Build for Windows, macOS (Intel + ARM), and Linux
3. Sign Windows and macOS builds
4. Notarize macOS builds
5. Generate update manifest (latest.json)
6. Upload all artifacts to the release

### 4. Publish Release

1. Go to GitHub Releases
2. Review the draft release
3. Edit release notes
4. Click "Publish release"

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

| Item | Cost | Frequency |
|------|------|-----------|
| Apple Developer Program | $99 | Annual |
| Windows Standard Code Signing | $200-500 | Annual |
| Windows EV Code Signing | $400-700 | Annual |
| Azure Trusted Signing | ~$10/month | Monthly |

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
