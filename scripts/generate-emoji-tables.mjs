/**
 * Regenerates the Unicode emoji property tables in
 * `src-tauri/src/core/text/emoji.rs`.
 *
 * The QC burn-in check has to know which code points a font is expected to draw
 * as emoji, and Rust has no such table in the standard library. Rather than take
 * a dependency on an unmaintained crate, the two derived properties the check
 * needs — `Emoji` and `Emoji_Presentation` — are baked in as sorted, inclusive
 * code-point ranges, generated from the Unicode Consortium's own data file so
 * the table can be re-derived instead of hand-audited.
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

/** Properties baked into the Rust file, in the order they are emitted. */
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

const sourceUrl = `https://www.unicode.org/Public/${unicodeVersion}/ucd/emoji/emoji-data.txt`;

const emojiData = await fetchEmojiData(sourceUrl);
const generated = renderTables(emojiData);

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

/** Downloads `emoji-data.txt` and returns its text. */
async function fetchEmojiData(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status} ${response.statusText}`);
  }
  return response.text();
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

/** Renders the whole generated block, markers included. */
function renderTables(text) {
  const blocks = PROPERTIES.map(({ property, constName, doc }) => {
    const ranges = parseProperty(text, property);
    const entries = ranges
      .map(([first, last]) => `    (${hex(first)}, ${hex(last)}),`)
      .join('\n');

    return [
      ...doc.map((line) => (line ? `/// ${line}` : '///')),
      `const ${constName}: [(u32, u32); ${ranges.length}] = [`,
      entries,
      '];',
    ].join('\n');
  });

  return [
    BEGIN_MARKER,
    `// Generated from ${sourceUrl}`,
    '// Regenerate with `node scripts/generate-emoji-tables.mjs`. Do not edit by hand.',
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
