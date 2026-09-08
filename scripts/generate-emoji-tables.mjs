/**
 * Regenerates the Unicode emoji property tables in
 * `src-tauri/src/core/text/emoji.rs`.
 *
 * The QC burn-in check has to know which code points a font is expected to draw
 * as emoji, and Rust has no such table in the standard library. Rather than take
 * a dependency on an unmaintained crate, the three derived tables the check
 * needs — `Emoji` and `Emoji_Presentation` from `emoji-data.txt`, and the bases
 * that have a text-style variation sequence from `emoji-variation-sequences.txt`
 * — are baked in as sorted, inclusive code-point ranges, generated from the
 * Unicode Consortium's own data files so they can be re-derived instead of
 * hand-audited.
 *
 * The version constant is emitted with them, inside the same markers, so
 * `--version` moves the tables and the release they claim to be together.
 *
 * The inputs are vendored under `scripts/unicode-data/`, and generation reads
 * them off disk. Deriving them from a live unicode.org download instead made a
 * third party a merge gate: a transient 5xx there turned an unrelated pull
 * request's lint job red. Refreshing the vendored copies is an explicit,
 * interactive `--fetch`; everything else — generation and `--check` alike — is
 * offline and deterministic.
 *
 * Usage:
 *   node scripts/generate-emoji-tables.mjs            # rewrite the tables in place
 *   node scripts/generate-emoji-tables.mjs --check     # fail if they are stale
 *   node scripts/generate-emoji-tables.mjs --fetch     # refresh the vendored data first
 *   node scripts/generate-emoji-tables.mjs --fetch --version 17.0.0
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Unicode release assumed when the vendored data carries no version marker. */
const DEFAULT_UNICODE_VERSION = '16.0.0';

/** How long one `--fetch` request may take before it is abandoned. */
const FETCH_TIMEOUT_MS = 30_000;

/** How many times `--fetch` tries a file before giving up. */
const FETCH_ATTEMPTS = 3;

/** Base delay between `--fetch` retries; multiplied by the attempt number. */
const FETCH_RETRY_DELAY_MS = 1_000;

/** Properties read out of `emoji-data.txt`, in the order they are emitted. */
const PROPERTIES = [
  {
    property: 'Emoji',
    constName: 'EMOJI_RANGES',
    doc: [
      'Code points with the Unicode `Emoji` property.',
      '',
      'Membership alone says nothing about how a character is drawn: most of',
      'this set is text-default (`#`, `1`, `\u{2764}`) and renders correctly as an',
      'ordinary glyph. It is the gate for the *sequences* — a variation',
      'selector, a keycap, a ZWJ join — that turn one of these into a picture.',
    ],
  },
  {
    property: 'Emoji_Presentation',
    constName: 'EMOJI_PRESENTATION_RANGES',
    doc: [
      'Code points with the Unicode `Emoji_Presentation` property.',
      '',
      'These default to the colour picture with no variation selector asked for,',
      'which is exactly the set a monochrome burn-in cannot honour.',
    ],
  },
];

/** The table derived from `emoji-variation-sequences.txt`. */
const TEXT_VARIATION_BASES = {
  constName: 'TEXT_VARIATION_BASES',
  doc: [
    'Code points that have a text-style (`U+FE0E`) variation sequence.',
    '',
    'Only a base listed here can be asked for monochrome: a variation selector',
    'is honoured for the sequences Unicode actually defines, and a renderer',
    'ignores an `FE0E` it has no sequence for and draws the colour emoji anyway.',
    'Treating any `FE0E` as a request for text presentation therefore silenced',
    'the check on exactly the strings an agent produces when it "repairs" a',
    'finding by appending the selector.',
  ],
};

const BEGIN_MARKER = '// BEGIN GENERATED EMOJI TABLES';
const END_MARKER = '// END GENERATED EMOJI TABLES';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const targetPath = path.join(repoRoot, 'src-tauri', 'src', 'core', 'text', 'emoji.rs');
const dataDir = path.join(scriptDir, 'unicode-data');
const versionPath = path.join(dataDir, 'VERSION');

/** The vendored inputs, keyed by the file name they carry upstream. */
const DATA_FILES = {
  emojiData: 'emoji-data.txt',
  variationSequences: 'emoji-variation-sequences.txt',
};

