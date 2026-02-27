//! Agent Plan Executor Module
//!
//! Provides topological sorting, step-reference resolution, and rollback
//! report generation for agent plans. The actual tool dispatch will be
//! connected when the BackendToolExecutor adapter is wired up.

use std::collections::HashMap;

use super::agent_plan::{AgentPlan, PlanStep, RollbackReport, StepResult};

// =============================================================================
// PlanExecutor
// =============================================================================

/// Executes an `AgentPlan` by validating its dependency graph, resolving
/// inter-step references, and producing rollback reports on failure.
///
/// The executor does **not** dispatch commands directly; it prepares and
/// validates the execution order. Command dispatch will be integrated once
/// the `BackendToolExecutor` adapter is ready.
#[derive(Debug, Clone)]
pub struct PlanExecutor {
    plan: AgentPlan,
}

impl PlanExecutor {
    /// Creates a new executor for the given plan.
    pub fn new(plan: AgentPlan) -> Self {
        Self { plan }
    }

    /// Returns a reference to the underlying plan.
    pub fn plan(&self) -> &AgentPlan {
        &self.plan
    }

    /// Validates the plan structure and returns execution order as step
    /// indices. Returns an error if circular dependencies are detected
    /// or a `depends_on` reference points to a non-existent step.
    pub fn validate_and_prepare(&self) -> Result<Vec<usize>, String> {
        topological_sort(&self.plan.steps)
    }

    /// Builds a rollback report after a failure at `failed_index`.
    ///
    /// The report lists the completed steps that are candidates for
    /// rollback, in reverse execution order.
    pub fn build_rollback_report(
        &self,
        failed_index: usize,
        completed_results: &[StepResult],
    ) -> RollbackReport {
        let failed_step_id = self
            .plan
            .steps
            .get(failed_index)
            .map(|s| s.id.clone())
            .unwrap_or_else(|| format!("unknown-{}", failed_index));

        // Candidates for rollback are completed steps in reverse order.
        let candidate_count = completed_results.len();
        let mut rolled_back_steps: Vec<String> = completed_results
            .iter()
            .filter(|r| r.success)
            .map(|r| r.step_id.clone())
            .collect();
        rolled_back_steps.reverse();

        let attempted_count = rolled_back_steps.len();

        RollbackReport {
            attempted: !rolled_back_steps.is_empty(),
            failed_step_id,
            failed_at_index: failed_index,
            candidate_count,
            attempted_count,
            succeeded_count: 0,
            failed_count: 0,
            rolled_back_steps,
            rollback_errors: vec![],
            reason: if candidate_count == 0 {
                Some("No completed steps to roll back".to_string())
            } else {
                None
            },
        }
    }
}

// =============================================================================
// Topological Sort
// =============================================================================

