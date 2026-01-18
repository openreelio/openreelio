/**
 * Project Path Utilities
 *
 * Provides validation and sanitization for project names and paths.
 * Prevents path traversal attacks and ensures cross-platform compatibility.
 */

// =============================================================================
// Constants
// =============================================================================

/**
 * Characters that are invalid in file/folder names across Windows, macOS, and Linux.
 * Windows: \ / : * ? " < > |
 * macOS/Linux: / and null
 * Combined set for cross-platform safety.
 */
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]/g;

/**
 * Path traversal patterns that could escape the intended directory.
 */
const PATH_TRAVERSAL_PATTERN = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/**
 * Reserved names on Windows (case-insensitive).
 * These cannot be used as file or folder names.
 */
const WINDOWS_RESERVED_NAMES = [
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
];

// =============================================================================
// Types
// =============================================================================

export interface ProjectNameValidationResult {
  isValid: boolean;
  sanitized: string;
  errors: string[];
}

// =============================================================================
// Functions
// =============================================================================

/**
 * Validates and sanitizes a project name for use as a folder name.
 *
 * @param name - The raw project name input from user
 * @returns Validation result with sanitized name and any errors
 *
 * @example
 * ```ts
 * validateProjectName('My Project');
 * // { isValid: true, sanitized: 'My_Project', errors: [] }
 *
 * validateProjectName('../../evil');
 * // { isValid: false, sanitized: 'evil', errors: ['Project name contains path traversal characters'] }
 * ```
 */
export function validateProjectName(name: string): ProjectNameValidationResult {
  const errors: string[] = [];

  // Trim whitespace
  let sanitized = name.trim();

  // Check for empty name
  if (!sanitized) {
    return {
      isValid: false,
      sanitized: '',
      errors: ['Project name cannot be empty'],
    };
  }

  // Check for path traversal attempts
  if (PATH_TRAVERSAL_PATTERN.test(sanitized)) {
    errors.push('Project name cannot contain path traversal sequences (..)');
  }

  // Remove path traversal sequences
  sanitized = sanitized.replace(/\.\./g, '');

  // Check for invalid characters
  if (INVALID_FILENAME_CHARS.test(sanitized)) {
    errors.push('Project name contains invalid characters (\\/:*?"<>|)');
  }

  // Replace invalid characters with underscores
  sanitized = sanitized.replace(INVALID_FILENAME_CHARS, '_');

  // Replace whitespace with underscores
  sanitized = sanitized.replace(/\s+/g, '_');

  // Remove leading/trailing dots and spaces (Windows restriction)
  sanitized = sanitized.replace(/^[.\s]+|[.\s]+$/g, '');

  // Remove consecutive underscores
  sanitized = sanitized.replace(/_+/g, '_');

  // Check for Windows reserved names
  const upperName = sanitized.toUpperCase();
  const baseName = upperName.split('.')[0]; // Check without extension
  if (WINDOWS_RESERVED_NAMES.includes(baseName)) {
    errors.push(`"${sanitized}" is a reserved system name and cannot be used`);
    sanitized = `Project_${sanitized}`;
  }

  // Check for empty result after sanitization
  if (!sanitized) {
    return {
      isValid: false,
      sanitized: 'Untitled_Project',
      errors: ['Project name resulted in empty string after sanitization'],
    };
  }

  // Limit length (255 is max for most filesystems, but we use 100 for practicality)
  const MAX_LENGTH = 100;
  if (sanitized.length > MAX_LENGTH) {
    sanitized = sanitized.substring(0, MAX_LENGTH);
    errors.push(`Project name was truncated to ${MAX_LENGTH} characters`);
  }

  return {
    isValid: errors.length === 0,
    sanitized,
    errors,
  };
}

/**
 * Builds a safe project path from location and project name.
 *
 * @param location - The parent directory path
 * @param projectName - The project name (will be validated and sanitized)
 * @returns The full project path with sanitized project name
 * @throws Error if project name is invalid and cannot be sanitized
 *
 * @example
 * ```ts
 * buildProjectPath('C:/Users/Documents', 'My Project');
 * // 'C:/Users/Documents/My_Project'
 *
 * buildProjectPath('/home/user', '../../etc/passwd');
 * // '/home/user/etc_passwd' (traversal removed, invalid chars replaced)
 * ```
 */
export function buildProjectPath(location: string, projectName: string): string {
  const validation = validateProjectName(projectName);

  if (!validation.sanitized) {
    throw new Error('Invalid project name: cannot be empty');
  }

  // Normalize location path (remove trailing slashes)
  const normalizedLocation = location.replace(/[\\/]+$/, '');

  // Use forward slash for consistency (Tauri handles conversion)
  return `${normalizedLocation}/${validation.sanitized}`;
}

/**
 * Checks if a project name is valid without sanitizing.
 *
 * @param name - The project name to validate
 * @returns true if the name is valid as-is, false otherwise
 */
export function isValidProjectName(name: string): boolean {
  const trimmed = name.trim();

  if (!trimmed) return false;
  if (PATH_TRAVERSAL_PATTERN.test(trimmed)) return false;
  if (INVALID_FILENAME_CHARS.test(trimmed)) return false;
  if (/^[.\s]|[.\s]$/.test(trimmed)) return false;

  const upperName = trimmed.toUpperCase().split('.')[0];
  if (WINDOWS_RESERVED_NAMES.includes(upperName)) return false;

  return trimmed.length <= 100;
}
