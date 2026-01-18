/**
 * Project Path Utilities Tests
 */

import { describe, it, expect } from 'vitest';
import {
  validateProjectName,
  buildProjectPath,
  isValidProjectName,
} from './projectPath';

describe('validateProjectName', () => {
  describe('valid names', () => {
    it('should accept simple alphanumeric names', () => {
      const result = validateProjectName('MyProject');
      expect(result.isValid).toBe(true);
      expect(result.sanitized).toBe('MyProject');
      expect(result.errors).toHaveLength(0);
    });

    it('should accept names with spaces (converts to underscores)', () => {
      const result = validateProjectName('My Project');
      expect(result.isValid).toBe(true);
      expect(result.sanitized).toBe('My_Project');
    });

    it('should accept names with numbers', () => {
      const result = validateProjectName('Project2024');
      expect(result.isValid).toBe(true);
      expect(result.sanitized).toBe('Project2024');
    });

    it('should accept names with underscores', () => {
      const result = validateProjectName('my_project_name');
      expect(result.isValid).toBe(true);
      expect(result.sanitized).toBe('my_project_name');
    });

    it('should accept names with hyphens', () => {
      const result = validateProjectName('my-project-name');
      expect(result.isValid).toBe(true);
      expect(result.sanitized).toBe('my-project-name');
    });
  });

  describe('path traversal prevention', () => {
    it('should reject names with ../', () => {
      const result = validateProjectName('../evil');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(
        'Project name cannot contain path traversal sequences (..)',
      );
      expect(result.sanitized).toBe('_evil');
    });

    it('should reject names with ..\\', () => {
      const result = validateProjectName('..\\evil');
      expect(result.isValid).toBe(false);
      expect(result.sanitized).not.toContain('..');
    });

    it('should reject names with ../../', () => {
      const result = validateProjectName('../../etc/passwd');
      expect(result.isValid).toBe(false);
      expect(result.sanitized).not.toContain('..');
      expect(result.sanitized).not.toContain('/');
    });

    it('should reject names with embedded ..', () => {
      const result = validateProjectName('foo/../bar');
      expect(result.isValid).toBe(false);
      expect(result.sanitized).not.toContain('..');
    });
  });

  describe('invalid character handling', () => {
    it('should reject and replace backslashes', () => {
      const result = validateProjectName('path\\to\\project');
      expect(result.isValid).toBe(false);
      expect(result.sanitized).toBe('path_to_project');
    });

    it('should reject and replace forward slashes', () => {
      const result = validateProjectName('path/to/project');
      expect(result.isValid).toBe(false);
      expect(result.sanitized).toBe('path_to_project');
    });

    it('should reject and replace colons', () => {
      const result = validateProjectName('C:Project');
      expect(result.isValid).toBe(false);
      expect(result.sanitized).toBe('C_Project');
    });

    it('should reject and replace asterisks', () => {
      const result = validateProjectName('Project*Name');
      expect(result.isValid).toBe(false);
      expect(result.sanitized).toBe('Project_Name');
    });

    it('should reject and replace question marks', () => {
      const result = validateProjectName('Project?');
      expect(result.isValid).toBe(false);
      expect(result.sanitized).toBe('Project_');
    });

    it('should reject and replace quotes', () => {
      const result = validateProjectName('"Project"');
      expect(result.isValid).toBe(false);
      expect(result.sanitized).toBe('_Project_');
    });

    it('should reject and replace angle brackets', () => {
      const result = validateProjectName('<Project>');
      expect(result.isValid).toBe(false);
      expect(result.sanitized).toBe('_Project_');
    });

    it('should reject and replace pipes', () => {
      const result = validateProjectName('Project|Name');
      expect(result.isValid).toBe(false);
      expect(result.sanitized).toBe('Project_Name');
    });
  });

  describe('Windows reserved names', () => {
    it('should reject CON', () => {
      const result = validateProjectName('CON');
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('reserved'))).toBe(true);
    });

    it('should reject PRN', () => {
      const result = validateProjectName('PRN');
      expect(result.isValid).toBe(false);
    });

    it('should reject COM1', () => {
      const result = validateProjectName('COM1');
      expect(result.isValid).toBe(false);
    });

    it('should reject LPT1', () => {
      const result = validateProjectName('LPT1');
      expect(result.isValid).toBe(false);
    });

    it('should reject NUL', () => {
      const result = validateProjectName('NUL');
      expect(result.isValid).toBe(false);
    });

    it('should reject reserved names case-insensitively', () => {
      const result = validateProjectName('con');
      expect(result.isValid).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should reject empty string', () => {
      const result = validateProjectName('');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Project name cannot be empty');
    });

    it('should reject whitespace-only string', () => {
      const result = validateProjectName('   ');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Project name cannot be empty');
    });

    it('should handle leading/trailing spaces', () => {
      const result = validateProjectName('  Project  ');
      expect(result.isValid).toBe(true);
      expect(result.sanitized).toBe('Project');
    });

    it('should remove leading dots', () => {
      const result = validateProjectName('.hidden');
      expect(result.sanitized).toBe('hidden');
    });

    it('should remove trailing dots', () => {
      const result = validateProjectName('Project.');
      expect(result.sanitized).toBe('Project');
    });

    it('should collapse consecutive underscores', () => {
      const result = validateProjectName('My   Project');
      expect(result.sanitized).toBe('My_Project');
    });

    it('should truncate names longer than 100 characters', () => {
      const longName = 'A'.repeat(150);
      const result = validateProjectName(longName);
      expect(result.sanitized.length).toBe(100);
      expect(result.errors.some((e) => e.includes('truncated'))).toBe(true);
    });
  });
});

describe('buildProjectPath', () => {
  it('should build path with simple name', () => {
    const path = buildProjectPath('/home/user/projects', 'MyProject');
    expect(path).toBe('/home/user/projects/MyProject');
  });

  it('should sanitize project name in path', () => {
    const path = buildProjectPath('/home/user/projects', 'My Project');
    expect(path).toBe('/home/user/projects/My_Project');
  });

  it('should remove path traversal from name', () => {
    const path = buildProjectPath('/home/user/projects', '../../evil');
    expect(path).not.toContain('..');
    expect(path.startsWith('/home/user/projects/')).toBe(true);
  });

  it('should handle Windows-style location paths', () => {
    const path = buildProjectPath('C:\\Users\\Documents', 'Project');
    expect(path).toBe('C:\\Users\\Documents/Project');
  });

  it('should remove trailing slashes from location', () => {
    const path = buildProjectPath('/home/user/projects/', 'MyProject');
    expect(path).toBe('/home/user/projects/MyProject');
  });

  it('should throw error for empty name after sanitization', () => {
    expect(() => buildProjectPath('/home', '')).toThrow('Invalid project name');
  });
});

describe('isValidProjectName', () => {
  it('should return true for valid names', () => {
    expect(isValidProjectName('MyProject')).toBe(true);
    expect(isValidProjectName('Project_2024')).toBe(true);
    expect(isValidProjectName('my-project')).toBe(true);
  });

  it('should return false for invalid names', () => {
    expect(isValidProjectName('')).toBe(false);
    expect(isValidProjectName('../evil')).toBe(false);
    expect(isValidProjectName('path/to/project')).toBe(false);
    expect(isValidProjectName('CON')).toBe(false);
    expect(isValidProjectName('.hidden')).toBe(false);
  });

  it('should return true for names with spaces (will be sanitized)', () => {
    // Names with spaces are valid - they will be sanitized to underscores
    // This is acceptable user input, not a security concern
    expect(isValidProjectName('My Project')).toBe(true);
  });
});
