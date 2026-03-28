//! GPU Acceleration Module
//!
//! Provides GPU-accelerated decoding, encoding, and effects processing.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::core::render::{
    detect_available_decoders, detect_available_encoders, resolve_best_decoder, AvailableDecoders,
    AvailableEncoders, HardwareAccelMode, HardwareDecoderBackend,
};
use crate::core::{CoreError, CoreResult};

/// GPU device vendor
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GpuVendor {
    /// NVIDIA GPU
    Nvidia,
    /// AMD GPU
    Amd,
    /// Intel GPU
    Intel,
    /// Apple GPU (Metal)
    Apple,
    /// Unknown vendor
    Unknown,
}

impl std::fmt::Display for GpuVendor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GpuVendor::Nvidia => write!(f, "NVIDIA"),
            GpuVendor::Amd => write!(f, "AMD"),
            GpuVendor::Intel => write!(f, "Intel"),
            GpuVendor::Apple => write!(f, "Apple"),
            GpuVendor::Unknown => write!(f, "Unknown"),
        }
    }
}

/// GPU capability flags
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GpuCapability {
    /// Hardware video decoding
    HardwareDecode,
    /// Hardware video encoding
    HardwareEncode,
    /// CUDA compute (NVIDIA)
    Cuda,
    /// OpenCL compute
    OpenCL,
    /// Vulkan compute
    Vulkan,
    /// Metal compute (Apple)
    Metal,
    /// DirectX compute
    DirectCompute,
    /// 10-bit color support
    TenBitColor,
    /// HDR support
    Hdr,
}

/// Hardware encoder type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HardwareEncoder {
    /// NVIDIA NVENC
    Nvenc,
    /// AMD VCE/VCN
    Amf,
    /// Intel QuickSync
    Qsv,
    /// Apple VideoToolbox
    VideoToolbox,
    /// Software fallback
    Software,
}

impl HardwareEncoder {
    /// FFmpeg encoder name for H.264
    pub fn h264_encoder(&self) -> &'static str {
        match self {
            HardwareEncoder::Nvenc => "h264_nvenc",
            HardwareEncoder::Amf => "h264_amf",
            HardwareEncoder::Qsv => "h264_qsv",
            HardwareEncoder::VideoToolbox => "h264_videotoolbox",
            HardwareEncoder::Software => "libx264",
        }
    }

    /// FFmpeg encoder name for H.265/HEVC
    pub fn hevc_encoder(&self) -> &'static str {
        match self {
            HardwareEncoder::Nvenc => "hevc_nvenc",
            HardwareEncoder::Amf => "hevc_amf",
            HardwareEncoder::Qsv => "hevc_qsv",
            HardwareEncoder::VideoToolbox => "hevc_videotoolbox",
            HardwareEncoder::Software => "libx265",
        }
    }

    /// FFmpeg encoder name for AV1
    pub fn av1_encoder(&self) -> Option<&'static str> {
        match self {
            HardwareEncoder::Nvenc => Some("av1_nvenc"),
            HardwareEncoder::Amf => Some("av1_amf"),
            HardwareEncoder::Qsv => Some("av1_qsv"),
            HardwareEncoder::VideoToolbox => None, // Not yet widely supported
            HardwareEncoder::Software => Some("libaom-av1"),
        }
    }
}

/// Hardware decoder type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HardwareDecoder {
    /// NVIDIA CUVID
    Cuvid,
    /// AMD AMF
    Amf,
    /// Intel QuickSync
    Qsv,
    /// Apple VideoToolbox
    VideoToolbox,
    /// Direct3D 11 Video Acceleration
    D3d11va,
    /// VAAPI (Linux)
    Vaapi,
    /// Software fallback
    Software,
}

impl HardwareDecoder {
    /// FFmpeg hwaccel name
    pub fn hwaccel_name(&self) -> Option<&'static str> {
        match self {
            HardwareDecoder::Cuvid => Some("cuda"),
            HardwareDecoder::Amf => Some("d3d11va"),
            HardwareDecoder::Qsv => Some("qsv"),
            HardwareDecoder::VideoToolbox => Some("videotoolbox"),
            HardwareDecoder::D3d11va => Some("d3d11va"),
            HardwareDecoder::Vaapi => Some("vaapi"),
            HardwareDecoder::Software => None,
        }
    }
}

/// GPU device information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuDevice {
    /// Device ID
    pub id: String,
    /// Device name
    pub name: String,
    /// Vendor
    pub vendor: GpuVendor,
    /// Total VRAM in bytes
    pub vram_total: u64,
    /// Available VRAM in bytes
    pub vram_available: u64,
    /// Compute capability (e.g., "8.6" for NVIDIA)
    pub compute_capability: Option<String>,
    /// Supported capabilities
    pub capabilities: Vec<GpuCapability>,
    /// Preferred hardware encoder
    pub preferred_encoder: HardwareEncoder,
    /// Preferred hardware decoder
    pub preferred_decoder: HardwareDecoder,
    /// Is primary display adapter
    pub is_primary: bool,
}

impl GpuDevice {
    /// Creates a mock GPU device for testing
    pub fn mock(name: &str, vendor: GpuVendor) -> Self {
        let (encoder, decoder) = match vendor {
            GpuVendor::Nvidia => (HardwareEncoder::Nvenc, HardwareDecoder::Cuvid),
            GpuVendor::Amd => (HardwareEncoder::Amf, HardwareDecoder::Amf),
            GpuVendor::Intel => (HardwareEncoder::Qsv, HardwareDecoder::Qsv),
            GpuVendor::Apple => (HardwareEncoder::VideoToolbox, HardwareDecoder::VideoToolbox),
            GpuVendor::Unknown => (HardwareEncoder::Software, HardwareDecoder::Software),
        };

        Self {
            id: ulid::Ulid::new().to_string(),
            name: name.to_string(),
            vendor,
            vram_total: 8 * 1024 * 1024 * 1024,     // 8GB
            vram_available: 6 * 1024 * 1024 * 1024, // 6GB available
            compute_capability: Some("8.6".to_string()),
            capabilities: vec![
                GpuCapability::HardwareDecode,
                GpuCapability::HardwareEncode,
                GpuCapability::TenBitColor,
            ],
            preferred_encoder: encoder,
            preferred_decoder: decoder,
            is_primary: true,
        }
    }

