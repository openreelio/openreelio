//! GPU Acceleration Module
//!
//! Provides GPU-accelerated decoding, encoding, and effects processing.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

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

    /// Detects available GPU devices
    pub async fn detect_devices(&self) -> CoreResult<Vec<GpuDevice>> {
        // In real implementation, this would query actual hardware
        // For now, return a mock device
        let mock_device = GpuDevice::mock("Mock GPU", GpuVendor::Nvidia);

        let mut devices = self.devices.write().await;
        devices.clear();
        devices.push(mock_device.clone());

        // Auto-select primary device
        let mut active = self.active_device.write().await;
        *active = Some(mock_device.id.clone());

        Ok(devices.clone())
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

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

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
}
