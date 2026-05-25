//! FFmpeg process executor.
//!
//! This module is intentionally below the render plan/invocation boundary. It
//! receives a typed invocation and owns subprocess execution, progress parsing,
//! cancellation, stderr draining, and terminal file metadata collection.

use std::path::{Path, PathBuf};

use tokio::sync::{mpsc::Sender, oneshot};

use super::{
    export::{
        calculate_export_progress, parse_ffmpeg_progress_line, ExportError, ExportProgress,
        FFmpegProgressData,
    },
    FfmpegInvocation,
};
use crate::core::process::configure_tokio_command;

#[derive(Clone, Debug)]
pub struct FfmpegExecutionResult {
    pub output_path: PathBuf,
    pub file_size: u64,
    pub encoding_time_sec: f64,
}

#[derive(Clone, Debug)]
pub struct FfmpegOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub async fn execute_ffmpeg_output(
    ffmpeg_path: &Path,
    args: &[String],
) -> Result<FfmpegOutput, ExportError> {
    let mut cmd = tokio::process::Command::new(ffmpeg_path);
    configure_tokio_command(&mut cmd);
    let output = cmd
        .args(args)
        .output()
        .await
        .map_err(|e| ExportError::FFmpegFailed(format!("Failed to spawn FFmpeg: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ExportError::FFmpegFailed(stderr.to_string()));
    }

    Ok(FfmpegOutput {
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

pub async fn execute_ffmpeg_invocation(
    ffmpeg_path: &Path,
    invocation: FfmpegInvocation,
    duration_sec: f64,
    progress_tx: Option<Sender<ExportProgress>>,
    cancel_rx: Option<oneshot::Receiver<()>>,
    start_message: impl Into<String>,
    complete_message: impl Into<String>,
) -> Result<FfmpegExecutionResult, ExportError> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

    let start_time = std::time::Instant::now();
    let total_frames = invocation.estimated_frames;
    let start_message = start_message.into();
    let complete_message = complete_message.into();
    let progress_completion_tx = progress_tx.clone();

    if let Some(ref tx) = progress_tx {
        let _ = tx
            .send(ExportProgress {
                frame: 0,
                total_frames,
                percent: 0.0,
                fps: 0.0,
                eta_seconds: 0,
                message: start_message,
            })
            .await;
    }

    let mut cmd = tokio::process::Command::new(ffmpeg_path);
    configure_tokio_command(&mut cmd);
    cmd.args(&invocation.args).stderr(Stdio::piped());
    if progress_tx.is_some() {
        cmd.stdout(Stdio::piped());
    } else {
        cmd.stdout(Stdio::null());
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| ExportError::FFmpegFailed(format!("Failed to spawn FFmpeg: {}", e)))?;

    let stderr_handle = child.stderr.take().map(|stderr| {
        tokio::spawn(async move {
            let mut buf = Vec::new();
            let mut stderr = stderr;
            let _ = stderr.read_to_end(&mut buf).await;
            String::from_utf8_lossy(&buf).to_string()
        })
    });

    let progress_handle = if let (Some(stdout), Some(tx)) = (child.stdout.take(), progress_tx) {
        Some(tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            let mut progress_data = FFmpegProgressData::default();

            while let Ok(Some(line)) = lines.next_line().await {
                let is_progress_line = parse_ffmpeg_progress_line(&line, &mut progress_data);
                if is_progress_line && line.trim_start().starts_with("progress=") {
                    let progress =
                        calculate_export_progress(&progress_data, duration_sec, total_frames);

                    if tx.send(progress).await.is_err() {
                        break;
                    }
                }
            }
        }))
    } else {
        None
    };

    let status =
        if let Some(cancel_rx) = cancel_rx {
            tokio::select! {
                result = child.wait() => {
                    Some(result.map_err(|e| ExportError::FFmpegFailed(
                        format!("Failed to wait for FFmpeg: {}", e),
                    ))?)
                }
                _ = cancel_rx => {
                    let _ = child.kill().await;
                    None
                }
            }
        } else {
            Some(child.wait().await.map_err(|e| {
                ExportError::FFmpegFailed(format!("Failed to wait for FFmpeg: {}", e))
            })?)
        };

    if let Some(handle) = progress_handle {
        let _ = handle.await;
    }

    let Some(status) = status else {
        if let Some(handle) = stderr_handle {
            let _ = handle.await;
        }
        let _ = tokio::fs::remove_file(&invocation.output_path).await;
        return Err(ExportError::Cancelled);
    };

    if !status.success() {
        let stderr_msg = if let Some(handle) = stderr_handle {
            handle
                .await
                .unwrap_or_else(|_| "Failed to read stderr".to_string())
        } else {
            format!("FFmpeg exited with status: {}", status)
        };
        return Err(ExportError::FFmpegFailed(stderr_msg));
    }

    if let Some(handle) = stderr_handle {
        let _ = handle.await;
    }

    if let Some(tx) = progress_completion_tx {
        let _ = tx
            .send(ExportProgress {
                frame: total_frames,
                total_frames,
                percent: 100.0,
                fps: 0.0,
                eta_seconds: 0,
                message: complete_message,
            })
            .await;
    }

    let file_size = std::fs::metadata(&invocation.output_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);

    Ok(FfmpegExecutionResult {
        output_path: invocation.output_path,
        file_size,
        encoding_time_sec: start_time.elapsed().as_secs_f64(),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::core::render::FfmpegInvocation;

    fn shell_quote(path: &Path) -> String {
        format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
    }

    #[tokio::test]
    async fn should_send_completion_progress_only_after_successful_exit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output_path = dir.path().join("out.mp4");
        let script = format!(
            "printf 'frame=3\\nprogress=continue\\n'; : > {}",
            shell_quote(&output_path)
        );
        let invocation = FfmpegInvocation {
            args: vec!["-c".to_string(), script],
            output_path: output_path.clone(),
            estimated_frames: 3,
            plan_hash: Some("plan-ok".to_string()),
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);

        let result = execute_ffmpeg_invocation(
            Path::new("sh"),
            invocation,
            1.0,
            Some(tx),
            None,
            "start",
            "done",
        )
        .await
        .expect("execution");

        assert_eq!(result.output_path, output_path);

        let mut messages = Vec::new();
        while let Ok(progress) = rx.try_recv() {
            messages.push(progress.message);
        }

        assert_eq!(messages.first().map(String::as_str), Some("start"));
        assert_eq!(messages.last().map(String::as_str), Some("done"));
    }

    #[tokio::test]
    async fn should_not_send_completion_progress_after_failed_exit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output_path = dir.path().join("failed.mp4");
        let script = "printf 'frame=3\\nprogress=continue\\n'; printf 'boom' >&2; exit 7";
        let invocation = FfmpegInvocation {
            args: vec!["-c".to_string(), script.to_string()],
            output_path,
            estimated_frames: 3,
            plan_hash: Some("plan-fail".to_string()),
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);

        let result = execute_ffmpeg_invocation(
            Path::new("sh"),
            invocation,
            1.0,
            Some(tx),
            None,
            "start",
            "done",
        )
        .await;

        assert!(
            matches!(result, Err(ExportError::FFmpegFailed(message)) if message.contains("boom"))
        );

        let mut messages = Vec::new();
        while let Ok(progress) = rx.try_recv() {
            messages.push(progress.message);
        }

        assert_eq!(messages.first().map(String::as_str), Some("start"));
        assert!(!messages.iter().any(|message| message == "done"));
    }
}