    /// Checks if device supports a capability
    pub fn supports(&self, capability: GpuCapability) -> bool {
        self.capabilities.contains(&capability)
    }

    /// Available VRAM in megabytes
    pub fn available_vram_mb(&self) -> u64 {
        self.vram_available / (1024 * 1024)
    }

    /// VRAM usage percentage
    pub fn vram_usage_percent(&self) -> f32 {
        if self.vram_total == 0 {
            return 0.0;
        }
        ((self.vram_total - self.vram_available) as f32 / self.vram_total as f32) * 100.0
    }
}

/// GPU acceleration configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuConfig {
    /// Enable GPU acceleration
    pub enabled: bool,
    /// Preferred device ID (None for auto-select)
    pub preferred_device: Option<String>,
    /// Enable hardware decoding
    pub hw_decode: bool,
    /// Enable hardware encoding
    pub hw_encode: bool,
    /// Maximum VRAM usage (percentage, 0-100)
    pub max_vram_usage: u8,
    /// Preferred encoder override
    pub preferred_encoder: Option<HardwareEncoder>,
    /// Enable 10-bit encoding if supported
    pub enable_10bit: bool,
    /// Enable HDR processing if supported
    pub enable_hdr: bool,
}

impl Default for GpuConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            preferred_device: None,
            hw_decode: true,
            hw_encode: true,
            max_vram_usage: 80,
            preferred_encoder: None,
            enable_10bit: false,
            enable_hdr: false,
        }
    }
}

impl GpuConfig {
    /// Disables all GPU acceleration
    pub fn software_only() -> Self {
        Self {
            enabled: false,
            hw_decode: false,
            hw_encode: false,
            ..Default::default()
        }
    }
}

/// Encoding preset for quality vs speed tradeoff
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EncodingPreset {
    /// Fastest encoding, lowest quality
    UltraFast,
    /// Very fast encoding
    VeryFast,
    /// Fast encoding (default for previews)
    Fast,
    /// Medium quality/speed balance
    Medium,
    /// Slower encoding, better quality
    Slow,
    /// Very slow encoding, high quality
    VerySlow,
    /// Slowest encoding, highest quality
    Placebo,
}

impl EncodingPreset {
    /// NVENC preset string
    pub fn nvenc_preset(&self) -> &'static str {
        match self {
            EncodingPreset::UltraFast => "p1",
            EncodingPreset::VeryFast => "p2",
            EncodingPreset::Fast => "p3",
            EncodingPreset::Medium => "p4",
            EncodingPreset::Slow => "p5",
            EncodingPreset::VerySlow => "p6",
            EncodingPreset::Placebo => "p7",
        }
    }

    /// x264/x265 preset string
    pub fn software_preset(&self) -> &'static str {
        match self {
            EncodingPreset::UltraFast => "ultrafast",
            EncodingPreset::VeryFast => "veryfast",
            EncodingPreset::Fast => "fast",
            EncodingPreset::Medium => "medium",
            EncodingPreset::Slow => "slow",
            EncodingPreset::VerySlow => "veryslow",
            EncodingPreset::Placebo => "placebo",
        }
    }
}

/// Encoding job parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncodingParams {
    /// Output codec
    pub codec: VideoCodec,
    /// Encoding preset
    pub preset: EncodingPreset,
    /// Bitrate in kbps (None for CRF mode)
    pub bitrate_kbps: Option<u32>,
    /// CRF value (quality-based, lower = better)
    pub crf: Option<u8>,
    /// Output width
    pub width: u32,
    /// Output height
    pub height: u32,
    /// Frame rate
    pub fps: f64,
    /// Pixel format
    pub pixel_format: PixelFormat,
    /// Force hardware encoder
    pub force_hw: bool,
}

impl Default for EncodingParams {
    fn default() -> Self {
        Self {
            codec: VideoCodec::H264,
            preset: EncodingPreset::Medium,
            bitrate_kbps: None,
            crf: Some(23),
            width: 1920,
            height: 1080,
            fps: 30.0,
            pixel_format: PixelFormat::Yuv420p,
            force_hw: false,
        }
    }
}

/// Video codec
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoCodec {
    H264,
    H265,
    Av1,
    Vp9,
    ProRes,
}

/// Pixel format
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PixelFormat {
    Yuv420p,
    Yuv422p,
    Yuv444p,
    Yuv420p10le,
    Rgb24,
    Rgba,
}

impl PixelFormat {
    /// FFmpeg pixel format string
    pub fn ffmpeg_name(&self) -> &'static str {
        match self {
            PixelFormat::Yuv420p => "yuv420p",
            PixelFormat::Yuv422p => "yuv422p",
            PixelFormat::Yuv444p => "yuv444p",
            PixelFormat::Yuv420p10le => "yuv420p10le",
            PixelFormat::Rgb24 => "rgb24",
            PixelFormat::Rgba => "rgba",
        }
    }

    /// Is 10-bit format
    pub fn is_10bit(&self) -> bool {
        matches!(self, PixelFormat::Yuv420p10le)
    }
}

/// GPU accelerator for video processing
#[derive(Debug)]
pub struct GpuAccelerator {
    /// Configuration
    config: Arc<RwLock<GpuConfig>>,
    /// Detected GPU devices
    devices: Arc<RwLock<Vec<GpuDevice>>>,
    /// Active device ID
    active_device: Arc<RwLock<Option<String>>>,
    /// VRAM allocations tracking
    vram_allocations: Arc<RwLock<HashMap<String, u64>>>,
}

