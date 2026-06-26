/**
 * Analysis Tools - Source Content Summaries
 *
 * Prose summarization helpers (people, text, visual cues, audio, scene labels,
 * semantic moments) consumed when building source report moments.
 */

import {
  uniqueStrings,
  formatNaturalList,
  ensureSentence,
  quoteSnippet,
  normalizeLookupValues,
  includesAnyLookupValue,
  humanizeSegmentType,
} from './shared';

export function buildPeopleSummary(args: {
  topObjectLabels: string[];
  faceDetections: Array<{ faceId?: string | null; emotions?: string[] }>;
}): string | null {
  const objectLookups = normalizeLookupValues(args.topObjectLabels);
  const distinctFaceIds = uniqueStrings(args.faceDetections.map((entry) => entry.faceId ?? null));
  const emotionCues = uniqueStrings(
    args.faceDetections.flatMap((entry) => entry.emotions ?? []).map((emotion) => emotion),
    2,
  );
  const hasAudienceCue = includesAnyLookupValue(objectLookups, ['audience', 'crowd', 'spectator']);
  const hasPersonCue = includesAnyLookupValue(objectLookups, [
    'person',
    'people',
    'speaker',
    'singer',
    'performer',
    'man',
    'woman',
    'child',
    'host',
  ]);
  const parts: string[] = [];

  if (hasAudienceCue) {
    parts.push('a crowd or audience is visible');
  }

  if (distinctFaceIds.length > 1) {
    parts.push(`${distinctFaceIds.length} recurring faces are visible`);
  } else if (distinctFaceIds.length === 1) {
    parts.push('at least one recurring face is visible');
  } else if (args.faceDetections.length > 1) {
    parts.push('one or more faces are visible');
  } else if (args.faceDetections.length === 1) {
    parts.push('at least one face is visible');
  } else if (hasPersonCue) {
    parts.push('a person is visible on screen');
  }

  if (emotionCues.length > 0 && args.faceDetections.length > 0) {
    parts.push(`facial emotion cues include ${formatNaturalList(emotionCues, 2)}`);
  }

  return parts.length > 0 ? parts.slice(0, 2).join('; ') : null;
}

export function buildTextSummary(ocrTexts: string[]): string | null {
  const uniqueTexts = uniqueStrings(ocrTexts, 3);
  if (uniqueTexts.length === 0) {
    return null;
  }

  if (uniqueTexts.length === 1) {
    return `on-screen text reads ${quoteSnippet(uniqueTexts[0], 80)}`;
  }

  return `on-screen text includes ${uniqueTexts
    .map((text) => quoteSnippet(text, 48))
    .filter((value): value is string => Boolean(value))
    .join(', ')}`;
}

export function buildVisualCueSummary(args: {
  cameraAngle?: string | null;
  subjectPosition?: string | null;
  motionDirection?: string | null;
  visualComplexity?: number | null;
}): string | null {
  const parts: string[] = [];

  if (args.cameraAngle && args.cameraAngle !== 'unknown') {
    parts.push(`${args.cameraAngle} framing`);
  }

  if (args.subjectPosition && args.subjectPosition !== 'unknown') {
    parts.push(`${args.subjectPosition} subject placement`);
  }

  if (args.motionDirection && args.motionDirection !== 'unknown') {
    parts.push(
      args.motionDirection === 'static' ? 'mostly static camera' : `${args.motionDirection} motion`,
    );
  }

  if (typeof args.visualComplexity === 'number' && Number.isFinite(args.visualComplexity)) {
    if (args.visualComplexity >= 0.7) {
      parts.push('visually busy frame');
    } else if (args.visualComplexity <= 0.25) {
      parts.push('simple, uncluttered frame');
    }
  }

  return parts.length > 0 ? parts.join(', ') : null;
}

export function deriveSettingHints(args: {
  dominantSegmentType: string | null;
  topObjectLabels: string[];
  ocrTexts: string[];
  transcriptExcerpt: string | null;
  visualCueSummary: string | null;
}): string[] {
  const lookups = normalizeLookupValues([
    ...args.topObjectLabels,
    ...args.ocrTexts,
    args.transcriptExcerpt,
    args.visualCueSummary,
  ]);
  const hints: string[] = [];

  if (
    args.dominantSegmentType === 'performance' ||
    includesAnyLookupValue(lookups, [
      'microphone',
      'stage',
      'concert',
      'audience',
      'crowd',
      'guitar',
      'drum',
      'performer',
      'podium',
      'live',
    ])
  ) {
    hints.push('stage or live event setting');
  }

  if (
    args.dominantSegmentType === 'talk' &&
    (includesAnyLookupValue(lookups, [
      'office',
      'desk',
      'computer',
      'monitor',
      'presentation',
      'podium',
      'studio',
      'host',
      'interview',
    ]) ||
      lookups.some((value) => value.includes('center') || value.includes('static')))
  ) {
    hints.push('interview, presentation, or studio-style setup');
  }

  if (
    includesAnyLookupValue(lookups, [
      'tree',
      'sky',
      'road',
      'street',
      'car',
      'mountain',
      'grass',
      'water',
      'outdoor',
      'nature',
    ])
  ) {
    hints.push('outdoor or location-based setting');
  }

  if (
    args.ocrTexts.length >= 2 ||
    includesAnyLookupValue(lookups, ['screen', 'display', 'monitor', 'phone', 'tablet', 'sign'])
  ) {
    hints.push('screen, signage, or graphic-led frame');
  }

  if (includesAnyLookupValue(lookups, ['sofa', 'couch', 'bed', 'kitchen', 'room', 'table'])) {
    hints.push('indoor room or home-like setting');
  }

  if (args.dominantSegmentType === 'establishing' || args.dominantSegmentType === 'montage') {
    hints.push('environment or b-roll coverage');
  }

  return uniqueStrings(hints, 2);
}

