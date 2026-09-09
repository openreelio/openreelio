/**
 * Builds the bundled colour-emoji PNG pack under `src-tauri/emoji/`.
 *
 * Captions burn text with libass, which draws from a monochrome font. Anything
 * the renderer is asked to draw in colour — an emoji in a caption or a text
 * overlay — has to come from somewhere else, so the emoji are shipped as flat
 * RGBA rasters that the compositor can blend directly. That trades a font
 * dependency for a fixed, auditable set of bytes in the installer.
 *
 * The source is microsoft/fluentui-emoji (MIT), pinned to one commit so a
 * rebuild is reproducible: upstream reshapes its asset tree fairly often, and a
 * floating `main` would silently change both the artwork and the file count
 * between two builds of the same release.
 *
 * Only the base, skin-tone-neutral form of each emoji is packed. The Rust
 * resolver strips tone modifiers before it looks a sequence up, so the five
 * toned variants of every human emoji would be dead weight — they roughly
 * quadruple the pack for glyphs nothing ever reads.
 *
 * Sizing: captions draw an emoji at about 1.2x the font size in a 1080-tall
 * coordinate space, so a 48pt caption wants ~58px at 1080p and ~115px at 4K.
 * 128px covers 4K without upscaling; below 96px 4K captions visibly soften.
 * The whole directory is held under `--max-bytes` because it ships inside every
 * installer, which is why the rasters are palette-quantized rather than stored
 * as full-colour PNGs.
 *
 * Network: the tree listing and the asset files are downloaded from GitHub and
 * cached on disk, so the first run needs the network and later runs do not. The
 * cache is keyed by commit SHA; re-running is idempotent and rewrites the same
 * bytes. Pass `--cache <dir>` to keep it somewhere durable.
 *
 * Dependencies: `@resvg/resvg-js` (SVG rasterization) and `sharp` (palette
 * quantization). Both are large native binaries used only to build this pack,
 * so they are deliberately NOT repository dependencies. Install them into a
 * throwaway directory and point the script at it:
 *
 *   mkdir /tmp/emoji-deps && cd /tmp/emoji-deps && npm init -y
 *   npm i @resvg/resvg-js sharp
 *   node scripts/generate-emoji-pack.mjs --deps /tmp/emoji-deps
 *
 * Usage:
 *   node scripts/generate-emoji-pack.mjs --deps <dir>
 *   node scripts/generate-emoji-pack.mjs --deps <dir> --size 96
 *   node scripts/generate-emoji-pack.mjs --deps <dir> --sha <40-hex>
 *   node scripts/generate-emoji-pack.mjs --deps <dir> --check
 */

import { createRequire } from 'node:module';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Upstream commit the checked-in pack was built from.
 *
 * Bumping this is a deliberate act: it changes the artwork and can change which
 * emoji exist at all, so it belongs in its own commit with the regenerated pack.
 */
const SOURCE_COMMIT = '1ffb34c752ecf5d402f04cfb4b392c77f57c54bc';

/** Upstream repository, recorded in the manifest for provenance. */
const SOURCE_REPO = 'microsoft/fluentui-emoji';

/** Upstream licence, recorded in the manifest and copied to `LICENSE`. */
const SOURCE_LICENSE = 'MIT';

/** Upstream style directory. The flat vector set, as opposed to `3D` or `High Contrast`. */
const STYLE = 'Color';

/** Manifest schema version. Bump when the shape of `manifest.json` changes. */
const MANIFEST_VERSION = 1;

/** Edge length in pixels of each rendered PNG. See the sizing note above. */
const DEFAULT_PIXEL_SIZE = 128;

/** Smallest size worth shipping; below this, 4K captions visibly soften. */
const MIN_PIXEL_SIZE = 96;

/** Palette entries allowed per PNG. 256 is the most an 8-bit indexed PNG can hold. */
const DEFAULT_PALETTE_COLOURS = 256;

/** Ceiling on the whole output directory, because it ships in every installer. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** Parallel downloads. GitHub starts shedding requests well above this. */
const DEFAULT_CONCURRENCY = 16;

/** How long a single download may take before it is abandoned. */
const FETCH_TIMEOUT_MS = 30_000;

/** How many times a file is tried before the run fails. */
const FETCH_ATTEMPTS = 5;

/** Base delay for the retry backoff; multiplied by the attempt number. */
const FETCH_RETRY_DELAY_MS = 1_000;