impl GpuAccelerator {
    /// Creates a new GPU accelerator
    pub fn new() -> Self {
        Self {
            config: Arc::new(RwLock::new(GpuConfig::default())),
            devices: Arc::new(RwLock::new(Vec::new())),
            active_device: Arc::new(RwLock::new(None)),
            vram_allocations: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Creates with custom config
    pub fn with_config(config: GpuConfig) -> Self {
        Self {
            config: Arc::new(RwLock::new(config)),
            devices: Arc::new(RwLock::new(Vec::new())),
            active_device: Arc::new(RwLock::new(None)),
            vram_allocations: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Detects available GPU devices using mock data (for testing only)
    #[cfg(test)]
    pub async fn detect_devices(&self) -> CoreResult<Vec<GpuDevice>> {
        let mock_device = GpuDevice::mock("Mock GPU", GpuVendor::Nvidia);

        let mut devices = self.devices.write().await;
        devices.clear();
        devices.push(mock_device.clone());

        let mut active = self.active_device.write().await;
        *active = Some(mock_device.id.clone());

        Ok(devices.clone())
    }

    /// Detects available GPU devices by probing FFmpeg for hardware capabilities
    ///
    /// Queries FFmpeg for supported hardware decoders (`-hwaccels`) and encoders
    /// (`-encoders`), then builds GPU device entries grouped by vendor.
    pub async fn detect_devices_from_ffmpeg(
        &self,
        ffmpeg_path: &Path,
    ) -> CoreResult<Vec<GpuDevice>> {
        // Run synchronous FFmpeg subprocess probes on a blocking thread
        // to avoid stalling the tokio async runtime.
        let ffmpeg_path_owned = ffmpeg_path.to_path_buf();
        let (available_decoders, available_encoders) = tokio::task::spawn_blocking(move || {
            let decoders = detect_available_decoders(&ffmpeg_path_owned);
            let encoders = detect_available_encoders(&ffmpeg_path_owned);
            (decoders, encoders)
        })
        .await
        .map_err(|e| CoreError::Internal(format!("FFmpeg probe task failed: {e}")))?;

        let devices = build_gpu_devices_from_probes(&available_decoders, &available_encoders);

        if devices.is_empty() {
            tracing::info!("No GPU hardware acceleration detected, using software fallback");
        } else {
            tracing::info!(
                "Detected {} GPU device(s): {}",
                devices.len(),
                devices
                    .iter()
                    .map(|d| format!("{} ({})", d.name, d.vendor))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }

        let mut dev = self.devices.write().await;
        dev.clear();
        dev.extend(devices.iter().cloned());

        // Auto-select primary device
        let mut active = self.active_device.write().await;
        *active = devices.first().map(|d| d.id.clone());

        // Clear stale VRAM allocations from the previous device inventory
        self.vram_allocations.write().await.clear();

        Ok(devices)
    }

    /// Registers pre-built device list (for testing or manual override)
    pub async fn register_devices(&self, devices: Vec<GpuDevice>) {
        let mut dev = self.devices.write().await;
        dev.clear();
        dev.extend(devices.iter().cloned());

        let mut active = self.active_device.write().await;
        *active = devices.first().map(|d| d.id.clone());

        // Clear stale VRAM allocations from the previous device inventory
        self.vram_allocations.write().await.clear();
    }

    /// Gets available devices
    pub async fn get_devices(&self) -> Vec<GpuDevice> {
        self.devices.read().await.clone()
    }

    /// Gets the active device
    pub async fn get_active_device(&self) -> Option<GpuDevice> {
        let active_id = self.active_device.read().await;
        if let Some(id) = active_id.as_ref() {
            let devices = self.devices.read().await;
            devices.iter().find(|d| &d.id == id).cloned()
        } else {
            None
        }
    }

    /// Sets the active device
    pub async fn set_active_device(&self, device_id: &str) -> CoreResult<()> {
        let devices = self.devices.read().await;
        if !devices.iter().any(|d| d.id == device_id) {
            return Err(CoreError::NotFound(format!(
                "GPU device not found: {}",
                device_id
            )));
        }
        drop(devices);

        let mut active = self.active_device.write().await;
        *active = Some(device_id.to_string());
        Ok(())
    }

    /// Gets the best encoder for current device
    pub async fn get_best_encoder(&self) -> HardwareEncoder {
        let config = self.config.read().await;

        if !config.enabled || !config.hw_encode {
            return HardwareEncoder::Software;
        }

        if let Some(preferred) = config.preferred_encoder {
            return preferred;
        }

        if let Some(device) = self.get_active_device().await {
            device.preferred_encoder
        } else {
            HardwareEncoder::Software
        }
    }

    /// Gets the best decoder for current device
    pub async fn get_best_decoder(&self) -> HardwareDecoder {
        let config = self.config.read().await;

        if !config.enabled || !config.hw_decode {
            return HardwareDecoder::Software;
        }

        if let Some(device) = self.get_active_device().await {
            device.preferred_decoder
        } else {
            HardwareDecoder::Software
        }
    }

    /// Builds FFmpeg encoding arguments
    pub async fn build_encode_args(&self, params: &EncodingParams) -> Vec<String> {
        let encoder = if params.force_hw {
            self.get_best_encoder().await
        } else {
            let config = self.config.read().await;
            if config.hw_encode {
                self.get_best_encoder().await
            } else {
                HardwareEncoder::Software
            }
        };

        let mut args = Vec::new();

        // Codec selection
        let encoder_name = match params.codec {
            VideoCodec::H264 => encoder.h264_encoder(),
            VideoCodec::H265 => encoder.hevc_encoder(),
            VideoCodec::Av1 => encoder.av1_encoder().unwrap_or("libaom-av1"),
            VideoCodec::Vp9 => "libvpx-vp9",
            VideoCodec::ProRes => "prores_ks",
        };
        args.push("-c:v".to_string());
        args.push(encoder_name.to_string());

        // Preset
        let preset = match encoder {
            HardwareEncoder::Nvenc => params.preset.nvenc_preset(),
            _ => params.preset.software_preset(),
        };
        args.push("-preset".to_string());
        args.push(preset.to_string());

        // Quality/bitrate
        if let Some(bitrate) = params.bitrate_kbps {
            args.push("-b:v".to_string());
            args.push(format!("{}k", bitrate));
        } else if let Some(crf) = params.crf {
            match encoder {
                HardwareEncoder::Nvenc => {
                    args.push("-cq".to_string());
                    args.push(crf.to_string());
                }
                _ => {
                    args.push("-crf".to_string());
                    args.push(crf.to_string());
                }
            }
        }

        // Resolution
        args.push("-s".to_string());
        args.push(format!("{}x{}", params.width, params.height));

        // Frame rate
        args.push("-r".to_string());
        args.push(format!("{}", params.fps));

        // Pixel format
        args.push("-pix_fmt".to_string());
        args.push(params.pixel_format.ffmpeg_name().to_string());

        args
    }

    /// Builds FFmpeg decode arguments for hardware acceleration
    pub async fn build_decode_args(&self) -> Vec<String> {
        let decoder = self.get_best_decoder().await;
        let mut args = Vec::new();

        if let Some(hwaccel) = decoder.hwaccel_name() {
            args.push("-hwaccel".to_string());
            args.push(hwaccel.to_string());
            args.push("-hwaccel_output_format".to_string());
            args.push(hwaccel.to_string());
        }

        args
    }

    /// Allocates VRAM for an operation
    pub async fn allocate_vram(&self, operation_id: &str, bytes: u64) -> CoreResult<()> {
        let device = self
            .get_active_device()
            .await
            .ok_or_else(|| CoreError::NotFound("No active GPU device".to_string()))?;

        let config = self.config.read().await;
        let max_bytes = (device.vram_total as f64 * config.max_vram_usage as f64 / 100.0) as u64;

        let mut allocations = self.vram_allocations.write().await;
        let current_usage: u64 = allocations.values().sum();

        if current_usage + bytes > max_bytes {
            return Err(CoreError::ResourceExhausted(format!(
                "VRAM allocation would exceed limit: {} + {} > {}",
                current_usage, bytes, max_bytes
            )));
        }

        allocations.insert(operation_id.to_string(), bytes);
        Ok(())
    }

    /// Releases VRAM allocation
    pub async fn release_vram(&self, operation_id: &str) {
        let mut allocations = self.vram_allocations.write().await;
        allocations.remove(operation_id);
    }

    /// Gets current VRAM usage
    pub async fn get_vram_usage(&self) -> u64 {
        let allocations = self.vram_allocations.read().await;
        allocations.values().sum()
    }

    /// Gets configuration
    pub async fn get_config(&self) -> GpuConfig {
        self.config.read().await.clone()
    }

    /// Updates configuration
    pub async fn set_config(&self, config: GpuConfig) {
        let mut cfg = self.config.write().await;
        *cfg = config;
    }
}

impl Default for GpuAccelerator {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// GPU Device Detection from FFmpeg Probes
// =============================================================================

/// Default VRAM estimate when actual VRAM cannot be queried.
/// Platform-specific VRAM detection requires vendor APIs (NVML, DXGI, etc.)
/// which is a future enhancement. 4 GB is a conservative default.
const DEFAULT_VRAM_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Map a decoder backend to a GPU vendor
fn vendor_from_decoder(backend: &HardwareDecoderBackend) -> GpuVendor {
    match backend {
        HardwareDecoderBackend::Cuda => GpuVendor::Nvidia,
        HardwareDecoderBackend::Qsv => GpuVendor::Intel,
        HardwareDecoderBackend::VideoToolbox => GpuVendor::Apple,
        HardwareDecoderBackend::Vaapi | HardwareDecoderBackend::Vdpau => {
            // VAAPI/VDPAU can be any vendor on Linux; cannot distinguish without platform APIs
            GpuVendor::Unknown
        }
        HardwareDecoderBackend::Vulkan => GpuVendor::Unknown,
        HardwareDecoderBackend::D3d11va | HardwareDecoderBackend::Dxva2 => {
            // D3D11VA/DXVA2 can be any vendor; cannot distinguish without DXGI
            GpuVendor::Unknown
        }
    }
}

/// Map a hardware accel mode (from encoder detection) to a GPU vendor
fn vendor_from_encoder(mode: &HardwareAccelMode) -> Option<GpuVendor> {
    match mode {
        HardwareAccelMode::Nvenc => Some(GpuVendor::Nvidia),
        HardwareAccelMode::Qsv => Some(GpuVendor::Intel),
        HardwareAccelMode::Amf => Some(GpuVendor::Amd),
        HardwareAccelMode::VideoToolbox => Some(GpuVendor::Apple),
        HardwareAccelMode::Auto | HardwareAccelMode::Cpu => None,
    }
}

/// Map a vendor to their preferred hardware encoder
fn encoder_for_vendor(vendor: &GpuVendor) -> HardwareEncoder {
    match vendor {
        GpuVendor::Nvidia => HardwareEncoder::Nvenc,
        GpuVendor::Amd => HardwareEncoder::Amf,
        GpuVendor::Intel => HardwareEncoder::Qsv,
        GpuVendor::Apple => HardwareEncoder::VideoToolbox,
        GpuVendor::Unknown => HardwareEncoder::Software,
    }
}

/// Map a vendor to their preferred hardware decoder
fn decoder_for_vendor(vendor: &GpuVendor) -> HardwareDecoder {
    match vendor {
        GpuVendor::Nvidia => HardwareDecoder::Cuvid,
        GpuVendor::Amd => HardwareDecoder::Amf,
        GpuVendor::Intel => HardwareDecoder::Qsv,
        GpuVendor::Apple => HardwareDecoder::VideoToolbox,
        GpuVendor::Unknown => HardwareDecoder::Software,
    }
}

/// Returns a stable, deterministic ID for the given GPU vendor.
///
/// IDs are per-vendor, not per-device: a system with two NVIDIA GPUs will
/// produce a single device entry with id `"gpu-nvidia"`.  This is intentional
/// because FFmpeg probe results are aggregated by vendor (we detect *encoder
/// backends*, not individual PCI devices).
fn stable_gpu_device_id(vendor: GpuVendor) -> String {
    let slug = match vendor {
        GpuVendor::Nvidia => "nvidia",
        GpuVendor::Amd => "amd",
        GpuVendor::Intel => "intel",
        GpuVendor::Apple => "apple",
        GpuVendor::Unknown => "unknown",
    };

    format!("gpu-{}", slug)
}

fn hardware_mode_for_encoder(encoder: HardwareEncoder) -> HardwareAccelMode {
    match encoder {
        HardwareEncoder::Nvenc => HardwareAccelMode::Nvenc,
        HardwareEncoder::Amf => HardwareAccelMode::Amf,
        HardwareEncoder::Qsv => HardwareAccelMode::Qsv,
        HardwareEncoder::VideoToolbox => HardwareAccelMode::VideoToolbox,
        HardwareEncoder::Software => HardwareAccelMode::Auto,
    }
}

/// Resolve the active GPU device ID using persisted preference and current probe results.
pub fn resolve_active_gpu_device_id(
    enabled: bool,
    preferred_device_id: Option<&str>,
    devices: &[GpuDevice],
) -> Option<String> {
    if !enabled {
        return None;
    }

    preferred_device_id
        .and_then(|id| {
            devices
                .iter()
                .find(|device| device.id == id)
                .map(|_| id.to_string())
        })
        .or_else(|| {
            devices
                .iter()
                .find(|device| device.is_primary)
                .or_else(|| devices.first())
                .map(|device| device.id.clone())
        })
}

/// Resolve which hardware acceleration mode export/rendering should use.
pub fn resolve_hardware_accel_mode(
    enabled: bool,
    preferred_device_id: Option<&str>,
    devices: &[GpuDevice],
) -> HardwareAccelMode {
    if !enabled {
        return HardwareAccelMode::Cpu;
    }

    resolve_active_gpu_device_id(enabled, preferred_device_id, devices)
        .and_then(|active_id| devices.iter().find(|device| device.id == active_id))
        .map(|device| hardware_mode_for_encoder(device.preferred_encoder))
        .unwrap_or_default()
}

/// Build GPU device list from FFmpeg decoder and encoder probe results
///
/// Groups detected backends by vendor and creates one `GpuDevice` per vendor.
/// Uses encoder detection to disambiguate vendor when decoder detection is ambiguous
/// (e.g., D3D11VA could be any vendor, but NVENC confirms NVIDIA presence).
pub fn build_gpu_devices_from_probes(
    decoders: &AvailableDecoders,
    encoders: &AvailableEncoders,
) -> Vec<GpuDevice> {
    let mut vendor_set: HashMap<GpuVendor, (Vec<GpuCapability>, Option<HardwareDecoder>)> =
        HashMap::new();

    // Phase 1: Gather vendors from encoder detection (most specific)
    for enc_info in &encoders.hardware {
        if let Some(vendor) = vendor_from_encoder(&enc_info.backend) {
            let entry = vendor_set
                .entry(vendor)
                .or_insert_with(|| (Vec::new(), None));
            if !entry.0.contains(&GpuCapability::HardwareEncode) {
                entry.0.push(GpuCapability::HardwareEncode);
            }
        }
    }

    // Phase 2: Gather vendors from decoder detection
    let best_decoder = resolve_best_decoder(decoders);
    for dec_info in &decoders.hardware {
        let vendor = vendor_from_decoder(&dec_info.backend);
        // Ambiguous decoder backends (D3D11VA, VAAPI) return Unknown vendor.
        // When exactly one specific vendor is known from encoder detection, it
        // is safe to attribute the decode capability to that vendor. When
        // multiple vendors exist, we cannot determine which GPU the system-level
        // decoder targets, so skip to avoid incorrect hardware decoder selection
        // (e.g. emitting CUDA args when only VAAPI was detected).
        if vendor == GpuVendor::Unknown && vendor_set.len() > 1 {
            continue;
        }
        if vendor == GpuVendor::Unknown && vendor_set.len() == 1 {
            // Single known vendor — attribute decode capability to it
            for (_, (caps, _)) in vendor_set.iter_mut() {
                if !caps.contains(&GpuCapability::HardwareDecode) {
                    caps.push(GpuCapability::HardwareDecode);
                }
            }
            continue;
        }

        let entry = vendor_set
            .entry(vendor)
            .or_insert_with(|| (Vec::new(), None));
        if !entry.0.contains(&GpuCapability::HardwareDecode) {
            entry.0.push(GpuCapability::HardwareDecode);
        }
        // Track the decoder backend for this vendor
        let decoder = match dec_info.backend {
            HardwareDecoderBackend::Cuda => HardwareDecoder::Cuvid,
            HardwareDecoderBackend::Qsv => HardwareDecoder::Qsv,
            HardwareDecoderBackend::VideoToolbox => HardwareDecoder::VideoToolbox,
            HardwareDecoderBackend::Vaapi => HardwareDecoder::Vaapi,
            // VDPAU is a legacy NVIDIA Linux API — we prefer CUDA for decode, so
            // treat VDPAU-only systems as software-fallback for our purposes.
            HardwareDecoderBackend::Vdpau => HardwareDecoder::Software,
            HardwareDecoderBackend::D3d11va => HardwareDecoder::D3d11va,
            HardwareDecoderBackend::Dxva2 => HardwareDecoder::D3d11va,
            // Vulkan Video is not yet widely supported in FFmpeg filter chains;
            // map to software until our pipeline supports vulkan hwframes.
            HardwareDecoderBackend::Vulkan => HardwareDecoder::Software,
        };
        if entry.1.is_none() {
            entry.1 = Some(decoder);
        }
    }

    // Phase 3: Build GpuDevice entries
    let mut devices: Vec<GpuDevice> = vendor_set
        .into_iter()
        .map(|(vendor, (capabilities, detected_decoder))| {
            let preferred_encoder = encoder_for_vendor(&vendor);
            let preferred_decoder = detected_decoder.unwrap_or_else(|| decoder_for_vendor(&vendor));

            let name = format!("{} GPU", vendor);
            let is_primary = best_decoder
                .map(|d| vendor_from_decoder(&d.backend) == vendor)
                .unwrap_or(false);

            GpuDevice {
                id: stable_gpu_device_id(vendor),
                name,
                vendor,
                vram_total: DEFAULT_VRAM_BYTES,
                vram_available: DEFAULT_VRAM_BYTES * 3 / 4,
                compute_capability: None,
                capabilities,
                preferred_encoder,
                preferred_decoder,
                is_primary,
            }
        })
        .collect();

    // Sort: primary first, then by vendor priority (NVIDIA > AMD > Intel > Apple > Unknown)
    devices.sort_by_key(|d| {
        let vendor_priority = match d.vendor {
            GpuVendor::Nvidia => 0,
            GpuVendor::Amd => 1,
            GpuVendor::Intel => 2,
            GpuVendor::Apple => 3,
            GpuVendor::Unknown => 4,
        };
        (!d.is_primary, vendor_priority)
    });

    devices
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::render::{
        AvailableDecoders, AvailableEncoders, HardwareDecoderBackend, HardwareDecoderInfo,
    };

    // ========================================================================
    // GpuVendor Tests
    // ========================================================================

    #[test]
    fn test_gpu_vendor_display() {
        assert_eq!(GpuVendor::Nvidia.to_string(), "NVIDIA");
        assert_eq!(GpuVendor::Amd.to_string(), "AMD");
        assert_eq!(GpuVendor::Intel.to_string(), "Intel");
    }

    // ========================================================================
    // HardwareEncoder Tests
    // ========================================================================

    #[test]
    fn test_hardware_encoder_h264() {
        assert_eq!(HardwareEncoder::Nvenc.h264_encoder(), "h264_nvenc");
        assert_eq!(HardwareEncoder::Amf.h264_encoder(), "h264_amf");
        assert_eq!(HardwareEncoder::Qsv.h264_encoder(), "h264_qsv");
        assert_eq!(HardwareEncoder::Software.h264_encoder(), "libx264");
    }

    #[test]
    fn test_hardware_encoder_hevc() {
        assert_eq!(HardwareEncoder::Nvenc.hevc_encoder(), "hevc_nvenc");
        assert_eq!(HardwareEncoder::Software.hevc_encoder(), "libx265");
    }

    #[test]
    fn test_hardware_encoder_av1() {
        assert_eq!(HardwareEncoder::Nvenc.av1_encoder(), Some("av1_nvenc"));
        assert_eq!(HardwareEncoder::VideoToolbox.av1_encoder(), None);
    }

    // ========================================================================
    // HardwareDecoder Tests
    // ========================================================================

    #[test]
    fn test_hardware_decoder_hwaccel() {
        assert_eq!(HardwareDecoder::Cuvid.hwaccel_name(), Some("cuda"));
        assert_eq!(HardwareDecoder::Qsv.hwaccel_name(), Some("qsv"));
        assert_eq!(HardwareDecoder::Software.hwaccel_name(), None);
    }

    // ========================================================================
    // GpuDevice Tests
    // ========================================================================

    #[test]
    fn test_gpu_device_mock() {
        let device = GpuDevice::mock("Test GPU", GpuVendor::Nvidia);

        assert_eq!(device.vendor, GpuVendor::Nvidia);
        assert_eq!(device.preferred_encoder, HardwareEncoder::Nvenc);
        assert_eq!(device.preferred_decoder, HardwareDecoder::Cuvid);
        assert!(device.is_primary);
    }

    #[test]
    fn test_gpu_device_supports_capability() {
        let device = GpuDevice::mock("Test GPU", GpuVendor::Nvidia);

        assert!(device.supports(GpuCapability::HardwareDecode));
        assert!(device.supports(GpuCapability::HardwareEncode));
        assert!(!device.supports(GpuCapability::Cuda)); // Not in mock
    }

    #[test]
    fn test_gpu_device_vram_calculations() {
        let device = GpuDevice::mock("Test GPU", GpuVendor::Nvidia);

        assert_eq!(device.available_vram_mb(), 6 * 1024); // 6GB
        assert!((device.vram_usage_percent() - 25.0).abs() < 0.1); // ~25% used
    }

    // ========================================================================
    // GpuConfig Tests
    // ========================================================================

    #[test]
    fn test_gpu_config_default() {
        let config = GpuConfig::default();

        assert!(config.enabled);
        assert!(config.hw_decode);
        assert!(config.hw_encode);
        assert_eq!(config.max_vram_usage, 80);
    }

    #[test]
    fn test_gpu_config_software_only() {
        let config = GpuConfig::software_only();

        assert!(!config.enabled);
        assert!(!config.hw_decode);
        assert!(!config.hw_encode);
    }

    // ========================================================================
    // EncodingPreset Tests
    // ========================================================================

    #[test]
    fn test_encoding_preset_nvenc() {
        assert_eq!(EncodingPreset::UltraFast.nvenc_preset(), "p1");
        assert_eq!(EncodingPreset::Medium.nvenc_preset(), "p4");
        assert_eq!(EncodingPreset::Placebo.nvenc_preset(), "p7");
    }

    #[test]
    fn test_encoding_preset_software() {
        assert_eq!(EncodingPreset::UltraFast.software_preset(), "ultrafast");
        assert_eq!(EncodingPreset::Medium.software_preset(), "medium");
        assert_eq!(EncodingPreset::Placebo.software_preset(), "placebo");
    }

    // ========================================================================
    // PixelFormat Tests
    // ========================================================================

    #[test]
    fn test_pixel_format_ffmpeg_name() {
        assert_eq!(PixelFormat::Yuv420p.ffmpeg_name(), "yuv420p");
        assert_eq!(PixelFormat::Yuv420p10le.ffmpeg_name(), "yuv420p10le");
    }

    #[test]
    fn test_pixel_format_is_10bit() {
        assert!(!PixelFormat::Yuv420p.is_10bit());
        assert!(PixelFormat::Yuv420p10le.is_10bit());
    }

    // ========================================================================
    // GpuAccelerator Tests
    // ========================================================================

    #[tokio::test]
    async fn test_gpu_accelerator_new() {
        let accel = GpuAccelerator::new();
        let config = accel.get_config().await;

        assert!(config.enabled);
    }

    #[tokio::test]
    async fn test_gpu_accelerator_detect_devices() {
        let accel = GpuAccelerator::new();
        let devices = accel.detect_devices().await.unwrap();

        assert!(!devices.is_empty());
        assert!(accel.get_active_device().await.is_some());
    }

    #[tokio::test]
    async fn test_gpu_accelerator_get_best_encoder() {
        let accel = GpuAccelerator::new();
        accel.detect_devices().await.unwrap();

        let encoder = accel.get_best_encoder().await;
        assert_eq!(encoder, HardwareEncoder::Nvenc);
    }

    #[tokio::test]
    async fn test_gpu_accelerator_software_fallback() {
        let accel = GpuAccelerator::with_config(GpuConfig::software_only());

        let encoder = accel.get_best_encoder().await;
        assert_eq!(encoder, HardwareEncoder::Software);

        let decoder = accel.get_best_decoder().await;
        assert_eq!(decoder, HardwareDecoder::Software);
    }

    #[tokio::test]
    async fn test_gpu_accelerator_build_encode_args() {
        let accel = GpuAccelerator::new();
        accel.detect_devices().await.unwrap();

        let params = EncodingParams::default();
        let args = accel.build_encode_args(&params).await;

        assert!(args.contains(&"-c:v".to_string()));
        assert!(args.contains(&"h264_nvenc".to_string()));
    }

    #[tokio::test]
    async fn test_gpu_accelerator_vram_allocation() {
        let accel = GpuAccelerator::new();
        accel.detect_devices().await.unwrap();

        // Allocate some VRAM
        accel.allocate_vram("op1", 1024 * 1024 * 100).await.unwrap(); // 100MB
        assert_eq!(accel.get_vram_usage().await, 1024 * 1024 * 100);

        // Release it
        accel.release_vram("op1").await;
        assert_eq!(accel.get_vram_usage().await, 0);
    }

    #[tokio::test]
    async fn test_gpu_accelerator_vram_limit() {
        let accel = GpuAccelerator::new();
        accel.detect_devices().await.unwrap();

        // Try to allocate more than limit (80% of 8GB = 6.4GB)
        let result = accel.allocate_vram("op1", 7 * 1024 * 1024 * 1024).await;
        assert!(result.is_err());
    }

    // ========================================================================
    // BDD: Feature: GPU Device Detection from FFmpeg Probes
    // ========================================================================

    #[test]
    fn should_build_nvidia_device_from_cuda_decoder_and_nvenc_encoder() {
        // Given: FFmpeg reports cuda decoder and nvenc encoder
        let decoders = AvailableDecoders {
            hardware: vec![HardwareDecoderInfo {
                backend: HardwareDecoderBackend::Cuda,
                display_name: "NVIDIA CUDA".to_string(),
                hwaccel_name: "cuda".to_string(),
            }],
            has_hardware: true,
        };
        let encoders = AvailableEncoders {
            hardware: vec![crate::core::render::HardwareEncoderInfo {
                backend: HardwareAccelMode::Nvenc,
                display_name: "NVIDIA NVENC".to_string(),
                h264_encoder: "h264_nvenc".to_string(),
                h265_encoder: "hevc_nvenc".to_string(),
            }],
            has_hardware: true,
        };

        // When: building GPU devices
        let devices = build_gpu_devices_from_probes(&decoders, &encoders);

        // Then: one NVIDIA device with decode + encode
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].vendor, GpuVendor::Nvidia);
        assert_eq!(devices[0].preferred_encoder, HardwareEncoder::Nvenc);
        assert_eq!(devices[0].preferred_decoder, HardwareDecoder::Cuvid);
        assert!(devices[0].supports(GpuCapability::HardwareDecode));
        assert!(devices[0].supports(GpuCapability::HardwareEncode));
    }

    #[test]
    fn should_build_multiple_devices_for_different_vendors() {
        // Given: NVIDIA and Intel detected
        let decoders = AvailableDecoders {
            hardware: vec![
                HardwareDecoderInfo {
                    backend: HardwareDecoderBackend::Cuda,
                    display_name: "NVIDIA CUDA".to_string(),
                    hwaccel_name: "cuda".to_string(),
                },
                HardwareDecoderInfo {
                    backend: HardwareDecoderBackend::Qsv,
                    display_name: "Intel Quick Sync Video".to_string(),
                    hwaccel_name: "qsv".to_string(),
                },
            ],
            has_hardware: true,
        };
        let encoders = AvailableEncoders {
            hardware: vec![
                crate::core::render::HardwareEncoderInfo {
                    backend: HardwareAccelMode::Nvenc,
                    display_name: "NVIDIA NVENC".to_string(),
                    h264_encoder: "h264_nvenc".to_string(),
                    h265_encoder: "hevc_nvenc".to_string(),
                },
                crate::core::render::HardwareEncoderInfo {
                    backend: HardwareAccelMode::Qsv,
                    display_name: "Intel QSV".to_string(),
                    h264_encoder: "h264_qsv".to_string(),
                    h265_encoder: "hevc_qsv".to_string(),
                },
            ],
            has_hardware: true,
        };

        // When: building GPU devices
        let devices = build_gpu_devices_from_probes(&decoders, &encoders);

        // Then: two devices, NVIDIA first (higher priority)
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].vendor, GpuVendor::Nvidia);
        assert_eq!(devices[1].vendor, GpuVendor::Intel);
    }

    #[test]
    fn should_return_empty_when_no_gpu_detected() {
        // Given: no hardware acceleration available
        let decoders = AvailableDecoders {
            hardware: Vec::new(),
            has_hardware: false,
        };
        let encoders = AvailableEncoders {
            hardware: Vec::new(),
            has_hardware: false,
        };

        // When: building GPU devices
        let devices = build_gpu_devices_from_probes(&decoders, &encoders);

        // Then: no devices returned
        assert!(devices.is_empty());
    }

    #[test]
    fn should_assign_d3d11va_to_known_vendor_from_encoder() {
        // Given: d3d11va decoder (ambiguous vendor) and nvenc encoder (NVIDIA)
        let decoders = AvailableDecoders {
            hardware: vec![HardwareDecoderInfo {
                backend: HardwareDecoderBackend::D3d11va,
                display_name: "D3D11VA".to_string(),
                hwaccel_name: "d3d11va".to_string(),
            }],
            has_hardware: true,
        };
        let encoders = AvailableEncoders {
            hardware: vec![crate::core::render::HardwareEncoderInfo {
                backend: HardwareAccelMode::Nvenc,
                display_name: "NVIDIA NVENC".to_string(),
                h264_encoder: "h264_nvenc".to_string(),
                h265_encoder: "hevc_nvenc".to_string(),
            }],
            has_hardware: true,
        };

        // When: building GPU devices
        let devices = build_gpu_devices_from_probes(&decoders, &encoders);

        // Then: NVIDIA device gets both encode and decode capabilities
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].vendor, GpuVendor::Nvidia);
        assert!(devices[0].supports(GpuCapability::HardwareEncode));
        assert!(devices[0].supports(GpuCapability::HardwareDecode));
    }

