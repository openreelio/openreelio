/**
 * Batch tool step extraction.
 *
 * A batch tool is one tool call that carries a list of other tool calls in its
 * args. Anything that reasons about "what does this call actually do" —
 * permission subjects, approval prompts — has to look inside, because the
 * wrapper name says nothing about the steps.
 */

/** Tools whose real work is a list of other tool calls, and the arg holding it. */
const BATCH_TOOL_STEP_KEYS: Readonly<Record<string, string>> = {
  execute_plan: 'steps',
};

/** One tool call carried inside a batch tool's args. */
export interface BatchStepCall {
  toolName: string;
  args: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a tool carries other tool calls in its args. */
export function isBatchToolName(toolName: string): boolean {
  return toolName.trim().toLowerCase() in BATCH_TOOL_STEP_KEYS;
}

/**
 * The tool calls a batch tool carries, in order.
 *
 * Malformed steps are skipped rather than rejected: this runs on the permission
 * path, where the job is to see every step that could execute, not to validate
 * the plan — the executor does that and refuses the whole batch.
 */
export function extractBatchStepCalls(
  toolName: string,
  args: Record<string, unknown> = {},
): BatchStepCall[] {
  const stepsKey = BATCH_TOOL_STEP_KEYS[toolName.trim().toLowerCase()];
  if (!stepsKey) {
    return [];
  }

  const rawSteps = args[stepsKey];
  if (!Array.isArray(rawSteps)) {
    return [];
  }

  const calls: BatchStepCall[] = [];
  for (const rawStep of rawSteps) {
    if (!isRecord(rawStep)) {
      continue;
    }

    const stepToolName = typeof rawStep.toolName === 'string' ? rawStep.toolName.trim() : '';
    if (!stepToolName) {
      continue;
    }

    calls.push({
      toolName: stepToolName,
      args: isRecord(rawStep.params) ? rawStep.params : {},
    });
  }

  return calls;
}

/**
 * Human-readable rundown of what a batch would run, e.g. `delete_clip x10,
 * add_marker`. Returns null when the call is not a batch or carries no steps.
 */
export function summarizeBatchStepCalls(
  toolName: string,
  args: Record<string, unknown> = {},
): string | null {
  const calls = extractBatchStepCalls(toolName, args);
  if (calls.length === 0) {
    return null;
  }

  const countByToolName = new Map<string, number>();
  for (const call of calls) {
    countByToolName.set(call.toolName, (countByToolName.get(call.toolName) ?? 0) + 1);
  }

  return [...countByToolName.entries()]
    .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
    .join(', ');
}
