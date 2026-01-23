# Code Signing Guide

This document explains how to set up code signing for OpenReelio releases.

## Overview

Code signing is essential for:
- **Windows**: Prevents SmartScreen warnings and establishes trust
- **macOS**: Required for Gatekeeper approval and distribution outside the App Store

## Required Secrets

Configure these secrets in your GitHub repository settings (`Settings > Secrets and variables > Actions`):

### Windows Authenticode Signing

| Secret Name | Description |
|-------------|-------------|
| `WINDOWS_CERTIFICATE` | Base64-encoded PFX certificate file |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password for the PFX file |
| `WINDOWS_CERTIFICATE_NAME` | Certificate subject name (e.g., "OpenReelio") |

### macOS Notarization

| Secret Name | Description |
|-------------|-------------|
| `APPLE_CERTIFICATE` | Base64-encoded P12 certificate file |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the P12 file |
| `APPLE_ID` | Apple ID email address |
| `APPLE_ID_PASSWORD` | App-specific password (not your Apple ID password) |
| `APPLE_TEAM_ID` | Apple Developer Team ID (10-character string) |
| `APPLE_SIGNING_IDENTITY` | Full certificate name (e.g., "Developer ID Application: OpenReelio (TEAMID)") |

## Setup Instructions

### Windows Code Signing

1. **Obtain a Code Signing Certificate**
   - Purchase from a Certificate Authority (DigiCert, Sectigo, GlobalSign, etc.)
   - EV (Extended Validation) certificates provide immediate SmartScreen trust
   - Standard certificates require reputation building

2. **Export as PFX**
   ```powershell
   # Export from Windows Certificate Store
   $cert = Get-ChildItem -Path Cert:\CurrentUser\My | Where-Object { $_.Subject -like "*OpenReelio*" }
   $password = ConvertTo-SecureString -String "YourPassword" -Force -AsPlainText
   Export-PfxCertificate -Cert $cert -FilePath "certificate.pfx" -Password $password
   ```

3. **Encode to Base64**
   ```powershell
   $bytes = [System.IO.File]::ReadAllBytes("certificate.pfx")
   $base64 = [System.Convert]::ToBase64String($bytes)
   Set-Content -Path "certificate.b64" -Value $base64
   ```

4. **Add to GitHub Secrets**
   - Copy the contents of `certificate.b64` to `WINDOWS_CERTIFICATE`
   - Set `WINDOWS_CERTIFICATE_PASSWORD` to your PFX password
   - Set `WINDOWS_CERTIFICATE_NAME` to the certificate subject name

### macOS Notarization

1. **Apple Developer Account**
   - Join the Apple Developer Program ($99/year)
   - Create a "Developer ID Application" certificate

2. **Export Certificate**
   ```bash
   # Open Keychain Access
   # Export your "Developer ID Application" certificate as .p12
   ```

3. **Create App-Specific Password**
   - Go to https://appleid.apple.com
   - Sign in and go to Security > App-Specific Passwords
   - Generate a new password for "OpenReelio Notarization"

4. **Find Your Team ID**
   - Go to https://developer.apple.com/account
   - Your Team ID is displayed in the top right (10-character string)

5. **Encode Certificate to Base64**
   ```bash
   base64 -i certificate.p12 -o certificate.b64
   ```

6. **Add to GitHub Secrets**
   - Copy the contents of `certificate.b64` to `APPLE_CERTIFICATE`
   - Set `APPLE_CERTIFICATE_PASSWORD` to your P12 password
   - Set `APPLE_ID` to your Apple ID email
   - Set `APPLE_ID_PASSWORD` to the app-specific password
   - Set `APPLE_TEAM_ID` to your 10-character Team ID
   - Set `APPLE_SIGNING_IDENTITY` to the full certificate name

## Verification

### Windows

After signing, verify with:
```powershell
# Check signature
signtool verify /pa /v "OpenReelio-setup.exe"

# Or use Windows Explorer
# Right-click the file > Properties > Digital Signatures tab
```

### macOS

After notarization, verify with:
```bash
# Check signature
codesign -vvv --deep --strict OpenReelio.app

# Check notarization
spctl -a -vvv OpenReelio.app

# Check DMG
spctl -a -vvv --type install OpenReelio.dmg
```

## Troubleshooting

### Windows

**"Certificate not found" error**
- Ensure the certificate is imported to `Cert:\CurrentUser\My`
- Check that `WINDOWS_CERTIFICATE_NAME` matches the certificate subject

**SmartScreen still shows warning**
- EV certificates get immediate trust
- Standard certificates require reputation building (downloads from many users)

### macOS

**"Unable to upload to notarization service"**
- Check your Apple ID credentials
- Ensure the app-specific password is correct
- Verify your Apple Developer account is in good standing

**"The signature is invalid"**
- Ensure the certificate is "Developer ID Application" (not Mac Developer)
- Check that the Team ID matches your certificate

**"The notarization service reported issues"**
- Run `xcrun notarytool log <submission-id>` for details
- Common issues: hardened runtime not enabled, unsigned nested code

## Cost Estimates

| Item | Cost |
|------|------|
| Windows Code Signing (Standard) | ~$200-500/year |
| Windows Code Signing (EV) | ~$300-700/year |
| Apple Developer Program | $99/year |

## Security Best Practices

1. **Never commit certificates to version control**
2. **Use strong passwords for certificate files**
3. **Rotate certificates before expiration**
4. **Store backup copies of certificates securely**
5. **Limit access to GitHub secrets**
6. **Use EV certificates for Windows if budget allows**

## Release Workflow

The release workflow (`.github/workflows/release.yml`) automatically:

1. Imports certificates from GitHub secrets
2. Builds the application
3. Signs Windows executables with Authenticode
4. Signs and notarizes macOS applications
5. Uploads signed artifacts to the GitHub release

No manual intervention is required once secrets are configured.
