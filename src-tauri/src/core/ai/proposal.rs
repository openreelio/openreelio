//! Proposal Module
//!
//! Manages AI-generated editing proposals that users can review,
//! approve, modify, or reject.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::edit_script::EditScript;
use crate::core::{CoreError, CoreResult};

// =============================================================================
// Proposal Status
// =============================================================================

/// Status of a proposal
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProposalStatus {
    /// Proposal is pending review
    Pending,
    /// User is reviewing the proposal
    Reviewing,
    /// Proposal was approved
    Approved,
    /// Proposal was partially approved (some commands modified/removed)
    PartiallyApproved,
    /// Proposal was rejected
    Rejected,
    /// Proposal was applied to timeline
    Applied,
    /// Proposal application failed
    Failed,
    /// Proposal expired (auto-cleanup)
    Expired,
}

impl Default for ProposalStatus {
    fn default() -> Self {
        Self::Pending
    }
}

// =============================================================================
// Proposal
// =============================================================================

/// An AI-generated editing proposal
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    /// Unique proposal ID
    pub id: String,
    /// The edit script containing commands
    pub script: EditScript,
    /// Current status
    pub status: ProposalStatus,
    /// Creation timestamp (Unix ms)
    pub created_at: u64,
    /// Last update timestamp (Unix ms)
    pub updated_at: u64,
    /// User feedback/notes
    pub user_notes: Option<String>,
    /// Commands that were modified by user
    pub modified_commands: Vec<usize>,
    /// Commands that were removed by user
    pub removed_commands: Vec<usize>,
    /// Preview data (rendered frames, etc.)
    pub preview: Option<ProposalPreview>,
    /// Error message if failed
    pub error: Option<String>,
}

impl Proposal {
    /// Creates a new proposal from an edit script
    pub fn new(script: EditScript) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        Self {
            id: Uuid::new_v4().to_string(),
            script,
            status: ProposalStatus::Pending,
            created_at: now,
            updated_at: now,
            user_notes: None,
            modified_commands: Vec::new(),
            removed_commands: Vec::new(),
            preview: None,
            error: None,
        }
    }

    /// Creates a proposal with a specific ID
    pub fn with_id(mut self, id: &str) -> Self {
        self.id = id.to_string();
        self
    }

    /// Sets the status
    pub fn with_status(mut self, status: ProposalStatus) -> Self {
        self.status = status;
        self.touch();
        self
    }

    /// Adds user notes
    pub fn with_notes(mut self, notes: &str) -> Self {
        self.user_notes = Some(notes.to_string());
        self.touch();
        self
    }

    /// Sets preview data
    pub fn with_preview(mut self, preview: ProposalPreview) -> Self {
        self.preview = Some(preview);
        self.touch();
        self
    }

    /// Updates the timestamp
    fn touch(&mut self) {
        self.updated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
    }

    /// Marks a command as modified
    pub fn mark_modified(&mut self, command_index: usize) {
        if !self.modified_commands.contains(&command_index) {
            self.modified_commands.push(command_index);
            self.touch();
        }
    }

    /// Marks a command as removed
    pub fn mark_removed(&mut self, command_index: usize) {
        if !self.removed_commands.contains(&command_index) {
            self.removed_commands.push(command_index);
            self.touch();
        }
    }

    /// Returns commands that should be applied
    pub fn active_commands(&self) -> Vec<(usize, &super::edit_script::EditCommand)> {
        self.script
            .commands
            .iter()
            .enumerate()
            .filter(|(i, _)| !self.removed_commands.contains(i))
            .collect()
    }

    /// Returns whether this proposal is actionable
    pub fn is_actionable(&self) -> bool {
        matches!(
            self.status,
            ProposalStatus::Pending | ProposalStatus::Reviewing
        )
    }

    /// Returns whether this proposal has been resolved
    pub fn is_resolved(&self) -> bool {
        matches!(
            self.status,
            ProposalStatus::Approved
                | ProposalStatus::PartiallyApproved
                | ProposalStatus::Rejected
                | ProposalStatus::Applied
                | ProposalStatus::Failed
                | ProposalStatus::Expired
        )
    }

    /// Approves the proposal
    pub fn approve(&mut self) {
        self.status = if self.removed_commands.is_empty() && self.modified_commands.is_empty() {
            ProposalStatus::Approved
        } else {
            ProposalStatus::PartiallyApproved
        };
        self.touch();
    }

    /// Rejects the proposal
    pub fn reject(&mut self) {
        self.status = ProposalStatus::Rejected;
        self.touch();
    }

    /// Marks as applied
    pub fn mark_applied(&mut self) {
        self.status = ProposalStatus::Applied;
        self.touch();
    }

    /// Marks as failed
    pub fn mark_failed(&mut self, error: &str) {
        self.status = ProposalStatus::Failed;
        self.error = Some(error.to_string());
        self.touch();
    }
}

