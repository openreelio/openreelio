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

/// The option whose value is a filtergraph written straight into the argv.
const FILTER_COMPLEX_OPTION: &str = "-filter_complex";

/// The option whose value is the *path* of a file holding the filtergraph.
///
/// FFmpeg's `-/name value` form reads "set option `name` to the contents of the
/// file `value`", and has done since FFmpeg 7.0.
const FILTER_SCRIPT_OPTION: &str = "-/filter_complex";

/// The first FFmpeg major release that understands the `-/option file` form.
const FILTER_SCRIPT_MINIMUM_MAJOR: u32 = 7;

/// Whether a reported FFmpeg version can read a filtergraph from a file.
///
/// [`crate::core::ffmpeg::FFmpegInfo::version`] is whatever `get_ffmpeg_version`
/// scraped off the banner, which is only loosely a version number: releases give
/// `8.0.1` or `8.0.1-essentials_build-www.gyan.dev`, distributions give `n6.1`,
/// git builds give `N-109421-g1b2c3d4`, and a banner that did not parse at all
/// yields the whole first line.
///
/// So this reads a major version only from the unambiguous shape — leading ASCII
/// digits terminated by `.`, `-`, or the end of the string — and answers `false`
/// for everything else. That conservative default is the point: a `false` here
/// routes the graph inline, which is what every FFmpeg has always accepted, so an
/// unrecognised version keeps behaving exactly as it did before the script-file
/// path existed. Guessing the other way would break every export on that binary.
pub fn ffmpeg_supports_filter_script(version: &str) -> bool {
    let version = version.trim();
    let digits: String = version.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return false;
    }

    // Anything other than a version separator after the digits means this was
    // never a version number, so it is not evidence of anything.
    match version[digits.len()..].chars().next() {
        None | Some('.') | Some('-') => {}
        Some(_) => return false,
    }

    digits
        .parse::<u32>()
        .is_ok_and(|major| major >= FILTER_SCRIPT_MINIMUM_MAJOR)
}

