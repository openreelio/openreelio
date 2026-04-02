/**
 * Permission subject compiler.
 *
 * Converts concrete tool invocations into canonical permission subjects while
 * preserving compatibility with legacy tool-name wildcard rules.
 */

export type PermissionSubjectType =
  | 'capability'
  | 'resource'
  | 'tool'
  | 'workspace'
  | 'asset'
  | 'external_provider'
  | 'export'
  | 'delegation'
  | 'approval'
  | 'system';

export interface PermissionSubject {
  subjectType: PermissionSubjectType;
  subject: string;
  normalizedToolName: string;
  toolName: string;
  resourceBinding: string | null;
  aliases: string[];
}

const META_TOOL_NAMES = new Set(['query', 'edit', 'audio', 'effects', 'text']);

const EXACT_SUBJECTS: Record<
  string,
  { subjectType: PermissionSubjectType; subject: string }
> = {
  analyze_asset: {
    subjectType: 'asset',
    subject: 'asset.analysis.run',
  },
  analyze_workspace_video: {
    subjectType: 'asset',
    subject: 'asset.analysis.run',
  },
  get_analysis_status: {
    subjectType: 'asset',
    subject: 'asset.analysis.status.read',
  },
  get_asset_annotation: {
    subjectType: 'asset',
    subject: 'asset.annotation.read',
  },
  get_analysis_cost_estimate: {
    subjectType: 'asset',
    subject: 'asset.analysis.cost.read',
  },
  get_analysis_providers: {
    subjectType: 'external_provider',
    subject: 'external_provider.providers.read',
  },
  list_workspace_documents: {
    subjectType: 'workspace',
    subject: 'workspace.document.read',
  },
  read_workspace_document: {
    subjectType: 'workspace',
    subject: 'workspace.document.read',
  },
  write_workspace_document: {
    subjectType: 'workspace',
    subject: 'workspace.document.write',
  },
  replace_workspace_document_text: {
    subjectType: 'workspace',
    subject: 'workspace.document.write',
  },
  create_workspace_folder: {
    subjectType: 'workspace',
    subject: 'workspace.folder.create',
  },
  rename_workspace_entry: {
    subjectType: 'workspace',
    subject: 'workspace.entry.rename',
  },
  move_workspace_entry: {
    subjectType: 'workspace',
    subject: 'workspace.entry.move',
  },
  delete_workspace_entry: {
    subjectType: 'workspace',
    subject: 'workspace.entry.delete',
  },
  search_stock_media: {
    subjectType: 'external_provider',
    subject: 'external_provider.search',
  },
  generate_video: {
    subjectType: 'external_provider',
    subject: 'external_provider.generate',
  },
  check_generation_status: {
    subjectType: 'external_provider',
    subject: 'external_provider.status.read',
  },
  estimate_generation_cost: {
    subjectType: 'external_provider',
    subject: 'external_provider.cost.read',
  },
  cancel_generation: {
    subjectType: 'external_provider',
    subject: 'external_provider.cancel',
  },
  execute_plan: {
    subjectType: 'approval',
    subject: 'approval.plan.execute',
  },
};

const READ_PREFIXES = ['get_', 'list_', 'find_', 'search_', 'inspect_', 'query_', 'read_'];

function matchLegacyPermissionPattern(pattern: string, value: string): boolean {
  if (pattern === '*') {
    return true;
  }

  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = `^${escaped.replace(/\*/g, '.*')}$`;
  try {
    return new RegExp(regexStr).test(value);
  } catch {
    return pattern === value;
  }
}

function splitCanonicalSubject(
  value: string,
): { path: string; resource: string | null } {
  const separatorIndex = value.indexOf('#');
  if (separatorIndex === -1) {
    return { path: value.trim(), resource: null };
  }
  return {
    path: value.slice(0, separatorIndex).trim(),
    resource: value.slice(separatorIndex + 1).trim() || null,
  };
}