// =============================================================================
// Proposal Preview
// =============================================================================

/// Preview data for a proposal
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalPreview {
    /// Preview frame paths
    pub frames: Vec<String>,
    /// Preview video path (if available)
    pub video_path: Option<String>,
    /// Affected time ranges
    pub affected_ranges: Vec<(f64, f64)>,
    /// Estimated duration change in seconds
    pub duration_change: f64,
}

impl ProposalPreview {
    /// Creates a new empty preview
    pub fn new() -> Self {
        Self {
            frames: Vec::new(),
            video_path: None,
            affected_ranges: Vec::new(),
            duration_change: 0.0,
        }
    }

    /// Adds a frame
    pub fn add_frame(mut self, path: &str) -> Self {
        self.frames.push(path.to_string());
        self
    }

    /// Adds an affected range
    pub fn add_range(mut self, start: f64, end: f64) -> Self {
        self.affected_ranges.push((start, end));
        self
    }

    /// Sets duration change
    pub fn with_duration_change(mut self, change: f64) -> Self {
        self.duration_change = change;
        self
    }
}

impl Default for ProposalPreview {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// Proposal Manager
// =============================================================================

/// Manages multiple proposals
pub struct ProposalManager {
    /// Active proposals by ID
    proposals: Arc<RwLock<HashMap<String, Proposal>>>,
    /// Maximum number of proposals to keep
    max_proposals: usize,
    /// Proposal expiry time in milliseconds
    expiry_ms: u64,
}

impl ProposalManager {
    /// Creates a new proposal manager
    pub fn new(max_proposals: usize, expiry_ms: u64) -> Self {
        Self {
            proposals: Arc::new(RwLock::new(HashMap::new())),
            max_proposals,
            expiry_ms,
        }
    }

    /// Creates with default settings
    pub fn with_defaults() -> Self {
        Self::new(100, 3_600_000) // 100 proposals, 1 hour expiry
    }

    /// Adds a new proposal
    pub async fn add(&self, proposal: Proposal) -> CoreResult<String> {
        let id = proposal.id.clone();

        {
            let mut proposals = self.proposals.write().await;

            // Check capacity
            if proposals.len() >= self.max_proposals {
                // Remove oldest resolved proposals first
                let mut to_remove: Vec<_> = proposals
                    .iter()
                    .filter(|(_, p)| p.is_resolved())
                    .map(|(id, p)| (id.clone(), p.created_at))
                    .collect();
                to_remove.sort_by_key(|(_, created)| *created);

                if let Some((old_id, _)) = to_remove.first() {
                    proposals.remove(old_id);
                } else {
                    return Err(CoreError::Internal(
                        "Proposal limit reached and no resolved proposals to remove".to_string(),
                    ));
                }
            }

            proposals.insert(id.clone(), proposal);
        }

        Ok(id)
    }

    /// Gets a proposal by ID
    pub async fn get(&self, id: &str) -> Option<Proposal> {
        let proposals = self.proposals.read().await;
        proposals.get(id).cloned()
    }

    /// Updates a proposal
    pub async fn update(&self, proposal: Proposal) -> CoreResult<()> {
        let mut proposals = self.proposals.write().await;
        if proposals.contains_key(&proposal.id) {
            proposals.insert(proposal.id.clone(), proposal);
            Ok(())
        } else {
            Err(CoreError::NotFound(format!(
                "Proposal not found: {}",
                proposal.id
            )))
        }
    }

    /// Removes a proposal
    pub async fn remove(&self, id: &str) -> Option<Proposal> {
        let mut proposals = self.proposals.write().await;
        proposals.remove(id)
    }

    /// Lists all pending proposals
    pub async fn pending(&self) -> Vec<Proposal> {
        let proposals = self.proposals.read().await;
        proposals
            .values()
            .filter(|p| matches!(p.status, ProposalStatus::Pending))
            .cloned()
            .collect()
    }

    /// Lists all proposals
    pub async fn all(&self) -> Vec<Proposal> {
        let proposals = self.proposals.read().await;
        proposals.values().cloned().collect()
    }

    /// Returns the count of proposals by status
    pub async fn count_by_status(&self) -> HashMap<String, usize> {
        let proposals = self.proposals.read().await;
        let mut counts = HashMap::new();

        for proposal in proposals.values() {
            let status = format!("{:?}", proposal.status);
            *counts.entry(status).or_insert(0) += 1;
        }

        counts
    }