/** Skin-tone directories, skipped wholesale. `Default` is the neutral yellow form. */
const SKIN_TONE_DIRECTORIES = new Set(['Dark', 'Light', 'Medium', 'Medium-Dark', 'Medium-Light']);

/**
 * The variation selector that only says "draw the previous character in colour".
 *
 * It carries no identity of its own, and upstream is inconsistent about whether
 * it appears in a `unicode` field, so it is dropped on both sides of the lookup
 * — here and in the Rust resolver — to keep the two in agreement.
 */
const VARIATION_SELECTOR_16 = 0xfe0f;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});

/** Parses the command line, builds the pack, and prints a summary. */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { rasterize, quantize } = await loadImageTools(options.depsDir);

  const outputDir = options.outputDir;
  const pngDir = path.join(outputDir, 'png');

  const tree = await loadTree(options);
  const assets = selectAssets(tree);
  console.error(`selected ${assets.length} assets from the ${STYLE} style`);

  await downloadAssets(assets, options);

  const { entries, skipped, collisions } = await resolveSequenceKeys(assets, options);
  reportResolution(entries, skipped, collisions);

  if (options.check) {
    await checkPack(entries, outputDir, pngDir, options);
    return;
  }

  await mkdir(pngDir, { recursive: true });
  const sizes = await renderAll(entries, pngDir, options, rasterize, quantize);
  await pruneStalePngs(entries, pngDir);

  await writeManifest(entries, outputDir, options);
  await writeLicense(outputDir, options);
  await writeReadme(entries, outputDir, options, skipped, collisions);

  await assertManifestMatchesDisk(outputDir, pngDir);
  await reportTotals(outputDir, pngDir, sizes, options);
}

/** Turns `process.argv` into a validated options object. */
function parseArguments(argv) {
  const options = {
    sha: SOURCE_COMMIT,
    pixelSize: DEFAULT_PIXEL_SIZE,
    colours: DEFAULT_PALETTE_COLOURS,
    maxBytes: DEFAULT_MAX_BYTES,
    concurrency: DEFAULT_CONCURRENCY,
    cacheDir: path.join(os.tmpdir(), 'openreelio-emoji-pack-cache'),
    outputDir: path.join(repoRoot, 'src-tauri', 'emoji'),
    depsDir: null,
    check: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };

    switch (flag) {
      case '--sha':
        options.sha = value();
        break;
      case '--size':
        options.pixelSize = Number.parseInt(value(), 10);
        break;
      case '--colours':
      case '--colors':
        options.colours = Number.parseInt(value(), 10);
        break;
      case '--max-bytes':
        options.maxBytes = Number.parseInt(value(), 10);
        break;
      case '--concurrency':
        options.concurrency = Number.parseInt(value(), 10);
        break;
      case '--cache':
        options.cacheDir = path.resolve(value());
        break;
      case '--out':
        options.outputDir = path.resolve(value());
        break;
      case '--deps':
        options.depsDir = path.resolve(value());
        break;
      case '--check':
        options.check = true;
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }

  if (!/^[0-9a-f]{40}$/.test(options.sha)) {
    throw new Error(`--sha must be a full 40-character commit SHA, got "${options.sha}"`);
  }
  if (!Number.isInteger(options.pixelSize) || options.pixelSize < MIN_PIXEL_SIZE) {
    throw new Error(`--size must be an integer of at least ${MIN_PIXEL_SIZE}`);
  }
  if (!Number.isInteger(options.colours) || options.colours < 2 || options.colours > 256) {
    throw new Error('--colours must be an integer between 2 and 256');
  }

  return options;
}

/**
 * Resolves the two native image libraries.
 *
 * They are looked up in `--deps` first so a throwaway install can satisfy them
 * without adding a multi-megabyte native dependency to the repository.
 */
