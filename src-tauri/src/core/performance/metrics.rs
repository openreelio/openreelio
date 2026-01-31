//! Performance Metrics Module
//!
//! Provides performance tracking, metrics collection, and reporting for
//! monitoring application performance against v1.0.0 targets:
//!
//! - Startup time: < 2s
//! - Timeline scroll: 60fps
//! - Preview latency: < 100ms
//! - Export speed: Real-time+
//! - Memory usage: < 500MB base

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

// =============================================================================
// Configuration
// =============================================================================

/// Configuration for metrics collection
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsConfig {
    /// Enable metrics collection
    pub enabled: bool,
    /// Sample interval for periodic metrics (milliseconds)
    pub sample_interval_ms: u64,
    /// Maximum number of samples to keep in history
    pub max_history_samples: usize,
    /// Enable detailed frame timing
    pub frame_timing_enabled: bool,
    /// Enable memory tracking
    pub memory_tracking_enabled: bool,
    /// Reporting interval (milliseconds, 0 = no automatic reporting)
    pub report_interval_ms: u64,
}

impl Default for MetricsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            sample_interval_ms: 1000, // 1 second
            max_history_samples: 300, // 5 minutes at 1s intervals
            frame_timing_enabled: true,
            memory_tracking_enabled: true,
            report_interval_ms: 0, // Manual reporting by default
        }
    }
}

impl MetricsConfig {
    /// Creates minimal config with reduced overhead
    pub fn minimal() -> Self {
        Self {
            enabled: true,
            sample_interval_ms: 5000, // 5 seconds
            max_history_samples: 60,  // 5 minutes at 5s intervals
            frame_timing_enabled: false,
            memory_tracking_enabled: false,
            report_interval_ms: 0,
        }
    }

    /// Creates verbose config for debugging
    pub fn verbose() -> Self {
        Self {
            enabled: true,
            sample_interval_ms: 100,  // 100ms
            max_history_samples: 600, // 1 minute at 100ms
            frame_timing_enabled: true,
            memory_tracking_enabled: true,
            report_interval_ms: 10000, // Report every 10s
        }
    }
}

// =============================================================================
// Metric Types
// =============================================================================

/// Startup phase timing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupMetrics {
    /// Total startup time in milliseconds
    pub total_ms: u64,
    /// Time to initialize core in milliseconds
    pub core_init_ms: u64,
    /// Time to load UI in milliseconds
    pub ui_load_ms: u64,
    /// Time to load plugins in milliseconds
    pub plugins_load_ms: u64,
    /// Whether startup met the < 2s target
    pub meets_target: bool,
}

impl StartupMetrics {
    /// Target startup time in milliseconds (2 seconds)
    pub const TARGET_MS: u64 = 2000;

    /// Creates new startup metrics
    pub fn new(total_ms: u64, core_init_ms: u64, ui_load_ms: u64, plugins_load_ms: u64) -> Self {
        Self {
            total_ms,
            core_init_ms,
            ui_load_ms,
            plugins_load_ms,
            meets_target: total_ms <= Self::TARGET_MS,
        }
    }
}

/// Frame timing metrics for timeline/preview performance
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameMetrics {
    /// Current FPS
    pub fps: f64,
    /// Average frame time in milliseconds
    pub avg_frame_time_ms: f64,
    /// 95th percentile frame time in milliseconds
    pub p95_frame_time_ms: f64,
    /// 99th percentile frame time in milliseconds
    pub p99_frame_time_ms: f64,
    /// Maximum frame time in milliseconds
    pub max_frame_time_ms: f64,
    /// Number of dropped frames
    pub dropped_frames: u64,
    /// Whether performance meets 60fps target
    pub meets_target: bool,
}

impl FrameMetrics {
    /// Target FPS for smooth scrolling
    pub const TARGET_FPS: f64 = 60.0;
    /// Target frame time in milliseconds (1000 / 60 ≈ 16.67ms)
    pub const TARGET_FRAME_TIME_MS: f64 = 16.667;