    /// Approves a proposal
    pub async fn approve(&self, id: &str) -> CoreResult<Proposal> {
        let mut proposals = self.proposals.write().await;

        if let Some(proposal) = proposals.get_mut(id) {
            if !proposal.is_actionable() {
                return Err(CoreError::Internal(format!(
                    "Proposal {} is not actionable (status: {:?})",
                    id, proposal.status
                )));
            }
            proposal.approve();
            Ok(proposal.clone())
        } else {
            Err(CoreError::NotFound(format!("Proposal not found: {}", id)))
        }
    }

    /// Rejects a proposal
    pub async fn reject(&self, id: &str) -> CoreResult<Proposal> {
        let mut proposals = self.proposals.write().await;

        if let Some(proposal) = proposals.get_mut(id) {
            if !proposal.is_actionable() {
                return Err(CoreError::Internal(format!(
                    "Proposal {} is not actionable (status: {:?})",
                    id, proposal.status
                )));
            }
            proposal.reject();
            Ok(proposal.clone())
        } else {
            Err(CoreError::NotFound(format!("Proposal not found: {}", id)))
        }
    }

    /// Marks a proposal as applied
    pub async fn mark_applied(&self, id: &str) -> CoreResult<()> {
        let mut proposals = self.proposals.write().await;

        if let Some(proposal) = proposals.get_mut(id) {
            proposal.mark_applied();
            Ok(())
        } else {
            Err(CoreError::NotFound(format!("Proposal not found: {}", id)))
        }
    }

    /// Marks a proposal as failed
    pub async fn mark_failed(&self, id: &str, error: &str) -> CoreResult<()> {
        let mut proposals = self.proposals.write().await;

        if let Some(proposal) = proposals.get_mut(id) {
            proposal.mark_failed(error);
            Ok(())
        } else {
            Err(CoreError::NotFound(format!("Proposal not found: {}", id)))
        }
    }

    /// Cleans up expired proposals
    pub async fn cleanup_expired(&self) -> usize {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let mut proposals = self.proposals.write().await;
        let initial_count = proposals.len();

        proposals.retain(|_, p| {
            // Use saturating_sub to prevent underflow if system time changed
            !(p.is_resolved() && now.saturating_sub(p.updated_at) > self.expiry_ms)
        });

        initial_count - proposals.len()
    }

    /// Clears all proposals
    pub async fn clear(&self) {
        let mut proposals = self.proposals.write().await;
        proposals.clear();
    }
}

impl Default for ProposalManager {
    fn default() -> Self {
        Self::with_defaults()
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ai::edit_script::{EditCommand, EditScript};

    // -------------------------------------------------------------------------
    // Helper Functions
    // -------------------------------------------------------------------------

    fn create_test_script() -> EditScript {
        EditScript::new("Test intent")
            .add_command(EditCommand::insert_clip("track_1", "asset_1", 0.0))
            .add_command(EditCommand::insert_clip("track_1", "asset_2", 5.0))
            .with_explanation("Test explanation")
    }

    // -------------------------------------------------------------------------
    // Proposal Creation Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_proposal_creation() {
        let script = create_test_script();
        let proposal = Proposal::new(script);

        assert!(!proposal.id.is_empty());
        assert_eq!(proposal.status, ProposalStatus::Pending);
        assert!(proposal.created_at > 0);
        assert_eq!(proposal.script.commands.len(), 2);
    }

    #[test]
    fn test_proposal_with_id() {
        let script = create_test_script();
        let proposal = Proposal::new(script).with_id("custom-id");

        assert_eq!(proposal.id, "custom-id");
    }

    #[test]
    fn test_proposal_with_status() {
        let script = create_test_script();
        let proposal = Proposal::new(script).with_status(ProposalStatus::Reviewing);

        assert_eq!(proposal.status, ProposalStatus::Reviewing);
    }

    // -------------------------------------------------------------------------
    // Proposal Status Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_proposal_approve() {
        let script = create_test_script();
        let mut proposal = Proposal::new(script);

        proposal.approve();
        assert_eq!(proposal.status, ProposalStatus::Approved);
    }

    #[test]
    fn test_proposal_approve_with_modifications() {
        let script = create_test_script();
        let mut proposal = Proposal::new(script);

        proposal.mark_modified(0);
        proposal.approve();

        assert_eq!(proposal.status, ProposalStatus::PartiallyApproved);
    }