async function loadImageTools(depsDir) {
  const load = async (name) => {
    const candidates = [];
    if (depsDir) {
      const require = createRequire(pathToFileURL(path.join(depsDir, 'resolve.cjs')));
      try {
        candidates.push(pathToFileURL(require.resolve(name)).href);
      } catch {
        // Fall through to plain resolution below.
      }
    }
    candidates.push(name);

    let lastError;
    for (const specifier of candidates) {
      try {
        return await import(specifier);
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `could not load "${name}" (${lastError?.message ?? 'unknown error'}).\n` +
        'Install the build-only dependencies into a throwaway directory and pass --deps:\n' +
        '  mkdir /tmp/emoji-deps && cd /tmp/emoji-deps && npm init -y && npm i @resvg/resvg-js sharp\n' +
        '  node scripts/generate-emoji-pack.mjs --deps /tmp/emoji-deps',
    );
  };

  const resvg = await load('@resvg/resvg-js');
  const sharpModule = await load('sharp');
  const sharp = sharpModule.default ?? sharpModule;
  const Resvg = resvg.Resvg ?? resvg.default?.Resvg;

  /**
   * Rasterizes one SVG buffer so its longest edge is exactly `size` pixels.
   *
   * Most upstream assets are a square `0 0 32 32` viewBox, but a handful are
   * not — the elephant, the bomb and seven others are taller or wider than they
   * are square. Fitting a fixed axis would stretch those; fitting the longer
   * edge scales every asset by its own aspect ratio and leaves the short axis
   * to be padded into the square below, so nothing is cropped or distorted.
   */
  const rasterize = (svg, size) => {
    const intrinsic = new Resvg(svg, { background: 'rgba(0,0,0,0)' });
    const mode = intrinsic.width >= intrinsic.height ? 'width' : 'height';
    return new Resvg(svg, { fitTo: { mode, value: size }, background: 'rgba(0,0,0,0)' })
      .render()
      .asPng();
  };

  /**
   * Pads to a centred square and re-encodes as a palette PNG.
   *
   * The pack is a lookup table the compositor blends at a fixed box size, so
   * every entry has to be the same square shape or the odd-aspect emoji would
   * land at the wrong scale. Padding is fully transparent, so it adds no ink.
   * Palette encoding is what brings the directory inside its size budget.
   */
  const quantize = async (png, colours, size) => {
    const { width, height } = await sharp(png).metadata();
    let pipeline = sharp(png);

    if (width !== size || height !== size) {
      const horizontal = size - width;
      const vertical = size - height;
      if (horizontal < 0 || vertical < 0) {
        throw new Error(`rasterized ${width}x${height} exceeds the ${size}px square`);
      }
      pipeline = pipeline.extend({
        top: Math.floor(vertical / 2),
        bottom: Math.ceil(vertical / 2),
        left: Math.floor(horizontal / 2),
        right: Math.ceil(horizontal / 2),
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      });
    }

    const out = await pipeline.png({ palette: true, colours, quality: 90, effort: 10 }).toBuffer();
    const final = await sharp(out).metadata();
    if (final.width !== size || final.height !== size) {
      throw new Error(`produced a ${final.width}x${final.height} PNG, expected ${size}x${size}`);
    }
    return out;
  };

  return { rasterize, quantize };
}

/** Loads the recursive git tree for the pinned commit, downloading it once. */
async function loadTree(options) {
  const cached = path.join(options.cacheDir, `tree-${options.sha}.json`);
  await mkdir(options.cacheDir, { recursive: true });

  try {
    const text = await readFile(cached, 'utf8');
    const tree = JSON.parse(text);
    if (tree.sha === options.sha && !tree.truncated) return tree;
  } catch {
    // Not cached yet, or unusable; fetch it below.
  }

  const url = `https://api.github.com/repos/${SOURCE_REPO}/git/trees/${options.sha}?recursive=1`;
  const body = await fetchWithRetry(url, { accept: 'application/vnd.github+json' });
  const tree = JSON.parse(body.toString('utf8'));

  if (tree.truncated) {
    throw new Error('GitHub truncated the tree listing; cannot enumerate assets reliably');
  }
  await writeFile(cached, JSON.stringify(tree));
  return tree;
}

/**
 * Picks the one neutral colour SVG for each asset that has metadata.
 *
 * Upstream splits assets in two: emoji that take no skin tone keep their SVG at
 * `<Name>/Color/`, while toneable ones nest it under `<Name>/Default/Color/`.
 * `Default` is the neutral yellow form, so it is the base the resolver falls
 * back to; the five named tone directories are dropped.
 */
function selectAssets(tree) {
  const blobs = tree.tree.filter((entry) => entry.type === 'blob');
  const metadataByName = new Map();
  const directSvg = new Map();
  const defaultSvg = new Map();

  for (const { path: filePath } of blobs) {
    const segments = filePath.split('/');
    if (segments[0] !== 'assets' || segments.length < 3) continue;
    const name = segments[1];

    if (segments.length === 3 && segments[2] === 'metadata.json') {
      metadataByName.set(name, filePath);
      continue;
    }
    if (!filePath.endsWith('.svg')) continue;

    if (segments.length === 4 && segments[2] === STYLE) {
      directSvg.set(name, filePath);
    } else if (segments.length === 5 && segments[3] === STYLE && !SKIN_TONE_DIRECTORIES.has(segments[2])) {
      if (segments[2] === 'Default') defaultSvg.set(name, filePath);
    }
  }

  const assets = [];
  for (const [name, metadataPath] of [...metadataByName].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const svgPath = directSvg.get(name) ?? defaultSvg.get(name);
    if (!svgPath) continue;
    assets.push({ name, metadataPath, svgPath });
  }
  return assets;
}

/** Downloads every metadata and SVG file that is not already cached. */
async function downloadAssets(assets, options) {
  const jobs = [];
  for (const asset of assets) {
    jobs.push(asset.metadataPath, asset.svgPath);
  }

  let done = 0;
  let downloaded = 0;
  await runPool(jobs, options.concurrency, async (repoPath) => {
    const target = cachePathFor(repoPath, options);
    if (!(await exists(target))) {
      const url = `https://raw.githubusercontent.com/${SOURCE_REPO}/${options.sha}/${encodePath(repoPath)}`;
      const body = await fetchWithRetry(url);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body);
      downloaded += 1;
    }
    done += 1;
    if (done % 250 === 0) console.error(`  fetched ${done}/${jobs.length}`);
  });

  console.error(`cache ready: ${jobs.length} files (${downloaded} downloaded, ${jobs.length - downloaded} already cached)`);
}

