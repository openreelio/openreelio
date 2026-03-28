//! GPU-Accelerated Filter Helpers
//!
//! Provides context-aware GPU filter generation for FFmpeg filter chains.
//! Handles GPU↔CPU memory transitions (hwupload/hwdownload) and offers
//! GPU-accelerated variants for common filters (scale, blur, denoise).

use serde::{Deserialize, Serialize};

/// GPU filter acceleration backend
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GpuFilterBackend {
    /// NVIDIA CUDA filters (scale_cuda, yadif_cuda, etc.)
    Cuda,
    /// Intel QSV filters (scale_qsv, vpp_qsv, etc.)
    Qsv,
    /// VA-API filters (scale_vaapi, denoise_vaapi, etc.)
    Vaapi,
    /// No GPU — use CPU filters
    None,
}

/// Context for GPU-accelerated filter chain generation
///
/// Carries hardware acceleration state through the filter chain builder.
/// Handles the insertion of hwupload/hwdownload transitions when mixing
/// GPU and CPU filters in the same chain.
#[derive(Debug, Clone)]
pub struct GpuFilterContext {
    /// Active GPU backend (None = CPU-only)
    backend: GpuFilterBackend,
    /// Whether frames are currently in GPU memory
    frames_on_gpu: bool,
}

impl GpuFilterContext {
    /// Create a CPU-only context (no GPU acceleration)
    pub fn cpu_only() -> Self {
        Self {
            backend: GpuFilterBackend::None,
            frames_on_gpu: false,
        }
    }

    /// Create a GPU-accelerated context
    pub fn with_backend(backend: GpuFilterBackend) -> Self {
        Self {
            backend,
            frames_on_gpu: false,
        }
    }

    /// Whether GPU acceleration is active
    pub fn is_gpu_active(&self) -> bool {
        self.backend != GpuFilterBackend::None
    }

    /// Whether frames are currently in GPU memory
    pub fn is_frames_on_gpu(&self) -> bool {
        self.frames_on_gpu
    }

    /// Get the active backend
    pub fn backend(&self) -> &GpuFilterBackend {
        &self.backend
    }

    /// Generate the hwupload filter to move frames to GPU memory.
    /// Returns None if already on GPU or no GPU backend.
    pub fn upload_filter(&mut self) -> Option<String> {
        if !self.is_gpu_active() || self.frames_on_gpu {
            return None;
        }
        self.frames_on_gpu = true;
        Some(match &self.backend {
            GpuFilterBackend::Cuda => "hwupload_cuda".to_string(),
            GpuFilterBackend::Qsv => "hwupload=extra_hw_frames=64".to_string(),
            GpuFilterBackend::Vaapi => "hwupload".to_string(),
            GpuFilterBackend::None => return None,
        })
    }

    /// Generate the hwdownload filter to move frames back to CPU memory.
    /// Returns None if already on CPU or no GPU backend.
    pub fn download_filter(&mut self) -> Option<String> {
        if !self.is_gpu_active() || !self.frames_on_gpu {
            return None;
        }
        self.frames_on_gpu = false;
        Some(match &self.backend {
            GpuFilterBackend::Cuda => "hwdownload,format=nv12".to_string(),
            GpuFilterBackend::Qsv => "hwdownload,format=nv12".to_string(),
            GpuFilterBackend::Vaapi => "hwdownload,format=nv12".to_string(),
            GpuFilterBackend::None => return None,
        })
    }

    /// Get GPU-accelerated scale filter, or CPU fallback.
    ///
    /// Returns the filter string for scaling to the given dimensions.
    pub fn scale_filter(&self, width: u32, height: u32) -> String {
        match &self.backend {
            GpuFilterBackend::Cuda => {
                format!("scale_cuda=w={}:h={}", width, height)
            }
            GpuFilterBackend::Qsv => {
                format!("scale_qsv=w={}:h={}", width, height)
            }
            GpuFilterBackend::Vaapi => {
                format!("scale_vaapi=w={}:h={}", width, height)
            }
            GpuFilterBackend::None => {
                format!("scale={}:{}", width, height)
            }
        }
    }

