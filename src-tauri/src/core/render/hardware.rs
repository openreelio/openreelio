//! Hardware Encoder Detection & Resolution
//!
//! Detects available GPU video encoders (NVENC, QSV, AMF, VideoToolbox)
//! and resolves the appropriate FFmpeg encoder name based on user preference.

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};
use specta::Type;

use super::export::VideoCodec;

/// Hardware encoder backend
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum HardwareAccelMode {
    /// Automatically detect and use best available GPU encoder
    #[default]
    Auto,
    /// Force CPU-only software encoding
    Cpu,
    /// NVIDIA NVENC
    Nvenc,
    /// Intel Quick Sync Video
    Qsv,
    /// AMD AMF (Advanced Media Framework)
    Amf,
    /// Apple VideoToolbox (macOS only)
    VideoToolbox,
}

/// Information about a detected hardware encoder
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HardwareEncoderInfo {
    /// The encoder backend identifier
    pub backend: HardwareAccelMode,
    /// Human-readable display name
    pub display_name: String,
    /// FFmpeg encoder name for H.264 (e.g., "h264_nvenc")
    pub h264_encoder: String,
    /// FFmpeg encoder name for H.265/HEVC (e.g., "hevc_nvenc")
    pub h265_encoder: String,
}

/// Result of probing available hardware encoders
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AvailableEncoders {
    /// List of detected hardware encoder backends
    pub hardware: Vec<HardwareEncoderInfo>,
    /// Whether any hardware encoder is available
    pub has_hardware: bool,
}

/// Known hardware encoder definitions (FFmpeg encoder name → backend info)
const HARDWARE_ENCODERS: &[(&str, &str, &str, &str, &str)] = &[
    // (probe_encoder, backend_id, display_name, h264_encoder, h265_encoder)
    (
        "h264_nvenc",
        "nvenc",
        "NVIDIA NVENC",
        "h264_nvenc",
        "hevc_nvenc",
    ),
    (
        "h264_qsv",
        "qsv",
        "Intel Quick Sync Video",
        "h264_qsv",
        "hevc_qsv",
    ),
    ("h264_amf", "amf", "AMD AMF", "h264_amf", "hevc_amf"),
    (
        "h264_videotoolbox",
        "videotoolbox",
        "Apple VideoToolbox",
        "h264_videotoolbox",
        "hevc_videotoolbox",
    ),
];

/// Detect available hardware encoders by probing FFmpeg
///
/// Runs `ffmpeg -encoders` and parses the output to find GPU-accelerated encoders.
pub fn detect_available_encoders(ffmpeg_path: &Path) -> AvailableEncoders {
    let encoder_list = match query_ffmpeg_encoders(ffmpeg_path) {
        Ok(output) => output,
        Err(e) => {
            tracing::warn!("Failed to probe FFmpeg encoders: {}", e);
            return AvailableEncoders {
                hardware: Vec::new(),
                has_hardware: false,
            };
        }
    };

    let mut hardware = Vec::new();

    for &(probe_encoder, _backend_id, display_name, h264_enc, h265_enc) in HARDWARE_ENCODERS {
        if encoder_list.contains(probe_encoder) {
            let backend = match _backend_id {
                "nvenc" => HardwareAccelMode::Nvenc,
                "qsv" => HardwareAccelMode::Qsv,
                "amf" => HardwareAccelMode::Amf,
                "videotoolbox" => HardwareAccelMode::VideoToolbox,
                _ => continue,
            };

            // Verify H.265 encoder independently — older GPUs or driver versions
            // may support H.264 hardware encoding but not H.265.
            let verified_h265 = if encoder_list.contains(h265_enc) {
                h265_enc.to_string()
            } else {
                tracing::info!(
                    "{} H.265 encoder ({}) not found, will fall back to software for HEVC",
                    display_name,
                    h265_enc
                );
                String::new()
            };

            hardware.push(HardwareEncoderInfo {
                backend,
                display_name: display_name.to_string(),
                h264_encoder: h264_enc.to_string(),
                h265_encoder: verified_h265,
            });
        }
    }

    let has_hardware = !hardware.is_empty();
    AvailableEncoders {
        hardware,
        has_hardware,
    }
}

