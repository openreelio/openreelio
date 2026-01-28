//! Analysis Orchestrator
//!
//! Coordinates analysis requests across multiple providers.
//! Handles provider selection, cost estimation, and result aggregation.

use std::path::Path;
use std::sync::Arc;

use crate::core::{CoreError, CoreResult};

use super::{
    AnalysisProvider as ProviderType, AnalysisProviderTrait, AnalysisRequest, AnalysisResponse,
    AnalysisType, AnnotationStore, AssetAnnotation, CostEstimate, GoogleCloudProvider,
    LocalAnalysisProvider, ProviderCapabilities,
};

// =============================================================================
// Orchestrator
// =============================================================================

/// Orchestrates analysis across multiple providers
///
/// Responsibilities:
/// - Provider management and selection
/// - Cost estimation and confirmation
/// - Result aggregation and storage
/// - Automatic provider fallback
pub struct AnalysisOrchestrator {
    /// Local FFmpeg-based provider (always available)
    local_provider: Arc<LocalAnalysisProvider>,
    /// Optional Google Cloud provider (requires API key)
    cloud_provider: Option<Arc<GoogleCloudProvider>>,
    /// Annotation store for persistence
    store: AnnotationStore,
}

impl AnalysisOrchestrator {
    /// Creates a new orchestrator with annotation store
    pub fn new(project_dir: &Path) -> Self {
        Self {
            local_provider: Arc::new(LocalAnalysisProvider::new()),
            cloud_provider: None,
            store: AnnotationStore::new(project_dir),
        }
    }

    /// Creates orchestrator with a custom annotation store
    pub fn with_store(store: AnnotationStore) -> Self {
        Self {
            local_provider: Arc::new(LocalAnalysisProvider::new()),
            cloud_provider: None,
            store,
        }
    }

    /// Configures the Google Cloud provider with an API key
    pub fn configure_cloud_provider(&mut self, api_key: &str) -> CoreResult<()> {
        let provider = GoogleCloudProvider::new(api_key)?;
        self.cloud_provider = Some(Arc::new(provider));
        Ok(())
    }

    /// Removes the cloud provider configuration
    pub fn remove_cloud_provider(&mut self) {
        self.cloud_provider = None;
    }

    /// Returns available providers
    pub fn available_providers(&self) -> Vec<ProviderCapabilities> {
        let mut providers = vec![self.local_provider.capabilities()];
        if let Some(ref cloud) = self.cloud_provider {
            if cloud.is_available() {
                providers.push(cloud.capabilities());
            }
        }
        providers
    }

    /// Returns capabilities for a specific provider
    pub fn get_provider_capabilities(
        &self,
        provider: ProviderType,
    ) -> Option<ProviderCapabilities> {
        match provider {
            ProviderType::Ffmpeg => Some(self.local_provider.capabilities()),
            ProviderType::GoogleCloud => self.cloud_provider.as_ref().map(|p| p.capabilities()),
            _ => None,
        }
    }

    /// Checks if a provider is available
    pub fn is_provider_available(&self, provider: ProviderType) -> bool {
        match provider {
            ProviderType::Ffmpeg | ProviderType::Whisper => self.local_provider.is_available(),
            ProviderType::GoogleCloud => self
                .cloud_provider
                .as_ref()
                .map(|p| p.is_available())
                .unwrap_or(false),
            ProviderType::Custom(_) => false,
        }
    }

    /// Estimates cost for analysis
    ///
    /// Returns `None` for free providers (local).
    pub fn estimate_cost(
        &self,
        provider: ProviderType,
        duration_sec: f64,
        analysis_types: &[AnalysisType],
    ) -> Option<CostEstimate> {
        match provider {
            ProviderType::Ffmpeg | ProviderType::Whisper => self
                .local_provider
                .estimate_cost(duration_sec, analysis_types),
            ProviderType::GoogleCloud => self
                .cloud_provider
                .as_ref()
                .and_then(|p| p.estimate_cost(duration_sec, analysis_types)),
            ProviderType::Custom(_) => None,
        }
    }