    #[test]
    fn test_proposal_approve_with_removals() {
        let script = create_test_script();
        let mut proposal = Proposal::new(script);

        proposal.mark_removed(1);
        proposal.approve();

        assert_eq!(proposal.status, ProposalStatus::PartiallyApproved);
    }

    #[test]
    fn test_proposal_reject() {
        let script = create_test_script();
        let mut proposal = Proposal::new(script);

        proposal.reject();
        assert_eq!(proposal.status, ProposalStatus::Rejected);
    }

    #[test]
    fn test_proposal_mark_applied() {
        let script = create_test_script();
        let mut proposal = Proposal::new(script);

        proposal.mark_applied();
        assert_eq!(proposal.status, ProposalStatus::Applied);
    }

    #[test]
    fn test_proposal_mark_failed() {
        let script = create_test_script();
        let mut proposal = Proposal::new(script);

        proposal.mark_failed("Test error");

        assert_eq!(proposal.status, ProposalStatus::Failed);
        assert_eq!(proposal.error, Some("Test error".to_string()));
    }

    // -------------------------------------------------------------------------
    // Proposal State Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_proposal_is_actionable() {
        let script = create_test_script();

        let pending = Proposal::new(script.clone());
        assert!(pending.is_actionable());

        let reviewing = Proposal::new(script.clone()).with_status(ProposalStatus::Reviewing);
        assert!(reviewing.is_actionable());

        let approved = Proposal::new(script.clone()).with_status(ProposalStatus::Approved);
        assert!(!approved.is_actionable());

