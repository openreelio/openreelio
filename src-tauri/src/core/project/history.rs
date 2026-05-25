//! Persistent project history manifest.
//!
//! This tracks the currently applied operation chain plus redo candidates so
//! headless frontends can preserve undo/redo behavior across process restarts
//! without mutating the append-only ops log.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::core::{
    project::{state::ProjectMeta, Operation},
    CoreError, CoreResult, OpId,
};

/// Serializable history metadata stored alongside the ops log.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHistory {
    /// History format version for future migrations.
    pub version: String,
    /// Stable project metadata baseline used when rebuilding state from a subset of ops.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_meta: Option<ProjectMeta>,
    /// Applied operations in execution order.
    pub applied_op_ids: Vec<OpId>,
    /// Undone operations in redo order. The last entry is the next redo target.
    pub redo_op_ids: Vec<OpId>,
    /// Operations recorded in the append-only ops log but intentionally excluded
    /// from active history, such as rolled-back failed agent plan steps.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub discarded_op_ids: Vec<OpId>,
    /// Number of applied operations that are intentionally excluded from undo.
    pub protected_prefix_len: usize,
}

impl Default for ProjectHistory {
    fn default() -> Self {
        Self {
            version: "1.0.0".to_string(),
            base_meta: None,
            applied_op_ids: Vec::new(),
            redo_op_ids: Vec::new(),
            discarded_op_ids: Vec::new(),
            protected_prefix_len: 0,
        }
    }
}

impl ProjectHistory {
    /// Builds a history manifest from the current ops log order.
    pub fn from_operations(operations: &[Operation], base_meta: ProjectMeta) -> Self {
        let mut history = Self {
            version: "1.0.0".to_string(),
            base_meta: Some(base_meta),
            applied_op_ids: operations.iter().map(|op| op.id.clone()).collect(),
            redo_op_ids: Vec::new(),
            discarded_op_ids: Vec::new(),
            protected_prefix_len: protected_prefix_len_for_operations(operations),
        };
        history.sanitize(operations);
        history
    }

    /// Loads history from disk. Missing files return the default empty history.
    pub fn load(path: &Path) -> CoreResult<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }

        let file = std::fs::File::open(path)?;
        let history = serde_json::from_reader(file)?;
        Ok(history)
    }

    /// Persists history to disk atomically.
    pub fn save(&self, path: &Path) -> CoreResult<()> {
        crate::core::fs::atomic_write_json_pretty(path, self)
    }

    /// Returns the current operation head.
    pub fn current_head(&self) -> Option<&str> {
        self.applied_op_ids.last().map(String::as_str)
    }

    /// Returns `true` when an undo is available.
    pub fn can_undo(&self) -> bool {
        self.applied_op_ids.len() > self.protected_prefix_len
    }

    /// Returns `true` when a redo is available.
    pub fn can_redo(&self) -> bool {
        !self.redo_op_ids.is_empty()
    }

    /// Moves the latest applied operation to the redo stack.
    pub fn undo(&mut self) -> CoreResult<OpId> {
        if !self.can_undo() {
            return Err(CoreError::NothingToUndo);
        }

        let op_id = self.applied_op_ids.pop().ok_or(CoreError::NothingToUndo)?;
        self.redo_op_ids.push(op_id.clone());
        Ok(op_id)
    }

    /// Re-applies the next redo candidate.
    pub fn redo(&mut self) -> CoreResult<OpId> {
        let op_id = self.redo_op_ids.pop().ok_or(CoreError::NothingToRedo)?;
        self.applied_op_ids.push(op_id.clone());
        Ok(op_id)
    }

    /// Appends newly recorded operations and clears redo history.
    pub fn append_new_operations<I>(&mut self, op_ids: I)
    where
        I: IntoIterator<Item = OpId>,
    {
        let mut appended_any = false;
        for op_id in op_ids {
            if self
                .applied_op_ids
                .iter()
                .any(|existing| existing == &op_id)
                || self.redo_op_ids.iter().any(|existing| existing == &op_id)
                || self
                    .discarded_op_ids
                    .iter()
                    .any(|existing| existing == &op_id)
            {
                continue;
            }

            self.applied_op_ids.push(op_id);
            appended_any = true;
        }

        if appended_any {
            self.redo_op_ids.clear();
        }
    }

    /// Marks operations as intentionally excluded from both applied and redo history.
    ///
    /// The ops log remains append-only, so failed transactional work cannot be
    /// deleted from disk. Recording discarded IDs prevents later history syncs
    /// from treating those durable log entries as newly applied user edits.
    pub fn discard_operations<I>(&mut self, op_ids: I)
    where
        I: IntoIterator<Item = OpId>,
    {
        let mut discard_set = HashSet::new();
        for op_id in op_ids {
            if discard_set.insert(op_id.clone())
                && !self
                    .discarded_op_ids
                    .iter()
                    .any(|existing| existing == &op_id)
            {
                self.discarded_op_ids.push(op_id);
            }
        }

        if discard_set.is_empty() {
            return;
        }

        self.applied_op_ids
            .retain(|op_id| !discard_set.contains(op_id));
        self.redo_op_ids
            .retain(|op_id| !discard_set.contains(op_id));
        self.protected_prefix_len = self.protected_prefix_len.min(self.applied_op_ids.len());
    }

    /// Removes references to missing/duplicate operation IDs.
    pub fn sanitize(&mut self, operations: &[Operation]) {
        let valid_ids: HashSet<&str> = operations.iter().map(|op| op.id.as_str()).collect();

        let mut seen_discarded = HashSet::new();
        self.discarded_op_ids.retain(|op_id| {
            valid_ids.contains(op_id.as_str()) && seen_discarded.insert(op_id.clone())
        });
        let discarded_ids: HashSet<&str> =
            self.discarded_op_ids.iter().map(String::as_str).collect();

        let mut seen_applied = HashSet::new();
        self.applied_op_ids.retain(|op_id| {
            valid_ids.contains(op_id.as_str())
                && !discarded_ids.contains(op_id.as_str())
                && seen_applied.insert(op_id.clone())
        });

        self.protected_prefix_len =
            protected_prefix_len_for_applied_operations(operations, &self.applied_op_ids);

        let applied_ids: HashSet<&str> = self.applied_op_ids.iter().map(String::as_str).collect();
        let mut seen_redo = HashSet::new();
        self.redo_op_ids.retain(|op_id| {
            valid_ids.contains(op_id.as_str())
                && !applied_ids.contains(op_id.as_str())
                && !discarded_ids.contains(op_id.as_str())
                && seen_redo.insert(op_id.clone())
        });
    }
}