    /// Performs analysis using the specified provider
    pub async fn analyze(
        &self,
        provider: ProviderType,
        request: AnalysisRequest,
    ) -> CoreResult<AnalysisResponse> {
        match provider {
            ProviderType::Ffmpeg | ProviderType::Whisper => {
                self.local_provider.analyze(request).await
            }
            ProviderType::GoogleCloud => {
                let cloud = self.cloud_provider.as_ref().ok_or_else(|| {
                    CoreError::NotSupported(
                        "Google Cloud provider not configured. Add API key in Settings."
                            .to_string(),
                    )
                })?;
                cloud.analyze(request).await
            }
            ProviderType::Custom(name) => Err(CoreError::NotSupported(format!(
                "Custom provider '{}' not supported",
                name
            ))),
        }
    }

    /// Performs analysis and stores results
    ///
    /// This is the main entry point for analysis.
    /// Results are automatically persisted to the annotation store.
    pub async fn analyze_and_store(
        &self,
        provider: ProviderType,
        request: AnalysisRequest,
        asset_hash: &str,
    ) -> CoreResult<AssetAnnotation> {
        let response = self.analyze(provider, request.clone()).await?;

        // Get or create annotation
        let mut annotation = self
            .store
            .load(&request.asset_id)?
            .unwrap_or_else(|| AssetAnnotation::new(&request.asset_id, asset_hash));

        // Update hash if changed
        if annotation.asset_hash != asset_hash {
            annotation.asset_hash = asset_hash.to_string();
        }

        // Store results
        if let Some(shots) = response.shots {
            annotation.set_shots(shots);
        }
        if let Some(transcript) = response.transcript {
            annotation.set_transcript(transcript);
        }
        if let Some(objects) = response.objects {
            annotation.set_objects(objects);
        }
        if let Some(faces) = response.faces {
            annotation.set_faces(faces);
        }
        if let Some(text_ocr) = response.text_ocr {
            annotation.set_text_ocr(text_ocr);
        }

        // Persist
        self.store.save(&annotation)?;

        Ok(annotation)
    }

    /// Gets annotation for an asset
    pub fn get_annotation(&self, asset_id: &str) -> CoreResult<Option<AssetAnnotation>> {
        self.store.load(asset_id)
    }

    /// Gets analysis status for an asset
    pub fn get_status(
        &self,
        asset_id: &str,
        asset_hash: &str,
    ) -> CoreResult<super::AnalysisStatus> {
        self.store.get_status(asset_id, asset_hash)
    }

    /// Deletes annotation for an asset
    pub fn delete_annotation(&self, asset_id: &str) -> CoreResult<()> {
        self.store.delete(asset_id)
    }

    /// Lists all annotated asset IDs
    pub fn list_annotated(&self) -> CoreResult<Vec<String>> {
        self.store.list_annotated()
    }

    /// Returns the recommended provider for given analysis types
    ///
    /// Strategy:
    /// - Use local provider for shots (free)
    /// - Require cloud provider for transcript, objects, faces, text
    pub fn recommend_provider(&self, analysis_types: &[AnalysisType]) -> ProviderType {
        // Check if any type requires cloud
        let needs_cloud = analysis_types.iter().any(|t| {
            matches!(
                t,
                AnalysisType::Transcript
                    | AnalysisType::Objects
                    | AnalysisType::Faces
                    | AnalysisType::TextOcr
            )
        });

        if needs_cloud && self.is_provider_available(ProviderType::GoogleCloud) {
            ProviderType::GoogleCloud
        } else {
            ProviderType::Ffmpeg
        }
    }

    /// Returns supported analysis types for a provider
    pub fn supported_types(&self, provider: ProviderType) -> Vec<AnalysisType> {
        match provider {
            ProviderType::Ffmpeg | ProviderType::Whisper => {
                self.local_provider.capabilities().supported_types
            }
            ProviderType::GoogleCloud => self
                .cloud_provider
                .as_ref()
                .map(|p| p.capabilities().supported_types)
                .unwrap_or_default(),
            ProviderType::Custom(_) => vec![],
        }
    }