/** Maps a repository path to its location inside the SHA-keyed cache. */
function cachePathFor(repoPath, options) {
  return path.join(options.cacheDir, options.sha, ...repoPath.split('/'));
}

/** Percent-encodes each path segment so spaces and punctuation survive the URL. */
function encodePath(repoPath) {
  return repoPath.split('/').map(encodeURIComponent).join('/');
}

/**
 * Reads every cached metadata file and derives its sequence key.
 *
 * The key is the emoji's code point sequence with `FE0F` removed and each point
 * in minimal lowercase hex, joined by `-`. The Rust resolver builds the same
 * string from the text it is asked to draw, so this function and that one have
 * to stay in step.
 */
async function resolveSequenceKeys(assets, options) {
  const entries = new Map();
  const skipped = [];
  const collisions = [];

  for (const asset of assets) {
    const raw = await readFile(cachePathFor(asset.metadataPath, options), 'utf8');
    let metadata;
    try {
      metadata = JSON.parse(raw);
    } catch (error) {
      skipped.push({ name: asset.name, reason: `metadata is not valid JSON: ${error.message}` });
      continue;
    }

    if (typeof metadata.unicode !== 'string' || metadata.unicode.trim() === '') {
      skipped.push({ name: asset.name, reason: 'metadata has no "unicode" field' });
      continue;
    }

    let key;
    try {
      key = sequenceKey(metadata.unicode);
    } catch (error) {
      skipped.push({ name: asset.name, reason: error.message });
      continue;
    }
    if (key === '') {
      skipped.push({ name: asset.name, reason: `"${metadata.unicode}" is only variation selectors` });
      continue;
    }

    const existing = entries.get(key);
    if (existing) {
      collisions.push({ key, kept: existing.name, dropped: asset.name });
      continue;
    }
    entries.set(key, { key, name: asset.name, svgPath: asset.svgPath, unicode: metadata.unicode });
  }

  const sorted = [...entries.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { entries: sorted, skipped, collisions };
}

/**
 * Builds the lookup key for one `unicode` field.
 *
 * `"0031 fe0f 20e3"` becomes `"31-20e3"`, `"1f469 200d 1f4bb"` stays
 * `"1f469-200d-1f4bb"`: variation selectors go, leading zeros go, everything
 * else is preserved in order.
 */
function sequenceKey(unicode) {
  const points = unicode.trim().split(/\s+/);
  const kept = [];

  for (const point of points) {
    if (!/^[0-9a-fA-F]{1,6}$/.test(point)) {
      throw new Error(`"${unicode}" contains a non-hex code point "${point}"`);
    }
    const value = Number.parseInt(point, 16);
    if (value === VARIATION_SELECTOR_16) continue;
    kept.push(value.toString(16));
  }
  return kept.join('-');
}

/** Prints what was dropped while resolving keys, so nothing vanishes silently. */
function reportResolution(entries, skipped, collisions) {
  console.error(`resolved ${entries.length} sequence keys`);
  for (const { name, reason } of skipped) {
    console.error(`  skipped "${name}": ${reason}`);
  }
  for (const { key, kept, dropped } of collisions) {
    console.error(`  collision on "${key}": kept "${kept}", dropped "${dropped}"`);
  }
}

/** Rasterizes and quantizes every entry, returning the byte size of each PNG. */
async function renderAll(entries, pngDir, options, rasterize, quantize) {
  const sizes = new Map();
  let done = 0;

  await runPool(entries, options.concurrency, async (entry) => {
    const svg = await readFile(cachePathFor(entry.svgPath, options));
    const raster = rasterize(svg, options.pixelSize);
    const png = await quantize(raster, options.colours, options.pixelSize);
    await writeFile(path.join(pngDir, `${entry.key}.png`), png);
    sizes.set(entry.key, png.length);

    done += 1;
    if (done % 250 === 0) console.error(`  rendered ${done}/${entries.length}`);
  });

  console.error(`rendered ${entries.length} PNGs at ${options.pixelSize}px`);
  return sizes;
}

/**
 * Deletes PNGs left behind by an earlier run with a different asset set.
 *
 * Without this a rebuild after an upstream bump would leave orphans that the
 * manifest does not name, and the directory would only ever grow.
 */
async function pruneStalePngs(entries, pngDir) {
  const expected = new Set(entries.map((entry) => `${entry.key}.png`));
  const present = await readdir(pngDir);
  let removed = 0;

  for (const file of present) {
    if (!expected.has(file)) {
      await rm(path.join(pngDir, file));
      removed += 1;
    }
  }
  if (removed > 0) console.error(`pruned ${removed} stale PNG(s)`);
}

/**
 * Writes the sorted manifest with LF endings and a trailing newline.
 *
 * The JSON is assembled by hand rather than through `JSON.stringify` of an
 * object, because a JavaScript object does not preserve insertion order for
 * keys that look like array indices. Plenty of sequence keys are all decimal
 * digits — `2764` for a heart, `2708` for an aeroplane, `2795` for a plus — so
 * `JSON.stringify` would hoist exactly those to the front in numeric order and
 * silently emit an unsorted `entries` block.
 */
async function writeManifest(entries, outputDir, options) {
  const header = [
    ['version', MANIFEST_VERSION],
    ['source', SOURCE_REPO],
    ['sourceCommit', options.sha],
    ['license', SOURCE_LICENSE],
    ['style', STYLE],
    ['pixelSize', options.pixelSize],
  ].map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);

  const entryLines = entries.map(
    (entry, index) =>
      `    ${JSON.stringify(entry.key)}: ${JSON.stringify(`${entry.key}.png`)}` +
      (index === entries.length - 1 ? '' : ','),
  );

  const json = [
    '{',
    ...header,
    ...(entryLines.length > 0 ? ['  "entries": {', ...entryLines, '  }'] : ['  "entries": {}']),
    '}',
    '',
  ].join('\n');

  await writeFile(path.join(outputDir, 'manifest.json'), json, 'utf8');
}