        let rejected = Proposal::new(script).with_status(ProposalStatus::Rejected);
        assert!(!rejected.is_actionable());
    }

    #[test]
    fn test_proposal_is_resolved() {
        let script = create_test_script();

        let pending = Proposal::new(script.clone());
        assert!(!pending.is_resolved());

        let approved = Proposal::new(script.clone()).with_status(ProposalStatus::Approved);
        assert!(approved.is_resolved());

        let applied = Proposal::new(script).with_status(ProposalStatus::Applied);
        assert!(applied.is_resolved());
    }

    // -------------------------------------------------------------------------
    // Active Commands Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_active_commands_all() {
        let script = create_test_script();
        let proposal = Proposal::new(script);

        let active = proposal.active_commands();
        assert_eq!(active.len(), 2);
    }

    #[test]
    fn test_active_commands_with_removed() {
        let script = create_test_script();
        let mut proposal = Proposal::new(script);

        proposal.mark_removed(0);

        let active = proposal.active_commands();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].0, 1); // Only second command remains
    }

    // -------------------------------------------------------------------------
    // Preview Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_proposal_preview() {
        let preview = ProposalPreview::new()
            .add_frame("/path/frame1.png")
            .add_frame("/path/frame2.png")
            .add_range(0.0, 5.0)
            .add_range(10.0, 15.0)
            .with_duration_change(2.5);

        assert_eq!(preview.frames.len(), 2);
        assert_eq!(preview.affected_ranges.len(), 2);
        assert_eq!(preview.duration_change, 2.5);
    }

    #[test]
    fn test_proposal_with_preview() {
        let script = create_test_script();
        let preview = ProposalPreview::new().add_frame("/path/frame.png");
        let proposal = Proposal::new(script).with_preview(preview);

        assert!(proposal.preview.is_some());
        assert_eq!(proposal.preview.unwrap().frames.len(), 1);
    }

    // -------------------------------------------------------------------------
    // Proposal Manager Tests
    // -------------------------------------------------------------------------

    #[tokio::test]
    async fn test_manager_add_and_get() {
        let manager = ProposalManager::with_defaults();
        let proposal = Proposal::new(create_test_script());
        let id = proposal.id.clone();

        manager.add(proposal).await.unwrap();

        let retrieved = manager.get(&id).await;
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().id, id);
    }

    #[tokio::test]
    async fn test_manager_remove() {
        let manager = ProposalManager::with_defaults();
        let proposal = Proposal::new(create_test_script());
        let id = proposal.id.clone();

        manager.add(proposal).await.unwrap();
        let removed = manager.remove(&id).await;

        assert!(removed.is_some());
        assert!(manager.get(&id).await.is_none());
    }

    #[tokio::test]
    async fn test_manager_update() {
        let manager = ProposalManager::with_defaults();
        let mut proposal = Proposal::new(create_test_script());
        let id = proposal.id.clone();

        manager.add(proposal.clone()).await.unwrap();

        proposal.status = ProposalStatus::Reviewing;
        manager.update(proposal).await.unwrap();

        let retrieved = manager.get(&id).await.unwrap();
        assert_eq!(retrieved.status, ProposalStatus::Reviewing);
    }

    #[tokio::test]
    async fn test_manager_update_not_found() {
        let manager = ProposalManager::with_defaults();
        let proposal = Proposal::new(create_test_script());

        let result = manager.update(proposal).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_manager_pending() {
        let manager = ProposalManager::with_defaults();

        let p1 = Proposal::new(create_test_script());
        let p2 = Proposal::new(create_test_script()).with_status(ProposalStatus::Approved);
        let p3 = Proposal::new(create_test_script());

        manager.add(p1).await.unwrap();
        manager.add(p2).await.unwrap();
        manager.add(p3).await.unwrap();

        let pending = manager.pending().await;
        assert_eq!(pending.len(), 2);
    }

    #[tokio::test]
    async fn test_manager_approve() {
        let manager = ProposalManager::with_defaults();
        let proposal = Proposal::new(create_test_script());
        let id = proposal.id.clone();

        manager.add(proposal).await.unwrap();
        let approved = manager.approve(&id).await.unwrap();

        assert_eq!(approved.status, ProposalStatus::Approved);
    }

    #[tokio::test]
    async fn test_manager_approve_not_actionable() {
        let manager = ProposalManager::with_defaults();
        let proposal = Proposal::new(create_test_script()).with_status(ProposalStatus::Applied);
        let id = proposal.id.clone();

        manager.add(proposal).await.unwrap();
        let result = manager.approve(&id).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_manager_reject() {
        let manager = ProposalManager::with_defaults();
        let proposal = Proposal::new(create_test_script());
        let id = proposal.id.clone();

        manager.add(proposal).await.unwrap();
        let rejected = manager.reject(&id).await.unwrap();

        assert_eq!(rejected.status, ProposalStatus::Rejected);
    }

    #[tokio::test]
    async fn test_manager_count_by_status() {
        let manager = ProposalManager::with_defaults();

        manager
            .add(Proposal::new(create_test_script()))
            .await
            .unwrap();
        manager
            .add(Proposal::new(create_test_script()))
            .await
            .unwrap();
        manager
            .add(Proposal::new(create_test_script()).with_status(ProposalStatus::Approved))
            .await
            .unwrap();

        let counts = manager.count_by_status().await;

        assert_eq!(counts.get("Pending"), Some(&2));
        assert_eq!(counts.get("Approved"), Some(&1));
    }

    #[tokio::test]
    async fn test_manager_capacity() {
        let manager = ProposalManager::new(3, 3_600_000);

        // Add 3 proposals
        let p1 = Proposal::new(create_test_script());
        let p2 = Proposal::new(create_test_script());
        let p3 = Proposal::new(create_test_script());

        manager.add(p1).await.unwrap();
        manager.add(p2.clone()).await.unwrap();
        manager.add(p3).await.unwrap();

        // Try to add 4th without resolved proposals
        let p4 = Proposal::new(create_test_script());
        let result = manager.add(p4).await;
        assert!(result.is_err());

        // Resolve one proposal
        manager.approve(&p2.id).await.unwrap();

        // Now should be able to add
        let p5 = Proposal::new(create_test_script());
        let result = manager.add(p5).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_manager_clear() {
        let manager = ProposalManager::with_defaults();

        manager
            .add(Proposal::new(create_test_script()))
            .await
            .unwrap();
        manager
            .add(Proposal::new(create_test_script()))
            .await
            .unwrap();

        assert_eq!(manager.all().await.len(), 2);

        manager.clear().await;

        assert_eq!(manager.all().await.len(), 0);
    }

    // -------------------------------------------------------------------------
    // Serialization Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_proposal_serialization() {
        let proposal = Proposal::new(create_test_script())
            .with_notes("User notes")
            .with_preview(ProposalPreview::new().add_frame("/path/frame.png"));

        let json = serde_json::to_string(&proposal).unwrap();
        let parsed: Proposal = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.id, proposal.id);
        assert_eq!(parsed.status, proposal.status);
        assert_eq!(parsed.user_notes, proposal.user_notes);
        assert!(parsed.preview.is_some());
    }

    #[test]
    fn test_proposal_status_serialization() {
        let statuses = vec![
            ProposalStatus::Pending,
            ProposalStatus::Reviewing,
            ProposalStatus::Approved,
            ProposalStatus::PartiallyApproved,
            ProposalStatus::Rejected,
            ProposalStatus::Applied,
            ProposalStatus::Failed,
            ProposalStatus::Expired,
        ];

        for status in statuses {
            let json = serde_json::to_string(&status).unwrap();
            let parsed: ProposalStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed, status);
        }
    }
}
