//! IPC (Inter-Process Communication) Module
//!
//! Handles communication between Tauri backend and React frontend.
//! All Tauri commands and events are defined here.

#[cfg(feature = "gui")]
mod ai_command_defaults;
pub mod command_schema;
#[cfg(all(not(test), feature = "gui"))]
mod commands;
// Public so a command's signature can name a DTO by its own path: a `pub`
// command taking a crate-private type is a private-interface violation.
#[cfg(feature = "gui")]
pub mod dto;
#[cfg(all(not(test), feature = "gui"))]
mod events;
mod payloads;

#[allow(unused_imports)]
#[cfg(feature = "gui")]
pub(crate) use ai_command_defaults::*;
#[cfg(all(not(test), feature = "gui"))]
pub use commands::*;
// Named rather than globbed: `commands` and `dto` both carry a `frame_probe`
// module, and two glob re-exports of the same name are ambiguous.
#[allow(unused_imports)]
#[cfg(feature = "gui")]
pub(crate) use dto::serialize_to_json_string;
#[cfg(all(not(test), feature = "gui"))]
pub use events::*;
// Named rather than globbed so the derived-schema helpers keep one path: the
// generated `command_payload_schema` lives with the payloads it dispatches on,
// while the machinery that builds and searches the schemas lives in
// `command_schema`.
pub use command_schema::{
    all_command_payload_schemas, closest_command_type, command_payload_schemas,
    unsupported_command_type_error,
};
pub use payloads::*;

#[cfg(test)]
mod tests_destructive;