/**
 * Reads the manifest's entry keys in the order they physically appear.
 *
 * `JSON.parse` reorders integer-like keys the same way `JSON.stringify` does, so
 * checking sortedness through the parsed object would compare a reordered list
 * against itself and always pass. The order has to come off the raw text.
 */
function entryKeyOrder(manifestText) {
  const block = manifestText.slice(manifestText.indexOf('"entries"'));
  return [...block.matchAll(/^ {4}"((?:[^"\\]|\\.)*)":/gm)].map((match) => JSON.parse(`"${match[1]}"`));
}

/** Copies the upstream licence text verbatim, because the pack redistributes their art. */
async function writeLicense(outputDir, options) {
  const url = `https://raw.githubusercontent.com/${SOURCE_REPO}/${options.sha}/LICENSE`;
  const cached = cachePathFor('LICENSE', options);
  let body;
  if (await exists(cached)) {
    body = await readFile(cached);
  } else {
    body = await fetchWithRetry(url);
    await mkdir(path.dirname(cached), { recursive: true });
    await writeFile(cached, body);
  }
  await writeFile(path.join(outputDir, 'LICENSE'), body);
}

/** Writes the human-facing note that explains where these bytes came from. */
async function writeReadme(entries, outputDir, options, skipped, collisions) {
  const keys = new Set(entries.map((entry) => entry.key));
  const hasFlag = [...keys].some((key) => /^1f1[ef][0-9a-f]-1f1[ef][0-9a-f]$/.test(key));
  const hasTagFlag = [...keys].some((key) => key.includes('e0067'));
  const hasKeycap = [...keys].some((key) => key.endsWith('-20e3'));
  const hasZwj = [...keys].some((key) => key.includes('200d'));

  const lines = [
    '# Bundled colour emoji',
    '',
    `Flat colour emoji rasters from [${SOURCE_REPO}](https://github.com/${SOURCE_REPO}),`,
    `${SOURCE_LICENSE} licensed (see \`LICENSE\`), pinned to commit \`${options.sha}\`.`,
    `Style \`${STYLE}\`; ${entries.length} PNGs at ${options.pixelSize}x${options.pixelSize}px, RGBA, palette-quantized.`,
    '',
    'libass draws captions from a monochrome font, so colour emoji are composited',
    'from these rasters instead. `manifest.json` maps a sequence key to its file:',
    'the emoji code points with `FE0F` dropped, each in minimal lowercase hex,',
    'joined by `-` (`1f600`, `31-20e3`, `1f469-200d-1f4bb`). The Rust resolver',
    'builds the same key, and strips skin-tone modifiers before it looks one up.',
    '',
    '## Coverage',
    '',
    `- Country flags (regional indicators, e.g. \`1f1f0-1f1f7\`): ${hasFlag ? 'included' : 'NOT included'}.`,
    ...(hasFlag
      ? []
      : [
          '  Upstream ships no country flags at all — only symbolic ones (chequered,',
          '  pirate, rainbow, white, black). A caption containing a country flag will',
          '  fall back to whatever the caption font can draw for it.',
        ]),
    `- Subdivision tag flags (England/Scotland/Wales): ${hasTagFlag ? 'included' : 'NOT included'}, for the same reason.`,
    `- Keycaps (\`31-20e3\`): ${hasKeycap ? 'included' : 'NOT included'}.`,
    `- ZWJ sequences (\`1f469-200d-1f4bb\`): ${hasZwj ? 'included' : 'NOT included'}.`,
    '- Skin-tone variants: NOT included by design. Only the neutral base form is',
    '  packed; the resolver strips tone modifiers and falls back to it.',
    ...(skipped.length > 0
      ? ['', `- ${skipped.length} upstream asset(s) skipped: ${skipped.map((s) => s.name).join(', ')}`]
      : []),
    ...(collisions.length > 0
      ? [`- ${collisions.length} sequence-key collision(s): ${collisions.map((c) => c.key).join(', ')}`]
      : []),
    '',
    '## Regenerating',
    '',
    'Everything here is generated. Do not edit by hand.',
    '',
    '```sh',
    'mkdir /tmp/emoji-deps && cd /tmp/emoji-deps && npm init -y && npm i @resvg/resvg-js sharp',
    'node scripts/generate-emoji-pack.mjs --deps /tmp/emoji-deps',
    '```',
    '',
    'The first run downloads from GitHub and caches by commit SHA; later runs are',
    'offline and rewrite identical bytes. `--check` verifies the pack without',
    'writing. Bumping the pinned commit changes the artwork and belongs in its own',
    'commit alongside the regenerated pack.',
    '',
  ];
  await writeFile(path.join(outputDir, 'README.md'), lines.join('\n'), 'utf8');
}