function splitCanonicalSegments(value: string): string[] {
  return value
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function matchCanonicalSegments(
  patternSegments: string[],
  subjectSegments: string[],
  patternIndex = 0,
  subjectIndex = 0,
): boolean {
  let currentPatternIndex = patternIndex;
  let currentSubjectIndex = subjectIndex;

  while (currentPatternIndex < patternSegments.length) {
    const patternSegment = patternSegments[currentPatternIndex];

    if (patternSegment === '**') {
      if (currentPatternIndex === patternSegments.length - 1) {
        return true;
      }

      for (
        let nextSubjectIndex = currentSubjectIndex;
        nextSubjectIndex <= subjectSegments.length;
        nextSubjectIndex += 1
      ) {
        if (
          matchCanonicalSegments(
            patternSegments,
            subjectSegments,
            currentPatternIndex + 1,
            nextSubjectIndex,
          )
        ) {
          return true;
        }
      }

      return false;
    }

    if (currentSubjectIndex >= subjectSegments.length) {
      return false;
    }

    if (patternSegment !== '*' && patternSegment !== subjectSegments[currentSubjectIndex]) {
      return false;
    }

    currentPatternIndex += 1;
    currentSubjectIndex += 1;
  }

  return currentSubjectIndex === subjectSegments.length;
}

function matchCanonicalPermissionPattern(pattern: string, subject: string): boolean {
  const patternParts = splitCanonicalSubject(pattern);
  const subjectParts = splitCanonicalSubject(subject);

  if (
    !matchCanonicalSegments(
      splitCanonicalSegments(patternParts.path),
      splitCanonicalSegments(subjectParts.path),
    )
  ) {
    return false;
  }

  if (!patternParts.resource) {
    return true;
  }

  if (!subjectParts.resource) {
    return false;
  }

  return matchLegacyPermissionPattern(patternParts.resource, subjectParts.resource);
}

function normalizeToolName(toolName: string, args: Record<string, unknown>): string {
  const normalizedToolName = toolName.trim().toLowerCase();
  if (!META_TOOL_NAMES.has(normalizedToolName)) {
    return normalizedToolName;
  }

  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
  return action || normalizedToolName;
}

function inferDomain(toolName: string): string {
  if (toolName.startsWith('analyze_')) {
    return 'asset.analysis';
  }

  if (toolName.includes('workspace') || toolName.includes('document')) {
    return 'workspace.document';
  }

  if (toolName.includes('file')) {
    return 'workspace.file';
  }

  if (toolName.includes('folder')) {
    return 'workspace.folder';
  }

  if (toolName.includes('prompt')) {
    return 'workspace.prompt';
  }

  if (toolName.includes('asset') || toolName.includes('analysis')) {
    return 'asset';
  }

  if (toolName.includes('generation') || toolName.includes('stock_media')) {
    return 'external_provider';
  }

  if (toolName.includes('caption') || toolName.includes('transcription')) {
    return 'caption';
  }

  if (
    toolName.includes('audio')
    || toolName.includes('volume')
    || toolName.includes('fade')
    || toolName.startsWith('mute_')
    || toolName.startsWith('normalize_')
  ) {
    return 'audio';
  }

  if (toolName.includes('effect')) {
    return 'timeline.effect';
  }

  if (toolName.includes('transition')) {
    return 'timeline.transition';
  }

  if (toolName.includes('marker')) {
    return 'timeline.marker';
  }

  if (toolName.includes('track')) {
    return 'timeline.track';
  }

  if (toolName.includes('clip') || toolName.includes('timeline')) {
    return 'timeline.clip';
  }

  if (toolName.startsWith('export_') || toolName.startsWith('render_')) {
    return 'render.export';
  }

  return 'tool';
}

function inferAction(toolName: string): string {
  if (READ_PREFIXES.some((prefix) => toolName.startsWith(prefix))) {
    return 'read';
  }

  if (toolName.startsWith('analyze_')) {
    return 'analyze';
  }

  if (toolName.startsWith('delete_') || toolName.startsWith('remove_') || toolName.startsWith('cancel_')) {
    return 'delete';
  }

  if (toolName.startsWith('add_') || toolName.startsWith('insert_') || toolName.startsWith('create_')) {
    return 'create';
  }

  if (toolName.startsWith('update_')) {
    return 'update';
  }

  if (toolName.startsWith('replace_')) {
    return 'replace';
  }

  if (toolName.startsWith('rename_')) {
    return 'rename';
  }

  if (toolName.startsWith('move_')) {
    return 'move';
  }

  if (toolName.startsWith('trim_')) {
    return 'trim';
  }

  if (toolName.startsWith('split_')) {
    return 'split';
  }

  if (toolName.startsWith('change_')) {
    return 'change';
  }

  if (toolName.startsWith('adjust_')) {
    return 'adjust';
  }

  if (toolName.startsWith('copy_')) {
    return 'copy';
  }

  if (toolName.startsWith('reset_')) {
    return 'reset';
  }

  if (toolName.startsWith('freeze_')) {
    return 'freeze';
  }

  if (toolName.startsWith('ripple_')) {
    return 'ripple';
  }

  if (toolName.startsWith('roll_')) {
    return 'roll';
  }

  if (toolName.startsWith('slip_')) {
    return 'slip';
  }

  if (toolName.startsWith('slide_')) {
    return 'slide';
  }

  if (toolName.startsWith('style_')) {
    return 'style';
  }

  if (toolName.startsWith('apply_')) {
    return 'apply';
  }

  if (toolName.startsWith('normalize_')) {
    return 'normalize';
  }

  if (toolName.startsWith('mute_')) {
    return 'mute';
  }

  if (toolName.startsWith('navigate_')) {
    return 'navigate';
  }

  return 'use';
}

function inferSubjectType(domain: string, resourceBinding: string | null): PermissionSubjectType {
  if (resourceBinding) {
    return 'resource';
  }

  if (domain === 'tool') {
    return 'tool';
  }

  if (domain.startsWith('workspace')) {
    return 'workspace';
  }

  if (domain.startsWith('asset')) {
    return 'asset';
  }

  if (domain.startsWith('external_provider')) {
    return 'external_provider';
  }

  if (domain.startsWith('render.export')) {
    return 'export';
  }

  if (domain.startsWith('approval')) {
    return 'approval';
  }

  return 'capability';
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim().length > 0) {
    return value[0].trim();
  }

  return null;
}

