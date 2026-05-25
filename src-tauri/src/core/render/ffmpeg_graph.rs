//! Pure FFmpeg invocation contract.
//!
//! This module owns the typed boundary between graph/plan builders and process
//! execution. It does not spawn FFmpeg or access project state.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use specta::Type;

use super::RenderPlan;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegInvocation {
    pub args: Vec<String>,
    pub output_path: PathBuf,
    pub estimated_frames: u64,
    pub plan_hash: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FfmpegInvocationError {
    MissingOutputPath,
}

impl std::fmt::Display for FfmpegInvocationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingOutputPath => write!(formatter, "No output path in FFmpeg arguments"),
        }
    }
}

impl std::error::Error for FfmpegInvocationError {}

pub fn build_ffmpeg_invocation_from_args(
    args: Vec<String>,
    estimated_frames: u64,
    plan_hash: Option<String>,
) -> Result<FfmpegInvocation, FfmpegInvocationError> {
    let output_path = args
        .last()
        .filter(|arg| !arg.starts_with('-'))
        .map(PathBuf::from)
        .ok_or(FfmpegInvocationError::MissingOutputPath)?;

    Ok(FfmpegInvocation {
        args,
        output_path,
        estimated_frames,
        plan_hash,
    })
}

pub fn build_ffmpeg_invocation_for_render_plan(
    plan: &RenderPlan,
    args: Vec<String>,
) -> Result<FfmpegInvocation, FfmpegInvocationError> {
    build_ffmpeg_invocation_from_args(
        args,
        plan.output_duration_frames as u64,
        Some(plan.plan_hash.clone()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffmpeg_invocation_extracts_output_path_from_args() {
        let invocation = build_ffmpeg_invocation_from_args(
            vec![
                "-i".to_string(),
                "input.mp4".to_string(),
                "-c:v".to_string(),
                "libx264".to_string(),
                "/tmp/out.mp4".to_string(),
            ],
            120,
            Some("planhash".to_string()),
        )
        .expect("invocation");

        assert_eq!(invocation.output_path, PathBuf::from("/tmp/out.mp4"));
        assert_eq!(invocation.estimated_frames, 120);
        assert_eq!(invocation.plan_hash.as_deref(), Some("planhash"));
    }

    #[test]
    fn ffmpeg_invocation_rejects_args_without_output_path() {
        let error =
            build_ffmpeg_invocation_from_args(vec!["-version".to_string()], 0, None).unwrap_err();

        assert_eq!(error, FfmpegInvocationError::MissingOutputPath);
    }

    #[test]
    fn ffmpeg_invocation_uses_render_plan_hash_and_frame_estimate() {
        let plan = RenderPlan {
            sequence_id: "seq-1".to_string(),
            graph_version: 1,
            output_start_sec: 0.0,
            output_end_sec: 4.0,
            output_start_frame: 0,
            output_end_frame: 120,
            output_duration_frames: 120,
            video_layers: Vec::new(),
            audio_layers: Vec::new(),
            validation: super::super::RenderPlanValidation {
                is_valid: true,
                errors: Vec::new(),
                warnings: Vec::new(),
            },
            plan_hash: "render-plan-hash".to_string(),
        };

        let invocation = build_ffmpeg_invocation_for_render_plan(
            &plan,
            vec![
                "-i".to_string(),
                "input.mp4".to_string(),
                "out.mp4".to_string(),
            ],
        )
        .expect("invocation");

        assert_eq!(invocation.estimated_frames, 120);
        assert_eq!(invocation.plan_hash.as_deref(), Some("render-plan-hash"));
    }
}