/// Performs a topological sort on plan steps using Kahn's algorithm.
///
/// Returns an ordered vector of step indices suitable for sequential
/// execution. Returns an error if circular dependencies are detected or
/// a `depends_on` entry references a non-existent step ID.
fn topological_sort(steps: &[PlanStep]) -> Result<Vec<usize>, String> {
    if steps.is_empty() {
        return Ok(vec![]);
    }

    // Build id -> index mapping
    let id_to_index: HashMap<&str, usize> = steps
        .iter()
        .enumerate()
        .map(|(i, s)| (s.id.as_str(), i))
        .collect();

    let n = steps.len();

    // Validate all dependency references exist
    for step in steps {
        for dep_id in &step.depends_on {
            if !id_to_index.contains_key(dep_id.as_str()) {
                return Err(format!(
                    "Step '{}' depends on '{}', which does not exist in the plan",
                    step.id, dep_id
                ));
            }
        }
    }

    // Compute in-degrees and adjacency list
    let mut in_degree = vec![0usize; n];
    let mut adjacency: Vec<Vec<usize>> = vec![vec![]; n];

    for (i, step) in steps.iter().enumerate() {
        for dep_id in &step.depends_on {
            let dep_idx = id_to_index[dep_id.as_str()];
            // dep_idx → i (dep must come before current step)
            adjacency[dep_idx].push(i);
            in_degree[i] += 1;
        }
    }

    // Kahn's algorithm
    let mut queue: Vec<usize> = (0..n).filter(|&i| in_degree[i] == 0).collect();
    // Sort the initial queue for deterministic output (by index)
    queue.sort_unstable();

    let mut order: Vec<usize> = Vec::with_capacity(n);

    while let Some(node) = queue.first().copied() {
        queue.remove(0);
        order.push(node);

        let mut next_candidates = Vec::new();
        for &neighbor in &adjacency[node] {
            in_degree[neighbor] -= 1;
            if in_degree[neighbor] == 0 {
                next_candidates.push(neighbor);
            }
        }
        // Sort candidates for deterministic ordering
        next_candidates.sort_unstable();
        queue.extend(next_candidates);
    }

    if order.len() != n {
        // Find the steps involved in the cycle for a helpful message
        let cycle_steps: Vec<&str> = (0..n)
            .filter(|&i| in_degree[i] > 0)
            .map(|i| steps[i].id.as_str())
            .collect();
        return Err(format!(
            "Circular dependency detected among steps: [{}]",
            cycle_steps.join(", ")
        ));
    }

    Ok(order)
}

// =============================================================================
// Step Reference Resolution
// =============================================================================

/// Resolves `$fromStep` / `$path` references in a JSON params object.
///
/// Walks the JSON tree looking for objects with both `$fromStep` and
/// `$path` keys. When found, looks up the matching step result's `data`
/// field and navigates the dot-separated path to extract the value.
///
/// # Example
///
/// Given step result data `{ "assetId": "asset-1" }` for step `"step-1"`:
///
/// ```json
/// { "clipAsset": { "$fromStep": "step-1", "$path": "assetId" } }
/// ```
///
/// resolves to:
///
/// ```json
/// { "clipAsset": "asset-1" }
/// ```
pub fn resolve_step_references(
    params: &serde_json::Value,
    step_results: &HashMap<String, StepResult>,
) -> Result<serde_json::Value, String> {
    match params {
        serde_json::Value::Object(map) => {
            // Check if this is a reference object
            if let (Some(from_step), Some(path)) = (map.get("$fromStep"), map.get("$path")) {
                let step_id = from_step
                    .as_str()
                    .ok_or_else(|| "$fromStep must be a string".to_string())?;
                let path_str = path
                    .as_str()
                    .ok_or_else(|| "$path must be a string".to_string())?;

                let result = step_results.get(step_id).ok_or_else(|| {
                    format!(
                        "Cannot resolve $fromStep '{}': step result not found",
                        step_id
                    )
                })?;

                let data = result.data.as_ref().ok_or_else(|| {
                    format!(
                        "Cannot resolve $fromStep '{}': step produced no data",
                        step_id
                    )
                })?;

                navigate_path(data, path_str).ok_or_else(|| {
                    format!(
                        "Cannot resolve $path '{}' in step '{}' data",
                        path_str, step_id
                    )
                })
            } else {
                // Regular object: recurse into each value
                let mut resolved = serde_json::Map::new();
                for (key, value) in map {
                    resolved.insert(key.clone(), resolve_step_references(value, step_results)?);
                }
                Ok(serde_json::Value::Object(resolved))
            }
        }
        serde_json::Value::Array(arr) => {
            let resolved: Result<Vec<_>, _> = arr
                .iter()
                .map(|v| resolve_step_references(v, step_results))
                .collect();
            Ok(serde_json::Value::Array(resolved?))
        }
        // Primitives are returned as-is
        other => Ok(other.clone()),
    }
}