    /// Get GPU-accelerated deinterlace filter, or CPU fallback.
    pub fn deinterlace_filter(&self) -> String {
        match &self.backend {
            GpuFilterBackend::Cuda => "yadif_cuda".to_string(),
            GpuFilterBackend::Qsv => "vpp_qsv=deinterlace=2".to_string(),
            GpuFilterBackend::Vaapi => "deinterlace_vaapi".to_string(),
            GpuFilterBackend::None => "yadif".to_string(),
        }
    }

    /// Get GPU-accelerated denoise filter, or CPU fallback.
    ///
    /// `strength` is 0.0-1.0 normalized.
    pub fn denoise_filter(&self, strength: f64) -> String {
        match &self.backend {
            GpuFilterBackend::Vaapi => {
                // VAAPI denoise uses integer strength 0-64
                let vaapi_strength = (strength * 64.0).round().min(64.0) as u32;
                format!("denoise_vaapi=denoise={}", vaapi_strength)
            }
            // CUDA and QSV don't have native denoise; use CPU filter
            _ => {
                // nlmeans strength: sigma ~3-15 for light-heavy denoise
                let sigma = 3.0 + strength * 12.0;
                format!("nlmeans=s={:.1}", sigma)
            }
        }
    }

    /// Get GPU-accelerated sharpen filter, or CPU fallback.
    ///
    /// `amount` is 0.0-1.0 normalized.
    pub fn sharpen_filter(&self, amount: f64) -> String {
        match &self.backend {
            GpuFilterBackend::Vaapi => {
                // VAAPI sharpness uses integer 0-64
                let vaapi_amount = (amount * 64.0).round().min(64.0) as u32;
                format!("sharpness_vaapi=sharpness={}", vaapi_amount)
            }
            _ => {
                // unsharp: luma_msize_x:luma_msize_y:luma_amount
                let luma_amount = 0.5 + amount * 2.0;
                format!("unsharp=5:5:{:.2}", luma_amount)
            }
        }
    }

    /// Wrap a CPU filter chain with GPU upload/download transitions if needed.
    ///
    /// When hwaccel decode outputs GPU frames, CPU filters need:
    /// `hwdownload,format=nv12` before the CPU filter chain.
    ///
    /// Only prepends `hwdownload` when frames are actually on the GPU (i.e. after
    /// hwaccel decode or an explicit `upload_filter()` call).  If frames are
    /// already on the CPU this returns the filter chain unchanged.
    pub fn wrap_cpu_filters(&mut self, cpu_filters: &str) -> String {
        if !self.is_gpu_active() || cpu_filters.is_empty() || !self.frames_on_gpu {
            return cpu_filters.to_string();
        }

        // Frames are on GPU — download before CPU processing
        let download = match &self.backend {
            GpuFilterBackend::Cuda => "hwdownload,format=nv12",
            GpuFilterBackend::Qsv => "hwdownload,format=nv12",
            GpuFilterBackend::Vaapi => "hwdownload,format=nv12",
            GpuFilterBackend::None => return cpu_filters.to_string(),
        };

        self.frames_on_gpu = false;
        format!("{},{}", download, cpu_filters)
    }

    /// Build FFmpeg input args for hardware-accelerated decoding.
    ///
    /// These arguments must be placed BEFORE `-i` in the FFmpeg command.
    pub fn build_decode_input_args(&self) -> Vec<String> {
        match &self.backend {
            GpuFilterBackend::Cuda => vec![
                "-hwaccel".to_string(),
                "cuda".to_string(),
                "-hwaccel_output_format".to_string(),
                "cuda".to_string(),
            ],
            GpuFilterBackend::Qsv => vec![
                "-hwaccel".to_string(),
                "qsv".to_string(),
                "-hwaccel_output_format".to_string(),
                "qsv".to_string(),
            ],
            GpuFilterBackend::Vaapi => vec![
                "-hwaccel".to_string(),
                "vaapi".to_string(),
                "-hwaccel_output_format".to_string(),
                "vaapi".to_string(),
            ],
            GpuFilterBackend::None => Vec::new(),
        }
    }
}

