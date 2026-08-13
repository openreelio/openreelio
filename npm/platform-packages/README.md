# Platform packages (`@openreelio/cli-*`)

These packages are **generated, not committed**. Each one carries a single
prebuilt `openreelio-cli` binary for one release target, plus `os`/`cpu` fields
so npm installs exactly one of them per host. The `openreelio-cli` shim in
`../openreelio-cli` lists all four as `optionalDependencies` and resolves the
binary at run time.

The binaries only exist as release assets, so the packages are assembled during
the publish workflow by `scripts/build-npm-platform-packages.mjs` and written to
`generated/` (git-ignored).

| Package                        | `os`     | `cpu`   | Release target             | Archive  |
| ------------------------------ | -------- | ------- | -------------------------- | -------- |
| `@openreelio/cli-win32-x64`    | `win32`  | `x64`   | `x86_64-pc-windows-msvc`   | `.zip`   |
| `@openreelio/cli-darwin-x64`   | `darwin` | `x64`   | `x86_64-apple-darwin`      | `.tar.gz`|
| `@openreelio/cli-darwin-arm64` | `darwin` | `arm64` | `aarch64-apple-darwin`     | `.tar.gz`|
| `@openreelio/cli-linux-x64`    | `linux`  | `x64`   | `x86_64-unknown-linux-gnu` | `.tar.gz`|

## Known limitation: glibc only

There is no `linux-x64-musl` package. The release matrix builds
`x86_64-unknown-linux-gnu` only, so Alpine and other musl distributions must
download a standalone archive and point `OPENREELIO_CLI_BINARY` at it. Adding a
musl variant means adding a musl target to the release matrix first; the
generator's `TARGETS` table is then the single place to register it.

## Generating locally

```bash
# From a real local build (Windows example)
cargo build --release -p openreelio-cli
node scripts/build-npm-platform-packages.mjs \
  --only win32-x64 \
  --binary win32-x64=target/release/openreelio-cli.exe

# From downloaded release assets, verifying checksums
node scripts/build-npm-platform-packages.mjs \
  --version 0.1.10 \
  --input dist/cli-assets \
  --archives dist/cli-archives \
  --shim-out npm/platform-packages/generated/shim
```

`--input` expects the archives already unpacked, one directory per target
triple. `--archives` is optional and verifies each archive against its `.sha256`
sidecar before the package is written.

Generate the non-Windows packages on Linux or macOS: `npm pack` records the
file mode, and a Windows host cannot set the executable bit.

## Design notes

- **No install scripts anywhere.** npm v12 disables dependency lifecycle
  scripts by default, so a `postinstall` downloader would silently fail. The
  binary must arrive as package content.
- **No `bin` field in the platform packages.** Only the shim declares a command;
  a second `bin` entry would fight it for the same name.
- **No `exports` field either.** The shim resolves
  `@openreelio/cli-<platform>/package.json`, which an `exports` map would block.
