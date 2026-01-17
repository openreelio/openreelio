# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take the security of OpenReelio seriously. If you believe you have found a security vulnerability, please report it to us as described below.

### Please Do

- **Report privately**: Email security vulnerabilities to [junseo5.dev@gmail.com](mailto:junseo5.dev@gmail.com)
- **Provide details**: Include steps to reproduce, potential impact, and any suggested fixes
- **Allow time**: Give us reasonable time to address the issue before public disclosure
- **Act in good faith**: Avoid accessing or modifying other users' data

### Please Don't

- Open public GitHub issues for security vulnerabilities
- Access data that doesn't belong to you
- Perform actions that could harm the service or other users

## What to Include

When reporting a vulnerability, please include:

1. **Description** of the vulnerability
2. **Steps to reproduce** the issue
3. **Potential impact** of the vulnerability
4. **Affected versions** (if known)
5. **Suggested fix** (if any)

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Resolution timeline**: Depends on severity, typically 30-90 days

## Security Measures

### Application Security

- **Plugin Sandboxing**: WASM plugins run in isolated sandboxes with fuel metering
- **Permission System**: Granular permissions for file, network, and model access
- **Input Validation**: All user inputs are validated and sanitized

### Data Security

- **Local-first**: All project data stored locally by default
- **API Key Storage**: Sensitive credentials stored in OS keychain
- **No Telemetry**: No data collected without explicit consent

### Dependency Security

- Regular dependency audits with `cargo audit` and `npm audit`
- Automated security updates via Dependabot
- Pinned dependency versions in lock files

## Security-Related Configuration

### Environment Variables

Never commit these to version control:
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- Any other API credentials

### Recommended `.env` Setup

```bash
# .env.local (never commit this file)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

## Acknowledgments

We appreciate security researchers who help keep OpenReelio safe. Contributors who report valid security issues will be acknowledged here (with permission).

---

Thank you for helping keep OpenReelio and our users safe!