/**
 * Asserts the manifest and `png/` name exactly the same set of files.
 *
 * A manifest entry with no file renders as a missing glyph at export time, and a
 * file no entry names is dead weight nothing can reach; both are silent, so they
 * are checked rather than trusted.
 */
async function assertManifestMatchesDisk(outputDir, pngDir) {
  const manifestText = await readFile(path.join(outputDir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const named = new Set(Object.values(manifest.entries));
  const onDisk = new Set((await readdir(pngDir)).filter((file) => file.endsWith('.png')));

  const missing = [...named].filter((file) => !onDisk.has(file));
  const orphaned = [...onDisk].filter((file) => !named.has(file));

  if (missing.length > 0) {
    throw new Error(`${missing.length} manifest entries have no PNG: ${missing.slice(0, 5).join(', ')}`);
  }
  if (orphaned.length > 0) {
    throw new Error(`${orphaned.length} PNGs are not in the manifest: ${orphaned.slice(0, 5).join(', ')}`);
  }
  const keys = entryKeyOrder(manifestText);
  if (keys.length !== named.size) {
    throw new Error(`manifest text lists ${keys.length} entries but parses to ${named.size}`);
  }
  const sorted = [...keys].sort();
  if (keys.some((key, index) => key !== sorted[index])) {
    throw new Error('manifest entries are not sorted by key');
  }
  console.error(`verified ${named.size} entries against ${onDisk.size} files on disk`);
}

/** Re-runs the assertions against an already-built pack without writing anything. */
async function checkPack(entries, outputDir, pngDir, options) {
  await assertManifestMatchesDisk(outputDir, pngDir);
  const manifest = JSON.parse(await readFile(path.join(outputDir, 'manifest.json'), 'utf8'));

  if (manifest.sourceCommit !== options.sha) {
    throw new Error(`manifest pins ${manifest.sourceCommit}, expected ${options.sha}`);
  }
  if (manifest.pixelSize !== options.pixelSize) {
    throw new Error(`manifest says ${manifest.pixelSize}px, expected ${options.pixelSize}px`);
  }
  const expected = new Set(entries.map((entry) => entry.key));
  const actual = new Set(Object.keys(manifest.entries));
  if (expected.size !== actual.size || [...expected].some((key) => !actual.has(key))) {
    throw new Error('manifest does not match the assets at the pinned commit; regenerate');
  }
  console.error('pack is up to date');
}

/** Prints the size breakdown and fails the run if the pack outgrew its budget. */
async function reportTotals(outputDir, pngDir, sizes, options) {
  const values = [...sizes.values()].sort((a, b) => a - b);
  const pngTotal = values.reduce((sum, value) => sum + value, 0);
  const median = values.length % 2 === 1
    ? values[(values.length - 1) / 2]
    : Math.round((values[values.length / 2 - 1] + values[values.length / 2]) / 2);

  const others = {};
  for (const file of ['manifest.json', 'LICENSE', 'README.md']) {
    others[file] = (await stat(path.join(outputDir, file))).size;
  }
  const total = pngTotal + Object.values(others).reduce((sum, value) => sum + value, 0);

  console.error('');
  console.error(`png/          ${pngTotal} bytes across ${values.length} files`);
  for (const [file, size] of Object.entries(others)) {
    console.error(`${file.padEnd(14)}${size} bytes`);
  }
  console.error(`TOTAL         ${total} bytes (budget ${options.maxBytes})`);
  console.error(`per-PNG       min ${values[0]} / median ${median} / max ${values[values.length - 1]}`);

  if (total > options.maxBytes) {
    throw new Error(
      `pack is ${total - options.maxBytes} bytes over the ${options.maxBytes}-byte budget; ` +
        're-run with a smaller --size or --colours',
    );
  }
}

/** Runs `worker` over `items` with at most `limit` in flight at once. */
async function runPool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

/**
 * Fetches a URL, retrying on rate limits and transient failures.
 *
 * A pack build makes thousands of requests, so being shed once is expected
 * rather than exceptional; `Retry-After` is honoured when GitHub sends it.
 */
async function fetchWithRetry(url, { accept } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'user-agent': 'openreelio-emoji-pack-generator',
          ...(accept ? { accept } : {}),
        },
      });

      if (response.ok) {
        return Buffer.from(await response.arrayBuffer());
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
        const delay = Number.isFinite(retryAfter)
          ? retryAfter * 1_000
          : FETCH_RETRY_DELAY_MS * attempt * attempt;
        lastError = new Error(`HTTP ${response.status}`);
        await sleep(delay);
        continue;
      }
      throw new Error(`HTTP ${response.status} for ${url}`);
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_ATTEMPTS) await sleep(FETCH_RETRY_DELAY_MS * attempt);
    }
  }
  throw new Error(`failed to fetch ${url} after ${FETCH_ATTEMPTS} attempts: ${lastError?.message}`);
}

/** Resolves after `ms` milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when `target` exists on disk. */
async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