    #[test]
    fn should_set_default_vram_for_detected_devices() {
        // Given: a detected NVIDIA GPU
        let decoders = AvailableDecoders {
            hardware: vec![HardwareDecoderInfo {
                backend: HardwareDecoderBackend::Cuda,
                display_name: "NVIDIA CUDA".to_string(),
                hwaccel_name: "cuda".to_string(),
            }],
            has_hardware: true,
        };
        let encoders = AvailableEncoders {
            hardware: Vec::new(),
            has_hardware: false,
        };

        // When: building GPU devices
        let devices = build_gpu_devices_from_probes(&decoders, &encoders);

        // Then: default VRAM is set (4 GB)
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].vram_total, DEFAULT_VRAM_BYTES);
        assert!(devices[0].vram_available > 0);
    }

    #[tokio::test]
    async fn should_register_devices_and_auto_select_primary() {
        // Given: a GpuAccelerator
        let accel = GpuAccelerator::new();
        let device1 = GpuDevice::mock("GPU 1", GpuVendor::Nvidia);
        let device2 = GpuDevice::mock("GPU 2", GpuVendor::Intel);
        let id1 = device1.id.clone();

        // When: registering devices
        accel.register_devices(vec![device1, device2]).await;

        // Then: first device is auto-selected
        let active = accel.get_active_device().await;
        assert!(active.is_some());
        assert_eq!(active.unwrap().id, id1);
        assert_eq!(accel.get_devices().await.len(), 2);
    }

    #[test]
    fn should_keep_gpu_device_ids_stable_across_repeated_probes() {
        let decoders = AvailableDecoders {
            hardware: vec![HardwareDecoderInfo {
                backend: HardwareDecoderBackend::Cuda,
                display_name: "NVIDIA CUDA".to_string(),
                hwaccel_name: "cuda".to_string(),
            }],
            has_hardware: true,
        };
        let encoders = AvailableEncoders {
            hardware: vec![crate::core::render::HardwareEncoderInfo {
                backend: HardwareAccelMode::Nvenc,
                display_name: "NVIDIA NVENC".to_string(),
                h264_encoder: "h264_nvenc".to_string(),
                h265_encoder: "hevc_nvenc".to_string(),
            }],
            has_hardware: true,
        };

        let first = build_gpu_devices_from_probes(&decoders, &encoders);
        let second = build_gpu_devices_from_probes(&decoders, &encoders);

        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert_eq!(first[0].id, "gpu-nvidia");
        assert_eq!(first[0].id, second[0].id);
    }

    #[test]
    fn should_resolve_selected_device_to_matching_hardware_accel_mode() {
        let devices = vec![
            GpuDevice {
                id: "gpu-intel".to_string(),
                name: "Intel GPU".to_string(),
                vendor: GpuVendor::Intel,
                vram_total: DEFAULT_VRAM_BYTES,
                vram_available: DEFAULT_VRAM_BYTES,
                compute_capability: None,
                capabilities: vec![GpuCapability::HardwareEncode],
                preferred_encoder: HardwareEncoder::Qsv,
                preferred_decoder: HardwareDecoder::Qsv,
                is_primary: false,
            },
            GpuDevice {
                id: "gpu-nvidia".to_string(),
                name: "NVIDIA GPU".to_string(),
                vendor: GpuVendor::Nvidia,
                vram_total: DEFAULT_VRAM_BYTES,
                vram_available: DEFAULT_VRAM_BYTES,
                compute_capability: None,
                capabilities: vec![GpuCapability::HardwareEncode],
                preferred_encoder: HardwareEncoder::Nvenc,
                preferred_decoder: HardwareDecoder::Cuvid,
                is_primary: true,
            },
        ];

        let mode = resolve_hardware_accel_mode(true, Some("gpu-intel"), &devices);

        assert_eq!(mode, HardwareAccelMode::Qsv);
    }

    #[test]
    fn should_fallback_to_cpu_mode_when_hardware_acceleration_disabled() {
        let devices = vec![GpuDevice::mock("Test GPU", GpuVendor::Nvidia)];

        let mode = resolve_hardware_accel_mode(false, Some(&devices[0].id), &devices);

        assert_eq!(mode, HardwareAccelMode::Cpu);
        assert!(resolve_active_gpu_device_id(false, Some(&devices[0].id), &devices).is_none());
    }
}
