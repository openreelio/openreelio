//! Terminal command-line parsing helpers.

/// Repairs a legacy Windows command line where a quoted path accidentally lost
/// its opening quote, for example `C:\Program Files\App\app.exe" --flag`.
pub fn repair_legacy_windows_quoted_command_line(command_line: &str) -> String {
    let input = command_line.trim();
    if input.is_empty() || input.starts_with('"') {
        return input.to_string();
    }

    let quote_count = input.chars().filter(|ch| *ch == '"').count();
    if quote_count % 2 == 1 {
        if let Some(first_quote_index) = input.find('"') {
            let prefix = &input[..first_quote_index];
            let looks_windows_path = prefix.len() >= 3
                && prefix.as_bytes()[1] == b':'
                && matches!(prefix.as_bytes()[2], b'\\' | b'/');
            let lower_prefix = prefix.to_ascii_lowercase();
            let looks_executable = [".exe", ".cmd", ".bat", ".com"]
                .iter()
                .any(|extension| lower_prefix.ends_with(extension));

            if looks_windows_path && looks_executable {
                return format!("\"{input}");
            }
        }
    }

    input.to_string()
}

fn split_windows_executable_with_spaces(command_line: &str) -> Option<(&str, &str)> {
    let input = command_line.trim();
    let bytes = input.as_bytes();
    if bytes.len() < 4
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || !matches!(bytes[2], b'\\' | b'/')
    {
        return None;
    }

    let lower = input.to_ascii_lowercase();
    for (index, _) in lower.match_indices('.') {
        for extension in [".exe", ".cmd", ".bat", ".com"] {
            if !lower[index..].starts_with(extension) {
                continue;
            }
            let executable_end = index + extension.len();
            let rest = &input[executable_end..];
            if rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace) {
                return Some((&input[..executable_end], rest.trim()));
            }
        }
    }

    None
}

fn tokenize_command_line(command_line: &str) -> Result<Vec<String>, String> {
    let repaired = repair_legacy_windows_quoted_command_line(command_line);
    let input = repaired.trim();
    if input.is_empty() {
        return Err("Terminal profile command line is empty".to_string());
    }

    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
                continue;
            }

            if ch == '\\' && chars.peek() == Some(&active_quote) {
                current.push(active_quote);
                chars.next();
                continue;
            }

            current.push(ch);
            continue;
        }

        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }

        if ch.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            continue;
        }

        current.push(ch);
    }

    if quote.is_some() {
        return Err("Terminal profile command line contains an unmatched quote".to_string());
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    if tokens.is_empty() {
        return Err("Terminal profile command line is empty".to_string());
    }

    Ok(tokens)
}

pub fn parse_terminal_command_line(command_line: &str) -> Result<(String, Vec<String>), String> {
    let repaired = repair_legacy_windows_quoted_command_line(command_line);
    let input = repaired.trim();
    if let Some((executable, rest)) = split_windows_executable_with_spaces(input) {
        let args = if rest.is_empty() {
            Vec::new()
        } else {
            tokenize_command_line(rest)?
        };
        return Ok((executable.to_string(), args));
    }

    let tokens = tokenize_command_line(input)?;
    let executable = tokens
        .first()
        .cloned()
        .ok_or_else(|| "Terminal profile command line is empty".to_string())?;
    Ok((executable, tokens.into_iter().skip(1).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quoted_windows_path() {
        let (executable, args) =
            parse_terminal_command_line(r#""C:\Program Files\Git\bin\bash.exe" --login -i"#)
                .unwrap();

        assert_eq!(executable, r#"C:\Program Files\Git\bin\bash.exe"#);
        assert_eq!(args, vec!["--login".to_string(), "-i".to_string()]);
    }

    #[test]
    fn parses_unquoted_legacy_windows_path_with_spaces() {
        let (executable, args) =
            parse_terminal_command_line(r#"C:\Program Files\Git\bin\bash.exe --login -i"#).unwrap();

        assert_eq!(executable, r#"C:\Program Files\Git\bin\bash.exe"#);
        assert_eq!(args, vec!["--login".to_string(), "-i".to_string()]);
    }

    #[test]
    fn repairs_missing_opening_quote_for_legacy_windows_path() {
        let (executable, args) =
            parse_terminal_command_line(r#"C:\Program Files\Git\bin\bash.exe" --login -i"#)
                .unwrap();

        assert_eq!(executable, r#"C:\Program Files\Git\bin\bash.exe"#);
        assert_eq!(args, vec!["--login".to_string(), "-i".to_string()]);
    }

    #[test]
    fn rejects_unmatched_quote() {
        let result = parse_terminal_command_line(r#""/bin/zsh"#);

        assert!(result.is_err());
    }
}
