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
 * Usage:
 *   node scripts/generate-emoji-tables.mjs            # rewrite the tables in place
 *   node scripts/generate-emoji-tables.mjs --check     # fail if they are stale
 *   node scripts/generate-emoji-tables.mjs --version 17.0.0
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Unicode release the checked-in tables were generated from. */
const DEFAULT_UNICODE_VERSION = '16.0.0';

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

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const versionIndex = args.indexOf('--version');
const unicodeVersion =
  versionIndex >= 0 && args[versionIndex + 1] ? args[versionIndex + 1] : DEFAULT_UNICODE_VERSION;

const unicodeBaseUrl = `https://www.unicode.org/Public/${unicodeVersion}/ucd/emoji`;
const emojiDataUrl = `${unicodeBaseUrl}/emoji-data.txt`;
const variationSequencesUrl = `${unicodeBaseUrl}/emoji-variation-sequences.txt`;

const emojiData = await fetchUnicodeFile(emojiDataUrl);
const variationSequences = await fetchUnicodeFile(variationSequencesUrl);
const generated = renderTables(emojiData, variationSequences);

const current = await readFile(targetPath, 'utf8');
const begin = current.indexOf(BEGIN_MARKER);
const end = current.indexOf(END_MARKER);
if (begin < 0 || end < 0) {
  throw new Error(`Markers ${BEGIN_MARKER} / ${END_MARKER} not found in ${targetPath}`);
}

const updated =
  current.slice(0, begin) + generated + current.slice(end + END_MARKER.length);

if (updated === current) {
  console.log(`Emoji tables are up to date with Unicode ${unicodeVersion}.`);
  process.exit(0);
}

if (checkOnly) {
  console.error(
    `Emoji tables in ${path.relative(repoRoot, targetPath)} are stale. ` +
      'Run `node scripts/generate-emoji-tables.mjs`.',
  );
  process.exit(1);
}

await writeFile(targetPath, updated, 'utf8');
console.log(`Wrote emoji tables from Unicode ${unicodeVersion} to ${path.relative(repoRoot, targetPath)}.`);

/** Downloads one Unicode data file and returns its text. */
async function fetchUnicodeFile(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status} ${response.statusText}`);
  }
  return response.text();
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
function renderTables(emojiDataText, variationSequencesText) {
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
    `// Generated from ${emojiDataUrl}`,
    `// and ${variationSequencesUrl}`,
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
