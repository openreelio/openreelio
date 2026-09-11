//! The QC pre-pass that measures where the burn-in actually puts each caption.
//!
//! # Why this is a pre-pass and not a rule
//!
//! QC rules never spawn FFmpeg. A rule is a pure function of the sequence and
//! the [`QCContext`], so the whole rule set can run in one pass, in any order,
//! on a machine with no toolchain at all. Anything that needs a subprocess runs
//! *before* the rules and leaves its findings on the context — which is how
//! [`crate::core::qc::caption_contrast`] already works, and this mirrors its
//! shape deliberately: samples, a coverage record, and notes for the report.
//!
//! # The state this pass introduced
//!
//! Every measurement pass before it needed a rendered file. This one does not:
//! it renders synthetic cues over a transparent canvas and reads the inked alpha
//! box back, so all it needs is an FFmpeg binary. That creates a third run
//! state, between "structural only" and "measure this render":
//!
//! | run | FFmpeg | extent pass |
//! |-----|--------|-------------|
//! | `--structural-only` | never resolved | skipped |
//! | `--path` alone | resolved if it can be | runs when it was |
//! | `--path --file R` | already resolved | runs (it does not read `R`) |
//!
//! The middle row is the new one, and it is *opportunistic*: a machine with no
//! FFmpeg still verifies exactly as it did before, and the rule falls back to
//! its estimate. A missing binary is never an error on a structural run.
//!
//! # Honesty
//!
//! A cue with no entry in the returned samples was **not measured**. It is never
//! "measured and fine". The coverage record names every cue that fell out and
//! why, so a caller cannot read a short list as a clean bill of health.

use std::collections::HashMap;

use super::context::{CaptionExtentCoverageRecord, CaptionExtentSample};
use crate::core::effects::Effect;
use crate::core::ffmpeg::FFmpegRunner;
use crate::core::render::caption_measure::{measure_caption_extents, CaptionExtentRequest};
use crate::core::render::export::ExportEngine;
use crate::core::timeline::Sequence;

/// What the pass measured, and what it could not.
///
/// The same triple [`crate::core::qc::caption_contrast::CaptionBandSampling`]
/// returns, for the same reason: the samples go on the context, the coverage
/// goes on the context beside them, and the notes go into the report's
/// `warnings` so a reader learns what was skipped without reading the data.
#[derive(Debug, Clone, Default)]
pub struct CaptionExtentSampling {
    /// One entry per measured cue, in timeline order
    pub samples: Vec<CaptionExtentSample>,
    /// What the pass could not measure
    pub coverage: CaptionExtentCoverageRecord,
    /// Lines for the report's warnings
    pub notes: Vec<String>,
}

/// Below this, the pass is skipped rather than started.
///
/// One FFmpeg spawn costs more than this on every machine this ships to, so a
/// budget under it can only end in a timeout — and a timeout that reports "ran
/// out of the 0s left in the run's budget" is a diagnostic nobody can act on.
const MINIMUM_USEFUL_BUDGET: std::time::Duration = std::time::Duration::from_millis(250);

/// Everything the pass needs beyond the FFmpeg binary.
pub struct CaptionExtentOptions {
    /// Canvas width the probe renders at
    ///
    /// libass lays a script out against the frame it is drawn into, so measuring
    /// at any other size would measure a different set of line breaks.
    pub canvas_width: u32,
    /// Canvas height, for the same reason
    pub canvas_height: u32,
    /// Frame rate, so probe instants land on frames the graph really produces
    pub fps: f64,
    /// Where the run's clock starts on the timeline; `0.0` for a whole-project
    /// verify
    pub window_start_sec: f64,
    /// What is left of the run's single measurement budget
    ///
    /// Shared with the probe pass and the caption-band pass rather than taken
    /// afresh, so `--timeout-sec 600` bounds the run and not each stage of it.
    pub run_timeout: std::time::Duration,
}

