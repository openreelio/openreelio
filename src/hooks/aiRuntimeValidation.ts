/**
 * Runtime validation for AI IPC payloads.
 *
 * TypeScript types do not exist at runtime. IPC is a trust boundary: the renderer process
 * (or a compromised extension) can send malformed data, and the backend can return unexpected
 * shapes due to version skew. These guards fail fast with descriptive errors.
 */

import type {
  ApplyResult,
  EditCommand,
  EditScript,
  Requirement,
  ValidationResult,
} from './useAIAgent';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function expectOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return expectString(value, label);
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function expectStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function parseRequirement(raw: unknown, index: number): Requirement {
  const obj = expectPlainObject(raw, `EditScript.requires[${index}]`);
  const kind = expectString(obj.kind, `EditScript.requires[${index}].kind`);
  const query = expectOptionalString(obj.query, `EditScript.requires[${index}].query`);
  const provider = expectOptionalString(obj.provider, `EditScript.requires[${index}].provider`);
  return { kind, query, provider };
}

function parseEditCommand(raw: unknown, index: number): EditCommand {
  const obj = expectPlainObject(raw, `EditScript.commands[${index}]`);
  const commandType = expectString(obj.commandType, `EditScript.commands[${index}].commandType`);
  const params = expectPlainObject(obj.params, `EditScript.commands[${index}].params`);
  const description = expectOptionalString(
    obj.description,
    `EditScript.commands[${index}].description`,
  );
  return { commandType, params, description };
}

export function parseEditScript(raw: unknown): EditScript {
  const obj = expectPlainObject(raw, 'EditScript');

  const intent = expectString(obj.intent, 'EditScript.intent');
  const explanation = expectString(obj.explanation, 'EditScript.explanation');

  if (!Array.isArray(obj.commands)) {
    throw new Error('EditScript.commands must be an array');
  }
  const commands = obj.commands.map((c, i) => parseEditCommand(c, i));

  if (!Array.isArray(obj.requires)) {
    throw new Error('EditScript.requires must be an array');
  }
  const requires = obj.requires.map((r, i) => parseRequirement(r, i));

  const qcRules = expectStringArray(obj.qcRules, 'EditScript.qcRules');

  const riskObj = expectPlainObject(obj.risk, 'EditScript.risk');
  const copyright = expectString(
    riskObj.copyright,
    'EditScript.risk.copyright',
  ) as EditScript['risk']['copyright'];
  const nsfw = expectString(riskObj.nsfw, 'EditScript.risk.nsfw') as EditScript['risk']['nsfw'];

  const risk: EditScript['risk'] = { copyright, nsfw };

  return { intent, commands, requires, qcRules, risk, explanation };
}

export function parseApplyResult(raw: unknown): ApplyResult {
  const obj = expectPlainObject(raw, 'ApplyResult');
  const success = expectBoolean(obj.success, 'ApplyResult.success');
  const appliedOpIds = expectStringArray(obj.appliedOpIds, 'ApplyResult.appliedOpIds');
  const errors = expectStringArray(obj.errors, 'ApplyResult.errors');
  return { success, appliedOpIds, errors };
}

export function parseValidationResult(raw: unknown): ValidationResult {
  const obj = expectPlainObject(raw, 'ValidationResult');
  const isValid = expectBoolean(obj.isValid, 'ValidationResult.isValid');
  const issues = expectStringArray(obj.issues, 'ValidationResult.issues');
  const warnings = expectStringArray(obj.warnings, 'ValidationResult.warnings');
  return { isValid, issues, warnings };
}