    /// Creates metrics from frame time samples
    pub fn from_samples(samples: &[f64], dropped_frames: u64) -> Self {
        if samples.is_empty() {
            return Self {
                fps: 0.0,
                avg_frame_time_ms: 0.0,
                p95_frame_time_ms: 0.0,
                p99_frame_time_ms: 0.0,
                max_frame_time_ms: 0.0,
                dropped_frames,
                meets_target: false,
            };
        }

        let mut sorted = samples.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        let sum: f64 = sorted.iter().sum();
        let avg = sum / sorted.len() as f64;
        let fps = if avg > 0.0 { 1000.0 / avg } else { 0.0 };

        let p95_idx = (sorted.len() as f64 * 0.95) as usize;
        let p99_idx = (sorted.len() as f64 * 0.99) as usize;

        Self {
            fps,
            avg_frame_time_ms: avg,
            p95_frame_time_ms: sorted.get(p95_idx).copied().unwrap_or(0.0),
            p99_frame_time_ms: sorted.get(p99_idx).copied().unwrap_or(0.0),
            max_frame_time_ms: sorted.last().copied().unwrap_or(0.0),
            dropped_frames,
            meets_target: fps >= Self::TARGET_FPS,
        }
    }
}

/// Preview latency metrics
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewMetrics {
    /// Average latency in milliseconds
    pub avg_latency_ms: f64,
    /// 95th percentile latency in milliseconds
    pub p95_latency_ms: f64,
    /// Maximum latency in milliseconds
    pub max_latency_ms: f64,
    /// Number of preview requests
    pub request_count: u64,
    /// Whether latency meets < 100ms target
    pub meets_target: bool,
}

impl PreviewMetrics {
    /// Target preview latency in milliseconds
    pub const TARGET_MS: f64 = 100.0;

    /// Creates metrics from latency samples
    pub fn from_samples(samples: &[f64]) -> Self {
        if samples.is_empty() {
            return Self {
                avg_latency_ms: 0.0,
                p95_latency_ms: 0.0,
                max_latency_ms: 0.0,
                request_count: 0,
                meets_target: true,
            };
        }

        let mut sorted = samples.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        let sum: f64 = sorted.iter().sum();
        let avg = sum / sorted.len() as f64;
        let p95_idx = (sorted.len() as f64 * 0.95) as usize;

        Self {
            avg_latency_ms: avg,
            p95_latency_ms: sorted.get(p95_idx).copied().unwrap_or(0.0),
            max_latency_ms: sorted.last().copied().unwrap_or(0.0),
            request_count: sorted.len() as u64,
            meets_target: avg <= Self::TARGET_MS,
        }
    }
}

/// Export performance metrics
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMetrics {
    /// Export speed ratio (1.0 = real-time, 2.0 = 2x real-time)
    pub speed_ratio: f64,
    /// Frames encoded per second
    pub encoding_fps: f64,
    /// Total export time in seconds
    pub total_time_sec: f64,
    /// Video duration in seconds
    pub video_duration_sec: f64,
    /// Whether export meets real-time+ target
    pub meets_target: bool,
}

impl ExportMetrics {
    /// Target: at least real-time export (ratio >= 1.0)
    pub const TARGET_RATIO: f64 = 1.0;

    /// Creates export metrics
    pub fn new(video_duration_sec: f64, total_time_sec: f64, total_frames: u64) -> Self {
        let speed_ratio = if total_time_sec > 0.0 {
            video_duration_sec / total_time_sec
        } else {
            0.0
        };

        let encoding_fps = if total_time_sec > 0.0 {
            total_frames as f64 / total_time_sec
        } else {
            0.0
        };

        Self {
            speed_ratio,
            encoding_fps,
            total_time_sec,
            video_duration_sec,
            meets_target: speed_ratio >= Self::TARGET_RATIO,
        }
    }
}

/// Memory usage metrics
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMetrics {
    /// Current memory usage in bytes
    pub current_bytes: u64,
    /// Peak memory usage in bytes
    pub peak_bytes: u64,
    /// Average memory usage in bytes
    pub avg_bytes: u64,
    /// Cache size in bytes
    pub cache_bytes: u64,
    /// Whether memory meets < 500MB base target
    pub meets_target: bool,
}

