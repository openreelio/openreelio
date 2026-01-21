# OpenReelio

<div align="center">

**AI-Powered Video Editor for Creators**

[![CI](https://github.com/openreelio/openreelio/actions/workflows/ci.yml/badge.svg)](https://github.com/openreelio/openreelio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Features](#features) • [Installation](#installation) • [Documentation](#documentation) • [Contributing](#contributing)

</div>

---

## Overview

OpenReelio is an AI-powered desktop video editor designed for content creators. Built with a prompt-first approach, it combines the power of modern AI with professional editing capabilities.

### Key Concepts

- **Prompt-First Editing**: Describe what you want in natural language
- **Event Sourcing**: Complete edit history with unlimited undo/redo
- **AI Agent-Driven**: Parallel processing, automatic analysis, source generation
- **IDE-like Experience**: Familiar interface for developers and creators

## Features

### Core Editing
- Non-linear timeline with multi-track support
- Clip splitting, trimming, and repositioning
- Effects and transitions
- Audio mixing and synchronization
- Caption/subtitle support with styling

### AI Integration
- Natural language edit commands
- Automatic scene detection
- Speech-to-text transcription
- Smart asset search (text + semantic)
- AI-generated edit suggestions

### Plugin System
- WASM-based sandboxed plugins
- Asset providers (stock media, memes, audio)
- Custom effect presets
- Template providers

### Quality Control
- Automated QC rules (7 built-in)
- Black frame detection
- Audio peak monitoring
- Caption safe area checking
- Auto-fix suggestions

### Performance
- GPU-accelerated encoding (NVENC, AMF, QSV, VideoToolbox)
- Parallel proxy generation
- Efficient memory pooling
- Smart caching with LRU/LFU eviction

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | [Tauri](https://tauri.app/) 2.x |
| Backend | Rust |
| Frontend | React 18 + TypeScript |
| State | Zustand + Immer |
| Styling | Tailwind CSS |
| Video | FFmpeg |
| Plugins | WebAssembly (Wasmtime) |
| Database | SQLite |

## Installation

### Prerequisites

- [Rust](https://rustup.rs/) 1.85+
- [Node.js](https://nodejs.org/) 20+
- [FFmpeg](https://ffmpeg.org/) 6+
- (Optional) LLVM/Clang for Whisper: building with `--features whisper` requires `libclang` (bindgen). On Windows, install LLVM and set `LIBCLANG_PATH` to the folder containing `libclang.dll`.

### From Source

```bash
# Clone the repository
git clone https://github.com/openreelio/openreelio.git
cd openreelio

# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

### Pre-built Binaries

Download the latest release from the [Releases](https://github.com/openreelio/openreelio/releases) page.

## Documentation

- [Architecture Overview](docs/ARCHITECTURE.md)
- [API Specification](docs/API_SPEC.md)
- [Command Reference](docs/COMMAND_REFERENCE.md)
- [Data Models](docs/DATA_MODELS.md)
- [Plugin Development](docs/PLUGIN_SPEC.md)

## Project Structure

```
openreelio/
├── src/                    # React frontend
│   ├── components/         # UI components
│   ├── stores/             # Zustand stores
│   └── types/              # TypeScript types
├── src-tauri/              # Rust backend
│   └── src/
│       ├── core/           # Core engine
│       │   ├── ai/         # AI integration
│       │   ├── commands/   # Edit commands
│       │   ├── plugin/     # Plugin system
│       │   ├── qc/         # QC automation
│       │   └── ...
│       └── ipc/            # Tauri IPC layer
└── docs/                   # Documentation
```

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Quick Start

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

### Development

```bash
# Run frontend tests
npm test

# Run Rust tests
cd src-tauri && cargo test

# Run linter
npm run lint
cargo clippy
```

Notes:
- Windows PowerShell may block `npm` due to `npm.ps1` execution policy. Use `npm.cmd ...` (or adjust PowerShell execution policy) if you see `PSSecurityException`.

## Roadmap

- [ ] Real AI provider integration (OpenAI, Anthropic)
- [ ] Video generation (Sora, Runway)
- [ ] Collaboration features
- [ ] Cloud project sync
- [ ] Mobile companion app

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Tauri](https://tauri.app/) for the amazing desktop framework
- [FFmpeg](https://ffmpeg.org/) for video processing
- All our [contributors](https://github.com/openreelio/openreelio/graphs/contributors)

---

<div align="center">
Made with ❤️ by the OpenReelio community
</div>
