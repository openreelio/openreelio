# Vendored Unicode emoji data

Inputs for `scripts/generate-emoji-tables.mjs`, which derives the property
tables baked into `src-tauri/src/core/text/emoji.rs`.

| File | Source |
| --- | --- |
| `emoji-data.txt` | <https://www.unicode.org/Public/16.0.0/ucd/emoji/emoji-data.txt> |
| `emoji-variation-sequences.txt` | <https://www.unicode.org/Public/16.0.0/ucd/emoji/emoji-variation-sequences.txt> |
| `VERSION` | The release the two files above were retrieved from. |

- **Unicode version:** 16.0.0
- **Retrieved:** 2026-09-09

These are byte-for-byte copies of what the Unicode Consortium published, kept
under their [terms of use](https://www.unicode.org/terms_of_use.html), with the
LF line endings the originals use. Do not edit them by hand.

## Why they are vendored

The generator used to download them on every run, so CI re-derived the tables
from unicode.org on every push and pull request. That made a third party a merge
gate: one transient 5xx there turned an unrelated pull request's lint job red.
Generation and `--check` now read these files off disk, which is both offline and
deterministic.

## Refreshing them

```bash
node scripts/generate-emoji-tables.mjs --fetch                  # same release
node scripts/generate-emoji-tables.mjs --fetch --version 17.0.0 # a new release
```

`--fetch` re-downloads both files into this directory (with a timeout and a
couple of retries, because it is interactive rather than a CI gate), rewrites
`VERSION`, and regenerates the Rust tables. Review the resulting diff — the data
files, `VERSION`, and `emoji.rs` — and commit it, then update the version and
retrieval date above. `--check` never touches the network.