export function buildAudioSummary(args: {
  dominantSegmentType: string | null;
  transcriptExcerpt: string | null;
  audioCue: string | null;
  speakerIds: string[];
}): string | null {
  const quotedExcerpt = quoteSnippet(args.transcriptExcerpt, 96);
  if (quotedExcerpt) {
    if (args.dominantSegmentType === 'performance') {
      return `audio suggests a performance, with lyrics or stage banter such as ${quotedExcerpt}`;
    }

    if (args.speakerIds.length === 1) {
      return `${args.speakerIds[0]} is heard saying ${quotedExcerpt}`;
    }

    return `spoken audio includes ${quotedExcerpt}`;
  }

  if (args.dominantSegmentType === 'performance') {
    return 'audio suggests music or a live performance';
  }

  if (args.audioCue === 'speech-heavy') {
    return 'continuous speech is present';
  }

  if (args.audioCue === 'spoken content') {
    return 'some spoken audio is present';
  }

  if (args.audioCue === 'long pause') {
    return 'the moment contains a noticeable quiet pause';
  }

  if (args.audioCue === 'quiet gap') {
    return 'there is a brief quiet gap in the audio';
  }

  return null;
}

export function buildSceneLabel(args: {
  dominantSegmentType: string | null;
  transcriptExcerpt: string | null;
  topObjectLabels: string[];
  textSummary: string | null;
}): string {
  if (args.transcriptExcerpt && args.dominantSegmentType === 'performance') {
    return 'Performance moment';
  }

  if (args.transcriptExcerpt && args.dominantSegmentType === 'talk') {
    return 'Spoken moment';
  }

  if (args.transcriptExcerpt) {
    return 'Transcript-led moment';
  }

  if (args.textSummary) {
    return 'Text-led shot';
  }

  if (args.dominantSegmentType === 'establishing') {
    return 'Establishing shot';
  }

  if (args.dominantSegmentType === 'reaction') {
    return 'Reaction shot';
  }

  if (args.dominantSegmentType === 'performance') {
    return 'Performance moment';
  }

  if (args.dominantSegmentType === 'montage') {
    return 'Montage beat';
  }

  if (args.topObjectLabels.length > 0) {
    return `${args.topObjectLabels[0]}-led visual moment`;
  }

  return 'Visual moment';
}

export function buildSemanticMomentSummary(args: {
  dominantSegmentType: string | null;
  transcriptExcerpt: string | null;
  topObjectLabels: string[];
  peopleSummary: string | null;
  audioSummary: string | null;
  textSummary: string | null;
  visualCueSummary: string | null;
  settingHints: string[];
}): string {
  const quotedExcerpt = quoteSnippet(args.transcriptExcerpt, 96);
  let primary = '';

  if (quotedExcerpt) {
    if (args.dominantSegmentType === 'performance') {
      primary = `Performance or stage moment with captured lyrics or banter: ${quotedExcerpt}`;
    } else if (args.dominantSegmentType === 'talk') {
      primary = `Spoken moment: ${quotedExcerpt}`;
    } else {
      primary = `Transcript indicates: ${quotedExcerpt}`;
    }
  } else if (args.dominantSegmentType === 'performance') {
    primary =
      args.topObjectLabels.length > 0
        ? `Performance-oriented moment featuring ${formatNaturalList(args.topObjectLabels, 3)}`
        : 'Performance-oriented moment';
  } else if (args.dominantSegmentType === 'reaction') {
    primary = 'Reaction or cutaway moment';
  } else if (args.dominantSegmentType === 'establishing') {
    primary = 'Establishing shot of the scene';
  } else if (args.dominantSegmentType === 'montage') {
    primary = 'Montage or quick-cut sequence';
  } else if (args.topObjectLabels.length > 0) {
    primary = `Visual moment featuring ${formatNaturalList(args.topObjectLabels, 3)}`;
  } else if (args.textSummary) {
    primary = 'Text-led shot with visible graphics or signage';
  } else {
    primary =
      humanizeSegmentType(args.dominantSegmentType) ?? 'Visual moment with limited semantic cues';
  }

  const sentences = [ensureSentence(primary)];

  if (args.peopleSummary) {
    sentences.push(ensureSentence(`People: ${args.peopleSummary}`));
  }

  if (!quotedExcerpt && args.audioSummary) {
    sentences.push(ensureSentence(`Audio: ${args.audioSummary}`));
  }

  if (args.textSummary) {
    sentences.push(ensureSentence(`Text: ${args.textSummary}`));
  }

  if (args.settingHints.length > 0) {
    sentences.push(ensureSentence(`Likely setting: ${formatNaturalList(args.settingHints, 2)}`));
  }

  if (args.visualCueSummary) {
    sentences.push(ensureSentence(`Framing: ${args.visualCueSummary}`));
  }

  return sentences.filter((value): value is string => Boolean(value)).join(' ');
}
