//! Bins/Folders Module
//!
//! Manages organizational bins (folders) for media assets in the project.
//! Provides hierarchical folder structure with color-coding support.
//! All types are exported to TypeScript via tauri-specta.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::BinId;

// =============================================================================
// Bin Color
// =============================================================================

/// Available colors for bin visual identification
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum BinColor {
    #[default]
    Gray,
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
    Purple,
    Pink,
}

impl BinColor {
    /// Get all available colors
    pub fn all() -> Vec<BinColor> {
        vec![
            BinColor::Gray,
            BinColor::Red,
            BinColor::Orange,
            BinColor::Yellow,
            BinColor::Green,
            BinColor::Blue,
            BinColor::Purple,
            BinColor::Pink,
        ]
    }
}

impl std::str::FromStr for BinColor {
    type Err = String;

    /// Parse color from string (case-insensitive)
    fn from_str(s: &str) -> Result<BinColor, Self::Err> {
        match s.to_lowercase().as_str() {
            "gray" | "grey" => Ok(BinColor::Gray),
            "red" => Ok(BinColor::Red),
            "orange" => Ok(BinColor::Orange),
            "yellow" => Ok(BinColor::Yellow),
            "green" => Ok(BinColor::Green),
            "blue" => Ok(BinColor::Blue),
            "purple" => Ok(BinColor::Purple),
            "pink" => Ok(BinColor::Pink),
            "none" => Ok(BinColor::Gray), // Default to gray for "none"
            _ => Err(format!("Unknown bin color: {}", s)),
        }
    }
}

// =============================================================================
// Bin Model
// =============================================================================

/// A bin (folder) for organizing media assets
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Bin {
    /// Unique bin identifier
    pub id: BinId,
    /// Bin name (display name)
    pub name: String,
    /// Parent bin ID (None for root-level bins)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<BinId>,
    /// Visual color for the bin
    #[serde(default)]
    pub color: BinColor,
    /// Creation timestamp (ISO 8601)
    pub created_at: String,
    /// Whether the bin is expanded in the UI
    #[serde(default)]
    pub expanded: bool,
}

impl Bin {
    /// Creates a new bin with a generated ID
    pub fn new(name: &str) -> Self {
        Self {
            id: format!("bin_{}", ulid::Ulid::new().to_string().to_lowercase()),
            name: name.to_string(),
            parent_id: None,
            color: BinColor::default(),
            created_at: chrono::Utc::now().to_rfc3339(),
            expanded: false,
        }
    }

    /// Creates a new bin with a specific ID (for testing or replay)
    pub fn with_id(id: &str, name: &str) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            parent_id: None,
            color: BinColor::default(),
            created_at: chrono::Utc::now().to_rfc3339(),
            expanded: false,
        }
    }

    /// Sets the parent bin ID
    pub fn with_parent(mut self, parent_id: &str) -> Self {
        self.parent_id = Some(parent_id.to_string());
        self
    }

    /// Sets the bin color
    pub fn with_color(mut self, color: BinColor) -> Self {
        self.color = color;
        self
    }

    /// Sets the expanded state
    pub fn with_expanded(mut self, expanded: bool) -> Self {
        self.expanded = expanded;
        self
    }

    /// Creates a child bin under this bin
    pub fn create_child(&self, name: &str) -> Self {
        let mut child = Bin::new(name);
        child.parent_id = Some(self.id.clone());
        child
    }

    /// Checks if this bin is a root bin (no parent)
    pub fn is_root(&self) -> bool {
        self.parent_id.is_none()
    }

    /// Updates the bin's name
    pub fn rename(&mut self, new_name: &str) {
        self.name = new_name.to_string();
    }

    /// Moves the bin to a new parent
    pub fn move_to(&mut self, new_parent_id: Option<BinId>) {
        self.parent_id = new_parent_id;
    }
}

// =============================================================================
// Validation
// =============================================================================

/// Validates a bin name
pub fn validate_bin_name(name: &str) -> Result<(), &'static str> {
    if name.is_empty() {
        return Err("Bin name cannot be empty");
    }
    if name.len() > 255 {
        return Err("Bin name too long (max 255 characters)");
    }
    // Check for invalid characters
    if name.contains('/') || name.contains('\\') {
        return Err("Bin name cannot contain path separators");
    }
    Ok(())
}

