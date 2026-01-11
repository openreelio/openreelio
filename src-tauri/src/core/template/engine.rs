//! Template Engine
//!
//! Core engine for managing, instantiating, and applying templates.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use super::models::{Template, TemplateCategory, TemplateFormat};
use super::sections::{ContentType, TemplateSection, TemplateStyle};
use crate::core::{CoreError, CoreResult};

/// Configuration for the template engine
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateEngineConfig {
    /// Whether to auto-save template instances
    pub auto_save: bool,
    /// Default template format
    pub default_format: TemplateFormat,
    /// Maximum templates to cache
    pub max_cache_size: usize,
    /// Enable AI-powered auto-fill
    pub ai_autofill_enabled: bool,
}

impl Default for TemplateEngineConfig {
    fn default() -> Self {
        Self {
            auto_save: true,
            default_format: TemplateFormat::shorts_1080(),
            max_cache_size: 50,
            ai_autofill_enabled: true,
        }
    }
}

/// A slot in a template instance (maps to a section)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateSlot {
    /// Section ID this slot maps to
    pub section_id: String,
    /// Section name (for display)
    pub section_name: String,
    /// Content type expected
    pub content_type: ContentType,
    /// Whether this slot is required
    pub required: bool,
    /// Assigned asset ID (if filled)
    pub asset_id: Option<String>,
    /// Start time within asset (if filled)
    pub asset_start_sec: Option<f64>,
    /// End time within asset (if filled)
    pub asset_end_sec: Option<f64>,
    /// Generated clip ID (if applied to timeline)
    pub clip_id: Option<String>,
    /// Whether this slot is filled
    pub filled: bool,
    /// AI suggestion for this slot
    pub ai_suggestion: Option<SlotSuggestion>,
}

impl TemplateSlot {
    /// Creates a new slot from a section
    pub fn from_section(section: &TemplateSection) -> Self {
        Self {
            section_id: section.id.clone(),
            section_name: section.name.clone(),
            content_type: section.content_type,
            required: section.required,
            asset_id: None,
            asset_start_sec: None,
            asset_end_sec: None,
            clip_id: None,
            filled: false,
            ai_suggestion: None,
        }
    }

    /// Fills the slot with an asset
    pub fn fill(&mut self, asset_id: String, start_sec: f64, end_sec: f64) {
        self.asset_id = Some(asset_id);
        self.asset_start_sec = Some(start_sec);
        self.asset_end_sec = Some(end_sec);
        self.filled = true;
    }

    /// Clears the slot
    pub fn clear(&mut self) {
        self.asset_id = None;
        self.asset_start_sec = None;
        self.asset_end_sec = None;
        self.clip_id = None;
        self.filled = false;
    }

    /// Returns the duration if filled
    pub fn duration(&self) -> Option<f64> {
        match (self.asset_start_sec, self.asset_end_sec) {
            (Some(start), Some(end)) => Some(end - start),
            _ => None,
        }
    }
}

/// AI suggestion for a template slot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotSuggestion {
    /// Suggested asset ID
    pub asset_id: String,
    /// Suggested start time
    pub start_sec: f64,
    /// Suggested end time
    pub end_sec: f64,
    /// Confidence score (0.0 - 1.0)
    pub confidence: f32,
    /// Explanation for the suggestion
    pub explanation: String,
}

/// An instance of a template being filled
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateInstance {
    /// Instance ID
    pub id: String,
    /// Source template ID
    pub template_id: String,
    /// Template name (cached)
    pub template_name: String,
    /// Creation timestamp
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// Last modified timestamp
    pub modified_at: chrono::DateTime<chrono::Utc>,
    /// Slots to fill
    pub slots: Vec<TemplateSlot>,
    /// Target sequence ID (if applied)
    pub sequence_id: Option<String>,
    /// Custom title for the output
    pub custom_title: Option<String>,
    /// Status
    pub status: InstanceStatus,
    /// Style overrides
    pub style_overrides: HashMap<String, serde_json::Value>,
}