/// Measures every caption cue this project's burn-in can be attributed one box.
///
/// Never fails the run. A setup the engine refuses, an FFmpeg that will not
/// spawn, a budget that ran out — each comes back as an empty or partial sample
/// list with the reason in [`CaptionExtentSampling::coverage`], because a QC
/// pass that failed the verification it was helping would be a tool that broke
/// the thing it was checking.
pub async fn sample_caption_extents(
    runner: &FFmpegRunner,
    sequence: &Sequence,
    effects: &HashMap<String, Effect>,
    options: &CaptionExtentOptions,
) -> CaptionExtentSampling {
    // Nothing left to spend. Reported as a pass that did not run rather than as
    // one that timed out: "ran out of the 0s left in the run's budget" names a
    // failure nobody had, and an agent reading it would go looking for a slow
    // probe that never started.
    if options.run_timeout < MINIMUM_USEFUL_BUDGET {
        return skipped(
            "Caption extents were not measured: the run's measurement budget was already spent \
             before this pass, so the reported boxes are estimates"
                .to_string(),
        );
    }

    let engine = ExportEngine::new(runner.clone());
    let request = CaptionExtentRequest {
        sequence,
        effects,
        canvas_width: options.canvas_width,
        canvas_height: options.canvas_height,
        fps: options.fps,
        window_start_sec: options.window_start_sec,
    };

    // The engine bounds nothing itself: it spawns one FFmpeg run per chunk of
    // cues and each of those can hang on a pathological font. The run's budget
    // is the only thing standing between a caption-heavy project and a verify
    // that never returns.
    let measured = match tokio::time::timeout(
        options.run_timeout,
        Box::pin(measure_caption_extents(&engine, &request)),
    )
    .await
    {
        Ok(Ok(measured)) => measured,
        Ok(Err(error)) => {
            return refused(format!(
                "Caption extents could not be measured, so the reported boxes are estimates: \
                 {error}"
            ));
        }
        Err(_) => {
            return refused(format!(
                "Caption extent measurement ran out of the {}s left in the run's budget, so the \
                 reported boxes are estimates",
                options.run_timeout.as_secs()
            ));
        }
    };

    let mut coverage = CaptionExtentCoverageRecord {
        shared_frame_cue_ids: measured.coverage.shared_frame_cue_ids.clone(),
        sub_frame_cue_ids: measured.coverage.sub_frame_cue_ids.clone(),
        emoji_cue_ids: measured.coverage.emoji_cue_ids.clone(),
        uses_host_fonts: measured.coverage.uses_host_fonts,
        probe_failed: measured.coverage.probe_failed,
        notes: measured.coverage.notes.clone(),
        ..CaptionExtentCoverageRecord::default()
    };

    let mut samples = Vec::with_capacity(measured.extents.len());
    for extent in measured.extents {
        // A cue that drew nothing has no rectangle to grade. Reported as
        // unmeasured rather than as a zero-sized box at the origin, which would
        // read as a caption tucked neatly into the top-left corner.
        let Some(box_percent) = extent.box_percent else {
            coverage.no_ink_cue_ids.push(extent.clip_id);
            continue;
        };

        samples.push(CaptionExtentSample {
            clip_id: extent.clip_id,
            left_percent: box_percent.left,
            right_percent: box_percent.right,
            top_percent: box_percent.top,
            bottom_percent: box_percent.bottom,
            clipped: extent.clipped,
        });
    }

    coverage.measured = samples.len();
    coverage.measured_cue_ids = samples
        .iter()
        .map(|sample| sample.clip_id.clone())
        .collect();
    if !coverage.no_ink_cue_ids.is_empty() {
        // TODO(caption-no-ink): a cue that renders nothing is a defect in its
        // own right — a missing font, a transparent style, an override tag that
        // hid the text. It wants a rule of its own; until then it is reported
        // here and graded by the estimator like any other unmeasured cue.
        coverage.notes.push(format!(
            "{} caption cue(s) rendered no ink at all; their boxes are estimated",
            coverage.no_ink_cue_ids.len()
        ));
    }

    let notes = coverage.notes.clone();
    CaptionExtentSampling {
        samples,
        coverage,
        notes,
    }
}

/// A pass that measured nothing, saying so in one note.
fn refused(note: String) -> CaptionExtentSampling {
    CaptionExtentSampling {
        samples: Vec::new(),
        coverage: CaptionExtentCoverageRecord {
            probe_failed: true,
            notes: vec![note.clone()],
            ..CaptionExtentCoverageRecord::default()
        },
        notes: vec![note],
    }
}