impl MemoryMetrics {
    /// Target base memory usage in bytes (500MB)
    pub const TARGET_BYTES: u64 = 500 * 1024 * 1024;

    /// Creates memory metrics
    pub fn new(current_bytes: u64, peak_bytes: u64, avg_bytes: u64, cache_bytes: u64) -> Self {
        // Base memory = current - cache
        let base_bytes = current_bytes.saturating_sub(cache_bytes);

        Self {
            current_bytes,
            peak_bytes,
            avg_bytes,
            cache_bytes,
            meets_target: base_bytes <= Self::TARGET_BYTES,
        }
    }
}

// =============================================================================
// Aggregated Performance Report
// =============================================================================

/// Complete performance report
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceReport {
    /// Report timestamp (Unix epoch milliseconds)
    pub timestamp_ms: u64,
    /// Uptime in seconds
    pub uptime_sec: f64,
    /// Startup metrics (if available)
    pub startup: Option<StartupMetrics>,
    /// Frame metrics
    pub frame: FrameMetrics,
    /// Preview metrics
    pub preview: PreviewMetrics,
    /// Export metrics (last export)
    pub export: Option<ExportMetrics>,
    /// Memory metrics
    pub memory: MemoryMetrics,
    /// Overall health score (0-100)
    pub health_score: u8,
    /// Number of targets met out of total
    pub targets_met: (u8, u8),
}

impl PerformanceReport {
    /// Calculates health score based on targets met
    pub fn calculate_health_score(&self) -> u8 {
        let mut met = 0u8;
        let mut total = 0u8;

        // Startup target
        if let Some(ref startup) = self.startup {
            total += 1;
            if startup.meets_target {
                met += 1;
            }
        }

        // Frame target
        total += 1;
        if self.frame.meets_target {
            met += 1;
        }

        // Preview target
        total += 1;
        if self.preview.meets_target {
            met += 1;
        }

        // Export target
        if let Some(ref export) = self.export {
            total += 1;
            if export.meets_target {
                met += 1;
            }
        }

        // Memory target
        total += 1;
        if self.memory.meets_target {
            met += 1;
        }

        if total == 0 {
            return 100;
        }

        (met as f64 / total as f64 * 100.0) as u8
    }
}

// =============================================================================
// Metrics Collector
// =============================================================================

/// Performance metrics collector
pub struct MetricsCollector {
    config: MetricsConfig,
    start_time: Instant,
    startup_metrics: RwLock<Option<StartupMetrics>>,
    frame_times: RwLock<VecDeque<f64>>,
    preview_latencies: RwLock<VecDeque<f64>>,
    last_export: RwLock<Option<ExportMetrics>>,
    memory_samples: RwLock<VecDeque<u64>>,
    dropped_frames: AtomicU64,
    peak_memory: AtomicU64,
    cache_size: AtomicU64,
    is_recording: AtomicBool,
}

impl MetricsCollector {
    /// Creates a new metrics collector
    pub fn new(config: MetricsConfig) -> Self {
        Self {
            config,
            start_time: Instant::now(),
            startup_metrics: RwLock::new(None),
            frame_times: RwLock::new(VecDeque::new()),
            preview_latencies: RwLock::new(VecDeque::new()),
            last_export: RwLock::new(None),
            memory_samples: RwLock::new(VecDeque::new()),
            dropped_frames: AtomicU64::new(0),
            peak_memory: AtomicU64::new(0),
            cache_size: AtomicU64::new(0),
            is_recording: AtomicBool::new(true),
        }
    }

    /// Creates with default config
    pub fn with_defaults() -> Self {
        Self::new(MetricsConfig::default())
    }

    /// Returns the uptime in seconds
    pub fn uptime_sec(&self) -> f64 {
        self.start_time.elapsed().as_secs_f64()
    }

    /// Records startup metrics
    pub async fn record_startup(
        &self,
        total_ms: u64,
        core_init_ms: u64,
        ui_load_ms: u64,
        plugins_load_ms: u64,
    ) {
        let metrics = StartupMetrics::new(total_ms, core_init_ms, ui_load_ms, plugins_load_ms);
        *self.startup_metrics.write().await = Some(metrics);
    }

