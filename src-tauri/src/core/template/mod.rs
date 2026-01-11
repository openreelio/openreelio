//! Template System
//!
//! Video editing templates for rapid content creation.
//! Provides structure, sections, and AI-powered auto-fill.

pub mod engine;
pub mod models;
pub mod sections;

// Re-export main types
pub use engine::{TemplateEngine, TemplateEngineConfig, TemplateInstance, TemplateSlot};
pub use models::{Template, TemplateCategory, TemplateFormat, TemplateMetadata};
pub use sections::{ContentType, SectionConfig, TemplateSection, TemplateStyle};
