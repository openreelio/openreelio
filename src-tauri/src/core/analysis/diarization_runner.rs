//! External diarization runner integration.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use crate::core::process::configure_tokio_command;
use crate::core::{CoreError, CoreResult};

/// Default timeout for external diarization runners.
const DEFAULT_DIARIZATION_TIMEOUT_SEC: u64 = 15 * 60;

/// Replaces supported placeholders in runner args.
pub fn expand_runner_args(args: &[String], audio_path: &Path, output_path: &Path) -> Vec<String> {
    let audio = audio_path.to_string_lossy();
    let output = output_path.to_string_lossy();

    args.iter()
        .map(|arg| {
            arg.replace("{audioPath}", &audio)
                .replace("{outputPath}", &output)
        })
        .collect()
}

/// Runs an external diarization command that writes JSON to the provided output path.
pub async fn run_external_diarization_runner(
    executable: &str,
    args: &[String],
    audio_path: &Path,
    output_path: &Path,
    timeout: Option<Duration>,
) -> CoreResult<PathBuf> {
    if executable.trim().is_empty() {
        return Err(CoreError::AnalysisFailed(
            "External diarization executable is required".to_string(),
        ));
    }

    if !audio_path.exists() {
        return Err(CoreError::AnalysisFailed(format!(
            "External diarization input audio not found: {}",
            audio_path.display()
        )));
    }

    if let Some(parent) = output_path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| {
            CoreError::Internal(format!(
                "Failed to create diarization output directory {}: {}",
                parent.display(),
                e
            ))
        })?;
    }

    let expanded_args = expand_runner_args(args, audio_path, output_path);
    let mut cmd = Command::new(executable);
    configure_tokio_command(&mut cmd);
    cmd.args(&expanded_args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = tokio::time::timeout(
        timeout.unwrap_or_else(|| Duration::from_secs(DEFAULT_DIARIZATION_TIMEOUT_SEC)),
        cmd.output(),
    )
    .await
    .map_err(|_| CoreError::AnalysisFailed("External diarization runner timed out".to_string()))?
    .map_err(|e| {
        CoreError::AnalysisFailed(format!(
            "Failed to spawn external diarization runner '{}': {}",
            executable, e
        ))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CoreError::AnalysisFailed(format!(
            "External diarization runner failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        )));
    }

    if !output_path.exists() {
        return Err(CoreError::AnalysisFailed(format!(
            "External diarization runner completed but did not create output JSON: {}",
            output_path.display()
        )));
    }

    Ok(output_path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_runner_args_should_replace_supported_placeholders() {
        let args = vec![
            "--input".to_string(),
            "{audioPath}".to_string(),
            "--output".to_string(),
            "{outputPath}".to_string(),
        ];

        let expanded =
            expand_runner_args(&args, Path::new("/tmp/in.wav"), Path::new("/tmp/out.json"));

        assert_eq!(expanded[1], "/tmp/in.wav");
        assert_eq!(expanded[3], "/tmp/out.json");
    }
}