/// Status of a template instance
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstanceStatus {
    /// Being edited
    Draft,
    /// All required slots filled
    Ready,
    /// Applied to timeline
    Applied,
    /// Rendered to output
    Rendered,
    /// Archived
    Archived,
}

impl TemplateInstance {
    /// Creates a new instance from a template
    pub fn from_template(template: &Template) -> Self {
        let slots = template
            .sections
            .iter()
            .map(TemplateSlot::from_section)
            .collect();

        Self {
            id: ulid::Ulid::new().to_string(),
            template_id: template.id.clone(),
            template_name: template.name.clone(),
            created_at: chrono::Utc::now(),
            modified_at: chrono::Utc::now(),
            slots,
            sequence_id: None,
            custom_title: None,
            status: InstanceStatus::Draft,
            style_overrides: HashMap::new(),
        }
    }

    /// Returns the count of filled slots
    pub fn filled_count(&self) -> usize {
        self.slots.iter().filter(|s| s.filled).count()
    }

    /// Returns the count of required slots
    pub fn required_count(&self) -> usize {
        self.slots.iter().filter(|s| s.required).count()
    }

    /// Returns the count of filled required slots
    pub fn filled_required_count(&self) -> usize {
        self.slots.iter().filter(|s| s.required && s.filled).count()
    }

    /// Returns whether all required slots are filled
    pub fn is_ready(&self) -> bool {
        self.required_count() == self.filled_required_count()
    }

    /// Returns the total duration of filled slots
    pub fn total_duration(&self) -> f64 {
        self.slots.iter().filter_map(|s| s.duration()).sum()
    }

    /// Gets a slot by section ID
    pub fn get_slot(&self, section_id: &str) -> Option<&TemplateSlot> {
        self.slots.iter().find(|s| s.section_id == section_id)
    }

    /// Gets a mutable slot by section ID
    pub fn get_slot_mut(&mut self, section_id: &str) -> Option<&mut TemplateSlot> {
        self.slots.iter_mut().find(|s| s.section_id == section_id)
    }

    /// Fills a slot
    pub fn fill_slot(
        &mut self,
        section_id: &str,
        asset_id: String,
        start_sec: f64,
        end_sec: f64,
    ) -> CoreResult<()> {
        let slot = self
            .get_slot_mut(section_id)
            .ok_or_else(|| CoreError::NotFound(format!("Slot not found: {}", section_id)))?;

        slot.fill(asset_id, start_sec, end_sec);
        self.modified_at = chrono::Utc::now();
        self.update_status();

        Ok(())
    }

    /// Clears a slot
    pub fn clear_slot(&mut self, section_id: &str) -> CoreResult<()> {
        let slot = self
            .get_slot_mut(section_id)
            .ok_or_else(|| CoreError::NotFound(format!("Slot not found: {}", section_id)))?;

        slot.clear();
        self.modified_at = chrono::Utc::now();
        self.update_status();

        Ok(())
    }

    /// Updates the status based on filled slots
    fn update_status(&mut self) {
        if self.status == InstanceStatus::Applied || self.status == InstanceStatus::Rendered {
            return; // Don't change these statuses
        }

        if self.is_ready() {
            self.status = InstanceStatus::Ready;
        } else {
            self.status = InstanceStatus::Draft;
        }
    }

    /// Sets a style override
    pub fn set_style_override<T: Serialize>(&mut self, key: &str, value: T) {
        if let Ok(v) = serde_json::to_value(value) {
            self.style_overrides.insert(key.to_string(), v);
            self.modified_at = chrono::Utc::now();
        }
    }
}

/// Main template engine
#[derive(Debug)]
pub struct TemplateEngine {
    /// Registered templates
    templates: Arc<RwLock<HashMap<String, Template>>>,
    /// Active instances
    instances: Arc<RwLock<HashMap<String, TemplateInstance>>>,
    /// Engine configuration
    config: Arc<RwLock<TemplateEngineConfig>>,
}

