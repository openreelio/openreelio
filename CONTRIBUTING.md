# Contributing to OpenReelio

First off, thank you for considering contributing to OpenReelio! It's people like you that make OpenReelio such a great tool.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How Can I Contribute?](#how-can-i-contribute)
- [Style Guidelines](#style-guidelines)
- [Commit Messages](#commit-messages)
- [Pull Request Process](#pull-request-process)
- [Branch Naming Convention](#branch-naming-convention)

## Code of Conduct

This project and everyone participating in it is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to [junseo5.dev@gmail.com](mailto:junseo5.dev@gmail.com).

## Getting Started

### Prerequisites

- **Rust** 1.85+ ([rustup.rs](https://rustup.rs))
- **Node.js** 20+ ([nodejs.org](https://nodejs.org))
- **pnpm** 8+ (recommended) or npm
- **FFmpeg** 6+ (for video processing)

### Development Setup

1. **Fork the repository** on GitHub

2. **Clone your fork locally**
   ```bash
   git clone https://github.com/YOUR_USERNAME/openreelio.git
   cd openreelio
   ```

3. **Add upstream remote**
   ```bash
   git remote add upstream https://github.com/openreelio/openreelio.git
   ```

4. **Install dependencies**
   ```bash
   # Frontend dependencies
   pnpm install

   # Rust dependencies (automatic on first build)
   cd src-tauri && cargo fetch
   ```

5. **Run development server**
   ```bash
   pnpm tauri dev
   ```

6. **Run tests**
   ```bash
   # Frontend tests
   pnpm test

   # Rust tests
   cd src-tauri && cargo test
   ```

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates. When you create a bug report, include as many details as possible using our [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml).

**Great bug reports include:**
- A quick summary and/or background
- Steps to reproduce (be specific!)
- What you expected would happen
- What actually happens
- Screenshots/videos if applicable
- Environment details (OS, versions, etc.)

### Suggesting Features

Feature suggestions are tracked as GitHub issues. Create one using our [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml).

**Great feature requests include:**
- Clear, descriptive title
- Detailed description of the proposed feature
- Explanation of why this feature would be useful
- Possible implementation approach (optional)

### Your First Code Contribution

Unsure where to begin? Look for issues labeled:
- `good first issue` - Simple issues for newcomers
- `help wanted` - Issues that need community help
- `documentation` - Documentation improvements

### Pull Requests

1. **Create a branch** from `main`
2. **Make your changes** following our style guidelines
3. **Write/update tests** for your changes
4. **Run the test suite** and ensure all tests pass
5. **Submit a PR** to the `main` branch

## Style Guidelines

### Rust Code Style

- Follow the [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/)
- Use `cargo fmt` before committing
- Use `cargo clippy` and address all warnings
- Document all public APIs with doc comments
- Use `thiserror` for error types

```rust
/// Splits a clip at the specified timeline position.
///
/// # Arguments
/// * `clip_id` - The ID of the clip to split
/// * `at_sec` - Timeline position in seconds
///
/// # Errors
/// Returns `CoreError::ClipNotFound` if the clip doesn't exist
/// Returns `CoreError::InvalidSplitPoint` if position is outside clip bounds
pub fn split_clip(&mut self, clip_id: &str, at_sec: f64) -> CoreResult<SplitResult> {
    // implementation
}
```

### TypeScript/React Code Style

- Use TypeScript strict mode
- Follow React best practices and hooks guidelines
- Use functional components with hooks
- Prefer named exports over default exports
- Use Tailwind CSS for styling

```typescript
// Good
export function ClipComponent({ clip, onSelect }: ClipProps) {
  const [isHovered, setIsHovered] = useState(false);
  // ...
}

// Avoid
export default function(props) {
  // ...
}
```

### Testing Guidelines

- Write tests for all new features
- Maintain or improve test coverage
- Use descriptive test names

```rust
#[test]
fn split_clip_at_middle_creates_two_clips() {
    // Arrange
    let mut state = create_state_with_10sec_clip();

    // Act
    let result = state.split_clip("clip_1", 5.0);

    // Assert
    assert!(result.is_ok());
    assert_eq!(state.clips().len(), 2);
}
```

```typescript
describe('Timeline', () => {
  it('should select clip when clicked', async () => {
    // Arrange
    render(<Timeline />);

    // Act
    await userEvent.click(screen.getByTestId('clip-1'));

    // Assert
    expect(screen.getByTestId('clip-1')).toHaveClass('selected');
  });
});
```

## Commit Messages

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification.

### Format

```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

### Types

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only changes |
| `style` | Code style changes (formatting, semicolons, etc.) |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `build` | Build system or external dependency changes |
| `ci` | CI configuration changes |
| `chore` | Other changes that don't modify src or test files |

### Scopes

| Scope | Description |
|-------|-------------|
| `core` | Rust core engine |
| `ui` | React frontend |
| `timeline` | Timeline components |
| `preview` | Preview player |
| `plugin` | Plugin system |
| `ai` | AI integration |
| `qc` | QC automation |
| `ipc` | Tauri IPC layer |

### Examples

```
feat(timeline): add multi-clip selection with shift+click

fix(core): prevent crash when splitting clip at boundary

docs(api): update command reference for v2.0

refactor(ui): extract timeline zoom logic into custom hook

test(qc): add unit tests for AudioPeakRule
```

## Pull Request Process

### Before Submitting

1. **Sync with upstream**
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. **Run all checks**
   ```bash
   pnpm test
   pnpm lint
   cd src-tauri && cargo test && cargo clippy
   ```

3. **Update documentation** if needed

### PR Requirements

- [ ] PR targets the `main` branch
- [ ] All tests pass
- [ ] Code follows style guidelines
- [ ] Commit messages follow conventions
- [ ] Documentation updated if needed
- [ ] PR description clearly describes changes
- [ ] Related issue linked (if applicable)

### Review Process

1. **Automated checks** must pass (CI/CD)
2. **Code review** by at least one maintainer
3. **Changes requested** should be addressed promptly
4. **Approval** from maintainer(s)
5. **Merge** by maintainer (squash merge for feature branches)

## Branch Naming Convention

```
<type>/<issue-number>-<short-description>
```

### Examples

```
feat/123-multi-clip-selection
fix/456-timeline-scroll-bug
docs/789-api-documentation
refactor/101-extract-zoom-hook
```

### Protected Branches

| Branch | Purpose | Protection |
|--------|---------|------------|
| `main` | Default branch | Requires PR, approvals, passing CI |

## Release Process

1. Features are merged to `main`
2. Tags are created on `main` following semver
4. GitHub Actions builds and publishes releases

## Questions?

Feel free to:
- Open a [Discussion](https://github.com/openreelio/openreelio/discussions)
- Ask in issues with the `question` label
- Reach out to maintainers

---

Thank you for contributing to OpenReelio!
