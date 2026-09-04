//! Sequence inspection resolution for the in-app agent bridge.
//!
//! The where-to-look signals themselves — cuts, edit points, transition spans,
//! caption and text spans, marker positions and the counts derived from them —
//! are computed once in [`crate::core::timeline::inspection`], the same
//! function the CLI's `timeline info` and the MCP's `timeline.snapshot` call.
//! Nothing is recomputed here and nothing is re-typed: the core
//! [`InspectionSummary`] derives `specta::Type`, so it crosses the IPC boundary
//! as itself and reaches TypeScript through the generated bindings.
//!
//! What lives here is the only part the app adds — deciding *which* sequence a
//! caller meant. That is pure over a [`ProjectState`], so it is unit tested
//! here rather than in `ipc::commands`, which is not compiled into the test
//! build.

use crate::core::project::ProjectState;
use crate::core::timeline::{inspection_summary, InspectionSummary, Sequence};

/// Derives the inspection summary of the sequence a caller means.
///
/// `sequence_id` names a sequence outright; absent (or blank) it means the
/// project's active sequence. Errors rather than falling back, so an agent that
/// mistyped an id learns that instead of silently reading another timeline.
pub fn resolve_inspection_summary(
    state: &ProjectState,
    sequence_id: Option<&str>,
) -> Result<InspectionSummary, String> {
    let sequence = resolve_sequence(state, sequence_id)?;
    Ok(inspection_summary(sequence, &state.effects))
}

/// Picks the named sequence, or the active one when no id was given.
///
/// A blank id is treated as absent: a bridge that forwards an empty string
/// means "the caller said nothing", not "the sequence called ''".
fn resolve_sequence<'a>(
    state: &'a ProjectState,
    sequence_id: Option<&str>,
) -> Result<&'a Sequence, String> {
    match sequence_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => state
            .get_sequence(id)
            .ok_or_else(|| format!("Sequence '{id}' was not found in this project")),
        None => state
            .get_active_sequence()
            .ok_or_else(|| "This project has no active sequence".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::timeline::{Sequence, SequenceFormat};

    /// A project whose active sequence is the one `ProjectState::new` created.
    fn project_with_second_sequence() -> (ProjectState, String, String) {
        let mut state = ProjectState::new("demo");
        let active_id = state
            .active_sequence_id
            .clone()
            .expect("a new project has an active sequence");
        let other = Sequence::new("Other", SequenceFormat::youtube_1080());
        let other_id = other.id.clone();
        state.sequences.insert(other_id.clone(), other);
        (state, active_id, other_id)
    }

    #[test]
    fn resolves_the_active_sequence_when_no_id_is_given() {
        let (state, active_id, _) = project_with_second_sequence();

        let summary = resolve_inspection_summary(&state, None).expect("active sequence resolves");
        let active = state
            .get_sequence(&active_id)
            .expect("the active sequence is present");

        assert_eq!(summary.canvas, active.format.canvas);
        assert_eq!(summary.fps_ratio, active.format.fps);
        assert_eq!(summary.duration_sec, active.duration());
    }

    #[test]
    fn resolves_the_named_sequence_over_the_active_one() {
        let (state, _, other_id) = project_with_second_sequence();

        let summary =
            resolve_inspection_summary(&state, Some(&other_id)).expect("a named sequence resolves");

        // An empty sequence has no cuts and no spans to look at, which is what
        // distinguishes it from a wrong-sequence answer.
        assert_eq!(summary.inspection_hints.cut_count, summary.cuts.len());
        assert!(summary.transitions.is_empty());
        assert!(summary.caption_spans.is_empty());
        assert!(summary.text_spans.is_empty());
    }

    #[test]
    fn treats_a_blank_id_as_the_active_sequence() {
        let (state, _, _) = project_with_second_sequence();

        let blank = resolve_inspection_summary(&state, Some("   ")).expect("blank means active");
        let absent = resolve_inspection_summary(&state, None).expect("active sequence resolves");

        assert_eq!(blank, absent);
    }

    #[test]
    fn reports_an_unknown_sequence_by_id() {
        let (state, _, _) = project_with_second_sequence();

        let error = resolve_inspection_summary(&state, Some("seq-missing"))
            .expect_err("an unknown id is an error");

        assert!(error.contains("seq-missing"), "unexpected message: {error}");
    }

    #[test]
    fn reports_a_project_with_no_active_sequence() {
        let mut state = ProjectState::new("demo");
        state.active_sequence_id = None;

        let error =
            resolve_inspection_summary(&state, None).expect_err("no active sequence is an error");

        assert!(
            error.contains("no active sequence"),
            "unexpected message: {error}"
        );
    }
}