impl TemplateEngine {
    /// Creates a new template engine
    pub fn new() -> Self {
        let mut engine = Self {
            templates: Arc::new(RwLock::new(HashMap::new())),
            instances: Arc::new(RwLock::new(HashMap::new())),
            config: Arc::new(RwLock::new(TemplateEngineConfig::default())),
        };

        // Register built-in templates
        engine.register_builtin_templates_sync();

        engine
    }

    /// Creates a new template engine with config
    pub fn with_config(config: TemplateEngineConfig) -> Self {
        let mut engine = Self {
            templates: Arc::new(RwLock::new(HashMap::new())),
            instances: Arc::new(RwLock::new(HashMap::new())),
            config: Arc::new(RwLock::new(config)),
        };

        engine.register_builtin_templates_sync();

        engine
    }

    /// Registers built-in templates (sync version for initialization)
    fn register_builtin_templates_sync(&mut self) {
        let templates = self.create_builtin_templates();
        let mut map = HashMap::new();
        for template in templates {
            map.insert(template.id.clone(), template);
        }
        self.templates = Arc::new(RwLock::new(map));
    }

    /// Creates built-in templates
    fn create_builtin_templates(&self) -> Vec<Template> {
        vec![
            self.create_shorts_hook_template(),
            self.create_shorts_story_template(),
            self.create_tutorial_template(),
            self.create_talking_head_template(),
        ]
    }

    /// Creates a Shorts Hook template
    fn create_shorts_hook_template(&self) -> Template {
        Template::new("Shorts - Hook + Content", TemplateCategory::Shorts)
            .with_description("Classic hook followed by main content")
            .with_format(TemplateFormat::shorts_1080())
            .with_section(
                TemplateSection::new("Hook", ContentType::Video)
                    .with_description("Attention-grabbing opening")
                    .with_duration_range(2.0, 5.0)
                    .with_order(1)
                    .with_required(true),
            )
            .with_section(
                TemplateSection::new("Main Content", ContentType::Video)
                    .with_description("Primary video content")
                    .with_duration_range(15.0, 45.0)
                    .with_order(2)
                    .with_required(true),
            )
            .with_section(
                TemplateSection::new("Call to Action", ContentType::Text)
                    .with_description("End with CTA overlay")
                    .with_duration_range(2.0, 5.0)
                    .with_order(3)
                    .with_required(false),
            )
            .with_duration_range(15.0, 60.0)
            .with_style(TemplateStyle::dark_theme())
            .as_builtin()
    }

    /// Creates a Shorts Story template
    fn create_shorts_story_template(&self) -> Template {
        Template::new("Shorts - Story Arc", TemplateCategory::Shorts)
            .with_description("Story structure with setup, conflict, resolution")
            .with_format(TemplateFormat::shorts_1080())
            .with_section(
                TemplateSection::new("Setup", ContentType::Video)
                    .with_description("Introduce the situation")
                    .with_duration_range(5.0, 15.0)
                    .with_order(1)
                    .with_required(true),
            )
            .with_section(
                TemplateSection::new("Conflict", ContentType::Video)
                    .with_description("The problem or challenge")
                    .with_duration_range(10.0, 25.0)
                    .with_order(2)
                    .with_required(true),
            )
            .with_section(
                TemplateSection::new("Resolution", ContentType::Video)
                    .with_description("The outcome or punchline")
                    .with_duration_range(5.0, 15.0)
                    .with_order(3)
                    .with_required(true),
            )
            .with_duration_range(20.0, 60.0)
            .with_style(TemplateStyle::vibrant())
            .as_builtin()
    }