try {
  await main();
} catch (error) {
  // A misuse of the flags and a missing vendored file are both ordinary,
  // actionable outcomes; a stack trace only buries the sentence that says what
  // to do about them.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

/** Parses the command line, refreshes the data if asked, and writes or checks. */
async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const shouldFetch = args.includes('--fetch') || args.includes('--update-data');
  const versionIndex = args.indexOf('--version');
  const requestedVersion = versionIndex >= 0 ? args[versionIndex + 1] : undefined;

  if (versionIndex >= 0 && !requestedVersion) {
    throw new Error('--version needs a release, e.g. `--version 17.0.0`');
  }
  if (checkOnly && shouldFetch) {
    throw new Error('--check is offline by design; drop --fetch or drop --check');
  }

  const vendoredVersion = await readVendoredVersion();

  if (requestedVersion && !shouldFetch && requestedVersion !== vendoredVersion) {
    throw new Error(
      `Vendored data under ${path.relative(repoRoot, dataDir)} is Unicode ${vendoredVersion}, ` +
        `not ${requestedVersion}. Re-run with \`--fetch --version ${requestedVersion}\` to ` +
        'refresh it, so the emitted version constant and the data it names stay together.',
    );
  }

  const unicodeVersion = shouldFetch
    ? (requestedVersion ?? vendoredVersion)
    : vendoredVersion;
  const urls = dataUrls(unicodeVersion);

  if (shouldFetch) {
    await refreshVendoredData(urls, unicodeVersion);
  }

  const emojiData = await readVendoredFile(DATA_FILES.emojiData);
  const variationSequences = await readVendoredFile(DATA_FILES.variationSequences);
  const generated = renderTables(emojiData, variationSequences, unicodeVersion, urls);

  const current = await readFile(targetPath, 'utf8');
  const begin = current.indexOf(BEGIN_MARKER);
  const end = current.indexOf(END_MARKER);
  if (begin < 0 || end < 0) {
    throw new Error(`Markers ${BEGIN_MARKER} / ${END_MARKER} not found in ${targetPath}`);
  }

  const updated = current.slice(0, begin) + generated + current.slice(end + END_MARKER.length);

  if (updated === current) {
    console.log(`Emoji tables are up to date with Unicode ${unicodeVersion}.`);
    return;
  }

  if (checkOnly) {
    console.error(
      `Emoji tables in ${path.relative(repoRoot, targetPath)} are stale. ` +
        'Run `node scripts/generate-emoji-tables.mjs`.',
    );
    process.exitCode = 1;
    return;
  }

  await writeFile(targetPath, updated, 'utf8');
  console.log(
    `Wrote emoji tables from Unicode ${unicodeVersion} to ${path.relative(repoRoot, targetPath)}.`,
  );
}

/** The upstream URLs one Unicode release publishes its emoji data at. */
function dataUrls(unicodeVersion) {
  const base = `https://www.unicode.org/Public/${unicodeVersion}/ucd/emoji`;
  return {
    emojiData: `${base}/${DATA_FILES.emojiData}`,
    variationSequences: `${base}/${DATA_FILES.variationSequences}`,
  };
}

/** The Unicode release the vendored inputs were retrieved from. */
async function readVendoredVersion() {
  try {
    const marker = await readFile(versionPath, 'utf8');
    const version = marker.trim();
    if (version) return version;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return DEFAULT_UNICODE_VERSION;
}

/** Reads one vendored input, pointing at `--fetch` when it is missing. */
async function readVendoredFile(name) {
  const file = path.join(dataDir, name);
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `Vendored Unicode input ${path.relative(repoRoot, file)} is missing. ` +
          'Run `node scripts/generate-emoji-tables.mjs --fetch` to download it.',
      );
    }
    throw error;
  }
}

/**
 * Re-downloads the vendored inputs from unicode.org.
 *
 * The only code path that touches the network, and it is never taken by CI: a
 * refresh is something a person does on purpose, reviews as a diff, and commits.
 * Written with the LF the upstream files use so a refresh on Windows does not
 * churn every line.
 */
async function refreshVendoredData(urls, unicodeVersion) {
  await mkdir(dataDir, { recursive: true });

  for (const [key, name] of Object.entries(DATA_FILES)) {
    const text = await fetchUnicodeFile(urls[key]);
    await writeFile(path.join(dataDir, name), text.replace(/\r\n/g, '\n'), 'utf8');
    console.log(`Fetched ${name} from ${urls[key]}`);
  }

  await writeFile(versionPath, `${unicodeVersion}\n`, 'utf8');
}

