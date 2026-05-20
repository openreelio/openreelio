//! Stock media provider.
//!
//! Built-in provider adapters for image/video stock search. Search returns
//! provider references and metadata only; import/download remains a separate
//! policy-checked workflow.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::core::assets::{LicenseInfo, LicenseSource, LicenseType};
use crate::core::plugin::api::{
    AssetProviderPlugin, PluginAssetRef, PluginAssetType, PluginFetchedAsset, PluginSearchQuery,
};
use crate::core::{CoreError, CoreResult};

/// Stock media source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StockSource {
    Pexels,
    Pixabay,
}

/// Configuration for a stock media provider instance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StockMediaConfig {
    /// API key for the service.
    pub api_key: Option<String>,
    /// Source service.
    pub source: StockSource,
    /// Request timeout in seconds.
    pub timeout_sec: u64,
    /// Cache directory reserved for future provider metadata cache.
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

#[allow(dead_code)]
mod pexels {
    use super::*;

    #[derive(Debug, Deserialize)]
    pub struct SearchResponse {
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
        pub width: Option<u32>,
        pub height: Option<u32>,
        pub link: String,
    }
}

#[allow(dead_code)]
mod pixabay {
    use super::*;

    #[derive(Debug, Deserialize)]
    pub struct ImageSearchResponse {
        pub hits: Vec<ImageHit>,
    }