    /// Creates a Tutorial template
    fn create_tutorial_template(&self) -> Template {
        Template::new("Tutorial - Step by Step", TemplateCategory::Educational)
            .with_description("Educational content with clear steps")
            .with_format(TemplateFormat::youtube_1080())
            .with_section(
                TemplateSection::new("Intro", ContentType::TalkingHead)
                    .with_description("Introduce the topic")
                    .with_duration_range(10.0, 30.0)
                    .with_order(1)
                    .with_required(true),
            )
            .with_section(
                TemplateSection::new("Step 1", ContentType::ScreenRecording)
                    .with_description("First step demonstration")
                    .with_duration_range(30.0, 120.0)
                    .with_order(2)
                    .with_required(true),
            )
            .with_section(
                TemplateSection::new("Step 2", ContentType::ScreenRecording)
                    .with_description("Second step demonstration")
                    .with_duration_range(30.0, 120.0)
                    .with_order(3)
                    .with_required(false),
            )
            .with_section(
                TemplateSection::new("Step 3", ContentType::ScreenRecording)
                    .with_description("Third step demonstration")
                    .with_duration_range(30.0, 120.0)
                    .with_order(4)
                    .with_required(false),
            )
            .with_section(
                TemplateSection::new("Outro", ContentType::TalkingHead)
                    .with_description("Wrap up and CTA")
                    .with_duration_range(10.0, 30.0)
                    .with_order(5)
                    .with_required(true),
            )
            .with_duration_range(60.0, 600.0)
            .with_style(TemplateStyle::light_theme())
            .as_builtin()
    }

    /// Creates a Talking Head template
    fn create_talking_head_template(&self) -> Template {
        Template::new("Talking Head + B-Roll", TemplateCategory::Vlog)
            .with_description("Main speaker with supporting footage")
            .with_format(TemplateFormat::youtube_1080())
            .with_section(
                TemplateSection::new("Main Speaker", ContentType::TalkingHead)
                    .with_description("Primary talking head footage")
                    .with_duration_range(60.0, 300.0)
                    .with_order(1)
                    .with_required(true),
            )
            .with_section(
                TemplateSection::new("B-Roll 1", ContentType::BRoll)
                    .with_description("Supporting footage segment 1")
                    .with_duration_range(5.0, 30.0)
                    .with_order(2)
                    .with_required(false),
            )
            .with_section(
                TemplateSection::new("B-Roll 2", ContentType::BRoll)
                    .with_description("Supporting footage segment 2")
                    .with_duration_range(5.0, 30.0)
                    .with_order(3)
                    .with_required(false),
            )
            .with_section(
                TemplateSection::new("Background Music", ContentType::Audio)
                    .with_description("Background music track")
                    .with_duration_range(60.0, 300.0)
                    .with_order(4)
                    .with_required(false),
            )
            .with_duration_range(60.0, 600.0)
            .with_style(TemplateStyle::default())
            .as_builtin()
    }

    /// Registers a template
    pub async fn register_template(&self, template: Template) -> CoreResult<()> {
        template
            .validate()
            .map_err(|e| CoreError::ValidationError(format!("Invalid template: {}", e)))?;

        let mut templates = self.templates.write().await;
        templates.insert(template.id.clone(), template);

        Ok(())
    }

    /// Gets a template by ID
    pub async fn get_template(&self, id: &str) -> Option<Template> {
        let templates = self.templates.read().await;
        templates.get(id).cloned()
    }

    /// Gets all templates
    pub async fn list_templates(&self) -> Vec<Template> {
        let templates = self.templates.read().await;
        templates.values().cloned().collect()
    }

    /// Gets templates by category
    pub async fn list_templates_by_category(&self, category: TemplateCategory) -> Vec<Template> {
        let templates = self.templates.read().await;
        templates
            .values()
            .filter(|t| t.category == category)
            .cloned()
            .collect()
    }

    /// Creates a new instance from a template
    pub async fn create_instance(&self, template_id: &str) -> CoreResult<TemplateInstance> {
        let template = self
            .get_template(template_id)
            .await
            .ok_or_else(|| CoreError::NotFound(format!("Template not found: {}", template_id)))?;

        let instance = TemplateInstance::from_template(&template);

        let mut instances = self.instances.write().await;
        instances.insert(instance.id.clone(), instance.clone());

        Ok(instance)
    }

    /// Gets an instance by ID
    pub async fn get_instance(&self, id: &str) -> Option<TemplateInstance> {
        let instances = self.instances.read().await;
        instances.get(id).cloned()
    }

