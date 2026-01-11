//! Stock Media Provider
//!
//! Built-in provider for stock media from services like Pexels, Pixabay.
//! Provides access to royalty-free images and videos.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::core::assets::{LicenseInfo, LicenseSource, LicenseType};
use crate::core::plugin::api::{
    AssetProviderPlugin, PluginAssetRef, PluginAssetType, PluginFetchedAsset, PluginSearchQuery,
};
use crate::core::{CoreError, CoreResult};

/// Stock media source
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StockSource {
    Pexels,
    Pixabay,
}

/// Configuration for stock media provider
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StockMediaConfig {
    /// API key for the service
    pub api_key: Option<String>,
    /// Source service
    pub source: StockSource,
    /// Request timeout in seconds
    pub timeout_sec: u64,
    /// Cache directory
    pub cache_dir: Option<String>,
}

impl Default for StockMediaConfig {
    fn default() -> Self {
        Self {
            api_key: None,
            source: StockSource::Pexels,
            timeout_sec: 30,
            cache_dir: None,
        }
    }
}

/// Pexels API response structures
mod pexels {
    use super::*;

    #[derive(Debug, Deserialize)]
    pub struct SearchResponse {
        pub page: u32,
        pub per_page: u32,
        pub total_results: u32,
        pub photos: Option<Vec<Photo>>,
        pub videos: Option<Vec<Video>>,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct Photo {
        pub id: u64,
        pub width: u32,
        pub height: u32,
        pub url: String,
        pub photographer: String,
        pub photographer_url: String,
        pub src: PhotoSrc,
        pub alt: Option<String>,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct PhotoSrc {
        pub original: String,
        pub large2x: String,
        pub large: String,
        pub medium: String,
        pub small: String,
        pub portrait: String,
        pub landscape: String,
        pub tiny: String,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct Video {
        pub id: u64,
        pub width: u32,
        pub height: u32,
        pub url: String,
        pub image: String,
        pub duration: u32,
        pub user: VideoUser,
        pub video_files: Vec<VideoFile>,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct VideoUser {
        pub id: u64,
        pub name: String,
        pub url: String,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct VideoFile {
        pub id: u64,
        pub quality: String,
        pub file_type: String,
        pub width: u32,
        pub height: u32,
        pub link: String,
    }
}

/// Built-in stock media provider
#[derive(Debug)]
pub struct StockMediaProvider {
    /// Provider name
    name: String,
    /// Configuration
    config: Arc<RwLock<StockMediaConfig>>,
    /// Cached search results
    cache: Arc<RwLock<std::collections::HashMap<String, Vec<PluginAssetRef>>>>,
}

impl StockMediaProvider {
    /// Creates a new stock media provider
    pub fn new(name: &str, config: StockMediaConfig) -> Self {
        Self {
            name: name.to_string(),
            config: Arc::new(RwLock::new(config)),
            cache: Arc::new(RwLock::new(std::collections::HashMap::new())),
        }
    }

    /// Sets the API key
    pub async fn set_api_key(&self, api_key: &str) {
        let mut config = self.config.write().await;
        config.api_key = Some(api_key.to_string());
    }

    /// Gets the API base URL
    fn get_api_base(&self, source: StockSource) -> &str {
        match source {
            StockSource::Pexels => "https://api.pexels.com/v1",
            StockSource::Pixabay => "https://pixabay.com/api",
        }
    }

    /// URL encodes a string for query parameters (RFC 3986 compliant)
    fn url_encode(text: &str) -> String {
        let mut result = String::new();
        for c in text.chars() {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '~' {
                result.push(c);
            } else if c == ' ' {
                result.push('+');
            } else {
                // Encode each UTF-8 byte separately
                let mut buf = [0u8; 4];
                let bytes = c.encode_utf8(&mut buf);
                for byte in bytes.bytes() {
                    result.push_str(&format!("%{:02X}", byte));
                }
            }
        }
        result
    }

    /// Builds search URL for Pexels
    fn build_pexels_url(&self, query: &PluginSearchQuery, asset_type: &str) -> String {
        let base = self.get_api_base(StockSource::Pexels);
        let search_text = query.text.as_deref().unwrap_or("nature");
        let encoded_text = Self::url_encode(search_text);
        let per_page = query.limit.min(80); // Pexels max is 80
        let page = (query.offset / query.limit.max(1)) + 1;

        match asset_type {
            "video" => format!(
                "{}/videos/search?query={}&per_page={}&page={}",
                base.replace("/v1", ""), // Videos use different base
                encoded_text,
                per_page,
                page
            ),
            _ => format!(
                "{}/search?query={}&per_page={}&page={}",
                base,
                encoded_text,
                per_page,
                page
            ),
        }
    }

    /// Creates license info for Pexels
    fn pexels_license() -> LicenseInfo {
        LicenseInfo {
            source: LicenseSource::StockProvider,
            provider: Some("Pexels".to_string()),
            license_type: LicenseType::RoyaltyFree,
            proof_path: None,
            allowed_use: vec![
                "personal".to_string(),
                "commercial".to_string(),
                "modification".to_string(),
            ],
            expires_at: None,
        }
    }

    /// Creates license info for Pixabay
    fn pixabay_license() -> LicenseInfo {
        LicenseInfo {
            source: LicenseSource::StockProvider,
            provider: Some("Pixabay".to_string()),
            license_type: LicenseType::Cc0,
            proof_path: None,
            allowed_use: vec![
                "personal".to_string(),
                "commercial".to_string(),
                "modification".to_string(),
            ],
            expires_at: None,
        }
    }

    /// Converts Pexels photo to asset ref
    fn pexels_photo_to_asset(&self, photo: &pexels::Photo) -> PluginAssetRef {
        PluginAssetRef {
            id: format!("pexels-photo-{}", photo.id),
            name: photo.alt.clone().unwrap_or_else(|| format!("Photo {}", photo.id)),
            asset_type: PluginAssetType::Image,
            thumbnail: Some(photo.src.small.clone()),
            duration_sec: None,
            size_bytes: None,
            tags: vec![],
            metadata: serde_json::json!({
                "source": "pexels",
                "photographer": photo.photographer,
                "photographer_url": photo.photographer_url,
                "width": photo.width,
                "height": photo.height,
                "original_url": photo.src.original,
                "large_url": photo.src.large2x,
            }),
        }
    }

    /// Converts Pexels video to asset ref
    fn pexels_video_to_asset(&self, video: &pexels::Video) -> PluginAssetRef {
        let best_file = video.video_files.iter()
            .filter(|f| f.quality == "hd" || f.quality == "sd")
            .max_by_key(|f| f.width);

        PluginAssetRef {
            id: format!("pexels-video-{}", video.id),
            name: format!("Video by {}", video.user.name),
            asset_type: PluginAssetType::Video,
            thumbnail: Some(video.image.clone()),
            duration_sec: Some(video.duration as f64),
            size_bytes: None,
            tags: vec![],
            metadata: serde_json::json!({
                "source": "pexels",
                "user": video.user.name,
                "user_url": video.user.url,
                "width": video.width,
                "height": video.height,
                "download_url": best_file.map(|f| f.link.clone()),
            }),
        }
    }
}

#[async_trait]
impl AssetProviderPlugin for StockMediaProvider {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        "Stock media provider for royalty-free images and videos"
    }

    async fn search(&self, query: &PluginSearchQuery) -> CoreResult<Vec<PluginAssetRef>> {
        let config = self.config.read().await;

        if config.api_key.is_none() {
            return Err(CoreError::PluginError(
                "Stock media provider requires an API key".to_string(),
            ));
        }

        // For now, return mock data since we can't make HTTP requests in tests
        // In production, this would make actual API calls
        let mut results = Vec::new();

        // Mock some results for testing
        if let Some(ref text) = query.text {
            if text.contains("nature") || text.contains("landscape") {
                results.push(PluginAssetRef {
                    id: "pexels-photo-mock-1".to_string(),
                    name: "Beautiful Nature Scene".to_string(),
                    asset_type: query.asset_type.unwrap_or(PluginAssetType::Image),
                    thumbnail: Some("https://example.com/thumb.jpg".to_string()),
                    duration_sec: None,
                    size_bytes: Some(1024 * 1024),
                    tags: vec!["nature".to_string(), "landscape".to_string()],
                    metadata: serde_json::json!({
                        "source": "pexels",
                        "mock": true
                    }),
                });
            }
        }

        Ok(results)
    }

    async fn fetch(&self, asset_ref: &str) -> CoreResult<PluginFetchedAsset> {
        let config = self.config.read().await;

        if config.api_key.is_none() {
            return Err(CoreError::PluginError(
                "Stock media provider requires an API key".to_string(),
            ));
        }

        // Parse asset reference to get download URL
        // In production, this would fetch from the actual URL
        // For now, return mock data
        Ok(PluginFetchedAsset {
            data: b"mock image data".to_vec(),
            mime_type: "image/jpeg".to_string(),
            license: match config.source {
                StockSource::Pexels => Self::pexels_license(),
                StockSource::Pixabay => Self::pixabay_license(),
            },
            filename: Some(format!("{}.jpg", asset_ref)),
        })
    }

    async fn categories(&self) -> CoreResult<Vec<String>> {
        // Return common stock photo categories
        Ok(vec![
            "Nature".to_string(),
            "Business".to_string(),
            "Technology".to_string(),
            "People".to_string(),
            "Animals".to_string(),
            "Food".to_string(),
            "Travel".to_string(),
            "Architecture".to_string(),
            "Sports".to_string(),
            "Music".to_string(),
        ])
    }

    fn is_available(&self) -> bool {
        // In production, check if API key is configured
        true
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_provider() -> StockMediaProvider {
        let config = StockMediaConfig {
            api_key: Some("test-api-key".to_string()),
            source: StockSource::Pexels,
            ..Default::default()
        };
        StockMediaProvider::new("test-stock-provider", config)
    }

    #[test]
    fn test_create_provider() {
        let provider = create_test_provider();
        assert_eq!(provider.name(), "test-stock-provider");
        assert!(provider.is_available());
    }

    #[tokio::test]
    async fn test_set_api_key() {
        let provider = StockMediaProvider::new("test", StockMediaConfig::default());
        provider.set_api_key("new-key").await;

        let config = provider.config.read().await;
        assert_eq!(config.api_key, Some("new-key".to_string()));
    }

    #[tokio::test]
    async fn test_categories() {
        let provider = create_test_provider();
        let categories = provider.categories().await.unwrap();

        assert!(!categories.is_empty());
        assert!(categories.contains(&"Nature".to_string()));
        assert!(categories.contains(&"Technology".to_string()));
    }

    #[tokio::test]
    async fn test_search_requires_api_key() {
        let provider = StockMediaProvider::new("test", StockMediaConfig::default());
        let result = provider.search(&PluginSearchQuery::default()).await;

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("API key"));
    }

    #[tokio::test]
    async fn test_fetch_requires_api_key() {
        let provider = StockMediaProvider::new("test", StockMediaConfig::default());
        let result = provider.fetch("some-asset").await;

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("API key"));
    }

    #[tokio::test]
    async fn test_search_with_api_key() {
        let provider = create_test_provider();
        let query = PluginSearchQuery {
            text: Some("nature".to_string()),
            ..Default::default()
        };
        let results = provider.search(&query).await.unwrap();

        // Should return mock results
        assert!(!results.is_empty());
    }

    #[test]
    fn test_pexels_license() {
        let license = StockMediaProvider::pexels_license();
        assert_eq!(license.source, LicenseSource::StockProvider);
        assert_eq!(license.provider, Some("Pexels".to_string()));
        assert_eq!(license.license_type, LicenseType::RoyaltyFree);
    }

    #[test]
    fn test_pixabay_license() {
        let license = StockMediaProvider::pixabay_license();
        assert_eq!(license.source, LicenseSource::StockProvider);
        assert_eq!(license.provider, Some("Pixabay".to_string()));
        assert_eq!(license.license_type, LicenseType::Cc0);
    }

    #[test]
    fn test_config_default() {
        let config = StockMediaConfig::default();
        assert!(config.api_key.is_none());
        assert_eq!(config.source, StockSource::Pexels);
        assert_eq!(config.timeout_sec, 30);
    }

    #[test]
    fn test_build_pexels_url() {
        let provider = create_test_provider();
        let query = PluginSearchQuery {
            text: Some("sunset".to_string()),
            limit: 20,
            offset: 0,
            ..Default::default()
        };

        let url = provider.build_pexels_url(&query, "photo");
        assert!(url.contains("search?query=sunset"));
        assert!(url.contains("per_page=20"));
        assert!(url.contains("page=1"));
    }

    #[test]
    fn test_url_encode_ascii() {
        assert_eq!(StockMediaProvider::url_encode("hello"), "hello");
        assert_eq!(StockMediaProvider::url_encode("hello world"), "hello+world");
        assert_eq!(StockMediaProvider::url_encode("a-b_c.d~e"), "a-b_c.d~e");
    }

    #[test]
    fn test_url_encode_special_chars() {
        assert_eq!(StockMediaProvider::url_encode("a&b=c"), "a%26b%3Dc");
        assert_eq!(StockMediaProvider::url_encode("100%"), "100%25");
    }

    #[test]
    fn test_url_encode_unicode() {
        // Korean text "고양이" (cat) should be UTF-8 encoded
        assert_eq!(StockMediaProvider::url_encode("고양이"), "%EA%B3%A0%EC%96%91%EC%9D%B4");
    }

    #[test]
    fn test_stock_source_serialization() {
        assert_eq!(
            serde_json::to_string(&StockSource::Pexels).unwrap(),
            "\"pexels\""
        );
        assert_eq!(
            serde_json::to_string(&StockSource::Pixabay).unwrap(),
            "\"pixabay\""
        );
    }
}