    #[derive(Debug, Deserialize)]
    pub struct VideoSearchResponse {
        pub hits: Vec<VideoHit>,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct ImageHit {
        pub id: u64,
        #[serde(rename = "pageURL")]
        pub page_url: Option<String>,
        pub tags: String,
        #[serde(rename = "previewURL")]
        pub preview_url: Option<String>,
        #[serde(rename = "webformatURL")]
        pub webformat_url: Option<String>,
        #[serde(rename = "largeImageURL")]
        pub large_image_url: Option<String>,
        #[serde(rename = "imageWidth")]
        pub image_width: Option<u32>,
        #[serde(rename = "imageHeight")]
        pub image_height: Option<u32>,
        pub user: Option<String>,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct VideoHit {
        pub id: u64,
        #[serde(rename = "pageURL")]
        pub page_url: Option<String>,
        pub tags: String,
        pub duration: Option<u32>,
        pub videos: VideoVariants,
        pub user: Option<String>,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct VideoVariants {
        pub large: Option<VideoFile>,
        pub medium: Option<VideoFile>,
        pub small: Option<VideoFile>,
        pub tiny: Option<VideoFile>,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct VideoFile {
        pub url: String,
        pub width: Option<u32>,
        pub height: Option<u32>,
        pub size: Option<u64>,
        pub thumbnail: Option<String>,
    }
}

/// Built-in stock media provider.
#[derive(Debug)]
pub struct StockMediaProvider {
    name: String,
    config: Arc<RwLock<StockMediaConfig>>,
    cache: Arc<RwLock<std::collections::HashMap<String, Vec<PluginAssetRef>>>>,
    available: Arc<AtomicBool>,
}

impl StockMediaProvider {
    /// Creates a new stock media provider.
    pub fn new(name: &str, config: StockMediaConfig) -> Self {
        let is_available = config
            .api_key
            .as_ref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);

        Self {
            name: name.to_string(),
            config: Arc::new(RwLock::new(config)),
            cache: Arc::new(RwLock::new(std::collections::HashMap::new())),
            available: Arc::new(AtomicBool::new(is_available)),
        }
    }

    /// Sets the API key.
    pub async fn set_api_key(&self, api_key: &str) {
        let trimmed = api_key.trim();
        let mut config = self.config.write().await;
        config.api_key = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
        self.available
            .store(config.api_key.is_some(), Ordering::Relaxed);
    }

    fn get_api_base(source: StockSource) -> &'static str {
        match source {
            StockSource::Pexels => "https://api.pexels.com/v1",
            StockSource::Pixabay => "https://pixabay.com/api",
        }
    }

    /// URL encodes a string for query parameters.
    fn url_encode(text: &str) -> String {
        let mut result = String::new();
        for c in text.chars() {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '~' {
                result.push(c);
            } else if c == ' ' {
                result.push('+');
            } else {
                let mut buf = [0u8; 4];
                for byte in c.encode_utf8(&mut buf).bytes() {
                    result.push_str(&format!("%{:02X}", byte));
                }
            }
        }
        result
    }

    fn search_text(query: &PluginSearchQuery, fallback: &str) -> String {
        query
            .text
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(fallback)
            .to_string()
    }

    fn cache_key(source: StockSource, query: &PluginSearchQuery) -> String {
        format!(
            "{:?}|{}|{:?}|{}|{}|{}|{:?}",
            source,
            query.text.as_deref().unwrap_or(""),
            query.asset_type,
            query.limit,
            query.offset,
            query.tags.join(","),
            query.duration_range
        )
    }

    /// Builds a Pexels search URL.
    fn build_pexels_url(&self, query: &PluginSearchQuery, asset_type: &str) -> String {
        let base = Self::get_api_base(StockSource::Pexels);
        let encoded_text = Self::url_encode(&Self::search_text(query, "nature"));
        let per_page = query.limit.clamp(1, 80);
        let page = (query.offset / query.limit.max(1)) + 1;

        match asset_type {
            "video" => format!(
                "{}/videos/search?query={}&per_page={}&page={}",
                base, encoded_text, per_page, page
            ),
            _ => format!(
                "{}/search?query={}&per_page={}&page={}",
                base, encoded_text, per_page, page
            ),
        }
    }

    /// Builds a Pixabay search URL.
    fn build_pixabay_url(
        &self,
        query: &PluginSearchQuery,
        asset_type: &str,
        api_key: &str,
    ) -> String {
        let base = Self::get_api_base(StockSource::Pixabay);
        let encoded_text = Self::url_encode(&Self::search_text(query, "nature"));
        let per_page = query.limit.clamp(3, 200);
        let page = (query.offset / query.limit.max(1)) + 1;

        match asset_type {
            "video" => format!(
                "{}/videos/?key={}&q={}&per_page={}&page={}&safesearch=true",
                base,
                Self::url_encode(api_key),
                encoded_text,
                per_page,
                page
            ),
            _ => format!(
                "{}/?key={}&q={}&per_page={}&page={}&safesearch=true",
                base,
                Self::url_encode(api_key),
                encoded_text,
                per_page,
                page
            ),
        }
    }

    /// Creates license info for Pexels.
    pub fn pexels_license() -> LicenseInfo {
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

    /// Creates license info for Pixabay.
    pub fn pixabay_license() -> LicenseInfo {
        LicenseInfo {
            source: LicenseSource::StockProvider,
            provider: Some("Pixabay".to_string()),
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

    fn license_metadata(
        license: LicenseInfo,
        license_name: &str,
        license_url: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "licenseInfo": license,
            "licenseName": license_name,
            "licenseUrl": license_url,
        })
    }

    fn pexels_photo_to_asset(&self, photo: &pexels::Photo) -> PluginAssetRef {
        let license = Self::pexels_license();

        PluginAssetRef {
            id: format!("pexels-photo-{}", photo.id),
            name: photo
                .alt
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| format!("Pexels photo {}", photo.id)),
            asset_type: PluginAssetType::Image,
            thumbnail: Some(photo.src.small.clone()),
            duration_sec: None,
            size_bytes: None,
            tags: Vec::new(),
            metadata: serde_json::json!({
                "provider": "pexels",
                "providerAssetId": photo.id.to_string(),
                "providerUrl": photo.url,
                "photographer": photo.photographer,
                "photographerUrl": photo.photographer_url,
                "width": photo.width,
                "height": photo.height,
                "previewUrl": photo.src.medium,
                "downloadUrl": photo.src.large2x,
                "originalUrl": photo.src.original,
                "license": Self::license_metadata(
                    license,
                    "Pexels License",
                    "https://www.pexels.com/license/"
                ),
            }),
        }
    }

    fn pexels_video_to_asset(&self, video: &pexels::Video) -> PluginAssetRef {
        let best_file = video
            .video_files
            .iter()
            .filter(|file| file.quality == "hd" || file.quality == "sd")
            .max_by_key(|file| file.width.unwrap_or(0));
        let license = Self::pexels_license();

        PluginAssetRef {
            id: format!("pexels-video-{}", video.id),
            name: format!("Pexels video by {}", video.user.name),
            asset_type: PluginAssetType::Video,
            thumbnail: Some(video.image.clone()),
            duration_sec: Some(video.duration as f64),
            size_bytes: None,
            tags: Vec::new(),
            metadata: serde_json::json!({
                "provider": "pexels",
                "providerAssetId": video.id.to_string(),
                "providerUrl": video.url,
                "userId": video.user.id,
                "user": video.user.name,
                "userUrl": video.user.url,
                "width": video.width,
                "height": video.height,
                "previewUrl": video.image,
                "downloadUrl": best_file.map(|file| file.link.clone()),
                "downloadMimeType": best_file.map(|file| file.file_type.clone()),
                "downloadWidth": best_file.and_then(|file| file.width),
                "downloadHeight": best_file.and_then(|file| file.height),
                "license": Self::license_metadata(
                    license,
                    "Pexels License",
                    "https://www.pexels.com/license/"
                ),
            }),
        }
    }

    fn pixabay_tags(tags: &str) -> Vec<String> {
        tags.split(',')
            .map(str::trim)
            .filter(|tag| !tag.is_empty())
            .map(str::to_string)
            .collect()
    }

    fn pixabay_image_to_asset(&self, image: &pixabay::ImageHit) -> PluginAssetRef {
        let license = Self::pixabay_license();

        PluginAssetRef {
            id: format!("pixabay-image-{}", image.id),
            name: image
                .tags
                .split(',')
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| format!("Pixabay image: {}", value))
                .unwrap_or_else(|| format!("Pixabay image {}", image.id)),
            asset_type: PluginAssetType::Image,
            thumbnail: image.preview_url.clone(),
            duration_sec: None,
            size_bytes: None,
            tags: Self::pixabay_tags(&image.tags),
            metadata: serde_json::json!({
                "provider": "pixabay",
                "providerAssetId": image.id.to_string(),
                "providerUrl": image.page_url,
                "creator": image.user,
                "width": image.image_width,
                "height": image.image_height,
                "previewUrl": image.webformat_url,
                "downloadUrl": image.large_image_url.as_ref().or(image.webformat_url.as_ref()),
                "license": Self::license_metadata(
                    license,
                    "Pixabay Content License",
                    "https://pixabay.com/service/license-summary/"
                ),
            }),
        }
    }