impl Default for GpuFilterContext {
    fn default() -> Self {
        Self::cpu_only()
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // BDD: Feature: GPU Filter Context — Upload/Download Transitions
    // -------------------------------------------------------------------------

    #[test]
    fn should_generate_cuda_upload_filter() {
        // Given: CUDA backend active, frames on CPU
        let mut ctx = GpuFilterContext::with_backend(GpuFilterBackend::Cuda);

        // When: requesting upload
        let upload = ctx.upload_filter();

        // Then: hwupload_cuda returned
        assert_eq!(upload, Some("hwupload_cuda".to_string()));
    }

    #[test]
    fn should_return_none_on_duplicate_upload() {
        // Given: frames already on GPU
        let mut ctx = GpuFilterContext::with_backend(GpuFilterBackend::Cuda);
        ctx.upload_filter(); // First upload

        // When: requesting upload again
        let upload = ctx.upload_filter();

        // Then: None (already on GPU)
        assert!(upload.is_none());
    }

    #[test]
    fn should_generate_download_filter_after_upload() {
        // Given: frames uploaded to GPU
        let mut ctx = GpuFilterContext::with_backend(GpuFilterBackend::Cuda);
        ctx.upload_filter();

        // When: requesting download
        let download = ctx.download_filter();

        // Then: hwdownload filter returned
        assert_eq!(download, Some("hwdownload,format=nv12".to_string()));
    }

    #[test]
    fn should_return_none_for_cpu_only_context() {
        // Given: CPU-only context
        let mut ctx = GpuFilterContext::cpu_only();

        // When: requesting upload/download
        let upload = ctx.upload_filter();
        let download = ctx.download_filter();

        // Then: both None
        assert!(upload.is_none());
        assert!(download.is_none());
    }

    // -------------------------------------------------------------------------
    // BDD: Feature: GPU-Accelerated Scale Filter
    // -------------------------------------------------------------------------

    #[test]
    fn should_use_scale_cuda_for_nvidia_backend() {
        // Given: CUDA backend
        let ctx = GpuFilterContext::with_backend(GpuFilterBackend::Cuda);

        // When: building scale filter
        let filter = ctx.scale_filter(1920, 1080);

        // Then: uses scale_cuda
        assert_eq!(filter, "scale_cuda=w=1920:h=1080");
    }

    #[test]
    fn should_use_scale_qsv_for_intel_backend() {
        let ctx = GpuFilterContext::with_backend(GpuFilterBackend::Qsv);
        let filter = ctx.scale_filter(1280, 720);
        assert_eq!(filter, "scale_qsv=w=1280:h=720");
    }

    #[test]
    fn should_use_cpu_scale_when_no_gpu() {
        let ctx = GpuFilterContext::cpu_only();
        let filter = ctx.scale_filter(1920, 1080);
        assert_eq!(filter, "scale=1920:1080");
    }

    // -------------------------------------------------------------------------
    // BDD: Feature: GPU-Accelerated Deinterlace Filter
    // -------------------------------------------------------------------------

    #[test]
    fn should_use_yadif_cuda_for_nvidia() {
        let ctx = GpuFilterContext::with_backend(GpuFilterBackend::Cuda);
        assert_eq!(ctx.deinterlace_filter(), "yadif_cuda");
    }

    #[test]
    fn should_use_cpu_yadif_when_no_gpu() {
        let ctx = GpuFilterContext::cpu_only();
        assert_eq!(ctx.deinterlace_filter(), "yadif");
    }

    // -------------------------------------------------------------------------
    // BDD: Feature: GPU Filter Chain Wrapping
    // -------------------------------------------------------------------------

    #[test]
    fn should_wrap_cpu_filters_with_hwdownload_when_frames_on_gpu() {
        // Given: CUDA backend active, frames on GPU (after hwaccel decode or upload)
        let mut ctx = GpuFilterContext::with_backend(GpuFilterBackend::Cuda);
        ctx.upload_filter(); // moves frames to GPU

        // When: wrapping CPU filters
        let wrapped = ctx.wrap_cpu_filters("gblur=sigma=5,crop=1920:1080:0:0");

        // Then: hwdownload prepended and frames_on_gpu reset
        assert_eq!(
            wrapped,
            "hwdownload,format=nv12,gblur=sigma=5,crop=1920:1080:0:0"
        );
        assert!(
            !ctx.is_frames_on_gpu(),
            "frames_on_gpu should be false after hwdownload"
        );
    }

    #[test]
    fn should_not_wrap_cpu_filters_when_frames_on_cpu() {
        // Given: CUDA backend active but frames are still on CPU
        let mut ctx = GpuFilterContext::with_backend(GpuFilterBackend::Cuda);

        // When: wrapping CPU filters
        let wrapped = ctx.wrap_cpu_filters("gblur=sigma=5,crop=1920:1080:0:0");

        // Then: no hwdownload needed — frames are already on CPU
        assert_eq!(wrapped, "gblur=sigma=5,crop=1920:1080:0:0");
    }

    #[test]
    fn should_not_wrap_empty_filter_string() {
        let mut ctx = GpuFilterContext::with_backend(GpuFilterBackend::Cuda);
        let wrapped = ctx.wrap_cpu_filters("");
        assert_eq!(wrapped, "");
    }

    #[test]
    fn should_pass_through_cpu_filters_when_no_gpu() {
        let mut ctx = GpuFilterContext::cpu_only();
        let wrapped = ctx.wrap_cpu_filters("gblur=sigma=5");
        assert_eq!(wrapped, "gblur=sigma=5");
    }

    // -------------------------------------------------------------------------
    // BDD: Feature: Decode Input Arguments
    // -------------------------------------------------------------------------

    #[test]
    fn should_build_cuda_decode_args() {
        let ctx = GpuFilterContext::with_backend(GpuFilterBackend::Cuda);
        let args = ctx.build_decode_input_args();
        assert_eq!(
            args,
            vec!["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
        );
    }

    #[test]
    fn should_build_empty_args_for_cpu() {
        let ctx = GpuFilterContext::cpu_only();
        let args = ctx.build_decode_input_args();
        assert!(args.is_empty());
    }

    // -------------------------------------------------------------------------
    // BDD: Feature: Denoise and Sharpen GPU Filters
    // -------------------------------------------------------------------------

    #[test]
    fn should_use_vaapi_denoise_for_vaapi_backend() {
        let ctx = GpuFilterContext::with_backend(GpuFilterBackend::Vaapi);
        let filter = ctx.denoise_filter(0.5);
        assert!(filter.starts_with("denoise_vaapi=denoise="));
    }

    #[test]
    fn should_use_nlmeans_for_non_vaapi_gpu() {
        let ctx = GpuFilterContext::with_backend(GpuFilterBackend::Cuda);
        let filter = ctx.denoise_filter(0.5);
        assert!(filter.starts_with("nlmeans=s="));
    }

    #[test]
    fn should_use_vaapi_sharpen_for_vaapi_backend() {
        let ctx = GpuFilterContext::with_backend(GpuFilterBackend::Vaapi);
        let filter = ctx.sharpen_filter(0.5);
        assert!(filter.starts_with("sharpness_vaapi=sharpness="));
    }

    #[test]
    fn should_use_unsharp_for_non_vaapi_gpu() {
        let ctx = GpuFilterContext::cpu_only();
        let filter = ctx.sharpen_filter(0.5);
        assert!(filter.starts_with("unsharp="));
    }
}
