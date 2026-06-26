# Whisper GPU Acceleration and Quantized Models

Status: code implemented; macOS Intel Metal release builds enabled for Phase 1.
Date: 2026-06-27

## Goal

OpenReelio should provide local Whisper transcription that is accurate enough
for multilingual and sung content while remaining practical for desktop users.
The implementation therefore combines:

- A quantized large-v3-turbo default model for a smaller download and lower RAM.
- Optional GPU acceleration backends compiled per release target.
- Automatic CPU fallback when a GPU backend is compiled but unavailable at
  runtime.

## Quantized Model Catalog

The local Whisper model catalog now includes:

| Model ID | File | Estimated Size | Purpose |
| --- | --- | ---: | --- |
| `large-v3-turbo-q5_0` | `ggml-large-v3-turbo-q5_0.bin` | 574 MB | Recommended balanced default |
| `large-v3-turbo-q8_0` | `ggml-large-v3-turbo-q8_0.bin` | 834 MB | Higher precision turbo option |
| `large-v3-q5_0` | `ggml-large-v3-q5_0.bin` | 1.1 GB | Quantized large-v3 option |

`large-v3-turbo-q5_0` is the recommended default because it keeps the download
small while avoiding the accuracy problems common with tiny/base/small models on
non-English speech and singing.

## Cargo Features

The base `whisper` feature remains CPU-safe. Hardware backends are explicit:

```toml
whisper-metal = ["whisper", "whisper-rs/metal"]
whisper-cuda = ["whisper", "whisper-rs/cuda"]
whisper-vulkan = ["whisper", "whisper-rs/vulkan"]
whisper-coreml = ["whisper", "whisper-rs/coreml"]
whisper-openblas = ["whisper", "whisper-rs/openblas"]
```

These features are not part of the default build because CUDA, Vulkan, CoreML,
and OpenBLAS can require platform-specific SDKs or runtime dependencies.

## Runtime Behavior

1. CPU-only builds behave as before.
2. GPU builds initialize Whisper with `use_gpu(true)`.
3. If GPU initialization fails, the engine retries once with CPU parameters.
4. `get_transcription_status()` reports the compiled backend through the
   additive `acceleration` field.

The runtime does not expose a manual GPU toggle. The compiled backend is used
automatically when available, with CPU fallback as the safety path.

## Release Rollout

Phase 1 enables Metal on the Intel macOS release target:

- `x86_64-apple-darwin`

Metal is low risk because it ships with macOS and does not require an extra
runtime dependency from users.

Future phases can add:

- Metal for `aarch64-apple-darwin` after the Apple Silicon CI linker failure is
  resolved (`___isPlatformVersionAtLeast` from `ggml-metal-device.m.o`).
- Vulkan for Windows and Linux after CI SDK installation and smoke validation.
- CUDA as an optional NVIDIA-focused artifact if the packaging cost of CUDA
  runtime libraries is acceptable.

## Verification Notes

- Default local builds should continue to report `acceleration = "cpu"`.
- Intel macOS release builds compiled with `whisper-metal` should report
  `acceleration = "metal"`.
- Apple Silicon release builds currently remain CPU Whisper builds and should
  report `acceleration = "cpu"`.
- GPU initialization failure must not abort transcription; it should fall back to
  CPU.
- TypeScript bindings must be regenerated whenever transcription status fields
  change.