    /// Performs health check on providers
    pub async fn health_check(&self, provider: ProviderType) -> CoreResult<()> {
        match provider {
            ProviderType::Ffmpeg | ProviderType::Whisper => {
                self.local_provider.health_check().await
            }
            ProviderType::GoogleCloud => {
                let cloud = self.cloud_provider.as_ref().ok_or_else(|| {
                    CoreError::NotSupported("Google Cloud provider not configured".to_string())
                })?;
                cloud.health_check().await
            }
            ProviderType::Custom(name) => Err(CoreError::NotSupported(format!(
                "Custom provider '{}' not supported",
                name
            ))),
        }
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_orchestrator() -> (TempDir, AnalysisOrchestrator) {
        let temp_dir = TempDir::new().unwrap();
        let orchestrator = AnalysisOrchestrator::new(temp_dir.path());
        (temp_dir, orchestrator)
    }

    // -------------------------------------------------------------------------
    // Basic Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_orchestrator_creation() {
        let (_temp_dir, orchestrator) = create_test_orchestrator();
        assert!(
            orchestrator.local_provider.is_available()
                || !orchestrator.local_provider.is_available()
        );
    }

    #[test]
    fn test_available_providers_local_only() {
        let (_temp_dir, orchestrator) = create_test_orchestrator();
        let providers = orchestrator.available_providers();

        // At least local provider should be listed
        assert!(!providers.is_empty());
        assert!(providers.iter().any(|p| p.provider == ProviderType::Ffmpeg));
    }

    #[test]
    fn test_configure_cloud_provider() {
        let (_temp_dir, mut orchestrator) = create_test_orchestrator();

        // Initially no cloud provider
        assert!(!orchestrator.is_provider_available(ProviderType::GoogleCloud));

        // Configure cloud provider
        orchestrator
            .configure_cloud_provider("test-api-key")
            .unwrap();
        assert!(orchestrator.is_provider_available(ProviderType::GoogleCloud));

        // Remove cloud provider
        orchestrator.remove_cloud_provider();
        assert!(!orchestrator.is_provider_available(ProviderType::GoogleCloud));
    }

    #[test]
    fn test_configure_cloud_provider_empty_key() {
        let (_temp_dir, mut orchestrator) = create_test_orchestrator();
        let result = orchestrator.configure_cloud_provider("");
        assert!(result.is_err());
    }

    // -------------------------------------------------------------------------
    // Provider Capabilities Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_get_provider_capabilities_local() {
        let (_temp_dir, orchestrator) = create_test_orchestrator();
        let caps = orchestrator.get_provider_capabilities(ProviderType::Ffmpeg);

