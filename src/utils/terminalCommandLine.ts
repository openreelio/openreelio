export interface ParsedTerminalCommandLine {
  executable: string | null;
  args: string[];
  error: string | null;
}

function repairLegacyWindowsQuotedCommandLine(commandLine: string): string {
  if (commandLine.startsWith('"')) {
    return commandLine;
  }

  const quoteCount = Array.from(commandLine).filter((char) => char === '"').length;
  if (quoteCount % 2 === 1) {
    const firstQuoteIndex = commandLine.indexOf('"');
    if (firstQuoteIndex > 2) {
      const prefix = commandLine.slice(0, firstQuoteIndex);
      const looksWindowsPath = /^[A-Za-z]:[\\/]/.test(prefix);
      const looksExecutable = /\.(exe|cmd|bat|com)$/i.test(prefix);
      if (looksWindowsPath && looksExecutable) {
        return `"${commandLine}`;
      }
    }
  }

  return commandLine;
}

function tokenizeCommandLine(input: string): { tokens: string[]; error: string | null } {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }

      if (char === '\\' && input[index + 1] === quote) {
        current += quote;
        index += 1;
        continue;
      }

      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    return { tokens: [], error: 'Terminal command contains an unmatched quote.' };
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return { tokens, error: null };
}

export function parseTerminalCommandLine(commandLine: string | null): ParsedTerminalCommandLine {
  const input = repairLegacyWindowsQuotedCommandLine(commandLine?.trim() ?? '');
  if (input.length === 0) {
    return { executable: null, args: [], error: null };
  }

  const windowsExecutableMatch = input.match(
    /^([A-Za-z]:[\\/].*?\.(?:exe|cmd|bat|com))(?=\s|$)(?:\s+(.*))?$/i,
  );
  if (windowsExecutableMatch) {
    const executable = windowsExecutableMatch[1] ?? null;
    const rest = windowsExecutableMatch[2]?.trim() ?? '';
    const tokenizedArgs = tokenizeCommandLine(rest);

    if (tokenizedArgs.error) {
      return { executable: null, args: [], error: tokenizedArgs.error };
    }

    return {
      executable,
      args: tokenizedArgs.tokens,
      error: null,
    };
  }

  const tokenized = tokenizeCommandLine(input);
  if (tokenized.error) {
    return { executable: null, args: [], error: tokenized.error };
  }

  const tokens = tokenized.tokens;

  if (tokens.length === 0) {
    return { executable: null, args: [], error: 'Terminal command is empty.' };
  }

  return {
    executable: tokens[0] ?? null,
    args: tokens.slice(1),
    error: null,
  };
}
