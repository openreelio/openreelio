# Bundled colour emoji

Flat colour emoji rasters from [microsoft/fluentui-emoji](https://github.com/microsoft/fluentui-emoji),
MIT licensed (see `LICENSE`), pinned to commit `1ffb34c752ecf5d402f04cfb4b392c77f57c54bc`.
Style `Color`; 1595 PNGs at 128x128px, RGBA, palette-quantized.

libass draws captions from a monochrome font, so colour emoji are composited
from these rasters instead. `manifest.json` maps a sequence key to its file:
the emoji code points with `FE0F` dropped, each in minimal lowercase hex,
joined by `-` (`1f600`, `31-20e3`, `1f469-200d-1f4bb`). The Rust resolver
builds the same key, and strips skin-tone modifiers before it looks one up.

## Coverage

- Country flags (regional indicators, e.g. `1f1f0-1f1f7`): NOT included.
  Upstream ships no country flags at all — only symbolic ones (chequered,
  pirate, rainbow, white, black). A caption containing a country flag will
  fall back to whatever the caption font can draw for it.
- Subdivision tag flags (England/Scotland/Wales): NOT included, for the same reason.
- Keycaps (`31-20e3`): included.
- ZWJ sequences (`1f469-200d-1f4bb`): included.
- Skin-tone variants: NOT included by design. Only the neutral base form is
  packed; the resolver strips tone modifiers and falls back to it.

## Regenerating

Everything here is generated. Do not edit by hand.

```sh
mkdir /tmp/emoji-deps && cd /tmp/emoji-deps && npm init -y && npm i @resvg/resvg-js sharp
node scripts/generate-emoji-pack.mjs --deps /tmp/emoji-deps
```

The first run downloads from GitHub and caches by commit SHA; later runs are
offline and rewrite identical bytes. `--check` verifies the pack without
writing. Bumping the pinned commit changes the artwork and belongs in its own
commit alongside the regenerated pack.