    /// Updates an instance
    pub async fn update_instance(&self, instance: TemplateInstance) -> CoreResult<()> {
        let mut instances = self.instances.write().await;

        if !instances.contains_key(&instance.id) {
            return Err(CoreError::NotFound(format!(
                "Instance not found: {}",
                instance.id
            )));
        }

        instances.insert(instance.id.clone(), instance);
        Ok(())
    }

    /// Deletes an instance
    pub async fn delete_instance(&self, id: &str) -> CoreResult<()> {
        let mut instances = self.instances.write().await;

        if instances.remove(id).is_none() {
            return Err(CoreError::NotFound(format!("Instance not found: {}", id)));
        }

        Ok(())
    }

    /// Lists all instances
    pub async fn list_instances(&self) -> Vec<TemplateInstance> {
        let instances = self.instances.read().await;
        instances.values().cloned().collect()
    }

    /// Gets the engine configuration
    pub async fn get_config(&self) -> TemplateEngineConfig {
        self.config.read().await.clone()
    }

    /// Sets the engine configuration
    pub async fn set_config(&self, config: TemplateEngineConfig) {
        let mut cfg = self.config.write().await;
        *cfg = config;
    }
}

impl Default for TemplateEngine {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // TemplateSlot Tests
    // ========================================================================

    #[test]
    fn test_slot_from_section() {
        let section = TemplateSection::new("Hook", ContentType::Video).with_required(true);

        let slot = TemplateSlot::from_section(&section);

        assert_eq!(slot.section_id, section.id);
        assert_eq!(slot.section_name, "Hook");
        assert_eq!(slot.content_type, ContentType::Video);
        assert!(slot.required);
        assert!(!slot.filled);
    }

    #[test]
    fn test_slot_fill_and_clear() {
        let section = TemplateSection::new("Test", ContentType::Video);
        let mut slot = TemplateSlot::from_section(&section);

        slot.fill("asset_001".to_string(), 0.0, 10.0);
        assert!(slot.filled);
        assert_eq!(slot.asset_id, Some("asset_001".to_string()));
        assert_eq!(slot.duration(), Some(10.0));

        slot.clear();
        assert!(!slot.filled);
        assert!(slot.asset_id.is_none());
        assert!(slot.duration().is_none());
    }

    // ========================================================================
    // TemplateInstance Tests
    // ========================================================================

    #[test]
    fn test_instance_from_template() {
        let template = Template::new("Test", TemplateCategory::Shorts)
            .with_section(TemplateSection::new("Hook", ContentType::Video).with_required(true))
            .with_section(TemplateSection::new("Main", ContentType::Video).with_required(true))
            .with_section(TemplateSection::new("CTA", ContentType::Text).with_required(false));

        let instance = TemplateInstance::from_template(&template);

        assert_eq!(instance.template_id, template.id);
        assert_eq!(instance.slots.len(), 3);
        assert_eq!(instance.required_count(), 2);
        assert_eq!(instance.status, InstanceStatus::Draft);
    }

    #[test]
    fn test_instance_fill_slot() {
        let template = Template::new("Test", TemplateCategory::Shorts)
            .with_section(TemplateSection::new("Hook", ContentType::Video).with_required(true));

        let mut instance = TemplateInstance::from_template(&template);
        let section_id = instance.slots[0].section_id.clone();

        instance
            .fill_slot(&section_id, "asset_001".to_string(), 0.0, 5.0)
            .unwrap();

        assert_eq!(instance.filled_count(), 1);
        assert!(instance.is_ready());
        assert_eq!(instance.status, InstanceStatus::Ready);
    }

    #[test]
    fn test_instance_clear_slot() {
        let template = Template::new("Test", TemplateCategory::Shorts)
            .with_section(TemplateSection::new("Hook", ContentType::Video).with_required(true));

        let mut instance = TemplateInstance::from_template(&template);
        let section_id = instance.slots[0].section_id.clone();

        instance
            .fill_slot(&section_id, "asset_001".to_string(), 0.0, 5.0)
            .unwrap();
        instance.clear_slot(&section_id).unwrap();

        assert_eq!(instance.filled_count(), 0);
        assert!(!instance.is_ready());
        assert_eq!(instance.status, InstanceStatus::Draft);
    }