/// Checks if moving a bin to a new parent would create a circular reference
pub fn would_create_cycle(
    bin_id: &str,
    new_parent_id: Option<&str>,
    bins: &std::collections::HashMap<BinId, Bin>,
) -> bool {
    let Some(target_parent_id) = new_parent_id else {
        // Moving to root never creates a cycle
        return false;
    };

    // Check if target is the bin itself
    if target_parent_id == bin_id {
        return true;
    }

    // Check if target is a descendant of the bin
    let mut current_id = Some(target_parent_id.to_string());
    while let Some(ref check_id) = current_id {
        if check_id == bin_id {
            return true;
        }
        current_id = bins.get(check_id).and_then(|b| b.parent_id.clone());
    }

    false
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn test_bin_creation() {
        let bin = Bin::new("My Folder");
        assert!(!bin.id.is_empty());
        assert!(bin.id.starts_with("bin_"));
        assert_eq!(bin.name, "My Folder");
        assert!(bin.parent_id.is_none());
        assert_eq!(bin.color, BinColor::Gray);
        assert!(!bin.created_at.is_empty());
        assert!(!bin.expanded);
    }

    #[test]
    fn test_bin_with_id() {
        let bin = Bin::with_id("bin_test_001", "Test Bin");
        assert_eq!(bin.id, "bin_test_001");
        assert_eq!(bin.name, "Test Bin");
    }

    #[test]
    fn test_bin_builder_methods() {
        let bin = Bin::new("Colored Folder")
            .with_parent("bin_parent")
            .with_color(BinColor::Blue)
            .with_expanded(true);

        assert_eq!(bin.parent_id, Some("bin_parent".to_string()));
        assert_eq!(bin.color, BinColor::Blue);
        assert!(bin.expanded);
    }

    #[test]
    fn test_bin_create_child() {
        let parent = Bin::with_id("bin_parent", "Parent");
        let child = parent.create_child("Child");

        assert_eq!(child.parent_id, Some("bin_parent".to_string()));
        assert_eq!(child.name, "Child");
    }

    #[test]
    fn test_bin_is_root() {
        let root_bin = Bin::new("Root");
        assert!(root_bin.is_root());

        let child_bin = Bin::new("Child").with_parent("parent");
        assert!(!child_bin.is_root());
    }

    #[test]
    fn test_bin_rename() {
        let mut bin = Bin::new("Old Name");
        bin.rename("New Name");
        assert_eq!(bin.name, "New Name");
    }

    #[test]
    fn test_bin_move_to() {
        let mut bin = Bin::new("Moving Bin");
        assert!(bin.is_root());

        bin.move_to(Some("new_parent".to_string()));
        assert_eq!(bin.parent_id, Some("new_parent".to_string()));

        bin.move_to(None);
        assert!(bin.is_root());
    }

    #[test]
    fn test_validate_bin_name_valid() {
        assert!(validate_bin_name("My Folder").is_ok());
        assert!(validate_bin_name("Folder_123").is_ok());
        assert!(validate_bin_name("a").is_ok());
    }

    #[test]
    fn test_validate_bin_name_empty() {
        assert_eq!(validate_bin_name(""), Err("Bin name cannot be empty"));
    }

    #[test]
    fn test_validate_bin_name_too_long() {
        let long_name = "a".repeat(256);
        assert_eq!(
            validate_bin_name(&long_name),
            Err("Bin name too long (max 255 characters)")
        );
    }

    #[test]
    fn test_validate_bin_name_invalid_chars() {
        assert_eq!(
            validate_bin_name("path/separator"),
            Err("Bin name cannot contain path separators")
        );
        assert_eq!(
            validate_bin_name("back\\slash"),
            Err("Bin name cannot contain path separators")
        );
    }

    #[test]
    fn test_would_create_cycle_move_to_root() {
        let bins: HashMap<BinId, Bin> = HashMap::new();
        assert!(!would_create_cycle("bin1", None, &bins));
    }

    #[test]
    fn test_would_create_cycle_move_to_self() {
        let bins: HashMap<BinId, Bin> = HashMap::new();
        assert!(would_create_cycle("bin1", Some("bin1"), &bins));
    }

    #[test]
    fn test_would_create_cycle_move_to_descendant() {
        let mut bins: HashMap<BinId, Bin> = HashMap::new();

        // Create hierarchy: parent -> child -> grandchild
        bins.insert("parent".to_string(), Bin::with_id("parent", "Parent"));
        bins.insert(
            "child".to_string(),
            Bin::with_id("child", "Child").with_parent("parent"),
        );
        bins.insert(
            "grandchild".to_string(),
            Bin::with_id("grandchild", "Grandchild").with_parent("child"),
        );

        // Moving parent to grandchild would create cycle
        assert!(would_create_cycle("parent", Some("grandchild"), &bins));

        // Moving parent to child would create cycle
        assert!(would_create_cycle("parent", Some("child"), &bins));

        // Moving child to grandchild would create cycle
        assert!(would_create_cycle("child", Some("grandchild"), &bins));

        // Moving grandchild to parent is ok
        assert!(!would_create_cycle("grandchild", Some("parent"), &bins));
    }

    #[test]
    fn test_would_create_cycle_no_cycle() {
        let mut bins: HashMap<BinId, Bin> = HashMap::new();

        bins.insert("bin1".to_string(), Bin::with_id("bin1", "Bin 1"));
        bins.insert("bin2".to_string(), Bin::with_id("bin2", "Bin 2"));

        // Moving bin1 under bin2 is ok (no hierarchy)
        assert!(!would_create_cycle("bin1", Some("bin2"), &bins));
    }

    #[test]
    fn test_bin_color_default() {
        let color = BinColor::default();
        assert_eq!(color, BinColor::Gray);
    }

    #[test]
    fn test_bin_color_all() {
        let colors = BinColor::all();
        assert_eq!(colors.len(), 8);
    }

    #[test]
    fn test_bin_serialization() {
        let bin = Bin::with_id("bin_001", "Test")
            .with_parent("bin_parent")
            .with_color(BinColor::Red);

        let json = serde_json::to_string(&bin).unwrap();
        assert!(json.contains("\"id\":\"bin_001\""));
        assert!(json.contains("\"name\":\"Test\""));
        assert!(json.contains("\"parentId\":\"bin_parent\""));
        assert!(json.contains("\"color\":\"red\""));
    }

    #[test]
    fn test_bin_deserialization() {
        let json = r#"{
            "id": "bin_001",
            "name": "Imported Bin",
            "parentId": null,
            "color": "blue",
            "createdAt": "2024-01-01T00:00:00Z",
            "expanded": true
        }"#;

        let bin: Bin = serde_json::from_str(json).unwrap();
        assert_eq!(bin.id, "bin_001");
        assert_eq!(bin.name, "Imported Bin");
        assert!(bin.parent_id.is_none());
        assert_eq!(bin.color, BinColor::Blue);
        assert!(bin.expanded);
    }
}