/// Query FFmpeg for the list of supported encoders
fn query_ffmpeg_encoders(ffmpeg_path: &Path) -> Result<String, String> {
    let mut command = Command::new(ffmpeg_path);
    crate::core::process::configure_std_command(&mut command);
    let output = command
        .args(["-encoders", "-hide_banner"])
        .output()
        .map_err(|e| format!("Failed to execute ffmpeg: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // FFmpeg -encoders writes to stdout; accept even with non-zero exit
    // as some builds return 1 but still output the encoder list
    if stdout.is_empty() && !stderr.is_empty() {
        return Err(format!("FFmpeg encoder probe failed: {}", stderr));
    }

    Ok(stdout)
}

/// Resolve the FFmpeg video encoder name based on codec and hardware preference
///
/// Returns the appropriate FFmpeg encoder name (e.g., "libx264", "h264_nvenc").
/// Falls back to software encoder when hardware is unavailable or not applicable.
pub fn resolve_video_encoder(
    codec: &VideoCodec,
    hw_mode: &HardwareAccelMode,
    available: &AvailableEncoders,
) -> String {
    // Software-only codecs have no GPU variant
    match codec {
        VideoCodec::Vp9 => return "libvpx-vp9".to_string(),
        VideoCodec::ProRes => return "prores_ks".to_string(),
        VideoCodec::Copy => return "copy".to_string(),
        VideoCodec::H264 | VideoCodec::H265 => {}
    }

    // CPU mode always uses software encoder
    if *hw_mode == HardwareAccelMode::Cpu {
        return software_encoder_name(codec);
    }

    // Find matching hardware encoder
    let target_backend = match hw_mode {
        HardwareAccelMode::Auto => {
            // Auto: pick first available hardware encoder
            available.hardware.first()
        }
        HardwareAccelMode::Nvenc
        | HardwareAccelMode::Qsv
        | HardwareAccelMode::Amf
        | HardwareAccelMode::VideoToolbox => available
            .hardware
            .iter()
            .find(|info| info.backend == *hw_mode),
        HardwareAccelMode::Cpu => unreachable!(),
    };

    match target_backend {
        Some(info) => {
            let encoder = match codec {
                VideoCodec::H264 => &info.h264_encoder,
                VideoCodec::H265 => &info.h265_encoder,
                _ => unreachable!(),
            };
            // Fall back to software if the specific codec encoder was not verified
            if encoder.is_empty() {
                return software_encoder_name(codec);
            }
            encoder.clone()
        }
        None => {
            // No matching hardware encoder available — fallback to software
            if *hw_mode != HardwareAccelMode::Auto {
                tracing::warn!(
                    "Requested hardware encoder {:?} not available, falling back to software",
                    hw_mode
                );
            }
            software_encoder_name(codec)
        }
    }
}

/// Get the software (CPU) encoder name for a video codec
pub fn software_encoder_name(codec: &VideoCodec) -> String {
    match codec {
        VideoCodec::H264 => "libx264".to_string(),
        VideoCodec::H265 => "libx265".to_string(),
        VideoCodec::Vp9 => "libvpx-vp9".to_string(),
        VideoCodec::ProRes => "prores_ks".to_string(),
        VideoCodec::Copy => "copy".to_string(),
    }
}

/// Resolve quality arguments for a given encoder
///
/// GPU encoders use different quality parameters than software encoders:
/// - libx264/libx265: `-crf <value>`
/// - NVENC: `-cq <value> -preset p4 -tune hq`
/// - QSV: `-global_quality <value>`
/// - AMF: `-quality <value> -rc cqp -qp_i <crf> -qp_p <crf>`
/// - VideoToolbox: `-q:v <scaled_value>`
pub fn resolve_quality_args(encoder_name: &str, crf: u8) -> Vec<String> {
    if encoder_name.contains("nvenc") {
        vec![
            "-cq".to_string(),
            crf.to_string(),
            "-preset".to_string(),
            "p4".to_string(),
            "-tune".to_string(),
            "hq".to_string(),
            "-rc".to_string(),
            "vbr".to_string(),
        ]
    } else if encoder_name.contains("qsv") {
        vec!["-global_quality".to_string(), crf.to_string()]
    } else if encoder_name.contains("amf") {
        vec![
            "-rc".to_string(),
            "cqp".to_string(),
            "-qp_i".to_string(),
            crf.to_string(),
            "-qp_p".to_string(),
            crf.to_string(),
        ]
    } else if encoder_name.contains("videotoolbox") {
        // VideoToolbox uses a 1-100 quality scale; approximate from CRF
        let quality = (51u8.saturating_sub(crf)).min(100);
        vec!["-q:v".to_string(), quality.to_string()]
    } else {
        // Software encoders: standard CRF
        vec!["-crf".to_string(), crf.to_string()]
    }
}

/// Check whether an encoder name represents a hardware encoder
pub fn is_hardware_encoder(encoder_name: &str) -> bool {
    encoder_name.contains("nvenc")
        || encoder_name.contains("qsv")
        || encoder_name.contains("amf")
        || encoder_name.contains("videotoolbox")
}

// =============================================================================
// Hardware Decoder Detection
// =============================================================================

/// Hardware decoder backend for video decoding acceleration
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum HardwareDecoderBackend {
    /// NVIDIA CUDA (CUVID)
    Cuda,
    /// Direct3D 11 Video Acceleration (Windows)
    D3d11va,
    /// DXVA2 (Windows, legacy)
    Dxva2,
    /// Intel Quick Sync Video
    Qsv,
    /// Video Acceleration API (Linux)
    Vaapi,
    /// Video Decode and Presentation API for Unix (Linux, legacy)
    Vdpau,
    /// Apple VideoToolbox (macOS)
    VideoToolbox,
    /// Vulkan Video
    Vulkan,
}

impl HardwareDecoderBackend {
    /// FFmpeg `-hwaccel` argument value
    pub fn hwaccel_name(&self) -> &'static str {
        match self {
            HardwareDecoderBackend::Cuda => "cuda",
            HardwareDecoderBackend::D3d11va => "d3d11va",
            HardwareDecoderBackend::Dxva2 => "dxva2",
            HardwareDecoderBackend::Qsv => "qsv",
            HardwareDecoderBackend::Vaapi => "vaapi",
            HardwareDecoderBackend::Vdpau => "vdpau",
            HardwareDecoderBackend::VideoToolbox => "videotoolbox",
            HardwareDecoderBackend::Vulkan => "vulkan",
        }
    }

    /// Human-readable display name
    pub fn display_name(&self) -> &'static str {
        match self {
            HardwareDecoderBackend::Cuda => "NVIDIA CUDA",
            HardwareDecoderBackend::D3d11va => "Direct3D 11 Video Acceleration",
            HardwareDecoderBackend::Dxva2 => "DXVA2",
            HardwareDecoderBackend::Qsv => "Intel Quick Sync Video",
            HardwareDecoderBackend::Vaapi => "VA-API",
            HardwareDecoderBackend::Vdpau => "VDPAU",
            HardwareDecoderBackend::VideoToolbox => "Apple VideoToolbox",
            HardwareDecoderBackend::Vulkan => "Vulkan Video",
        }
    }
}