    #[test]
    fn test_instance_total_duration() {
        let template = Template::new("Test", TemplateCategory::Shorts)
            .with_section(TemplateSection::new("Hook", ContentType::Video))
            .with_section(TemplateSection::new("Main", ContentType::Video));

        let mut instance = TemplateInstance::from_template(&template);

        instance
            .fill_slot(
                &instance.slots[0].section_id.clone(),
                "a".to_string(),
                0.0,
                5.0,
            )
            .unwrap();
        instance
            .fill_slot(
                &instance.slots[1].section_id.clone(),
                "b".to_string(),
                0.0,
                15.0,
            )
            .unwrap();

        assert_eq!(instance.total_duration(), 20.0);
    }

    #[test]
    fn test_instance_style_override() {
        let template = Template::new("Test", TemplateCategory::Shorts);
        let mut instance = TemplateInstance::from_template(&template);

        instance.set_style_override("custom_font", "Arial");
        assert!(instance.style_overrides.contains_key("custom_font"));
    }

    // ========================================================================
    // TemplateEngine Tests
    // ========================================================================

    #[tokio::test]
    async fn test_engine_new_has_builtin_templates() {
        let engine = TemplateEngine::new();
        let templates = engine.list_templates().await;

        assert!(!templates.is_empty());
        assert!(templates.iter().any(|t| t.builtin));
    }

    #[tokio::test]
    async fn test_engine_get_template() {
        let engine = TemplateEngine::new();
        let templates = engine.list_templates().await;
        let first = &templates[0];

        let retrieved = engine.get_template(&first.id).await;
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().id, first.id);
    }

    #[tokio::test]
    async fn test_engine_list_by_category() {
        let engine = TemplateEngine::new();

        let shorts = engine
            .list_templates_by_category(TemplateCategory::Shorts)
            .await;
        assert!(!shorts.is_empty());

        for t in shorts {
            assert_eq!(t.category, TemplateCategory::Shorts);
        }
    }

    #[tokio::test]
    async fn test_engine_create_instance() {
        let engine = TemplateEngine::new();
        let templates = engine.list_templates().await;
        let template = &templates[0];

        let instance = engine.create_instance(&template.id).await.unwrap();

        assert_eq!(instance.template_id, template.id);
        assert!(!instance.slots.is_empty());
    }

    #[tokio::test]
    async fn test_engine_instance_crud() {
        let engine = TemplateEngine::new();
        let templates = engine.list_templates().await;

        // Create
        let instance = engine.create_instance(&templates[0].id).await.unwrap();
        let instance_id = instance.id.clone();

        // Read
        let retrieved = engine.get_instance(&instance_id).await;
        assert!(retrieved.is_some());

        // Update
        let mut updated = retrieved.unwrap();
        updated.custom_title = Some("My Video".to_string());
        engine.update_instance(updated).await.unwrap();

        let check = engine.get_instance(&instance_id).await.unwrap();
        assert_eq!(check.custom_title, Some("My Video".to_string()));

        // Delete
        engine.delete_instance(&instance_id).await.unwrap();
        assert!(engine.get_instance(&instance_id).await.is_none());
    }

    #[tokio::test]
    async fn test_engine_register_custom_template() {
        let engine = TemplateEngine::new();

        let custom = Template::new(
            "My Custom Template",
            TemplateCategory::Custom("Test".to_string()),
        )
        .with_section(TemplateSection::new("Content", ContentType::Video));

        engine.register_template(custom.clone()).await.unwrap();

        let retrieved = engine.get_template(&custom.id).await;
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().name, "My Custom Template");
    }

    #[tokio::test]
    async fn test_engine_config() {
        let engine = TemplateEngine::new();

        let config = engine.get_config().await;
        assert!(config.auto_save);

        let mut new_config = config;
        new_config.auto_save = false;
        engine.set_config(new_config).await;

        let updated = engine.get_config().await;
        assert!(!updated.auto_save);
    }
}
