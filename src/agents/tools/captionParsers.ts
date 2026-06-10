/**
 * Caption document parsers for SRT and WebVTT subtitle files.
 */

export type CaptionDocumentFormat = 'srt' | 'vtt';

export interface ParsedCaptionSegment {
  startTime: number;
  endTime: number;
  text: string;
  speaker?: string;
}

function sanitizeCaptionText(text: string): string {
  return text
    .replace(/<[^>\n]*>/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseTimestamp(rawValue: string): number {
  const normalized = rawValue.trim().replace(',', '.');
  const parts = normalized.split(':');

  if (parts.length !== 2 && parts.length !== 3) {
    throw new Error(`Invalid caption timestamp '${rawValue}'`);
  }

  const numericParts = parts.map((part) => Number(part));
  if (numericParts.some((part) => !Number.isFinite(part))) {
    throw new Error(`Invalid caption timestamp '${rawValue}'`);
  }

  if (numericParts.length === 2) {
    const [minutes, seconds] = numericParts;
    return minutes * 60 + seconds;
  }

  const [hours, minutes, seconds] = numericParts;
  return hours * 3600 + minutes * 60 + seconds;
}

function parseTimestampRange(line: string): { startTime: number; endTime: number } {
  const parts = line.split('-->');
  if (parts.length !== 2) {
    throw new Error(`Invalid caption timing line '${line}'`);
  }

  const startTime = parseTimestamp(parts[0]);
  const endPart = parts[1].trim();
  const endToken = endPart.split(/\s+/)[0] ?? endPart;
  const endTime = parseTimestamp(endToken);

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    throw new Error(`Invalid caption time range '${line}'`);
  }

  return { startTime, endTime };
}

function parseSrtBlocks(content: string): ParsedCaptionSegment[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const segments: ParsedCaptionSegment[] = [];
  let index = 0;

  while (index < lines.length) {
    while (index < lines.length && lines[index].trim() === '') {
      index += 1;
    }

    if (index >= lines.length) {
      break;
    }

    const firstLine = lines[index]?.trim() ?? '';
    let timestampLine = firstLine;

    if (!timestampLine.includes('-->')) {
      index += 1;
      timestampLine = lines[index]?.trim() ?? '';
    }

    if (!timestampLine.includes('-->')) {
      throw new Error(`Expected SRT timing line near '${firstLine}'`);
    }

    const { startTime, endTime } = parseTimestampRange(timestampLine);
    index += 1;

    const textLines: string[] = [];
    while (index < lines.length && lines[index].trim() !== '') {
      textLines.push(lines[index]);
      index += 1;
    }

    const text = sanitizeCaptionText(textLines.join('\n'));
    if (!text) {
      throw new Error(`Missing caption text for range '${timestampLine}'`);
    }

    segments.push({ startTime, endTime, text });
  }

  return segments;
}

function stripVttTags(text: string): { text: string; speaker?: string } {
  const speakerMatch = text.match(/<v(?:\.[^>\s]+)?\s+([^>]+)>/i);
  const speaker = speakerMatch?.[1]?.trim();
  const cleanedText = sanitizeCaptionText(text);

  return speaker ? { text: cleanedText, speaker } : { text: cleanedText };
}

function isWebVttMetadataBlockStart(line: string): boolean {
  const normalized = line.trim().toUpperCase();
  return (
    normalized.startsWith('NOTE') ||
    normalized.startsWith('STYLE') ||
    normalized.startsWith('REGION')
  );
}

function skipWebVttMetadataBlock(lines: string[], index: number): number {
  let nextIndex = index + 1;
  while (nextIndex < lines.length && lines[nextIndex].trim() !== '') {
    nextIndex += 1;
  }
  return nextIndex;
}

function parseVttBlocks(content: string): ParsedCaptionSegment[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const segments: ParsedCaptionSegment[] = [];
  let index = 0;

  while (index < lines.length && lines[index].trim() === '') {
    index += 1;
  }

  if (index < lines.length && lines[index].startsWith('WEBVTT')) {
    index += 1;
    while (index < lines.length && lines[index].trim() !== '') {
      index += 1;
    }
  }

  while (index < lines.length) {
    while (index < lines.length && lines[index].trim() === '') {
      index += 1;
    }

    if (index >= lines.length) {
      break;
    }

    const firstLine = lines[index]?.trim() ?? '';
    if (isWebVttMetadataBlockStart(firstLine)) {
      index = skipWebVttMetadataBlock(lines, index);
      continue;
    }
    let timestampLine = firstLine;

    if (!timestampLine.includes('-->')) {
      index += 1;
      timestampLine = lines[index]?.trim() ?? '';
    }

    if (!timestampLine.includes('-->')) {
      throw new Error(`Expected VTT timing line near '${firstLine}'`);
    }

    const { startTime, endTime } = parseTimestampRange(timestampLine);
    index += 1;

    const textLines: string[] = [];
    let speaker: string | undefined;
    while (index < lines.length && lines[index].trim() !== '') {
      const parsedLine = stripVttTags(lines[index]);
      if (!speaker && parsedLine.speaker) {
        speaker = parsedLine.speaker;
      }
      textLines.push(parsedLine.text);
      index += 1;
    }

    const text = textLines.join('\n').trim();
    if (!text) {
      throw new Error(`Missing caption text for range '${timestampLine}'`);
    }

    segments.push({
      startTime,
      endTime,
      text,
      ...(speaker ? { speaker } : {}),
    });
  }

  return segments;
}

export function detectCaptionDocumentFormat(
  relativePath: string,
  content?: string,
): CaptionDocumentFormat | null {
  const normalizedPath = relativePath.trim().toLowerCase();
  if (normalizedPath.endsWith('.srt')) {
    return 'srt';
  }

  if (normalizedPath.endsWith('.vtt')) {
    return 'vtt';
  }

  const normalizedContent = content?.trimStart();
  if (normalizedContent?.startsWith('WEBVTT')) {
    return 'vtt';
  }

  if (normalizedContent?.includes('-->')) {
    return 'srt';
  }

  return null;
}

export function parseCaptionDocument(
  content: string,
  format: CaptionDocumentFormat,
): ParsedCaptionSegment[] {
  if (format === 'srt') {
    return parseSrtBlocks(content);
  }

  return parseVttBlocks(content);
}
