import type { AgentContext, Plan, PlanStep, Thought } from './types';
import type { IToolExecutor } from '../ports/IToolExecutor';

export interface FastPathMatch {
  thought: Thought;
  plan: Plan;
  confidence: number;
  strategy: 'split' | 'trim' | 'move' | 'add_caption' | 'delete_range';
}

interface FastPathParserOptions {
  minConfidence?: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.85;

export function parseFastPathPlan(
  input: string,
  context: AgentContext,
  toolExecutor: IToolExecutor,
  options: FastPathParserOptions = {},
): FastPathMatch | null {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const normalized = input.trim();

  if (!normalized || !context.sequenceId) {
    return null;
  }

  const parsers: Array<() => FastPathMatch | null> = [
    () => parseSplit(normalized, context, toolExecutor),
    () => parseTrim(normalized, context, toolExecutor),
    () => parseMove(normalized, context, toolExecutor),
    () => parseAddCaption(normalized, context, toolExecutor),
    () => parseDeleteRange(normalized, context, toolExecutor),
  ];

  for (const parse of parsers) {
    const candidate = parse();
    if (!candidate) {
      continue;
    }
    if (candidate.confidence >= minConfidence) {
      return candidate;
    }
  }

  return null;
}

function parseSplit(
  input: string,
  context: AgentContext,
  toolExecutor: IToolExecutor,
): FastPathMatch | null {
  if (!/(\bsplit\b|\bcut\b(?!\s*out)|분할|쪼개)/i.test(input)) {
    return null;
  }

  const selected = getSingleSelectedClip(context);
  if (!selected) {
    return null;
  }

  const splitTime =
    parseFirstTime(input) ??
    (/(playhead|재생헤드|현재\s*위치)/i.test(input) ? context.playheadPosition : null);
  if (splitTime === null) {
    return null;
  }

  const args = {
    sequenceId: context.sequenceId,
    trackId: selected.trackId,
    clipId: selected.clipId,
    splitTime,
  };

  return createFastPathMatch('split', 'split_clip', args, 0.97, toolExecutor);
}

function parseTrim(
  input: string,
  context: AgentContext,
  toolExecutor: IToolExecutor,
): FastPathMatch | null {
  if (!/(\btrim\b|컷편집|트림|잘라|까지)/i.test(input)) {
    return null;
  }

  const selected = getSingleSelectedClip(context);
  if (!selected) {
    return null;
  }

  const endTime = parseTrimTargetTime(input);
  if (endTime === null) {
    return null;
  }

  const args = {
    sequenceId: context.sequenceId,
    trackId: selected.trackId,
    clipId: selected.clipId,
    newSourceOut: endTime,
  };

  return createFastPathMatch('trim', 'trim_clip', args, 0.95, toolExecutor);
}

function parseMove(
  input: string,
  context: AgentContext,
  toolExecutor: IToolExecutor,
): FastPathMatch | null {
  if (!/(\bmove\b|\bshift\b|옮기|이동)/i.test(input)) {
    return null;
  }

  const selected = getSingleSelectedClip(context);
  if (!selected) {
    return null;
  }

  const newTimelineIn = parseFirstTime(input);
  if (newTimelineIn === null) {
    return null;
  }

  const args = {
    sequenceId: context.sequenceId,
    trackId: selected.trackId,
    clipId: selected.clipId,
    newTimelineIn,
  };

  return createFastPathMatch('move', 'move_clip', args, 0.95, toolExecutor);
}

function parseAddCaption(
  input: string,
  context: AgentContext,
  toolExecutor: IToolExecutor,
): FastPathMatch | null {
  if (!/(caption|subtitle|자막)/i.test(input)) {
    return null;
  }

  const text = parseQuotedText(input);
  if (!text) {
    return null;
  }

  const [startTime, endTime] = parseTimeRange(input) ?? [];
  if (startTime === undefined || endTime === undefined || endTime <= startTime) {
    return null;
  }

  const args = {
    sequenceId: context.sequenceId,
    text,
    startTime,
    endTime,
  };

  return createFastPathMatch('add_caption', 'add_caption', args, 0.96, toolExecutor);
}

function parseDeleteRange(
  input: string,
  context: AgentContext,
  toolExecutor: IToolExecutor,
): FastPathMatch | null {
  if (!/(delete|remove|cut\s*out|삭제)/i.test(input)) {
    return null;
  }

  const range = parseTimeRange(input);
  if (!range) {
    return null;
  }

  const [startTime, endTime] = range;
  if (endTime <= startTime) {
    return null;
  }

  const selectedTrack = context.selectedTracks.length === 1 ? context.selectedTracks[0] : undefined;

  const args: Record<string, unknown> = {
    sequenceId: context.sequenceId,
    startTime,
    endTime,
  };

  if (selectedTrack) {
    args.trackId = selectedTrack;
  }

  return createFastPathMatch('delete_range', 'delete_clips_in_range', args, 0.94, toolExecutor);
}

function createFastPathMatch(
  strategy: FastPathMatch['strategy'],
  tool: string,
  args: Record<string, unknown>,
  confidence: number,
  toolExecutor: IToolExecutor,
): FastPathMatch | null {
  if (!toolExecutor.hasTool(tool)) {
    return null;
  }

  const validation = toolExecutor.validateArgs(tool, args);
  if (!validation.valid) {
    return null;
  }

  const step: PlanStep = {
    id: `fastpath-${strategy}`,
    tool,
    args,
    description: `Fast-path ${strategy.replace('_', ' ')} action`,
    riskLevel: 'low',
    estimatedDuration: 150,
  };

  return {
    strategy,
    confidence,
    thought: {
      understanding: `Apply ${strategy.replace('_', ' ')} through deterministic fast path`,
      requirements: [],
      uncertainties: [],
      approach: 'Use deterministic fast path and execute schema-validated command directly',
      needsMoreInfo: false,
    },
    plan: {
      goal: `Execute ${strategy.replace('_', ' ')}`,
      steps: [step],
      estimatedTotalDuration: step.estimatedDuration,
      requiresApproval: false,
      rollbackStrategy: 'Use standard undo stack for this operation',
    },
  };
}

function getSingleSelectedClip(context: AgentContext): { clipId: string; trackId: string } | null {
  if (context.selectedClips.length !== 1 || context.selectedTracks.length !== 1) {
    return null;
  }

  return {
    clipId: context.selectedClips[0],
    trackId: context.selectedTracks[0],
  };
}

function parseTimeRange(input: string): [number, number] | null {
  const fromToPattern =
    /(?:from|between|구간|부터)?\s*([0-9:.]+(?:\s*(?:s|sec|secs|seconds?|m|min|mins|minutes?|초|분))?)\s*(?:to|and|~|-|까지)\s*([0-9:.]+(?:\s*(?:s|sec|secs|seconds?|m|min|mins|minutes?|초|분))?)/i;
  const match = input.match(fromToPattern);
  if (match) {
    const start = parseTimeValue(match[1]);
    const end = parseTimeValue(match[2]);
    if (start !== null && end !== null) {
      return [start, end];
    }
  }

  const values = parseAllTimes(input);
  if (values.length >= 2) {
    return [values[0], values[1]];
  }

  return null;
}

function parseTrimTargetTime(input: string): number | null {
  const match = input.match(
    /([0-9:.]+(?:\s*(?:s|sec|secs|seconds?|m|min|mins|minutes?|초|분))?)\s*(?:까지|to)/i,
  );
  if (match) {
    return parseTimeValue(match[1]);
  }

  return parseFirstTime(input);
}

function parseFirstTime(input: string): number | null {
  const values = parseAllTimes(input);
  return values.length > 0 ? values[0] : null;
}

function parseAllTimes(input: string): number[] {
  const values: number[] = [];
  const seen = new Set<string>();

  const push = (value: number | null): void => {
    if (value === null || !Number.isFinite(value) || value < 0) {
      return;
    }
    const key = value.toFixed(3);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    values.push(value);
  };

  for (const match of input.matchAll(/\d{1,2}:\d{1,2}(?::\d{1,2})?(?:\.\d+)?/g)) {
    push(parseTimeValue(match[0]));
  }

  for (const match of input.matchAll(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|초)\b/gi)) {
    push(parseFloat(match[1]));
  }