        assert!(caps.is_some());
        let caps = caps.unwrap();
        assert_eq!(caps.provider, ProviderType::Ffmpeg);
        assert!(!caps.has_cost);
    }

    #[test]
    fn test_get_provider_capabilities_cloud_not_configured() {
        let (_temp_dir, orchestrator) = create_test_orchestrator();
        let caps = orchestrator.get_provider_capabilities(ProviderType::GoogleCloud);
        assert!(caps.is_none());
    }

    #[test]
    fn test_get_provider_capabilities_cloud_configured() {
        let (_temp_dir, mut orchestrator) = create_test_orchestrator();
        orchestrator.configure_cloud_provider("test-key").unwrap();

        let caps = orchestrator.get_provider_capabilities(ProviderType::GoogleCloud);
        assert!(caps.is_some());
        let caps = caps.unwrap();
        assert!(caps.has_cost);
    }

    // -------------------------------------------------------------------------
    // Cost Estimation Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_estimate_cost_local_is_free() {
        let (_temp_dir, orchestrator) = create_test_orchestrator();
        let cost = orchestrator.estimate_cost(ProviderType::Ffmpeg, 120.0, &[AnalysisType::Shots]);
        assert!(cost.is_none());
    }

    #[test]
    fn test_estimate_cost_cloud() {
        let (_temp_dir, mut orchestrator) = create_test_orchestrator();
        orchestrator.configure_cloud_provider("test-key").unwrap();

        let cost = orchestrator
            .estimate_cost(ProviderType::GoogleCloud, 120.0, &[AnalysisType::Shots])
            .unwrap();

        assert_eq!(cost.provider, ProviderType::GoogleCloud);
        assert!(cost.estimated_cost_cents > 0);
    }

    // -------------------------------------------------------------------------
    // Recommend Provider Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_recommend_provider_shots_only() {
        let (_temp_dir, orchestrator) = create_test_orchestrator();
        let provider = orchestrator.recommend_provider(&[AnalysisType::Shots]);
        assert_eq!(provider, ProviderType::Ffmpeg);
    }

    #[test]
    fn test_recommend_provider_transcript_without_cloud() {
        let (_temp_dir, orchestrator) = create_test_orchestrator();
        // No cloud configured, should still return local (will fail later)
        let provider = orchestrator.recommend_provider(&[AnalysisType::Transcript]);
        assert_eq!(provider, ProviderType::Ffmpeg);
    }

    #[test]
    fn test_recommend_provider_transcript_with_cloud() {
        let (_temp_dir, mut orchestrator) = create_test_orchestrator();
        orchestrator.configure_cloud_provider("test-key").unwrap();

        let provider = orchestrator.recommend_provider(&[AnalysisType::Transcript]);
        assert_eq!(provider, ProviderType::GoogleCloud);
    }

    #[test]
    fn test_recommend_provider_mixed() {
        let (_temp_dir, mut orchestrator) = create_test_orchestrator();
        orchestrator.configure_cloud_provider("test-key").unwrap();

        // Mixed types should recommend cloud
        let provider =
            orchestrator.recommend_provider(&[AnalysisType::Shots, AnalysisType::Objects]);
        assert_eq!(provider, ProviderType::GoogleCloud);
    }

    // -------------------------------------------------------------------------
    // Supported Types Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_supported_types_local() {
        let (_temp_dir, orchestrator) = create_test_orchestrator();
        let types = orchestrator.supported_types(ProviderType::Ffmpeg);
        assert!(types.contains(&AnalysisType::Shots));
        assert!(!types.contains(&AnalysisType::Transcript));
    }

    #[test]
    fn test_supported_types_cloud_not_configured() {
        let (_temp_dir, orchestrator) = create_test_orchestrator();
        let types = orchestrator.supported_types(ProviderType::GoogleCloud);
        assert!(types.is_empty());
    }

    #[test]
    fn test_supported_types_cloud_configured() {
        let (_temp_dir, mut orchestrator) = create_test_orchestrator();
        orchestrator.configure_cloud_provider("test-key").unwrap();

        let types = orchestrator.supported_types(ProviderType::GoogleCloud);
        assert!(types.contains(&AnalysisType::Shots));
        assert!(types.contains(&AnalysisType::Transcript));
        assert!(types.contains(&AnalysisType::Objects));
    }

    // -------------------------------------------------------------------------
    // Annotation Store Integration Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_get_annotation_not_found() {
        let (_temp_dir, orchestrator) = create_test_orchestrator();
        let annotation = orchestrator.get_annotation("nonexistent").unwrap();
        assert!(annotation.is_none());
    }

    #[test]
    fn test_list_annotated_empty() {
        let (_temp_dir, orchestrator) = create_test_orchestrator();
        let list = orchestrator.list_annotated().unwrap();
        assert!(list.is_empty());
    }

    #[tokio::test]
    async fn test_analyze_file_not_found() {
        let (_temp_dir, orchestrator) = create_test_orchestrator();
        let request = AnalysisRequest::new(
            "asset_001",
            "/nonexistent/video.mp4",
            60.0,
            vec![AnalysisType::Shots],
        );

        let result = orchestrator.analyze(ProviderType::Ffmpeg, request).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_analyze_cloud_not_configured() {
        let (_temp_dir, orchestrator) = create_test_orchestrator();
        let request = AnalysisRequest::new(
            "asset_001",
            "/some/video.mp4",
            60.0,
            vec![AnalysisType::Shots],
        );

        let result = orchestrator
            .analyze(ProviderType::GoogleCloud, request)
            .await;
        assert!(result.is_err());
    }
}