/// Navigates a dot-separated path through a JSON value.
///
/// For example, `"data.assetId"` applied to
/// `{ "data": { "assetId": "a-1" } }` returns `"a-1"`.
fn navigate_path(value: &serde_json::Value, path: &str) -> Option<serde_json::Value> {
    let mut current = value;
    for segment in path.split('.') {
        if segment.is_empty() {
            continue;
        }
        match current {
            serde_json::Value::Object(map) => {
                current = map.get(segment)?;
            }
            serde_json::Value::Array(arr) => {
                let idx: usize = segment.parse().ok()?;
                current = arr.get(idx)?;
            }
            _ => return None,
        }
    }
    Some(current.clone())
}

// =============================================================================
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ai::agent_plan::PlanRiskLevel;

    /// Helper to build a minimal PlanStep.
    fn make_step(id: &str, depends_on: Vec<&str>) -> PlanStep {
        PlanStep {
            id: id.to_string(),
            tool_name: format!("tool_{}", id),
            params: serde_json::json!({}),
            description: format!("Step {}", id),
            risk_level: PlanRiskLevel::Low,
            depends_on: depends_on.into_iter().map(String::from).collect(),
            optional: false,
        }
    }

    /// Helper to build a StepResult with optional data.
    fn make_result(step_id: &str, data: Option<serde_json::Value>) -> StepResult {
        StepResult {
            step_id: step_id.to_string(),
            success: true,
            data,
            error: None,
            duration_ms: 10,
            operation_id: Some(format!("op-{}", step_id)),
        }
    }

    // =========================================================================
    // 1. Successful topological sort with dependencies
    // =========================================================================

    #[test]
    fn topological_sort_three_steps_with_dependencies() {
        // step-3 depends on step-2, step-2 depends on step-1
        let steps = vec![
            make_step("step-1", vec![]),
            make_step("step-2", vec!["step-1"]),
            make_step("step-3", vec!["step-2"]),
        ];

        let order = topological_sort(&steps).expect("Should sort successfully");
        assert_eq!(order, vec![0, 1, 2]);
    }

    #[test]
    fn topological_sort_diamond_dependency() {
        // step-1 -> step-2 -> step-4
        // step-1 -> step-3 -> step-4
        let steps = vec![
            make_step("step-1", vec![]),
            make_step("step-2", vec!["step-1"]),
            make_step("step-3", vec!["step-1"]),
            make_step("step-4", vec!["step-2", "step-3"]),
        ];

        let order = topological_sort(&steps).expect("Should sort diamond graph");
        // step-1 must be first, step-4 must be last
        assert_eq!(order[0], 0);
        assert_eq!(order[3], 3);
        // step-2 (idx 1) and step-3 (idx 2) in the middle, deterministic order
        assert!(order[1] < order[2]);
    }

    #[test]
    fn topological_sort_no_dependencies() {
        let steps = vec![
            make_step("a", vec![]),
            make_step("b", vec![]),
            make_step("c", vec![]),
        ];

        let order = topological_sort(&steps).expect("Should sort independent steps");
        // All independent: returns in original index order
        assert_eq!(order, vec![0, 1, 2]);
    }

    #[test]
    fn topological_sort_empty_plan() {
        let order = topological_sort(&[]).expect("Empty plan should succeed");
        assert!(order.is_empty());
    }

    // =========================================================================
    // 2. Circular dependency detection
    // =========================================================================

    #[test]
    fn topological_sort_detects_circular_dependency() {
        let steps = vec![
            make_step("step-1", vec!["step-3"]),
            make_step("step-2", vec!["step-1"]),
            make_step("step-3", vec!["step-2"]),
        ];

        let err = topological_sort(&steps).expect_err("Should detect circular dependency");
        assert!(
            err.contains("Circular dependency"),
            "Error should mention circular dependency, got: {}",
            err
        );
        // All three steps are in the cycle
        assert!(err.contains("step-1"));
        assert!(err.contains("step-2"));
        assert!(err.contains("step-3"));
    }

    #[test]
    fn topological_sort_detects_self_dependency() {
        let steps = vec![make_step("step-1", vec!["step-1"])];

        let err = topological_sort(&steps).expect_err("Should detect self-dependency");
        assert!(err.contains("Circular dependency"));
        assert!(err.contains("step-1"));
    }

    #[test]
    fn topological_sort_rejects_missing_dependency() {
        let steps = vec![make_step("step-1", vec!["step-nonexistent"])];

        let err = topological_sort(&steps).expect_err("Should reject missing dep");
        assert!(err.contains("does not exist"));
        assert!(err.contains("step-nonexistent"));
    }

    // =========================================================================
    // 3. $fromStep / $path reference resolution
    // =========================================================================

    #[test]
    fn resolve_step_references_simple_path() {
        let mut results = HashMap::new();
        results.insert(
            "step-1".to_string(),
            make_result("step-1", Some(serde_json::json!({ "assetId": "asset-42" }))),
        );

        let params = serde_json::json!({
            "clipAsset": { "$fromStep": "step-1", "$path": "assetId" },
            "trackId": "track-1"
        });

        let resolved =
            resolve_step_references(&params, &results).expect("Should resolve references");

        assert_eq!(resolved["clipAsset"], serde_json::json!("asset-42"));
        assert_eq!(resolved["trackId"], serde_json::json!("track-1"));
    }

    #[test]
    fn resolve_step_references_nested_path() {
        let mut results = HashMap::new();
        results.insert(
            "step-1".to_string(),
            make_result(
                "step-1",
                Some(serde_json::json!({
                    "result": {
                        "clips": ["clip-a", "clip-b"]
                    }
                })),
            ),
        );

        let params = serde_json::json!({
            "firstClip": { "$fromStep": "step-1", "$path": "result.clips.0" }
        });

        let resolved =
            resolve_step_references(&params, &results).expect("Should resolve nested path");

        assert_eq!(resolved["firstClip"], serde_json::json!("clip-a"));
    }

    #[test]
    fn resolve_step_references_in_array() {
        let mut results = HashMap::new();
        results.insert(
            "step-1".to_string(),
            make_result("step-1", Some(serde_json::json!({ "id": "abc" }))),
        );

        let params = serde_json::json!({
            "items": [
                { "$fromStep": "step-1", "$path": "id" },
                "literal-value"
            ]
        });

        let resolved =
            resolve_step_references(&params, &results).expect("Should resolve array elements");

        assert_eq!(resolved["items"][0], serde_json::json!("abc"));
        assert_eq!(resolved["items"][1], serde_json::json!("literal-value"));
    }

    #[test]
    fn resolve_step_references_no_references() {
        let results = HashMap::new();
        let params = serde_json::json!({
            "name": "test",
            "value": 42,
            "nested": { "key": true }
        });

        let resolved = resolve_step_references(&params, &results)
            .expect("Should pass through without references");

        assert_eq!(resolved, params);
    }

    // =========================================================================
    // 4. Unresolvable reference errors
    // =========================================================================

    #[test]
    fn resolve_step_references_step_not_found() {
        let results = HashMap::new();

        let params = serde_json::json!({
            "value": { "$fromStep": "nonexistent-step", "$path": "data" }
        });

        let err =
            resolve_step_references(&params, &results).expect_err("Should error on missing step");
        assert!(err.contains("nonexistent-step"));
        assert!(err.contains("not found"));
    }

    #[test]
    fn resolve_step_references_path_not_navigable() {
        let mut results = HashMap::new();
        results.insert(
            "step-1".to_string(),
            make_result("step-1", Some(serde_json::json!({ "foo": "bar" }))),
        );

        let params = serde_json::json!({
            "value": { "$fromStep": "step-1", "$path": "nonexistent.deep.path" }
        });

        let err =
            resolve_step_references(&params, &results).expect_err("Should error on invalid path");
        assert!(err.contains("$path"));
        assert!(err.contains("nonexistent.deep.path"));
    }

    #[test]
    fn resolve_step_references_step_has_no_data() {
        let mut results = HashMap::new();
        results.insert("step-1".to_string(), make_result("step-1", None));

        let params = serde_json::json!({
            "value": { "$fromStep": "step-1", "$path": "anything" }
        });

        let err = resolve_step_references(&params, &results)
            .expect_err("Should error when step has no data");
        assert!(err.contains("no data"));
    }

    // =========================================================================
    // 5. Rollback report generation
    // =========================================================================

    #[test]
    fn build_rollback_report_failure_at_step_two() {
        let plan = AgentPlan {
            id: "plan-001".to_string(),
            goal: "Import and split clip".to_string(),
            steps: vec![
                make_step("step-1", vec![]),
                make_step("step-2", vec!["step-1"]),
                make_step("step-3", vec!["step-2"]),
            ],
            approval_granted: true,
            session_id: None,
        };

        let executor = PlanExecutor::new(plan);

        let completed = vec![make_result("step-1", Some(serde_json::json!({})))];

        let report = executor.build_rollback_report(1, &completed);

        assert!(report.attempted);
        assert_eq!(report.failed_step_id, "step-2");
        assert_eq!(report.failed_at_index, 1);
        assert_eq!(report.candidate_count, 1);
        assert_eq!(report.attempted_count, 1);
        // succeeded_count defaults to 0 before actual rollback execution
        assert_eq!(report.succeeded_count, 0);
        assert_eq!(report.failed_count, 0);
        assert_eq!(report.rolled_back_steps, vec!["step-1".to_string()]);
        assert!(report.rollback_errors.is_empty());
        assert!(report.reason.is_none());
    }

    #[test]
    fn build_rollback_report_no_completed_steps() {
        let plan = AgentPlan {
            id: "plan-002".to_string(),
            goal: "Fail immediately".to_string(),
            steps: vec![make_step("step-1", vec![])],
            approval_granted: true,
            session_id: None,
        };

        let executor = PlanExecutor::new(plan);
        let report = executor.build_rollback_report(0, &[]);

        assert!(!report.attempted);
        assert_eq!(report.failed_step_id, "step-1");
        assert_eq!(report.failed_at_index, 0);
        assert_eq!(report.candidate_count, 0);
        assert_eq!(report.attempted_count, 0);
        assert_eq!(report.rolled_back_steps, Vec::<String>::new());
        assert_eq!(
            report.reason,
            Some("No completed steps to roll back".to_string())
        );
    }

    #[test]
    fn build_rollback_report_multiple_completed_steps_reversed() {
        let plan = AgentPlan {
            id: "plan-003".to_string(),
            goal: "Multi-step plan".to_string(),
            steps: vec![
                make_step("step-1", vec![]),
                make_step("step-2", vec!["step-1"]),
                make_step("step-3", vec!["step-2"]),
                make_step("step-4", vec!["step-3"]),
            ],
            approval_granted: true,
            session_id: None,
        };

        let executor = PlanExecutor::new(plan);

        let completed = vec![
            make_result("step-1", Some(serde_json::json!({}))),
            make_result("step-2", Some(serde_json::json!({}))),
            make_result("step-3", Some(serde_json::json!({}))),
        ];

        let report = executor.build_rollback_report(3, &completed);

        assert!(report.attempted);
        assert_eq!(report.failed_step_id, "step-4");
        assert_eq!(report.failed_at_index, 3);
        assert_eq!(report.candidate_count, 3);
        assert_eq!(report.attempted_count, 3);
        // Rolled back in reverse order
        assert_eq!(
            report.rolled_back_steps,
            vec![
                "step-3".to_string(),
                "step-2".to_string(),
                "step-1".to_string()
            ]
        );
    }

    // =========================================================================
    // PlanExecutor integration
    // =========================================================================

    #[test]
    fn validate_and_prepare_returns_sorted_order() {
        let plan = AgentPlan {
            id: "plan-010".to_string(),
            goal: "Multi-step workflow".to_string(),
            steps: vec![
                make_step("step-1", vec![]),
                make_step("step-2", vec!["step-1"]),
                make_step("step-3", vec!["step-1"]),
            ],
            approval_granted: true,
            session_id: None,
        };

        let executor = PlanExecutor::new(plan);
        let order = executor.validate_and_prepare().expect("Should validate");
        assert_eq!(order[0], 0); // step-1 first
                                 // step-2 and step-3 after step-1
        assert!(order.contains(&1));
        assert!(order.contains(&2));
    }

    #[test]
    fn validate_and_prepare_detects_circular() {
        let plan = AgentPlan {
            id: "plan-011".to_string(),
            goal: "Bad plan".to_string(),
            steps: vec![make_step("a", vec!["b"]), make_step("b", vec!["a"])],
            approval_granted: true,
            session_id: None,
        };

        let executor = PlanExecutor::new(plan);
        let err = executor
            .validate_and_prepare()
            .expect_err("Should detect cycle");
        assert!(err.contains("Circular dependency"));
    }

    #[test]
    fn plan_accessor() {
        let plan = AgentPlan {
            id: "plan-100".to_string(),
            goal: "Test accessor".to_string(),
            steps: vec![],
            approval_granted: false,
            session_id: Some("sess-1".to_string()),
        };

        let executor = PlanExecutor::new(plan);
        assert_eq!(executor.plan().id, "plan-100");
        assert_eq!(executor.plan().goal, "Test accessor");
        assert!(!executor.plan().approval_granted);
    }

    // =========================================================================
    // Integration test: execute plan against real ProjectState
    // =========================================================================

    #[test]
    fn integration_execute_plan_against_real_state() {
        use crate::core::assets::{Asset, VideoInfo};
        use crate::core::commands::CommandExecutor;
        use crate::core::project::ProjectState;
        use crate::core::timeline::{Sequence, SequenceFormat, Track, TrackKind};
        use crate::ipc::CommandPayload;

        // 1. Build a real ProjectState with one sequence, one video track, one asset
        let mut state = ProjectState::new_empty("Integration Test");

        let asset =
            Asset::new_video("video.mp4", "/video.mp4", VideoInfo::default()).with_duration(10.0);
        let asset_id = asset.id.clone();
        state.assets.insert(asset_id.clone(), asset);

        let mut seq = Sequence::new("Main", SequenceFormat::youtube_1080());
        let track = Track::new("Video 1", TrackKind::Video);
        let seq_id = seq.id.clone();
        let track_id = track.id.clone();
        seq.tracks.push(track);
        state.active_sequence_id = Some(seq_id.clone());
        state.sequences.insert(seq_id.clone(), seq);

        let mut cmd_executor = CommandExecutor::new();
        let project_path = std::path::PathBuf::from("/tmp/test-project");

        // 2. Build a 3-step plan:
        //    step-1: insert clip at 0s
        //    step-2: insert clip at 10s (depends on step-1)
        //    step-3: split the clip from step-1 at 5s (depends on step-1)
        let plan = AgentPlan {
            id: "integration-plan".to_string(),
            goal: "Insert two clips and split the first".to_string(),
            steps: vec![
                PlanStep {
                    id: "step-1".to_string(),
                    tool_name: "InsertClip".to_string(),
                    params: serde_json::json!({
                        "sequenceId": seq_id,
                        "trackId": track_id,
                        "assetId": asset_id,
                        "timelineStart": 0.0
                    }),
                    description: "Insert clip at 0s".to_string(),
                    risk_level: PlanRiskLevel::Low,
                    depends_on: vec![],
                    optional: false,
                },
                PlanStep {
                    id: "step-2".to_string(),
                    tool_name: "InsertClip".to_string(),
                    params: serde_json::json!({
                        "sequenceId": seq_id,
                        "trackId": track_id,
                        "assetId": asset_id,
                        "timelineStart": 20.0
                    }),
                    description: "Insert clip at 20s".to_string(),
                    risk_level: PlanRiskLevel::Low,
                    depends_on: vec!["step-1".to_string()],
                    optional: false,
                },
                PlanStep {
                    id: "step-3".to_string(),
                    tool_name: "SplitClip".to_string(),
                    params: serde_json::json!({
                        "sequenceId": seq_id,
                        "trackId": track_id,
                        "clipId": { "$fromStep": "step-1", "$path": "createdIds.0" },
                        "splitTime": 5.0
                    }),
                    description: "Split the first clip at 5s".to_string(),
                    risk_level: PlanRiskLevel::Low,
                    depends_on: vec!["step-1".to_string()],
                    optional: false,
                },
            ],
            approval_granted: true,
            session_id: Some("integration-test".to_string()),
        };

        // 3. Validate and prepare execution order
        let executor = PlanExecutor::new(plan.clone());
        let order = executor
            .validate_and_prepare()
            .expect("Plan should validate");
        assert_eq!(order, vec![0, 1, 2]); // step-1 first, then step-2, step-3

        // 4. Execute steps in order with reference resolution
        let mut step_results: HashMap<String, StepResult> = HashMap::new();
        let mut operation_ids: Vec<String> = Vec::new();

        for &step_idx in &order {
            let step = &plan.steps[step_idx];

            // Resolve references
            let resolved_params = resolve_step_references(&step.params, &step_results)
                .unwrap_or_else(|e| panic!("Reference resolution failed for {}: {}", step.id, e));

            // Parse and build command
            let typed_payload =
                CommandPayload::parse(step.tool_name.clone(), resolved_params.clone())
                    .unwrap_or_else(|e| panic!("Parse failed for {}: {}", step.id, e));
            let command = typed_payload.build_command(&project_path);

            // Execute
            let result = cmd_executor
                .execute(command, &mut state)
                .unwrap_or_else(|e| panic!("Execution failed for {}: {}", step.id, e));

            let step_data = serde_json::json!({
                "operationId": result.op_id,
                "createdIds": result.created_ids,
                "deletedIds": result.deleted_ids,
            });

            operation_ids.push(result.op_id.clone());
            step_results.insert(
                step.id.clone(),
                StepResult {
                    step_id: step.id.clone(),
                    success: true,
                    data: Some(step_data),
                    error: None,
                    duration_ms: 1,
                    operation_id: Some(result.op_id),
                },
            );
        }

        // 5. Verify final state:
        //    - 3 operations executed
        //    - Track should have 3 clips (original split into 2 + 1 inserted)
        assert_eq!(operation_ids.len(), 3);

        let track = &state.sequences[&seq_id].tracks[0];
        // After: insert_clip(0s) -> insert_clip(10s) -> split(5s)
        // The split creates 2 clips from the first, plus the second insert = 3 clips total
        assert_eq!(
            track.clips.len(),
            3,
            "Expected 3 clips after insert+insert+split, got {}",
            track.clips.len()
        );

        // 6. Verify undo works (rollback simulation)
        assert!(cmd_executor.can_undo());
        cmd_executor
            .undo(&mut state)
            .expect("Should undo step-3 (split)");
        // After undoing split: 2 clips remain
        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 2);

        cmd_executor
            .undo(&mut state)
            .expect("Should undo step-2 (insert)");
        // After undoing second insert: 1 clip remains
        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 1);

        cmd_executor
            .undo(&mut state)
            .expect("Should undo step-1 (insert)");
        // After undoing first insert: 0 clips remain
        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 0);
    }
}