    fn best_pixabay_video_file(hit: &pixabay::VideoHit) -> Option<&pixabay::VideoFile> {
        hit.videos
            .large
            .as_ref()
            .or(hit.videos.medium.as_ref())
            .or(hit.videos.small.as_ref())
            .or(hit.videos.tiny.as_ref())
    }

    fn pixabay_video_to_asset(&self, video: &pixabay::VideoHit) -> PluginAssetRef {
        let best_file = Self::best_pixabay_video_file(video);
        let thumbnail = best_file.and_then(|file| file.thumbnail.clone());
        let license = Self::pixabay_license();

        PluginAssetRef {
            id: format!("pixabay-video-{}", video.id),
            name: video
                .tags
                .split(',')
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| format!("Pixabay video: {}", value))
                .unwrap_or_else(|| format!("Pixabay video {}", video.id)),
            asset_type: PluginAssetType::Video,
            thumbnail,
            duration_sec: video.duration.map(|duration| duration as f64),
            size_bytes: best_file.and_then(|file| file.size),
            tags: Self::pixabay_tags(&video.tags),
            metadata: serde_json::json!({
                "provider": "pixabay",
                "providerAssetId": video.id.to_string(),
                "providerUrl": video.page_url,
                "creator": video.user,
                "width": best_file.and_then(|file| file.width),
                "height": best_file.and_then(|file| file.height),
                "previewUrl": best_file.map(|file| file.url.clone()),
                "downloadUrl": best_file.map(|file| file.url.clone()),
                "license": Self::license_metadata(
                    license,
                    "Pixabay Content License",
                    "https://pixabay.com/service/license-summary/"
                ),
            }),
        }
    }

    #[cfg(feature = "ai-providers")]
    async fn search_pexels(
        &self,
        config: &StockMediaConfig,
        query: &PluginSearchQuery,
    ) -> CoreResult<Vec<PluginAssetRef>> {
        let api_key = config.api_key.as_deref().ok_or_else(|| {
            CoreError::PluginError("Pexels provider requires an API key".to_string())
        })?;
        let asset_type = match query.asset_type.unwrap_or(PluginAssetType::Video) {
            PluginAssetType::Video => "video",
            PluginAssetType::Image => "image",
            _ => return Ok(Vec::new()),
        };

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(config.timeout_sec.max(1)))
            .build()
            .map_err(|e| CoreError::PluginError(format!("Failed to build HTTP client: {e}")))?;