  for (const match of input.matchAll(/(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|분)\b/gi)) {
    // Skip if this is the prefix of a Korean composite (e.g. "5분30초")
    const afterMatch = input.slice((match.index ?? 0) + match[0].length);
    if (/^\s*\d/.test(afterMatch) && match[2] === '분') {
      continue;
    }
    push(parseFloat(match[1]) * 60);
  }

  for (const match of input.matchAll(/(\d+)\s*분\s*(\d+(?:\.\d+)?)?\s*초?/g)) {
    const minutes = parseFloat(match[1]);
    const seconds = match[2] ? parseFloat(match[2]) : 0;
    push(minutes * 60 + seconds);
  }

  return values;
}

function parseTimeValue(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (!value) {
    return null;
  }

  const pureTimecode = /^\d{1,2}:\d{1,2}(?::\d{1,2})?(?:\.\d+)?$/;
  if (pureTimecode.test(value)) {
    const parts = value.split(':').map((part) => Number.parseFloat(part));
    if (parts.some((part) => Number.isNaN(part))) {
      return null;
    }
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
  }

  const minuteMatch = value.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|분)$/i);
  if (minuteMatch) {
    return Number.parseFloat(minuteMatch[1]) * 60;
  }

  const secondMatch = value.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|초)$/i);
  if (secondMatch) {
    return Number.parseFloat(secondMatch[1]);
  }

  const koreanComposite = value.match(/^(\d+)\s*분\s*(\d+(?:\.\d+)?)?\s*초?$/);
  if (koreanComposite) {
    const minutes = Number.parseFloat(koreanComposite[1]);
    const seconds = koreanComposite[2] ? Number.parseFloat(koreanComposite[2]) : 0;
    return minutes * 60 + seconds;
  }

  const numeric = Number.parseFloat(value);
  if (!Number.isNaN(numeric)) {
    return numeric;
  }

  return null;
}

function parseQuotedText(input: string): string | null {
  const match = input.match(/["']([^"']+)["']/);
  if (!match) {
    return null;
  }
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}
