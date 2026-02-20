/**
 * Workspace Schemas
 *
 * Runtime validation for workspace IPC payloads and events.
 * This protects the frontend from malformed backend responses and
 * enforces a strict path contract before crossing the IPC boundary.
 */

import { z } from 'zod';
import type {
  AssetKind,
  FileTreeEntry,
  RegisterFileResult,
  WorkspaceFileEvent,
  WorkspaceScanCompleteEvent,
  WorkspaceScanResult,
} from '@/types';

const MAX_RELATIVE_PATH_LENGTH = 4096;
const MAX_BATCH_REGISTRATION_PATHS = 500;

const WINDOWS_ABSOLUTE_PATH_REGEX = /^[a-zA-Z]:[/\\]/;

const AssetKindSchema = z.enum([
  'video',
  'audio',
  'image',
  'subtitle',
  'font',
  'effectPreset',
  'memePack',
]) satisfies z.ZodType<AssetKind>;

function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code >= 0 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

function hasUnsafeRelativeSegments(path: string): boolean {
  const segments = path.split('/');
  return segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..');
}

function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

export const RelativeWorkspacePathSchema = z
  .string()
  .transform((value) => normalizeSlashes(value.trim()))
  .refine((value) => value.length > 0, {
    message: 'relativePath is empty',
  })
  .refine((value) => value.length <= MAX_RELATIVE_PATH_LENGTH, {
    message: `relativePath exceeds ${MAX_RELATIVE_PATH_LENGTH} characters`,
  })
  .refine((value) => !hasControlCharacters(value), {
    message: 'relativePath contains control characters',
  })
  .refine((value) => !value.startsWith('/'), {
    message: 'relativePath must not be absolute',
  })
  .refine((value) => !WINDOWS_ABSOLUTE_PATH_REGEX.test(value), {
    message: 'relativePath must not be an absolute Windows path',
  })
  .refine((value) => !/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(value), {
    message: 'relativePath must not contain a URI scheme',
  })
  .refine((value) => !hasUnsafeRelativeSegments(value), {
    message: 'relativePath contains invalid "." or ".." path segments',
  });

const WorkspaceScanCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const WorkspaceScanResultSchema = z
  .object({
    totalFiles: WorkspaceScanCountSchema,
    newFiles: WorkspaceScanCountSchema,
    removedFiles: WorkspaceScanCountSchema,
    registeredFiles: WorkspaceScanCountSchema,
    autoRegisteredFiles: WorkspaceScanCountSchema,
  })
  .strict() satisfies z.ZodType<WorkspaceScanResult>;

const FileTreeEntrySchema: z.ZodType<FileTreeEntry> = z.lazy(() =>
  z
    .object({
      relativePath: RelativeWorkspacePathSchema,
      name: z.string().trim().min(1),
      isDirectory: z.boolean(),
      kind: z.preprocess(
        (value) => (value === null ? undefined : value),
        AssetKindSchema.optional(),
      ),
      fileSize: z.preprocess(
        (value) => (value === null ? undefined : value),
        z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      ),
      assetId: z.preprocess(
        (value) => (value === null ? undefined : value),
        z.string().trim().min(1).optional(),
      ),
      missing: z.boolean().optional().default(false),
      children: z.array(FileTreeEntrySchema),
    })
    .strict()
    .superRefine((entry, ctx) => {
      if (entry.isDirectory) {
        if (entry.kind !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['kind'],
            message: 'directory entries must not include kind',
          });
        }
        if (entry.fileSize !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['fileSize'],
            message: 'directory entries must not include fileSize',
          });
        }
        if (entry.assetId !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['assetId'],
            message: 'directory entries must not include assetId',
          });
        }
      } else if (entry.children.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['children'],
          message: 'file entries must not include child nodes',
        });
      }
    }),
);

export const WorkspaceTreeSchema = z.array(FileTreeEntrySchema);

export const RegisterFileResultSchema = z
  .object({
    assetId: z.string().trim().min(1),
    relativePath: RelativeWorkspacePathSchema,
    alreadyRegistered: z.boolean(),
  })
  .strict() satisfies z.ZodType<RegisterFileResult>;

export const RegisterFileResultsSchema = z.array(RegisterFileResultSchema);

export const WorkspaceFileEventSchema = z
  .object({
    relativePath: RelativeWorkspacePathSchema,
    kind: z.preprocess((value) => (value === null ? null : value), AssetKindSchema.nullable()),
  })
  .strict() satisfies z.ZodType<WorkspaceFileEvent>;

export const WorkspaceScanCompleteEventSchema =
  WorkspaceScanResultSchema satisfies z.ZodType<WorkspaceScanCompleteEvent>;

export const RelativeWorkspacePathListSchema = z
  .array(RelativeWorkspacePathSchema)
  .max(MAX_BATCH_REGISTRATION_PATHS, {
    message: `Cannot register more than ${MAX_BATCH_REGISTRATION_PATHS} files at once`,
  })
  .transform((paths) => Array.from(new Set(paths)));

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, context: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`${context}: ${formatValidationError(result.error)}`);
  }
  return result.data;
}

export function parseRelativeWorkspacePath(input: string): string {
  return parseOrThrow(RelativeWorkspacePathSchema, input, 'Invalid relativePath');
}

export function parseRelativeWorkspacePathList(inputs: string[]): string[] {
  const nonEmptyInputs = inputs.filter((input) => input.trim().length > 0);
  if (nonEmptyInputs.length === 0) {
    return [];
  }

  return parseOrThrow(RelativeWorkspacePathListSchema, nonEmptyInputs, 'Invalid relativePaths');
}

export function parseWorkspaceScanResult(input: unknown): WorkspaceScanResult {
  return parseOrThrow(WorkspaceScanResultSchema, input, 'Invalid workspace scan result payload');
}

export function parseWorkspaceTree(input: unknown): FileTreeEntry[] {
  return parseOrThrow(WorkspaceTreeSchema, input, 'Invalid workspace tree payload');
}

export function parseRegisterFileResult(input: unknown): RegisterFileResult {
  return parseOrThrow(RegisterFileResultSchema, input, 'Invalid register workspace file payload');
}

export function parseRegisterFileResults(input: unknown): RegisterFileResult[] {
  return parseOrThrow(RegisterFileResultsSchema, input, 'Invalid register workspace files payload');
}

export function parseWorkspaceFileEvent(input: unknown): WorkspaceFileEvent {
  return parseOrThrow(WorkspaceFileEventSchema, input, 'Invalid workspace file event payload');
}

export function parseWorkspaceScanCompleteEvent(input: unknown): WorkspaceScanCompleteEvent {
  return parseOrThrow(
    WorkspaceScanCompleteEventSchema,
    input,
    'Invalid workspace scan complete event payload',
  );
}

export const WORKSPACE_SCHEMA_LIMITS = {
  maxRelativePathLength: MAX_RELATIVE_PATH_LENGTH,
  maxBatchRegistrationPaths: MAX_BATCH_REGISTRATION_PATHS,
} as const;