/// A pass that never started, saying so in one note.
///
/// Distinct from [`refused`] in exactly one field: `probe_failed` stays false,
/// because nothing was attempted and nothing broke. Both leave every cue to the
/// estimator, and both say so in the report.
fn skipped(note: String) -> CaptionExtentSampling {
    CaptionExtentSampling {
        samples: Vec::new(),
        coverage: CaptionExtentCoverageRecord {
            notes: vec![note.clone()],
            ..CaptionExtentCoverageRecord::default()
        },
        notes: vec![note],
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ffmpeg::{FFmpegInfo, FFmpegSource};
    use crate::core::timeline::{Clip, SequenceFormat, Track};
    use std::time::Duration;

    /// A runner pointed at a binary that cannot possibly exist.
    fn runner_that_cannot_run() -> FFmpegRunner {
        FFmpegRunner::new(FFmpegInfo {
            ffmpeg_path: std::path::PathBuf::from("ffmpeg-that-cannot-possibly-exist"),
            ffprobe_path: std::path::PathBuf::from("ffprobe-that-cannot-possibly-exist"),
            version: "test".to_string(),
            is_bundled: false,
            source: FFmpegSource::System,
        })
    }

    fn options_for(sequence: &Sequence) -> CaptionExtentOptions {
        CaptionExtentOptions {
            canvas_width: sequence.format.canvas.width,
            canvas_height: sequence.format.canvas.height,
            fps: sequence.format.fps.as_f64(),
            window_start_sec: 0.0,
            run_timeout: Duration::from_secs(30),
        }
    }

    fn sequence_with_one_caption() -> Sequence {
        sequence_with_captions(&[("clip-a", "A caption", 0.0, 2.0)])
    }

    /// A caption track carrying `cues` of `(clip id, label, in, out)`.
    fn sequence_with_captions(cues: &[(&str, &str, f64, f64)]) -> Sequence {
        let mut sequence = Sequence::new("Extent", SequenceFormat::youtube_1080());
        let mut track = Track::new_caption("Captions");

        for (id, label, start, end) in cues {
            let mut clip = Clip::new("caption-asset")
                .with_source_range(0.0, end - start)
                .place_at(*start);
            clip.id = (*id).to_string();
            clip.label = Some((*label).to_string());
            track.add_clip(clip);
        }

        sequence.add_track(track);
        sequence
    }

    /// Feature: measured caption bounds
    /// Scenario: should report a probe it could not run as unmeasured, not clean
    #[tokio::test]
    async fn should_report_an_unrunnable_probe_as_unmeasured() {
        let sequence = sequence_with_one_caption();

        let sampling = sample_caption_extents(
            &runner_that_cannot_run(),
            &sequence,
            &HashMap::new(),
            &options_for(&sequence),
        )
        .await;

        assert!(sampling.samples.is_empty());
        assert!(
            sampling.coverage.probe_failed,
            "a probe that never spawned must not read as a caption measured fine"
        );
        assert!(!sampling.notes.is_empty(), "the report has to say so");
    }

    /// Feature: measured caption bounds
    /// Scenario: should measure nothing, and complain about nothing, for a
    /// sequence with no captions in it
    #[tokio::test]
    async fn should_stay_silent_when_there_is_nothing_to_measure() {
        let sequence = Sequence::new("Empty", SequenceFormat::youtube_1080());

        let sampling = sample_caption_extents(
            &runner_that_cannot_run(),
            &sequence,
            &HashMap::new(),
            &options_for(&sequence),
        )
        .await;

        assert!(sampling.samples.is_empty());
        assert!(
            !sampling.coverage.probe_failed,
            "no captions means no probe, not a failed one"
        );
        assert!(sampling.notes.is_empty());
    }

    /// Feature: measured caption bounds
    /// Scenario: should skip the pass, not time it out, when the budget is gone
    ///
    /// A run whose earlier stages spent the whole `--timeout-sec` used to reach
    /// this pass, start it with nothing, and report "ran out of the 0s left in
    /// the run's budget" — a timeout nobody experienced, describing a probe that
    /// never spawned. The cues are estimated either way; what changes is whether
    /// the report sends a reader looking for a slow probe.
    #[tokio::test]
    async fn should_skip_the_pass_rather_than_time_it_out_on_an_empty_budget() {
        let sequence = sequence_with_one_caption();
        let options = CaptionExtentOptions {
            run_timeout: Duration::ZERO,
            ..options_for(&sequence)
        };

        let sampling = sample_caption_extents(
            &runner_that_cannot_run(),
            &sequence,
            &HashMap::new(),
            &options,
        )
        .await;

        assert!(sampling.samples.is_empty());
        assert!(
            !sampling.coverage.probe_failed,
            "nothing was attempted, so nothing failed"
        );
        let note = sampling.notes.join(" ");
        assert!(
            note.contains("budget") && !note.contains("0s"),
            "the note has to say the budget was spent, not name a zero-second timeout: {note}"
        );
    }

    // ========================================================================
    // Against a real libass
    // ========================================================================

    /// An engine pointed at the FFmpeg this machine has, or `None` to skip.
    fn real_runner() -> Option<FFmpegRunner> {
        let ffmpeg = crate::core::test_ffmpeg::require_or_skip_ffmpeg()?;
        Some(FFmpegRunner::new(FFmpegInfo {
            ffprobe_path: ffmpeg.with_file_name(if cfg!(windows) {
                "ffprobe.exe"
            } else {
                "ffprobe"
            }),
            ffmpeg_path: ffmpeg,
            version: "test".to_string(),
            is_bundled: false,
            source: FFmpegSource::System,
        }))
    }

    /// Feature: measured caption bounds
    /// Scenario: should refuse an emoji cue and still measure its plain
    /// neighbour
    ///
    /// The two halves of the emoji answer, in one sequence. The probe builds the
    /// burn-in's script including its emoji pack — without which every cue in
    /// the script would wrap differently from the render — and that puts an
    /// ink-free spacer where the emoji is, with the colour picture composited
    /// outside the alpha this pass reads. So the emoji cue comes back named in
    /// the coverage record and *not* in the samples, while the plain caption
    /// beside it, laid out by the same script, is measured exactly as before.
    #[tokio::test]
    #[ignore = "requires FFmpeg with libass"]
    async fn should_refuse_an_emoji_cue_and_measure_the_plain_one_beside_it() {
        let Some(runner) = real_runner() else {
            return;
        };
        if crate::core::text::emoji_assets::discover().is_none() {
            eprintln!("Skipping test: no colour emoji pack is installed");
            return;
        }

        let sequence = sequence_with_captions(&[
            ("clip-plain", "A plain caption", 0.0, 2.0),
            ("clip-emoji", "Fire \u{1F525}", 2.0, 4.0),
        ]);

        let sampling =
            sample_caption_extents(&runner, &sequence, &HashMap::new(), &options_for(&sequence))
                .await;

        assert!(
            !sampling.coverage.probe_failed,
            "a real binary must complete the probe: {:?}",
            sampling.coverage.notes
        );
        assert_eq!(
            sampling.coverage.emoji_cue_ids,
            vec!["clip-emoji".to_string()],
            "the emoji cue is named as uncovered: {:?}",
            sampling.coverage
        );
        assert_eq!(
            sampling
                .samples
                .iter()
                .map(|sample| sample.clip_id.as_str())
                .collect::<Vec<_>>(),
            vec!["clip-plain"],
            "only the plain caption carries a measured box"
        );
        assert_eq!(
            sampling.coverage.measured_cue_ids,
            vec!["clip-plain".to_string()],
            "and a clean report can say which cue that was"
        );
    }

    /// Feature: measured caption bounds
    /// Scenario: should carry a real measurement all the way to the rule
    ///
    /// The end-to-end claim the unit tests above cannot make: a real FFmpeg
    /// renders a real caption through the export's own script, the box comes
    /// back in the shape the context stores, and
    /// [`crate::core::qc::structural::CaptionOutOfBoundsRule`] grades *that*
    /// rather than its estimate. Everything in between — the id correlation, the
    /// percent conversion, the context field, the per-cue lookup — is exercised
    /// exactly once here, against the renderer.
    #[tokio::test]
    #[ignore = "requires FFmpeg with libass"]
    async fn should_hand_the_rule_a_box_it_measured_for_real() {
        use crate::core::project::ProjectState;
        use crate::core::qc::rules::{QCRule, RuleConfig};
        use crate::core::qc::structural::CaptionOutOfBoundsRule;
        use crate::core::qc::QCContext;

        let Some(ffmpeg) = crate::core::test_ffmpeg::require_or_skip_ffmpeg() else {
            return;
        };
        let runner = FFmpegRunner::new(FFmpegInfo {
            ffprobe_path: ffmpeg.with_file_name(if cfg!(windows) {
                "ffprobe.exe"
            } else {
                "ffprobe"
            }),
            ffmpeg_path: ffmpeg,
            version: "test".to_string(),
            is_bundled: false,
            source: FFmpegSource::System,
        });

        let sequence = sequence_with_one_caption();
        let sampling =
            sample_caption_extents(&runner, &sequence, &HashMap::new(), &options_for(&sequence))
                .await;

        assert!(
            !sampling.coverage.probe_failed,
            "a real binary must complete the probe: {:?}",
            sampling.coverage.notes
        );
        assert_eq!(sampling.samples.len(), 1, "one solo cue, one rectangle");

        let sample = &sampling.samples[0];
        assert_eq!(sample.clip_id, "clip-a");
        assert!(
            sample.left_percent > 0.0
                && sample.right_percent < 100.0
                && sample.bottom_percent <= 100.0
                && sample.right_percent > sample.left_percent,
            "an ordinary caption lands inside the frame: {sample:?}"
        );
        assert!(!sample.clipped);

        // And the rule reads it: same sequence, same box, no finding.
        let context = QCContext::from_sequence(&sequence)
            .with_caption_extents(sampling.samples.clone(), sampling.coverage.clone());
        assert_eq!(
            context.caption_extent("clip-a"),
            Some(sample),
            "the rule looks the cue up by clip id"
        );

        let violations = CaptionOutOfBoundsRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("the rule runs");
        assert!(
            violations.is_empty(),
            "a caption libass drew inside the frame is not out of bounds: {violations:?}"
        );
    }
}
