import { describe, expect, it } from 'vitest';
import { parseTerminalCommandLine } from './terminalCommandLine';

describe('parseTerminalCommandLine', () => {
  it('should parse a plain executable', () => {
    expect(parseTerminalCommandLine('pwsh.exe')).toEqual({
      executable: 'pwsh.exe',
      args: [],
      error: null,
    });
  });

  it('should parse quoted paths with arguments', () => {
    expect(parseTerminalCommandLine('"C:\\Program Files\\Git\\bin\\bash.exe" --login -i')).toEqual({
      executable: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['--login', '-i'],
      error: null,
    });
  });

  it('should parse WSL distro arguments', () => {
    expect(parseTerminalCommandLine('wsl.exe -d "Ubuntu"')).toEqual({
      executable: 'wsl.exe',
      args: ['-d', 'Ubuntu'],
      error: null,
    });
  });

  it('should parse a quoted Git Bash path with login args', () => {
    expect(parseTerminalCommandLine('"C:\\Program Files\\Git\\bin\\bash.exe" --login -i')).toEqual({
      executable: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['--login', '-i'],
      error: null,
    });
  });

  it('should recover a legacy trimmed Git Bash command line', () => {
    expect(parseTerminalCommandLine('C:\\Program Files\\Git\\bin\\bash.exe" --login -i')).toEqual({
      executable: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['--login', '-i'],
      error: null,
    });
  });

  it('should parse an unquoted Windows executable path with spaces', () => {
    expect(parseTerminalCommandLine('C:\\Program Files\\Git\\bin\\bash.exe --login -i')).toEqual({
      executable: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['--login', '-i'],
      error: null,
    });
  });

  it('should report unmatched quotes', () => {
    expect(parseTerminalCommandLine('"/bin/zsh')).toEqual({
      executable: null,
      args: [],
      error: 'Terminal command contains an unmatched quote.',
    });
  });
});