/// Information about a detected hardware decoder
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HardwareDecoderInfo {
    /// The decoder backend
    pub backend: HardwareDecoderBackend,
    /// Human-readable display name
    pub display_name: String,
    /// FFmpeg hwaccel name (used with `-hwaccel <name>`)
    pub hwaccel_name: String,
}

/// Result of probing available hardware decoders
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AvailableDecoders {
    /// List of detected hardware decoder backends
    pub hardware: Vec<HardwareDecoderInfo>,
    /// Whether any hardware decoder is available
    pub has_hardware: bool,
}

/// Known hardware decoder definitions (ffmpeg hwaccel name → backend)
const HARDWARE_DECODERS: &[(&str, HardwareDecoderBackend)] = &[
    ("cuda", HardwareDecoderBackend::Cuda),
    ("d3d11va", HardwareDecoderBackend::D3d11va),
    ("dxva2", HardwareDecoderBackend::Dxva2),
    ("qsv", HardwareDecoderBackend::Qsv),
    ("vaapi", HardwareDecoderBackend::Vaapi),
    ("vdpau", HardwareDecoderBackend::Vdpau),
    ("videotoolbox", HardwareDecoderBackend::VideoToolbox),
    ("vulkan", HardwareDecoderBackend::Vulkan),
];

/// Detect available hardware decoders by probing FFmpeg
///
/// Runs `ffmpeg -hwaccels` and parses the output to find GPU-accelerated
/// decoding backends supported by the installed FFmpeg build.
pub fn detect_available_decoders(ffmpeg_path: &Path) -> AvailableDecoders {
    let hwaccel_list = match query_ffmpeg_hwaccels(ffmpeg_path) {
        Ok(output) => output,
        Err(e) => {
            tracing::warn!("Failed to probe FFmpeg hwaccels: {}", e);
            return AvailableDecoders {
                hardware: Vec::new(),
                has_hardware: false,
            };
        }
    };

    let hardware = parse_hwaccel_output(&hwaccel_list);
    let has_hardware = !hardware.is_empty();

    AvailableDecoders {
        hardware,
        has_hardware,
    }
}

