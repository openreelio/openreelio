export const READ_ONLY_TOOL_PREFIXES = [
  'get_',
  'list_',
  'find_',
  'search_',
  'analyze_',
  'inspect_',
  'query_',
  'read_',
  'check_',
  'compare_',
  'estimate_',
];

export const READ_ONLY_EXACT_TOOL_NAMES = new Set([
  'check_generation_status',
  'estimate_generation_cost',
  'list_workspace_documents',
  'read_workspace_document',
]);

const PROJECT_MUTATION_CATEGORIES = new Set([
  'timeline',
  'clip',
  'track',
  'effect',
  'transition',
  'audio',
]);

const PROJECT_MUTATION_UTILITY_TOOLS = new Set([
  'add_caption',
  'update_caption',
  'delete_caption',
  'style_caption',
  'add_captions_from_transcription',
  'import_captions_from_file',
]);

const MUTATING_TOOL_CATEGORIES = new Set([
  ...PROJECT_MUTATION_CATEGORIES,
  'editing',
  'generation',
  'project',
]);

const MUTATING_UTILITY_TOOLS = new Set([
  ...PROJECT_MUTATION_UTILITY_TOOLS,
  'write_workspace_document',
  'replace_workspace_document_text',
  'create_workspace_folder',
  'rename_workspace_entry',
  'move_workspace_entry',
  'delete_workspace_entry',
  'edit',
  'audio',
  'effects',
  'text',
  'execute_plan',
]);

export const MUTATION_INTENT_PATTERN = new RegExp(
  [
    '\\b(split|cut|trim|move|shift|delete|remove|insert|add|place|put|edit|update|change|replace|reorder|caption|subtitle|transcribe|mute|unmute|fade|normalize|speed|rename|create|write|apply)\\b',
    '분할',
    '쪼개',
    '자르',
    '잘라',
    '삭제',
    '제거',
    '이동',
    '옮기',
    '삽입',
    '추가',
    '배치',
    '편집',
    '수정',
    '변경',
    '자막',
    '속도',
    '음소거',
    '무음',
    '페이드',
    '생성',
    '작성',
    '적용',
  ].join('|'),
  'i',
);

export function isReadOnlyToolName(toolName: string, category?: string | null): boolean {
  const normalizedToolName = toolName.trim().toLowerCase();
  const normalizedCategory = category?.trim().toLowerCase() ?? null;

  if (normalizedCategory === 'analysis' || READ_ONLY_EXACT_TOOL_NAMES.has(normalizedToolName)) {
    return true;
  }

  return READ_ONLY_TOOL_PREFIXES.some((prefix) => normalizedToolName.startsWith(prefix));
}

export function requiresProjectMutationPreflight(
  toolName: string,
  category?: string | null,
): boolean {
  const normalizedToolName = toolName.trim().toLowerCase();
  const normalizedCategory = category?.trim().toLowerCase() ?? null;

  if (normalizedToolName === 'execute_plan' || normalizedToolName === 'edit') {
    return true;
  }

  if (PROJECT_MUTATION_UTILITY_TOOLS.has(normalizedToolName)) {
    return true;
  }

  return normalizedCategory !== null && PROJECT_MUTATION_CATEGORIES.has(normalizedCategory);
}

export function isMutatingToolName(toolName: string, category?: string | null): boolean {
  const normalizedToolName = toolName.trim().toLowerCase();
  const normalizedCategory = category?.trim().toLowerCase() ?? null;

  if (isReadOnlyToolName(normalizedToolName, normalizedCategory)) {
    return false;
  }

  if (MUTATING_UTILITY_TOOLS.has(normalizedToolName)) {
    return true;
  }

  return normalizedCategory !== null && MUTATING_TOOL_CATEGORIES.has(normalizedCategory);
}

export function hasMutationIntentText(...values: Array<string | undefined>): boolean {
  const text = values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ');

  return MUTATION_INTENT_PATTERN.test(text);
}