fn protected_prefix_len_for_operations(operations: &[Operation]) -> usize {
    operations
        .first()
        .filter(|op| matches!(op.kind, crate::core::project::OpKind::SequenceCreate))
        .map(|_| 1)
        .unwrap_or(0)
}

fn protected_prefix_len_for_applied_operations(
    operations: &[Operation],
    applied_op_ids: &[OpId],
) -> usize {
    let Some(first_operation) = operations.first() else {
        return 0;
    };

    if !matches!(
        first_operation.kind,
        crate::core::project::OpKind::SequenceCreate
    ) {
        return 0;
    }

    usize::from(applied_op_ids.first().map(String::as_str) == Some(first_operation.id.as_str()))
}

#[cfg(test)]
mod tests {
    use super::ProjectHistory;
    use crate::core::project::{OpKind, Operation, ProjectMeta};

    #[test]
    fn history_should_keep_first_sequence_create_protected() {
        let operations = vec![
            Operation::with_id("op1", OpKind::SequenceCreate, serde_json::json!({})),
            Operation::with_id("op2", OpKind::AssetImport, serde_json::json!({})),
        ];

        let history =
            ProjectHistory::from_operations(&operations, ProjectMeta::new("History Test"));

        assert_eq!(history.protected_prefix_len, 1);
        assert_eq!(
            history.applied_op_ids,
            vec!["op1".to_string(), "op2".to_string()]
        );
        assert!(history.can_undo());
    }

    #[test]
    fn history_undo_redo_should_move_operation_ids_between_stacks() {
        let operations = vec![
            Operation::with_id("op1", OpKind::SequenceCreate, serde_json::json!({})),
            Operation::with_id("op2", OpKind::AssetImport, serde_json::json!({})),
            Operation::with_id("op3", OpKind::ClipAdd, serde_json::json!({})),
        ];

        let mut history =
            ProjectHistory::from_operations(&operations, ProjectMeta::new("History Test"));
        let undone = history.undo().unwrap();
        assert_eq!(undone, "op3");
        assert_eq!(
            history.applied_op_ids,
            vec!["op1".to_string(), "op2".to_string()]
        );
        assert_eq!(history.redo_op_ids, vec!["op3".to_string()]);

        let redone = history.redo().unwrap();
        assert_eq!(redone, "op3");
        assert_eq!(
            history.applied_op_ids,
            vec!["op1".to_string(), "op2".to_string(), "op3".to_string()]
        );
        assert!(history.redo_op_ids.is_empty());
    }

    #[test]
    fn sanitize_should_restore_protected_prefix_after_incremental_append() {
        let operations = vec![
            Operation::with_id("op1", OpKind::SequenceCreate, serde_json::json!({})),
            Operation::with_id("op2", OpKind::AssetImport, serde_json::json!({})),
        ];

        let mut history = ProjectHistory::default();
        history.append_new_operations(["op1".to_string(), "op2".to_string()]);
        history.sanitize(&operations);

        assert_eq!(history.protected_prefix_len, 1);
        assert!(history.can_undo());
    }

    #[test]
    fn discarded_operations_should_not_be_reapplied_by_history_sync() {
        let operations = vec![
            Operation::with_id("op1", OpKind::SequenceCreate, serde_json::json!({})),
            Operation::with_id("op2", OpKind::AssetImport, serde_json::json!({})),
            Operation::with_id("op3", OpKind::ClipAdd, serde_json::json!({})),
        ];

        let mut history =
            ProjectHistory::from_operations(&operations, ProjectMeta::new("History Test"));

        history.discard_operations(["op2".to_string(), "op3".to_string()]);
        history.sanitize(&operations);
        history.append_new_operations(["op2".to_string(), "op3".to_string()]);
        history.sanitize(&operations);

        assert_eq!(history.applied_op_ids, vec!["op1".to_string()]);
        assert!(history.redo_op_ids.is_empty());
        assert_eq!(
            history.discarded_op_ids,
            vec!["op2".to_string(), "op3".to_string()]
        );
        assert!(!history.can_undo());
    }
}