/// Moves an argument list's filtergraph out of the argv and into a script file.
///
/// Windows caps a command line at 32,767 characters, and the graph is by far the
/// largest argument: one clip animated through a dozen motion keyframes carries
/// kilobytes of `scale`/`overlay` expressions on its own, so a timeline with a
/// handful of them overflows the limit and the export dies before FFmpeg starts.
/// Handing the graph over as a file keeps the command line a constant size no
/// matter how big the graph gets.
///
/// `use_script_file` is [`ffmpeg_supports_filter_script`] for the binary this
/// export will actually run. When it is `false` the arguments are returned
/// untouched and nothing is written: FFmpeg releases before 7.0 have no `-/`
/// form, and handing them one would break every export rather than only the
/// oversized ones. Those binaries keep the inline graph they have always had —
/// command-line limit included, which is no worse than before this path existed.
///
/// Nothing about the graph's *content* changes — the bytes written here are the
/// bytes the builders produced. Unlike the ASS overlay path, which interpolates a
/// filename into the filtergraph grammar and so has to escape it, this path is a
/// plain argv value handed to `Command::arg`, so no quoting is involved and a
/// temp directory containing spaces or apostrophes is harmless.
///
/// The returned [`tempfile::TempDir`] owns the script: dropping it deletes the
/// file, so the caller must keep it alive until FFmpeg has exited. Returns
/// `None` for an argument list with no filtergraph, which is left untouched.
pub fn materialize_filter_script(
    mut args: Vec<String>,
    use_script_file: bool,
) -> std::io::Result<(Vec<String>, Option<tempfile::TempDir>)> {
    if !use_script_file {
        return Ok((args, None));
    }

    let Some(option_index) = args.iter().position(|arg| arg == FILTER_COMPLEX_OPTION) else {
        return Ok((args, None));
    };
    let Some(graph_index) = option_index
        .checked_add(1)
        .filter(|index| *index < args.len())
    else {
        return Ok((args, None));
    };

    let directory = tempfile::Builder::new()
        .prefix("openreelio-filtergraph-")
        .tempdir()?;
    let script_path = directory.path().join("filter_complex.txt");
    std::fs::write(&script_path, args[graph_index].as_bytes())?;

    // Every downstream argument is a `String`, so a path that is not valid UTF-8
    // has to fail loudly here rather than be silently mangled into one.
    let script_arg = script_path
        .to_str()
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Filtergraph script path is not valid UTF-8: {script_path:?}"),
            )
        })?
        .to_string();

    args[option_index] = FILTER_SCRIPT_OPTION.to_string();
    args[graph_index] = script_arg;
    Ok((args, Some(directory)))
}

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

    /// Feature: Filtergraph delivery
    /// Scenario: the graph travels as a file, byte for byte
    ///
    /// The command line is capped — 32,767 characters on Windows — and the graph
    /// is the one argument with no upper bound on its size. Moving it to a file
    /// must change nothing about its content, or every existing render changes
    /// with it.
    #[test]
    fn filter_script_moves_the_graph_into_a_file_unchanged() {
        // Commas, quotes, colons and backslashes all mean something to one
        // grammar or another on the way to FFmpeg; none may be rewritten here.
        let graph = "[0:v]scale=w='if(lt(t,1),640,720)':h=360:eval=frame[v];\
                     [v]drawtext=text='a\\,b':x=3[out]";
        let args = vec![
            "-i".to_string(),
            "in.mp4".to_string(),
            "-filter_complex".to_string(),
            graph.to_string(),
            "-map".to_string(),
            "[out]".to_string(),
            "out.mp4".to_string(),
        ];

        let (rewritten, directory) = materialize_filter_script(args, true).expect("materialize");
        let directory = directory.expect("a graph must produce a script");

        assert_eq!(rewritten[2], "-/filter_complex");
        assert_eq!(
            std::fs::read_to_string(&rewritten[3]).expect("read script"),
            graph,
            "the script must hold exactly the bytes the builder produced"
        );
        assert_eq!(
            rewritten.last().map(String::as_str),
            Some("out.mp4"),
            "the output path must stay last so the invocation can still find it"
        );
        assert_eq!(
            rewritten.len(),
            7,
            "the rewrite must stay a one-for-one swap of the option and its value"
        );

        // The script only has to outlive FFmpeg, and the handle is what keeps it.
        let script_path = std::path::PathBuf::from(&rewritten[3]);
        assert!(script_path.exists());
        drop(directory);
        assert!(
            !script_path.exists(),
            "dropping the handle must clean the script up"
        );
    }

    /// Feature: Filtergraph delivery
    /// Scenario: only FFmpeg 7.0 and later is offered a script file
    ///
    /// The `-/option file` form arrived in FFmpeg 7.0. Handing it to an older
    /// binary does not degrade the export, it kills it — and it would kill every
    /// export, not just the oversized graphs the script file exists for.
    #[test]
    fn filter_script_support_is_decided_by_the_major_version() {
        for version in [
            "7.0",
            "7.1.1",
            "8.0.1",
            "8.0.1-essentials_build-www.gyan.dev",
            "10.2",
            "8",
        ] {
            assert!(
                ffmpeg_supports_filter_script(version),
                "{version} is 7.0 or later and can read a filtergraph from a file"
            );
        }

        for version in ["6.1.1", "6.1.1-static", "5.0", "4.4", "0.11"] {
            assert!(
                !ffmpeg_supports_filter_script(version),
                "{version} predates the -/option form"
            );
        }
    }

    /// Feature: Filtergraph delivery
    /// Scenario: a version string nobody can read means inline
    ///
    /// `get_ffmpeg_version` hands back whatever it scraped off the banner, and
    /// falls back to the entire first line when even that fails. Every one of
    /// these has to land on the inline path, because inline is what every FFmpeg
    /// has always accepted: guessing "probably new enough" and guessing wrong
    /// breaks the user's export outright.
    #[test]
    fn an_unreadable_ffmpeg_version_falls_back_to_the_inline_graph() {
        for version in [
            "",
            "   ",
            "n6.1",
            "n7.1",
            "N-109421-g1b2c3d4",
            "unknown",
            "ffmpeg version 8.0.1 Copyright (c) 2000-2025",
            "7x",
            "v7.0",
            "-7.0",
            "99999999999999999999.0",
        ] {
            assert!(
                !ffmpeg_supports_filter_script(version),
                "{version:?} is not a legible major version, so it must stay inline"
            );
        }
    }

    /// Feature: Filtergraph delivery
    /// Scenario: an unsupported FFmpeg keeps the arguments it always had
    ///
    /// This is the no-regression guarantee: on the inline branch the argument
    /// list must come back byte-identical, with no temp directory and no file
    /// written anywhere.
    #[test]
    fn filter_script_leaves_the_graph_inline_when_ffmpeg_is_too_old() {
        let graph = "[0:v]scale=w='if(lt(t,1),640,720)':h=360:eval=frame[out]";
        let args = vec![
            "-i".to_string(),
            "in.mp4".to_string(),
            "-filter_complex".to_string(),
            graph.to_string(),
            "-map".to_string(),
            "[out]".to_string(),
            "out.mp4".to_string(),
        ];

        let (rewritten, directory) =
            materialize_filter_script(args.clone(), false).expect("materialize");

        assert_eq!(
            rewritten, args,
            "an unsupported FFmpeg must be handed exactly the arguments it always was"
        );
        assert!(
            directory.is_none(),
            "the inline path must not create a temp directory"
        );
    }

    /// Feature: Filtergraph delivery
    /// Scenario: an argument list with no graph is left alone
    ///
    /// Still-frame extraction and the codec probes share this boundary and carry
    /// no filtergraph; they must not pay for a temp directory.
    #[test]
    fn filter_script_leaves_a_graphless_command_untouched() {
        let args = vec![
            "-i".to_string(),
            "in.mp4".to_string(),
            "-frames:v".to_string(),
            "1".to_string(),
            "out.png".to_string(),
        ];

        let (rewritten, directory) =
            materialize_filter_script(args.clone(), true).expect("materialize");

        assert_eq!(rewritten, args);
        assert!(
            directory.is_none(),
            "no graph means no script and no temp directory"
        );
    }

    /// Feature: Filtergraph delivery
    /// Scenario: a truncated command cannot be rewritten into nonsense
    ///
    /// `-filter_complex` as the final argument has no value to move. Rewriting
    /// the option anyway would hand FFmpeg a script path that is not there.
    #[test]
    fn filter_script_ignores_a_dangling_filter_complex_option() {
        let args = vec!["-i".to_string(), "-filter_complex".to_string()];

        let (rewritten, directory) =
            materialize_filter_script(args.clone(), true).expect("materialize");

        assert_eq!(rewritten, args);
        assert!(directory.is_none());
    }
}