        let response = client
            .get(self.build_pexels_url(query, asset_type))
            .header("Authorization", api_key)
            .send()
            .await
            .map_err(|e| CoreError::PluginError(format!("Pexels search request failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(CoreError::PluginError(format!(
                "Pexels search failed with status {}: {}",
                status, body
            )));
        }

        let payload = response
            .json::<pexels::SearchResponse>()
            .await
            .map_err(|e| CoreError::PluginError(format!("Failed to parse Pexels response: {e}")))?;

        let results = if asset_type == "video" {
            payload
                .videos
                .unwrap_or_default()
                .into_iter()
                .map(|video| self.pexels_video_to_asset(&video))
                .collect()
        } else {
            payload
                .photos
                .unwrap_or_default()
                .into_iter()
                .map(|photo| self.pexels_photo_to_asset(&photo))
                .collect()
        };

        Ok(results)
    }

    #[cfg(feature = "ai-providers")]
    async fn search_pixabay(
        &self,
        config: &StockMediaConfig,
        query: &PluginSearchQuery,
    ) -> CoreResult<Vec<PluginAssetRef>> {
        let api_key = config.api_key.as_deref().ok_or_else(|| {
            CoreError::PluginError("Pixabay provider requires an API key".to_string())
        })?;
        let asset_type = match query.asset_type.unwrap_or(PluginAssetType::Video) {
            PluginAssetType::Video => "video",
            PluginAssetType::Image => "image",
            _ => return Ok(Vec::new()),
        };

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(config.timeout_sec.max(1)))
            .build()
            .map_err(|e| CoreError::PluginError(format!("Failed to build HTTP client: {e}")))?;

        let response = client
            .get(self.build_pixabay_url(query, asset_type, api_key))
            .send()
            .await
            .map_err(|e| CoreError::PluginError(format!("Pixabay search request failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(CoreError::PluginError(format!(
                "Pixabay search failed with status {}: {}",
                status, body
            )));
        }

        if asset_type == "video" {
            let payload = response
                .json::<pixabay::VideoSearchResponse>()
                .await
                .map_err(|e| {
                    CoreError::PluginError(format!("Failed to parse Pixabay video response: {e}"))
                })?;
            Ok(payload
                .hits
                .into_iter()
                .map(|video| self.pixabay_video_to_asset(&video))
                .collect())
        } else {
            let payload = response
                .json::<pixabay::ImageSearchResponse>()
                .await
                .map_err(|e| {
                    CoreError::PluginError(format!("Failed to parse Pixabay image response: {e}"))
                })?;
            Ok(payload
                .hits
                .into_iter()
                .map(|image| self.pixabay_image_to_asset(&image))
                .collect())
        }
    }
}