    /// Records a frame time in milliseconds
    pub async fn record_frame_time(&self, frame_time_ms: f64) {
        if !self.config.frame_timing_enabled || !self.is_recording.load(Ordering::Relaxed) {
            return;
        }

        let mut times = self.frame_times.write().await;
        times.push_back(frame_time_ms);

        // Keep only max samples
        while times.len() > self.config.max_history_samples {
            times.pop_front();
        }

        // Track dropped frames (> 2x target frame time)
        if frame_time_ms > FrameMetrics::TARGET_FRAME_TIME_MS * 2.0 {
            self.dropped_frames.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Records a preview latency in milliseconds
    pub async fn record_preview_latency(&self, latency_ms: f64) {
        if !self.is_recording.load(Ordering::Relaxed) {
            return;
        }

        let mut latencies = self.preview_latencies.write().await;
        latencies.push_back(latency_ms);

        while latencies.len() > self.config.max_history_samples {
            latencies.pop_front();
        }
    }

    /// Records export completion
    pub async fn record_export(
        &self,
        video_duration_sec: f64,
        total_time_sec: f64,
        total_frames: u64,
    ) {
        let metrics = ExportMetrics::new(video_duration_sec, total_time_sec, total_frames);
        *self.last_export.write().await = Some(metrics);
    }

    /// Records current memory usage
    pub async fn record_memory(&self, current_bytes: u64, cache_bytes: u64) {
        if !self.config.memory_tracking_enabled || !self.is_recording.load(Ordering::Relaxed) {
            return;
        }

        // Update peak
        let mut current_peak = self.peak_memory.load(Ordering::Relaxed);
        while current_bytes > current_peak {
            match self.peak_memory.compare_exchange(
                current_peak,
                current_bytes,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(new) => current_peak = new,
            }
        }

        // Update cache size
        self.cache_size.store(cache_bytes, Ordering::Relaxed);

        // Record sample
        let mut samples = self.memory_samples.write().await;
        samples.push_back(current_bytes);

        while samples.len() > self.config.max_history_samples {
            samples.pop_front();
        }
    }

    /// Gets frame metrics
    pub async fn get_frame_metrics(&self) -> FrameMetrics {
        let times = self.frame_times.read().await;
        let samples: Vec<f64> = times.iter().copied().collect();
        let dropped = self.dropped_frames.load(Ordering::Relaxed);
        FrameMetrics::from_samples(&samples, dropped)
    }

    /// Gets preview metrics
    pub async fn get_preview_metrics(&self) -> PreviewMetrics {
        let latencies = self.preview_latencies.read().await;
        let samples: Vec<f64> = latencies.iter().copied().collect();
        PreviewMetrics::from_samples(&samples)
    }

    /// Gets memory metrics
    pub async fn get_memory_metrics(&self) -> MemoryMetrics {
        let samples = self.memory_samples.read().await;
        let current = samples.back().copied().unwrap_or(0);
        let peak = self.peak_memory.load(Ordering::Relaxed);
        let cache = self.cache_size.load(Ordering::Relaxed);

        let avg = if samples.is_empty() {
            0
        } else {
            samples.iter().sum::<u64>() / samples.len() as u64
        };

        MemoryMetrics::new(current, peak, avg, cache)
    }

    /// Generates a complete performance report
    pub async fn generate_report(&self) -> PerformanceReport {
        let startup = self.startup_metrics.read().await.clone();
        let frame = self.get_frame_metrics().await;
        let preview = self.get_preview_metrics().await;
        let export = self.last_export.read().await.clone();
        let memory = self.get_memory_metrics().await;

        let timestamp_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let mut report = PerformanceReport {
            timestamp_ms,
            uptime_sec: self.uptime_sec(),
            startup,
            frame,
            preview,
            export,
            memory,
            health_score: 0,
            targets_met: (0, 0),
        };

        report.health_score = report.calculate_health_score();

        // Count targets
        let mut met = 0u8;
        let mut total = 0u8;

        if report.startup.as_ref().is_some_and(|s| s.meets_target) {
            met += 1;
        }
        if report.startup.is_some() {
            total += 1;
        }

        if report.frame.meets_target {
            met += 1;
        }
        total += 1;

        if report.preview.meets_target {
            met += 1;
        }
        total += 1;

        if report.export.as_ref().is_some_and(|e| e.meets_target) {
            met += 1;
        }
        if report.export.is_some() {
            total += 1;
        }

        if report.memory.meets_target {
            met += 1;
        }
        total += 1;

        report.targets_met = (met, total);

        report
    }

    /// Pauses metrics recording
    pub fn pause(&self) {
        self.is_recording.store(false, Ordering::Relaxed);
    }

    /// Resumes metrics recording
    pub fn resume(&self) {
        self.is_recording.store(true, Ordering::Relaxed);
    }

    /// Clears all recorded metrics
    pub async fn clear(&self) {
        *self.startup_metrics.write().await = None;
        self.frame_times.write().await.clear();
        self.preview_latencies.write().await.clear();
        *self.last_export.write().await = None;
        self.memory_samples.write().await.clear();
        self.dropped_frames.store(0, Ordering::Relaxed);
        self.peak_memory.store(0, Ordering::Relaxed);
        self.cache_size.store(0, Ordering::Relaxed);
    }
}

// =============================================================================
// Timer Helper
// =============================================================================

/// Timer for measuring operation duration
pub struct Timer {
    start: Instant,
    name: String,
}

impl Timer {
    /// Creates a new timer with a name
    pub fn new(name: &str) -> Self {
        Self {
            start: Instant::now(),
            name: name.to_string(),
        }
    }

    /// Returns elapsed time in milliseconds
    pub fn elapsed_ms(&self) -> f64 {
        self.start.elapsed().as_secs_f64() * 1000.0
    }

    /// Returns elapsed time in seconds
    pub fn elapsed_sec(&self) -> f64 {
        self.start.elapsed().as_secs_f64()
    }

    /// Stops the timer and returns elapsed milliseconds
    pub fn stop(self) -> f64 {
        self.elapsed_ms()
    }

    /// Gets the timer name
    pub fn name(&self) -> &str {
        &self.name
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_startup_metrics_target() {
        let fast = StartupMetrics::new(1500, 500, 800, 200);
        assert!(fast.meets_target, "1500ms should meet 2000ms target");

        let slow = StartupMetrics::new(2500, 1000, 1000, 500);
        assert!(!slow.meets_target, "2500ms should not meet 2000ms target");
    }

    #[test]
    fn test_frame_metrics_from_samples() {
        let samples = vec![16.0, 16.5, 17.0, 16.2, 15.8];
        let metrics = FrameMetrics::from_samples(&samples, 0);

        assert!(metrics.fps > 58.0, "Should be near 60fps");
        assert!(metrics.avg_frame_time_ms < 17.0, "Avg should be under 17ms");
        assert!(metrics.meets_target, "Should meet 60fps target");
    }

    #[test]
    fn test_frame_metrics_empty_samples() {
        let metrics = FrameMetrics::from_samples(&[], 0);
        assert_eq!(metrics.fps, 0.0);
        assert!(!metrics.meets_target);
    }

    #[test]
    fn test_preview_metrics_target() {
        let fast = PreviewMetrics::from_samples(&[50.0, 60.0, 70.0, 80.0]);
        assert!(fast.meets_target, "65ms avg should meet 100ms target");

        let slow = PreviewMetrics::from_samples(&[100.0, 120.0, 150.0, 200.0]);
        assert!(!slow.meets_target, "142ms avg should not meet 100ms target");
    }

    #[test]
    fn test_export_metrics_speed_ratio() {
        // 60 second video exported in 30 seconds = 2x real-time
        let fast = ExportMetrics::new(60.0, 30.0, 1800);
        assert_eq!(fast.speed_ratio, 2.0);
        assert!(fast.meets_target);

        // 60 second video exported in 120 seconds = 0.5x real-time
        let slow = ExportMetrics::new(60.0, 120.0, 1800);
        assert_eq!(slow.speed_ratio, 0.5);
        assert!(!slow.meets_target);
    }

    #[test]
    fn test_memory_metrics_target() {
        // 400MB base (under target)
        let good = MemoryMetrics::new(
            500 * 1024 * 1024, // 500MB current
            600 * 1024 * 1024, // 600MB peak
            450 * 1024 * 1024, // 450MB avg
            100 * 1024 * 1024, // 100MB cache
        );
        assert!(good.meets_target, "400MB base should meet 500MB target");

        // 600MB base (over target)
        let bad = MemoryMetrics::new(
            700 * 1024 * 1024, // 700MB current
            800 * 1024 * 1024, // 800MB peak
            650 * 1024 * 1024, // 650MB avg
            100 * 1024 * 1024, // 100MB cache
        );
        assert!(!bad.meets_target, "600MB base should not meet 500MB target");
    }

    #[tokio::test]
    async fn test_metrics_collector_frame_recording() {
        let collector = MetricsCollector::with_defaults();

        // Record some frame times
        for _ in 0..10 {
            collector.record_frame_time(16.0).await;
        }

        let metrics = collector.get_frame_metrics().await;
        assert!(metrics.fps > 0.0);
        assert!(metrics.avg_frame_time_ms > 0.0);
    }

    #[tokio::test]
    async fn test_metrics_collector_preview_recording() {
        let collector = MetricsCollector::with_defaults();

        collector.record_preview_latency(50.0).await;
        collector.record_preview_latency(75.0).await;
        collector.record_preview_latency(60.0).await;

        let metrics = collector.get_preview_metrics().await;
        assert_eq!(metrics.request_count, 3);
        assert!(metrics.avg_latency_ms > 50.0 && metrics.avg_latency_ms < 75.0);
    }

    #[tokio::test]
    async fn test_metrics_collector_export_recording() {
        let collector = MetricsCollector::with_defaults();

        collector.record_export(60.0, 30.0, 1800).await;

        let report = collector.generate_report().await;
        assert!(report.export.is_some());
        assert_eq!(report.export.unwrap().speed_ratio, 2.0);
    }

    #[tokio::test]
    async fn test_metrics_collector_clear() {
        let collector = MetricsCollector::with_defaults();

        collector.record_frame_time(16.0).await;
        collector.record_preview_latency(50.0).await;
        collector.record_export(60.0, 30.0, 1800).await;

        collector.clear().await;

        let report = collector.generate_report().await;
        assert!(report.export.is_none());
        assert_eq!(report.preview.request_count, 0);
    }

    #[tokio::test]
    async fn test_performance_report_health_score() {
        let collector = MetricsCollector::with_defaults();

        // Record good metrics
        collector.record_startup(1500, 500, 800, 200).await;
        for _ in 0..10 {
            collector.record_frame_time(16.0).await;
        }
        for _ in 0..5 {
            collector.record_preview_latency(50.0).await;
        }
        collector
            .record_memory(400 * 1024 * 1024, 100 * 1024 * 1024)
            .await;

        let report = collector.generate_report().await;
        assert!(report.health_score > 0);
    }

    #[test]
    fn test_timer() {
        let timer = Timer::new("test_operation");
        std::thread::sleep(std::time::Duration::from_millis(10));
        let elapsed = timer.stop();
        assert!(elapsed >= 10.0, "Timer should measure at least 10ms");
    }

    #[test]
    fn test_metrics_config_default() {
        let config = MetricsConfig::default();
        assert!(config.enabled);
        assert_eq!(config.sample_interval_ms, 1000);
    }

    #[test]
    fn test_metrics_config_minimal() {
        let config = MetricsConfig::minimal();
        assert!(!config.frame_timing_enabled);
        assert!(!config.memory_tracking_enabled);
    }

    #[test]
    fn test_startup_metrics_serialization() {
        let metrics = StartupMetrics::new(1500, 500, 800, 200);
        let json = serde_json::to_string(&metrics).unwrap();
        assert!(json.contains("\"totalMs\":1500"));
        assert!(json.contains("\"meetsTarget\":true"));
    }
}
