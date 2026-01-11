# OpenReelio Plugin System Specification

This document describes the WASM-based plugin system of OpenReelio in detail.

---

## Table of Contents

1. [Overview](#overview)
2. [Plugin Structure](#plugin-structure)
3. [Plugin Interfaces](#plugin-interfaces)
4. [Permission System](#permission-system)
5. [Development Guide](#development-guide)
6. [Distribution and Installation](#distribution-and-installation)

---

## Overview

### Design Goals

1. **Security**: Execute in sandbox environment
2. **Cross-platform**: Support all platforms via WASM
3. **Extensibility**: Enable various feature extensions
4. **Performance**: Near-native performance

### Plugin Capabilities

| Capability | Description |
|------------|-------------|
| AssetProvider | Provides external assets (memes, stock, BGM) |
| EditAssistant | AI editing assistance |
| EffectPresetProvider | Provides effect presets |
| CaptionStyleProvider | Provides caption styles |
| ExportFormat | Additional output formats |

### Architecture

```
Plugin Host
├── Wasmtime Engine
└── Plugin Sandbox
    ├── WASM Plugin 1
    ├── WASM Plugin 2
    └── WASM Plugin 3
    └── Host Functions (with permission checks)
    └── Permission Manager
```

---

## Plugin Structure

### Directory Structure

```
my-plugin/
├── manifest.json           # Plugin metadata and permissions
├── plugin.wasm             # Compiled WASM binary
├── icon.png                # Plugin icon (128x128)
├── assets/                 # Plugin resources (optional)
│   ├── presets/
│   └── templates/
└── README.md               # Plugin description
```

### manifest.json Schema

```json
{
  "$schema": "https://openreelio.dev/schemas/plugin-manifest.json",

  "name": "my-meme-pack",
  "displayName": "Meme Pack Pro",
  "version": "1.0.0",
  "description": "Popular meme collection",
  "author": {
    "name": "John Doe",
    "email": "author@example.com",
    "url": "https://example.com"
  },
  "license": "MIT",
  "repository": "https://github.com/user/my-meme-pack",

  "openreelioVersion": ">=1.0.0",

  "interfaces": ["AssetProvider"],

  "permissions": {
    "fs": [
      {
        "path": "project:assets/downloaded",
        "read": true,
        "write": true
      }
    ],
    "net": [
      {
        "url": "https://api.meme-service.com/*",
        "methods": ["GET"]
      }
    ],
    "models": [],
    "project": {
      "readAssets": true,
      "readTimeline": false,
      "modifyTimeline": false
    }
  },

  "config": {
    "schema": {
      "apiKey": {
        "type": "string",
        "description": "API Key for meme service",
        "required": false,
        "secret": true
      },
      "maxResults": {
        "type": "number",
        "description": "Maximum search results",
        "default": 20,
        "min": 1,
        "max": 100
      }
    }
  }
}
```

---

## Plugin Interfaces

### AssetProvider

Plugin for providing external assets.

```rust
// Required exports
#[no_mangle]
pub extern "C" fn search(query_ptr: i32, query_len: i32) -> i64;

#[no_mangle]
pub extern "C" fn fetch(ref_ptr: i32, ref_len: i32) -> i64;

#[no_mangle]
pub extern "C" fn get_license(ref_ptr: i32, ref_len: i32) -> i64;
```

### EditAssistant

AI-based editing assistance plugin.

```rust
#[no_mangle]
pub extern "C" fn propose(context_ptr: i32, context_len: i32) -> i64;
```

### EffectPresetProvider

Plugin for effect presets.

```rust
#[no_mangle]
pub extern "C" fn list_presets() -> i64;

#[no_mangle]
pub extern "C" fn apply_preset(id_ptr: i32, id_len: i32, params_ptr: i32, params_len: i32) -> i64;
```

---

## Permission System

### Permission Types

#### File System (fs)

```typescript
interface FsPermission {
  path: string;      // Path pattern
  read: boolean;
  write: boolean;
}
```

Path patterns:
- `project:assets/` - Project's assets folder
- `project:cache/` - Project's cache folder
- `temp:` - Temporary folder
- `plugin:` - Plugin's own folder

#### Network (net)

```typescript
interface NetPermission {
  url: string;           // URL pattern (supports wildcards)
  methods: string[];     // Allowed HTTP methods
}
```

#### AI Models (models)

```typescript
type ModelPermission = string;  // Model name
// Examples: "gpt-4", "claude-3", "whisper"
```

#### Project Access (project)

```typescript
interface ProjectPermission {
  readAssets: boolean;       // Read asset list
  readTimeline: boolean;     // Read timeline state
  modifyTimeline: boolean;   // Generate EditScript
}
```

### Permission Validation

1. At install time, user is shown the list of required permissions
2. At runtime, host function calls are validated against permissions
3. Permission-violating calls result in error return

---

## Development Guide

### Development Environment Setup

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add WASM target
rustup target add wasm32-wasip1

# Install OpenReelio Plugin SDK
cargo install openreelio-plugin-sdk
```

### Create New Plugin

```bash
# Initialize project
openreelio-plugin new my-plugin --template asset-provider

# Build
cd my-plugin
cargo build --target wasm32-wasip1 --release

# Test
openreelio-plugin test
```

### Basic Code Structure

```rust
use openreelio_plugin_sdk::prelude::*;

// Plugin initialization
#[no_mangle]
pub extern "C" fn init() {
    // Initialization code
}

// Asset search implementation
#[no_mangle]
pub extern "C" fn search(query_ptr: i32, query_len: i32) -> i64 {
    let query: SearchQuery = host::read_json(query_ptr, query_len);

    // Execute search
    let results = vec![
        SearchResult {
            asset_ref: "meme_001".to_string(),
            name: "Surprised Pikachu".to_string(),
            preview_url: "https://...".to_string(),
            kind: "image".to_string(),
        },
    ];

    host::write_json(&results)
}
```

### Debugging

```rust
// Log output
host::log(LogLevel::Info, "Processing search query...");
host::log(LogLevel::Debug, &format!("Query: {:?}", query));
host::log(LogLevel::Error, "Failed to fetch asset");
```

---

## Distribution and Installation

### Package Format

```
my-plugin-1.0.0.orpkg
├── manifest.json
├── plugin.wasm
├── icon.png
├── assets/
└── signature.sig        # Package signature
```

### Installation Methods

1. **From Plugin Store**
   - Search in built-in store
   - View verified badge and reviews
   - One-click install

2. **Manual Install**
   - Download .orpkg file
   - Open in OpenReelio
   - Review permissions and confirm

3. **Developer Mode**
   - Link to local folder
   - Hot reload on changes

### Plugin Store Guidelines

1. **Review Process**
   - Permission appropriateness check
   - Security scan
   - Functionality verification

2. **Verification Badge**
   - Verified Publisher
   - Security Audited
   - Official Partner

3. **Update Policy**
   - Auto-update support
   - Version rollback
   - Breaking change notifications