/** Downloads one Unicode data file, with a timeout and a couple of retries. */
async function fetchUnicodeFile(url) {
  let lastError;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`GET ${url} failed with ${response.status} ${response.statusText}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_ATTEMPTS) {
        console.warn(`GET ${url} failed (attempt ${attempt}/${FETCH_ATTEMPTS}): ${error.message}`);
        await delay(attempt * FETCH_RETRY_DELAY_MS);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

/** Resolves after `milliseconds`. */
function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** Merges a set of code points into sorted, inclusive `[first, last]` ranges. */
function mergeRanges(points) {
  const sorted = [...points].sort((left, right) => left - right);
  const ranges = [];
  let first = sorted[0];
  let previous = sorted[0];

  for (const point of sorted.slice(1)) {
    if (point === previous + 1) {
      previous = point;
      continue;
    }
    ranges.push([first, previous]);
    first = point;
    previous = point;
  }
  ranges.push([first, previous]);

  return ranges;
}

/**
 * Parses one derived property out of `emoji-data.txt` into merged, inclusive
 * `[first, last]` ranges.
 */
function parseProperty(text, property) {
  const points = new Set();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    const [codes, name] = line.split(';').map((part) => part.trim());
    if (name !== property) continue;

    const [first, last] = codes.split('..');
    const start = Number.parseInt(first, 16);
    const stop = last === undefined ? start : Number.parseInt(last, 16);
    if (!Number.isInteger(start) || !Number.isInteger(stop)) {
      throw new Error(`Unparseable code point range: ${rawLine}`);
    }
    for (let point = start; point <= stop; point += 1) {
      points.add(point);
    }
  }

  if (points.size === 0) {
    throw new Error(`No code points found for property ${property}`);
  }

  return mergeRanges(points);
}

/**
 * Parses the bases of every text-style variation sequence out of
 * `emoji-variation-sequences.txt` into merged, inclusive ranges.
 *
 * Each line is `<base> <selector> ; <style> ; # comment`, so the base is the
 * first code point of a line whose style is `text style`.
 */
function parseTextVariationBases(text) {
  const points = new Set();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    const [sequence, style] = line.split(';').map((part) => part.trim());
    if (style !== 'text style') continue;

    const base = Number.parseInt(sequence.split(/\s+/)[0], 16);
    if (!Number.isInteger(base)) {
      throw new Error(`Unparseable variation sequence: ${rawLine}`);
    }
    points.add(base);
  }

  if (points.size === 0) {
    throw new Error('No text-style variation sequences found');
  }

  return { ranges: mergeRanges(points), baseCount: points.size };
}

/** Renders one `const NAME: [(u32, u32); N]` table with its doc comment. */
function renderRangeTable(constName, doc, ranges) {
  const entries = ranges.map(([first, last]) => `    (${hex(first)}, ${hex(last)}),`).join('\n');

  return [
    ...doc.map((line) => (line ? `/// ${line}` : '///')),
    `const ${constName}: [(u32, u32); ${ranges.length}] = [`,
    entries,
    '];',
  ].join('\n');
}

/** Renders the whole generated block, markers included. */
function renderTables(emojiDataText, variationSequencesText, unicodeVersion, urls) {
  const version = [
    '/// Unicode release the generated property tables were derived from.',
    '///',
    '/// Bumping this means re-running `scripts/generate-emoji-tables.mjs',
    '/// --version <release>`; it is generated with the tables so the constant',
    '/// and the data it names can never drift apart.',
    `pub const EMOJI_DATA_UNICODE_VERSION: &str = "${unicodeVersion}";`,
  ].join('\n');

  const blocks = PROPERTIES.map(({ property, constName, doc }) =>
    renderRangeTable(constName, doc, parseProperty(emojiDataText, property)),
  );

  const { ranges, baseCount } = parseTextVariationBases(variationSequencesText);
  blocks.push(
    renderRangeTable(
      TEXT_VARIATION_BASES.constName,
      [
        ...TEXT_VARIATION_BASES.doc,
        '',
        `${baseCount} bases in Unicode ${unicodeVersion}, merged into the ranges below.`,
      ],
      ranges,
    ),
  );

  return [
    BEGIN_MARKER,
    `// Generated from ${urls.emojiData}`,
    `// and ${urls.variationSequences}`,
    '// Regenerate with `node scripts/generate-emoji-tables.mjs`. Do not edit by hand.',
    '',
    version,
    '',
    blocks.join('\n\n'),
    '',
    END_MARKER,
  ].join('\n');
}

/** Formats a code point the way the existing range tables in core do. */
function hex(point) {
  return `0x${point.toString(16).toUpperCase().padStart(4, '0')}`;
}