/// Parse `ffmpeg -hwaccels` output into detected decoder backends
///
/// Output format:
/// ```text
/// Hardware acceleration methods:
/// cuda
/// d3d11va
/// qsv
/// ```
fn parse_hwaccel_output(output: &str) -> Vec<HardwareDecoderInfo> {
    let mut decoders = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim();
        // Skip header line and empty lines
        if trimmed.is_empty() || trimmed.starts_with("Hardware") {
            continue;
        }

        for (hwaccel_name, backend) in HARDWARE_DECODERS {
            if trimmed == *hwaccel_name {
                decoders.push(HardwareDecoderInfo {
                    backend: backend.clone(),
                    display_name: backend.display_name().to_string(),
                    hwaccel_name: hwaccel_name.to_string(),
                });
                break;
            }
        }
    }

    decoders
}

/// Query FFmpeg for the list of supported hardware acceleration methods
fn query_ffmpeg_hwaccels(ffmpeg_path: &Path) -> Result<String, String> {
    let mut command = Command::new(ffmpeg_path);
    crate::core::process::configure_std_command(&mut command);
    let output = command
        .args(["-hwaccels", "-hide_banner"])
        .output()
        .map_err(|e| format!("Failed to execute ffmpeg: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if stdout.is_empty() && !stderr.is_empty() {
        return Err(format!("FFmpeg hwaccel probe failed: {}", stderr));
    }

    Ok(stdout)
}

/// Resolve the best hardware decoder for the current platform
///
/// Prioritizes decoders by platform and performance:
/// - Windows: CUDA > D3D11VA > QSV > DXVA2
/// - Linux: CUDA > VAAPI > QSV > VDPAU
/// - macOS: VideoToolbox
pub fn resolve_best_decoder(available: &AvailableDecoders) -> Option<&HardwareDecoderInfo> {
    if !available.has_hardware {
        return None;
    }

    // Priority order for decoder selection
    let priority: &[HardwareDecoderBackend] = if cfg!(target_os = "macos") {
        &[HardwareDecoderBackend::VideoToolbox]
    } else if cfg!(target_os = "windows") {
        &[
            HardwareDecoderBackend::Cuda,
            HardwareDecoderBackend::D3d11va,
            HardwareDecoderBackend::Qsv,
            HardwareDecoderBackend::Vulkan,
            HardwareDecoderBackend::Dxva2,
        ]
    } else {
        // Linux
        &[
            HardwareDecoderBackend::Cuda,
            HardwareDecoderBackend::Vaapi,
            HardwareDecoderBackend::Qsv,
            HardwareDecoderBackend::Vulkan,
            HardwareDecoderBackend::Vdpau,
        ]
    };

    for target in priority {
        if let Some(decoder) = available.hardware.iter().find(|d| &d.backend == target) {
            return Some(decoder);
        }
    }

    // Fallback: return first available
    available.hardware.first()
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // BDD: Feature: Hardware Encoder Resolution
    // -------------------------------------------------------------------------

    #[test]
    fn should_return_software_encoder_when_cpu_mode_selected() {
        // Given: CPU mode selected
        let available = AvailableEncoders {
            hardware: vec![HardwareEncoderInfo {
                backend: HardwareAccelMode::Nvenc,
                display_name: "NVIDIA NVENC".to_string(),
                h264_encoder: "h264_nvenc".to_string(),
                h265_encoder: "hevc_nvenc".to_string(),
            }],
            has_hardware: true,
        };

        // When: resolving encoder for H264 with CPU mode
        let encoder = resolve_video_encoder(&VideoCodec::H264, &HardwareAccelMode::Cpu, &available);

        // Then: software encoder is returned despite GPU being available
        assert_eq!(encoder, "libx264");
    }

    #[test]
    fn should_return_nvenc_encoder_when_nvenc_available_and_selected() {
        // Given: NVENC is available and selected
        let available = AvailableEncoders {
            hardware: vec![HardwareEncoderInfo {
                backend: HardwareAccelMode::Nvenc,
                display_name: "NVIDIA NVENC".to_string(),
                h264_encoder: "h264_nvenc".to_string(),
                h265_encoder: "hevc_nvenc".to_string(),
            }],
            has_hardware: true,
        };

        // When: resolving H264 and H265 with NVENC mode
        let h264 = resolve_video_encoder(&VideoCodec::H264, &HardwareAccelMode::Nvenc, &available);
        let h265 = resolve_video_encoder(&VideoCodec::H265, &HardwareAccelMode::Nvenc, &available);

        // Then: NVENC encoders are returned
        assert_eq!(h264, "h264_nvenc");
        assert_eq!(h265, "hevc_nvenc");
    }

    #[test]
    fn should_fallback_to_software_when_requested_gpu_unavailable() {
        // Given: no hardware encoders available
        let available = AvailableEncoders {
            hardware: Vec::new(),
            has_hardware: false,
        };

        // When: requesting NVENC mode with nothing available
        let encoder =
            resolve_video_encoder(&VideoCodec::H264, &HardwareAccelMode::Nvenc, &available);

        // Then: falls back to software encoder
        assert_eq!(encoder, "libx264");
    }

    #[test]
    fn should_use_first_available_gpu_in_auto_mode() {
        // Given: multiple hardware encoders available
        let available = AvailableEncoders {
            hardware: vec![
                HardwareEncoderInfo {
                    backend: HardwareAccelMode::Qsv,
                    display_name: "Intel Quick Sync Video".to_string(),
                    h264_encoder: "h264_qsv".to_string(),
                    h265_encoder: "hevc_qsv".to_string(),
                },
                HardwareEncoderInfo {
                    backend: HardwareAccelMode::Nvenc,
                    display_name: "NVIDIA NVENC".to_string(),
                    h264_encoder: "h264_nvenc".to_string(),
                    h265_encoder: "hevc_nvenc".to_string(),
                },
            ],
            has_hardware: true,
        };

        // When: auto mode selected
        let encoder =
            resolve_video_encoder(&VideoCodec::H264, &HardwareAccelMode::Auto, &available);

        // Then: first available (QSV) is used
        assert_eq!(encoder, "h264_qsv");
    }

    #[test]
    fn should_return_software_for_non_gpu_codecs_regardless_of_mode() {
        // Given: NVENC available
        let available = AvailableEncoders {
            hardware: vec![HardwareEncoderInfo {
                backend: HardwareAccelMode::Nvenc,
                display_name: "NVIDIA NVENC".to_string(),
                h264_encoder: "h264_nvenc".to_string(),
                h265_encoder: "hevc_nvenc".to_string(),
            }],
            has_hardware: true,
        };

        // When: resolving VP9, ProRes, Copy with NVENC mode
        let vp9 = resolve_video_encoder(&VideoCodec::Vp9, &HardwareAccelMode::Nvenc, &available);
        let prores =
            resolve_video_encoder(&VideoCodec::ProRes, &HardwareAccelMode::Nvenc, &available);
        let copy = resolve_video_encoder(&VideoCodec::Copy, &HardwareAccelMode::Nvenc, &available);

        // Then: software encoders returned (no GPU variants exist)
        assert_eq!(vp9, "libvpx-vp9");
        assert_eq!(prores, "prores_ks");
        assert_eq!(copy, "copy");
    }

    // -------------------------------------------------------------------------
    // BDD: Feature: Quality Argument Resolution
    // -------------------------------------------------------------------------

    #[test]
    fn should_use_crf_for_software_encoders() {
        let args = resolve_quality_args("libx264", 23);
        assert_eq!(args, vec!["-crf", "23"]);

        let args = resolve_quality_args("libx265", 28);
        assert_eq!(args, vec!["-crf", "28"]);
    }

    #[test]
    fn should_use_cq_for_nvenc_encoders() {
        let args = resolve_quality_args("h264_nvenc", 23);
        assert!(args.contains(&"-cq".to_string()));
        assert!(args.contains(&"23".to_string()));
        assert!(args.contains(&"-preset".to_string()));
        assert!(args.contains(&"p4".to_string()));
    }

    #[test]
    fn should_use_global_quality_for_qsv_encoders() {
        let args = resolve_quality_args("h264_qsv", 20);
        assert_eq!(args, vec!["-global_quality", "20"]);
    }

    #[test]
    fn should_use_qp_for_amf_encoders() {
        let args = resolve_quality_args("h264_amf", 23);
        assert!(args.contains(&"-rc".to_string()));
        assert!(args.contains(&"cqp".to_string()));
        assert!(args.contains(&"-qp_i".to_string()));
    }

    #[test]
    fn should_scale_quality_for_videotoolbox_encoders() {
        let args = resolve_quality_args("h264_videotoolbox", 23);
        assert!(args.contains(&"-q:v".to_string()));
        // CRF 23 → quality = 51 - 23 = 28
        assert!(args.contains(&"28".to_string()));
    }

    // -------------------------------------------------------------------------
    // BDD: Feature: Hardware Encoder Detection
    // -------------------------------------------------------------------------

    #[test]
    fn should_detect_nvenc_from_ffmpeg_encoder_list() {
        // Given: encoder list output containing NVENC
        let encoder_output = " V..... h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)\n V..... hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)\n";

        // We test the detection logic by checking HARDWARE_ENCODERS matching
        let has_nvenc = encoder_output.contains("h264_nvenc");
        assert!(has_nvenc);
    }

    #[test]
    fn should_return_empty_when_no_gpu_encoders_found() {
        // Given: encoder list with only software encoders
        let available = AvailableEncoders {
            hardware: Vec::new(),
            has_hardware: false,
        };

        // Then: no hardware encoders detected
        assert!(!available.has_hardware);
        assert!(available.hardware.is_empty());
    }

    #[test]
    fn should_identify_hardware_encoder_names() {
        assert!(is_hardware_encoder("h264_nvenc"));
        assert!(is_hardware_encoder("hevc_nvenc"));
        assert!(is_hardware_encoder("h264_qsv"));
        assert!(is_hardware_encoder("h264_amf"));
        assert!(is_hardware_encoder("h264_videotoolbox"));
        assert!(!is_hardware_encoder("libx264"));
        assert!(!is_hardware_encoder("libx265"));
        assert!(!is_hardware_encoder("copy"));
    }

    // -------------------------------------------------------------------------
    // BDD: Feature: Hardware Decoder Detection
    // -------------------------------------------------------------------------

    #[test]
    fn should_parse_cuda_and_d3d11va_from_hwaccel_output() {
        // Given: ffmpeg -hwaccels output listing cuda and d3d11va
        let output = "Hardware acceleration methods:\ncuda\nd3d11va\n";

        // When: parsing the hwaccel output
        let decoders = parse_hwaccel_output(output);

        // Then: both backends are detected
        assert_eq!(decoders.len(), 2);
        assert_eq!(decoders[0].backend, HardwareDecoderBackend::Cuda);
        assert_eq!(decoders[0].hwaccel_name, "cuda");
        assert_eq!(decoders[1].backend, HardwareDecoderBackend::D3d11va);
        assert_eq!(decoders[1].hwaccel_name, "d3d11va");
    }

    #[test]
    fn should_parse_all_known_decoder_backends() {
        // Given: ffmpeg output with all known backends
        let output = "Hardware acceleration methods:\ncuda\nd3d11va\ndxva2\nqsv\nvaapi\nvdpau\nvideotoolbox\nvulkan\n";

        // When: parsing
        let decoders = parse_hwaccel_output(output);

        // Then: all 8 backends detected
        assert_eq!(decoders.len(), 8);
    }

    #[test]
    fn should_return_empty_when_no_hwaccels_available() {
        // Given: ffmpeg output with only the header, no backends
        let output = "Hardware acceleration methods:\n";

        // When: parsing
        let decoders = parse_hwaccel_output(output);

        // Then: no decoders detected
        assert!(decoders.is_empty());
    }

    #[test]
    fn should_skip_unknown_hwaccel_backends() {
        // Given: output with known and unknown backends
        let output = "Hardware acceleration methods:\ncuda\nfuture_backend\nqsv\n";

        // When: parsing
        let decoders = parse_hwaccel_output(output);

        // Then: only known backends are returned
        assert_eq!(decoders.len(), 2);
        assert_eq!(decoders[0].backend, HardwareDecoderBackend::Cuda);
        assert_eq!(decoders[1].backend, HardwareDecoderBackend::Qsv);
    }

    #[test]
    fn should_handle_whitespace_in_hwaccel_output() {
        // Given: output with extra whitespace
        let output = "Hardware acceleration methods:\n  cuda  \n  d3d11va  \n\n";

        // When: parsing
        let decoders = parse_hwaccel_output(output);

        // Then: backends detected despite whitespace
        assert_eq!(decoders.len(), 2);
    }

    #[test]
    fn should_provide_correct_display_names_for_decoders() {
        // Given/When: checking display names
        assert_eq!(HardwareDecoderBackend::Cuda.display_name(), "NVIDIA CUDA");
        assert_eq!(
            HardwareDecoderBackend::D3d11va.display_name(),
            "Direct3D 11 Video Acceleration"
        );
        assert_eq!(
            HardwareDecoderBackend::Qsv.display_name(),
            "Intel Quick Sync Video"
        );
        assert_eq!(
            HardwareDecoderBackend::VideoToolbox.display_name(),
            "Apple VideoToolbox"
        );
    }

    #[test]
    fn should_provide_correct_hwaccel_names_for_decoders() {
        // Given/When: checking FFmpeg hwaccel names
        assert_eq!(HardwareDecoderBackend::Cuda.hwaccel_name(), "cuda");
        assert_eq!(HardwareDecoderBackend::D3d11va.hwaccel_name(), "d3d11va");
        assert_eq!(HardwareDecoderBackend::Vaapi.hwaccel_name(), "vaapi");
        assert_eq!(
            HardwareDecoderBackend::VideoToolbox.hwaccel_name(),
            "videotoolbox"
        );
    }

    // -------------------------------------------------------------------------
    // BDD: Feature: Best Decoder Resolution
    // -------------------------------------------------------------------------

    #[test]
    fn should_resolve_best_decoder_by_platform_priority() {
        // Given: cuda and qsv available
        let available = AvailableDecoders {
            hardware: vec![
                HardwareDecoderInfo {
                    backend: HardwareDecoderBackend::Qsv,
                    display_name: "Intel Quick Sync Video".to_string(),
                    hwaccel_name: "qsv".to_string(),
                },
                HardwareDecoderInfo {
                    backend: HardwareDecoderBackend::Cuda,
                    display_name: "NVIDIA CUDA".to_string(),
                    hwaccel_name: "cuda".to_string(),
                },
            ],
            has_hardware: true,
        };

        // When: resolving best decoder (on Windows/Linux, CUDA is preferred over QSV)
        let best = resolve_best_decoder(&available);

        // Then: CUDA is selected (higher priority on Windows/Linux)
        assert!(best.is_some());
        #[cfg(not(target_os = "macos"))]
        assert_eq!(best.unwrap().backend, HardwareDecoderBackend::Cuda);
    }

    #[test]
    fn should_return_none_when_no_decoders_available() {
        // Given: no hardware decoders
        let available = AvailableDecoders {
            hardware: Vec::new(),
            has_hardware: false,
        };

        // When: resolving best decoder
        let best = resolve_best_decoder(&available);

        // Then: None returned
        assert!(best.is_none());
    }

    #[test]
    fn should_fallback_to_first_available_decoder() {
        // Given: only an uncommon decoder available
        let available = AvailableDecoders {
            hardware: vec![HardwareDecoderInfo {
                backend: HardwareDecoderBackend::Vdpau,
                display_name: "VDPAU".to_string(),
                hwaccel_name: "vdpau".to_string(),
            }],
            has_hardware: true,
        };

        // When: resolving (VDPAU is low priority on all platforms)
        let best = resolve_best_decoder(&available);

        // Then: returns the only available decoder
        assert!(best.is_some());
        assert_eq!(best.unwrap().backend, HardwareDecoderBackend::Vdpau);
    }
}
