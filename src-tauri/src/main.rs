//! OpenReelio Application Entry Point
//!
//! This is the main entry point for the desktop application.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    openreelio_lib::run()
}
