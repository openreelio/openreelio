//! Template System
//!
//! Video editing templates for rapid content creation.
//! Provides structure, sections, and AI-powered auto-fill.
//!
//! # Modules
//!
//! - `engine`: Template instantiation and slot management
//! - `models`: Project template data structures (Shorts, YouTube, etc.)
//! - `sections`: Template section configurations
//! - `motion_graphics`: Motion graphics templates (lower thirds, title cards, etc.)

pub mod engine;
pub mod models;
pub mod motion_graphics;
pub mod sections;

// Re-export main types
pub use engine::{TemplateEngine, TemplateEngineConfig, TemplateInstance, TemplateSlot};
pub use models::{Template, TemplateCategory, TemplateFormat, TemplateMetadata};
pub use sections::{ContentType, SectionConfig, TemplateSection, TemplateStyle};

// Motion graphics re-exports (prefixed to avoid conflicts)
pub use motion_graphics::{
    MotionGraphicsTemplate, TemplateElement, TemplateLibrary, TemplateParam, TemplateParamType,
    TemplateValue,
};