#[async_trait]
impl AssetProviderPlugin for StockMediaProvider {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        "Stock media provider for provider-referenced images and videos"
    }

    async fn search(&self, query: &PluginSearchQuery) -> CoreResult<Vec<PluginAssetRef>> {
        if query.limit == 0 {
            return Ok(Vec::new());
        }

        if matches!(query.asset_type, Some(asset_type) if !matches!(asset_type, PluginAssetType::Image | PluginAssetType::Video))
        {
            return Ok(Vec::new());
        }

        let config = self.config.read().await.clone();
        let cache_key = Self::cache_key(config.source, query);
        if let Some(cached) = self.cache.read().await.get(&cache_key).cloned() {
            return Ok(cached);
        }

        if !config
            .api_key
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        {
            return Err(CoreError::PluginError(format!(
                "{} provider requires an API key",
                match config.source {
                    StockSource::Pexels => "Pexels",
                    StockSource::Pixabay => "Pixabay",
                }
            )));
        }

        #[cfg(not(feature = "ai-providers"))]
        {
            let _ = query;
            return Err(CoreError::PluginError(
                "Stock media provider requires the ai-providers feature".to_string(),
            ));
        }

        #[cfg(feature = "ai-providers")]
        {
            let mut results = match config.source {
                StockSource::Pexels => self.search_pexels(&config, query).await?,
                StockSource::Pixabay => self.search_pixabay(&config, query).await?,
            };

            results.truncate(query.limit);
            self.cache.write().await.insert(cache_key, results.clone());
            Ok(results)
        }
    }

    async fn fetch(&self, _asset_ref: &str) -> CoreResult<PluginFetchedAsset> {
        Err(CoreError::PluginError(
            "Stock media fetch requires an import candidate with a verified download URL"
                .to_string(),
        ))
    }

    async fn categories(&self) -> CoreResult<Vec<String>> {
        Ok(vec![
            "Nature".to_string(),
            "Business".to_string(),
            "Technology".to_string(),
            "People".to_string(),
            "Food".to_string(),
            "Travel".to_string(),
            "Architecture".to_string(),
            "Sports".to_string(),
            "Music".to_string(),
        ])
    }

    fn is_available(&self) -> bool {
        self.available.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_provider(source: StockSource) -> StockMediaProvider {
        let config = StockMediaConfig {
            api_key: Some("test-api-key".to_string()),
            source,
            ..Default::default()
        };
        StockMediaProvider::new("test-stock-provider", config)
    }

    #[test]
    fn create_provider_reports_availability_from_api_key() {
        let available = create_test_provider(StockSource::Pexels);
        let unavailable = StockMediaProvider::new("test", StockMediaConfig::default());

        assert!(available.is_available());
        assert!(!unavailable.is_available());
    }

    #[tokio::test]
    async fn set_api_key_updates_availability() {
        let provider = StockMediaProvider::new("test", StockMediaConfig::default());
        assert!(!provider.is_available());

        provider.set_api_key("new-key").await;
        assert!(provider.is_available());

        provider.set_api_key("").await;
        assert!(!provider.is_available());
    }

    #[tokio::test]
    async fn search_requires_api_key() {
        let provider = StockMediaProvider::new("test", StockMediaConfig::default());
        let result = provider.search(&PluginSearchQuery::default()).await;

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("API key"));
    }

    #[tokio::test]
    async fn fetch_is_not_mocked() {
        let provider = create_test_provider(StockSource::Pexels);
        let result = provider.fetch("pexels-photo-1").await;

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("verified download URL"));
    }

    #[test]
    fn pexels_license_is_royalty_free() {
        let license = StockMediaProvider::pexels_license();
        assert_eq!(license.source, LicenseSource::StockProvider);
        assert_eq!(license.provider, Some("Pexels".to_string()));
        assert_eq!(license.license_type, LicenseType::RoyaltyFree);
        assert!(license.allowed_use.contains(&"commercial".to_string()));
    }

    #[test]
    fn pixabay_license_is_not_cc0() {
        let license = StockMediaProvider::pixabay_license();
        assert_eq!(license.source, LicenseSource::StockProvider);
        assert_eq!(license.provider, Some("Pixabay".to_string()));
        assert_eq!(license.license_type, LicenseType::RoyaltyFree);
        assert_ne!(license.license_type, LicenseType::Cc0);
    }

    #[test]
    fn build_pexels_video_url_uses_current_v1_endpoint() {
        let provider = create_test_provider(StockSource::Pexels);
        let query = PluginSearchQuery {
            text: Some("sunset street".to_string()),
            limit: 20,
            offset: 0,
            ..Default::default()
        };

        let url = provider.build_pexels_url(&query, "video");
        assert!(url.starts_with("https://api.pexels.com/v1/videos/search?"));
        assert!(url.contains("query=sunset+street"));
        assert!(url.contains("per_page=20"));
        assert!(url.contains("page=1"));
    }

    #[test]
    fn build_pixabay_video_url_includes_key_and_safesearch() {
        let provider = create_test_provider(StockSource::Pixabay);
        let query = PluginSearchQuery {
            text: Some("city skyline".to_string()),
            limit: 2,
            offset: 0,
            ..Default::default()
        };

        let url = provider.build_pixabay_url(&query, "video", "px-key");
        assert!(url.starts_with("https://pixabay.com/api/videos/?"));
        assert!(url.contains("key=px-key"));
        assert!(url.contains("q=city+skyline"));
        assert!(url.contains("per_page=3"));
        assert!(url.contains("safesearch=true"));
    }

    #[test]
    fn url_encode_special_chars_and_unicode() {
        assert_eq!(StockMediaProvider::url_encode("a&b=c"), "a%26b%3Dc");
        assert_eq!(StockMediaProvider::url_encode("rainy city"), "rainy+city");
        assert_eq!(
            StockMediaProvider::url_encode("고양이"),
            "%EA%B3%A0%EC%96%91%EC%9D%B4"
        );
    }

    #[test]
    fn pexels_photo_mapping_includes_license_metadata() {
        let provider = create_test_provider(StockSource::Pexels);
        let asset = provider.pexels_photo_to_asset(&pexels::Photo {
            id: 10,
            width: 1920,
            height: 1080,
            url: "https://www.pexels.com/photo/10".to_string(),
            photographer: "Creator".to_string(),
            photographer_url: "https://www.pexels.com/@creator".to_string(),
            src: pexels::PhotoSrc {
                original: "https://cdn/original.jpg".to_string(),
                large2x: "https://cdn/large2x.jpg".to_string(),
                large: "https://cdn/large.jpg".to_string(),
                medium: "https://cdn/medium.jpg".to_string(),
                small: "https://cdn/small.jpg".to_string(),
            },
            alt: Some("Rainy street".to_string()),
        });

        assert_eq!(asset.id, "pexels-photo-10");
        assert_eq!(asset.metadata["provider"], "pexels");
        assert_eq!(asset.metadata["license"]["licenseName"], "Pexels License");
    }

    #[test]
    fn pixabay_tags_are_normalized() {
        assert_eq!(
            StockMediaProvider::pixabay_tags("city, skyline, night"),
            vec!["city", "skyline", "night"]
        );
    }
}