function extractResourceBinding(args: Record<string, unknown>): string | null {
  const bindings: Array<[string, string]> = [
    ['path', 'relativePath'],
    ['path', 'oldRelativePath'],
    ['path', 'sourcePath'],
    ['path', 'destFolderPath'],
    ['path', 'file'],
    ['job', 'jobId'],
    ['clip', 'clipId'],
    ['track', 'trackId'],
    ['sequence', 'sequenceId'],
    ['asset', 'assetId'],
    ['marker', 'markerId'],
    ['provider', 'provider'],
    ['provider', 'providerId'],
    ['provider', 'modelProvider'],
    ['agent', 'agentProfileId'],
    ['agent', 'agentId'],
    ['project', 'projectId'],
  ];

  for (const [label, key] of bindings) {
    const value = firstString(args[key]);
    if (value) {
      return `${label}:${value}`;
    }
  }

  return null;
}

export function buildPermissionSubject(
  toolName: string,
  args: Record<string, unknown> = {},
): PermissionSubject {
  const rawToolName = toolName.trim().toLowerCase();
  const normalizedToolName = normalizeToolName(toolName, args);
  const exact = EXACT_SUBJECTS[normalizedToolName];
  const resourceBinding = extractResourceBinding(args);

  if (exact) {
    const subject = resourceBinding
      && exact.subjectType !== 'approval'
      && exact.subjectType !== 'system'
      ? `${exact.subject}#${resourceBinding}`
      : exact.subject;
    return {
      subjectType:
        resourceBinding
        && exact.subjectType !== 'approval'
        && exact.subjectType !== 'system'
          ? 'resource'
          : exact.subjectType,
      subject,
      normalizedToolName,
      toolName: rawToolName,
      resourceBinding,
      aliases: dedupe([
        subject,
        exact.subject,
        rawToolName,
        normalizedToolName,
        `tool.${rawToolName}`,
        `tool.${normalizedToolName}`,
      ]),
    };
  }

  const domain = inferDomain(normalizedToolName);
  const action = inferAction(normalizedToolName);
  const subjectBase = domain === 'tool'
    ? `tool.${normalizedToolName}`
    : domain.endsWith(`.${action}`)
      ? domain
      : `${domain}.${action}`;
  const subject = resourceBinding ? `${subjectBase}#${resourceBinding}` : subjectBase;

  return {
    subjectType: inferSubjectType(domain, resourceBinding),
    subject,
    normalizedToolName,
    toolName: rawToolName,
    resourceBinding,
    aliases: dedupe([
      subject,
      subjectBase,
      rawToolName,
      normalizedToolName,
      `tool.${rawToolName}`,
      `tool.${normalizedToolName}`,
    ]),
  };
}

export const normalizeToolPermissionSubject = buildPermissionSubject;

export function isCanonicalPermissionPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  return trimmed.includes('.') || trimmed.includes('#') || trimmed === '**';
}

export function matchPermissionPattern(pattern: string, subject: PermissionSubject): boolean {
  if (!isCanonicalPermissionPattern(pattern)) {
    return subject.aliases.some(
      (candidate) => !candidate.includes('.') && matchLegacyPermissionPattern(pattern, candidate),
    );
  }

  return subject.aliases.some((candidate) => matchCanonicalPermissionPattern(pattern, candidate));
}

export function isExactPermissionPatternMatch(
  pattern: string,
  subject: PermissionSubject,
): boolean {
  if (pattern.includes('*')) {
    return false;
  }

  if (!isCanonicalPermissionPattern(pattern)) {
    return subject.aliases.some((candidate) => !candidate.includes('.') && candidate === pattern);
  }

  return subject.aliases.includes(pattern);
}

export function getPermissionPatternSpecificity(pattern: string): number {
  if (!isCanonicalPermissionPattern(pattern)) {
    const wildcardCount = (pattern.match(/\*/g) ?? []).length;
    const literalLength = pattern.replace(/\*/g, '').length;
    return wildcardCount === 0 ? 10_000 + literalLength : literalLength;
  }

  const { path, resource } = splitCanonicalSubject(pattern);
  const segments = splitCanonicalSegments(path);
  let score = 0;
  for (const segment of segments) {
    if (segment === '**') {
      continue;
    }

    if (segment === '*') {
      score += 1;
      continue;
    }

    score += 20 + segment.length;
  }

  if (!pattern.includes('*')) {
    score += 10_000;
  }

  if (resource) {
    score += 50;
  }

  return score;
}

export function toPermissionRulePattern(subject: PermissionSubject): string {
  return subject.subject;
}

export { matchCanonicalPermissionPattern, matchLegacyPermissionPattern };
