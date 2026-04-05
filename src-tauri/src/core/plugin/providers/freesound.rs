//! Freesound Provider
//!
//! Built-in provider for real external sound-effect retrieval via the Freesound API.

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

#[allow(dead_code)]
const FREESOUND_API_BASE: &str = "https://freesound.org/apiv2";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FreesoundConfig {
    pub api_key: Option<String>,
    pub timeout_sec: u64,
}

impl Default for FreesoundConfig {
    fn default() -> Self {
        Self {
            api_key: None,
            timeout_sec: 30,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
struct FreesoundSearchResponse {
    results: Vec<FreesoundSound>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
struct FreesoundSound {
    id: u64,
    name: String,
    tags: Vec<String>,
    duration: Option<f64>,
    license: Option<String>,
    username: Option<String>,
    url: Option<String>,
    previews: Option<FreesoundPreviews>,
    images: Option<FreesoundImages>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
struct FreesoundPreviews {
    #[serde(rename = "preview-hq-mp3")]
    preview_hq_mp3: Option<String>,
    #[serde(rename = "preview-lq-mp3")]
    preview_lq_mp3: Option<String>,
    #[serde(rename = "preview-hq-ogg")]
    preview_hq_ogg: Option<String>,
    #[serde(rename = "preview-lq-ogg")]
    preview_lq_ogg: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
struct FreesoundImages {
    waveform_m: Option<String>,
    waveform_l: Option<String>,
    spectral_m: Option<String>,
    spectral_l: Option<String>,
}

#[derive(Debug)]
pub struct FreesoundProvider {
    name: String,
    config: Arc<RwLock<FreesoundConfig>>,
    cache: Arc<RwLock<std::collections::HashMap<String, Vec<PluginAssetRef>>>>,
    available: Arc<AtomicBool>,
}

impl FreesoundProvider {
    pub fn new(name: &str, config: FreesoundConfig) -> Self {
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

    #[allow(dead_code)]
    fn freesound_license(raw_license: Option<&str>) -> LicenseInfo {
        let normalized = raw_license.unwrap_or_default().to_lowercase();
        let license_type = if normalized.contains("cc0") {
            LicenseType::Cc0
        } else if normalized.contains("sampling+") {
            LicenseType::Custom
        } else {
            LicenseType::CcBy
        };

        LicenseInfo {
            source: LicenseSource::StockProvider,
            provider: Some("Freesound".to_string()),
            license_type,
            proof_path: None,
            allowed_use: vec!["reference".to_string(), "preview".to_string()],
            expires_at: None,
        }
    }

    #[allow(dead_code)]
    fn preview_url(previews: Option<&FreesoundPreviews>) -> Option<String> {
        previews.and_then(|value| {
            value
                .preview_hq_mp3
                .clone()
                .or_else(|| value.preview_lq_mp3.clone())
                .or_else(|| value.preview_hq_ogg.clone())
                .or_else(|| value.preview_lq_ogg.clone())
        })
    }

    #[allow(dead_code)]
    fn thumbnail_url(images: Option<&FreesoundImages>) -> Option<String> {
        images.and_then(|value| {
            value
                .waveform_m
                .clone()
                .or_else(|| value.waveform_l.clone())
                .or_else(|| value.spectral_m.clone())
                .or_else(|| value.spectral_l.clone())
        })
    }

    #[allow(dead_code)]
    fn sound_to_asset(sound: &FreesoundSound) -> PluginAssetRef {
        PluginAssetRef {
            id: format!("freesound-{}", sound.id),
            name: sound.name.clone(),
            asset_type: PluginAssetType::Audio,
            thumbnail: Self::thumbnail_url(sound.images.as_ref()),
            duration_sec: sound.duration,
            size_bytes: None,
            tags: sound.tags.clone(),
            metadata: serde_json::json!({
                "provider": "freesound",
                "license": sound.license,
                "creator": sound.username,
                "sourceUrl": sound.url,
                "previewUrl": Self::preview_url(sound.previews.as_ref()),
            }),
        }
    }

    fn cache_key(query: &PluginSearchQuery) -> String {
        format!(
            "{}|{:?}|{:?}|{}|{}|{}",
            query.text.as_deref().unwrap_or(""),
            query.asset_type,
            query.duration_range,
            query.limit,
            query.offset,
            query.tags.join(",")
        )
    }

    #[allow(dead_code)]
    fn matches_query(sound: &FreesoundSound, query: &PluginSearchQuery) -> bool {
        if query
            .asset_type
            .map(|asset_type| asset_type == PluginAssetType::Audio)
            .unwrap_or(true)
            == false
        {
            return false;
        }

        if !query.tags.is_empty() {
            let tags = sound
                .tags
                .iter()
                .map(|tag| tag.to_lowercase())
                .collect::<Vec<_>>();
            if !query
                .tags
                .iter()
                .all(|required| tags.contains(&required.to_lowercase()))
            {
                return false;
            }
        }

        if let Some((min_sec, max_sec)) = query.duration_range {
            match sound.duration {
                Some(duration) if duration >= min_sec && duration <= max_sec => {}
                _ => return false,
            }
        }

        true
    }

    fn parse_sound_id(asset_ref: &str) -> Option<u64> {
        asset_ref
            .strip_prefix("freesound-")
            .unwrap_or(asset_ref)
            .parse::<u64>()
            .ok()
    }
}

#[async_trait]
impl AssetProviderPlugin for FreesoundProvider {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        "External sound-effect search provider backed by Freesound"
    }

    async fn search(&self, query: &PluginSearchQuery) -> CoreResult<Vec<PluginAssetRef>> {
        if query.limit == 0 {
            return Ok(Vec::new());
        }

        if matches!(query.asset_type, Some(asset_type) if asset_type != PluginAssetType::Audio) {
            return Ok(Vec::new());
        }

        let cache_key = Self::cache_key(query);
        if let Some(cached) = self.cache.read().await.get(&cache_key).cloned() {
            return Ok(cached);
        }

        let config = self.config.read().await;
        let api_key = config.api_key.clone().ok_or_else(|| {
            CoreError::PluginError("Freesound provider requires an API key".to_string())
        })?;

        #[cfg(not(feature = "ai-providers"))]
        {
            let _ = (api_key, query);
            return Err(CoreError::PluginError(
                "Freesound provider requires the ai-providers feature".to_string(),
            ));
        }

        #[cfg(feature = "ai-providers")]
        {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(config.timeout_sec.max(1)))
                .build()
                .map_err(|e| CoreError::PluginError(format!("Failed to build HTTP client: {e}")))?;

            let text = query
                .text
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("sound effect");
            let requires_local_filtering = !query.tags.is_empty() || query.duration_range.is_some();
            let page_size = if requires_local_filtering {
                50
            } else {
                query.limit.clamp(1, 50)
            };
            let mut page = if requires_local_filtering {
                1
            } else {
                (query.offset / page_size) + 1
            };
            let mut intra_page_skip = if requires_local_filtering {
                0
            } else {
                query.offset % page_size
            };
            let required_results = if requires_local_filtering {
                query.offset.saturating_add(query.limit)
            } else {
                query.limit
            };
            let mut filtered_results = Vec::new();

            loop {
                let response = client
                    .get(format!("{}/search/text/", FREESOUND_API_BASE))
                    .header("Authorization", format!("Token {}", api_key))
                    .query(&[
                        ("query", text.to_string()),
                        ("page_size", page_size.to_string()),
                        ("page", page.to_string()),
                    ])
                    .send()
                    .await
                    .map_err(|e| {
                        CoreError::PluginError(format!("Freesound search request failed: {e}"))
                    })?;

                if !response.status().is_success() {
                    let status = response.status();
                    let body = response.text().await.unwrap_or_default();
                    return Err(CoreError::PluginError(format!(
                        "Freesound search failed with status {}: {}",
                        status, body
                    )));
                }

                let payload = response
                    .json::<FreesoundSearchResponse>()
                    .await
                    .map_err(|e| {
                        CoreError::PluginError(format!("Failed to parse Freesound response: {e}"))
                    })?;

                if payload.results.is_empty() {
                    break;
                }

                let page_result_count = payload.results.len();
                let mut page_results = payload.results;
                if intra_page_skip > 0 {
                    let skip_count = intra_page_skip.min(page_results.len());
                    page_results.drain(..skip_count);
                    intra_page_skip -= skip_count;
                }

                for sound in page_results {
                    if Self::matches_query(&sound, query) {
                        filtered_results.push(Self::sound_to_asset(&sound));
                        if filtered_results.len() >= required_results {
                            break;
                        }
                    }
                }

                if filtered_results.len() >= required_results || page_result_count < page_size {
                    break;
                }

                page += 1;
            }

            let results = if requires_local_filtering {
                filtered_results
                    .into_iter()
                    .skip(query.offset)
                    .take(query.limit)
                    .collect::<Vec<_>>()
            } else {
                filtered_results
                    .into_iter()
                    .take(query.limit)
                    .collect::<Vec<_>>()
            };

            self.cache.write().await.insert(cache_key, results.clone());
            Ok(results)
        }
    }

    async fn fetch(&self, asset_ref: &str) -> CoreResult<PluginFetchedAsset> {
        let config = self.config.read().await;
        let api_key = config.api_key.clone().ok_or_else(|| {
            CoreError::PluginError("Freesound provider requires an API key".to_string())
        })?;
        let sound_id = Self::parse_sound_id(asset_ref).ok_or_else(|| {
            CoreError::PluginError(format!("Invalid Freesound asset ref: {}", asset_ref))
        })?;

        #[cfg(not(feature = "ai-providers"))]
        {
            let _ = (api_key, sound_id);
            return Err(CoreError::PluginError(
                "Freesound provider requires the ai-providers feature".to_string(),
            ));
        }

        #[cfg(feature = "ai-providers")]
        {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(config.timeout_sec.max(1)))
                .build()
                .map_err(|e| CoreError::PluginError(format!("Failed to build HTTP client: {e}")))?;

            let detail = client
                .get(format!("{}/sounds/{}/", FREESOUND_API_BASE, sound_id))
                .header("Authorization", format!("Token {}", api_key))
                .send()
                .await
                .map_err(|e| {
                    CoreError::PluginError(format!("Freesound detail request failed: {e}"))
                })?;

            if !detail.status().is_success() {
                let status = detail.status();
                let body = detail.text().await.unwrap_or_default();
                return Err(CoreError::PluginError(format!(
                    "Freesound detail request failed with status {}: {}",
                    status, body
                )));
            }

            let sound = detail.json::<FreesoundSound>().await.map_err(|e| {
                CoreError::PluginError(format!("Failed to parse Freesound detail: {e}"))
            })?;
            let preview_url = Self::preview_url(sound.previews.as_ref()).ok_or_else(|| {
                CoreError::PluginError("Freesound sound does not include a preview URL".to_string())
            })?;
            let mime_type = if preview_url.ends_with(".ogg") {
                "audio/ogg"
            } else {
                "audio/mpeg"
            };

            let response = client.get(preview_url.clone()).send().await.map_err(|e| {
                CoreError::PluginError(format!("Freesound preview download failed: {e}"))
            })?;

            if !response.status().is_success() {
                return Err(CoreError::PluginError(format!(
                    "Freesound preview download failed with status {}",
                    response.status()
                )));
            }

            let data = response.bytes().await.map_err(|e| {
                CoreError::PluginError(format!("Failed to read Freesound preview bytes: {e}"))
            })?;

            Ok(PluginFetchedAsset {
                data: data.to_vec(),
                mime_type: mime_type.to_string(),
                license: Self::freesound_license(sound.license.as_deref()),
                filename: Some(format!(
                    "{}.{}",
                    sound.name,
                    if mime_type == "audio/ogg" {
                        "ogg"
                    } else {
                        "mp3"
                    }
                )),
            })
        }
    }

    async fn categories(&self) -> CoreResult<Vec<String>> {
        Ok(vec![
            "SFX".to_string(),
            "Ambient".to_string(),
            "Impacts".to_string(),
            "Transitions".to_string(),
            "Foley".to_string(),
            "Nature".to_string(),
            "UI".to_string(),
        ])
    }

    fn is_available(&self) -> bool {
        self.available.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_provider_reports_availability_from_api_key() {
        let available = FreesoundProvider::new(
            "freesound",
            FreesoundConfig {
                api_key: Some("test-key".to_string()),
                timeout_sec: 30,
            },
        );
        let unavailable = FreesoundProvider::new("freesound", FreesoundConfig::default());

        assert!(available.is_available());
        assert!(!unavailable.is_available());
    }

    #[test]
    fn sound_to_asset_maps_preview_and_license_metadata() {
        let asset = FreesoundProvider::sound_to_asset(&FreesoundSound {
            id: 42,
            name: "Door Slam".to_string(),
            tags: vec!["door".to_string(), "slam".to_string()],
            duration: Some(1.2),
            license: Some("Creative Commons 0".to_string()),
            username: Some("creator".to_string()),
            url: Some("https://freesound.org/s/42".to_string()),
            previews: Some(FreesoundPreviews {
                preview_hq_mp3: Some("https://cdn.example/hq.mp3".to_string()),
                preview_lq_mp3: None,
                preview_hq_ogg: None,
                preview_lq_ogg: None,
            }),
            images: Some(FreesoundImages {
                waveform_m: Some("https://cdn.example/waveform.png".to_string()),
                waveform_l: None,
                spectral_m: None,
                spectral_l: None,
            }),
        });

        assert_eq!(asset.id, "freesound-42");
        assert_eq!(asset.asset_type, PluginAssetType::Audio);
        assert_eq!(
            asset.thumbnail,
            Some("https://cdn.example/waveform.png".to_string())
        );
        assert_eq!(asset.metadata["previewUrl"], "https://cdn.example/hq.mp3");
    }

    #[test]
    fn cache_key_should_include_asset_type_and_duration_range() {
        let audio_query = PluginSearchQuery {
            text: Some("whoosh".to_string()),
            asset_type: Some(PluginAssetType::Audio),
            tags: vec!["transition".to_string()],
            duration_range: Some((0.5, 2.0)),
            limit: 10,
            offset: 0,
        };
        let all_query = PluginSearchQuery {
            asset_type: None,
            duration_range: None,
            ..audio_query.clone()
        };

        assert_ne!(
            FreesoundProvider::cache_key(&audio_query),
            FreesoundProvider::cache_key(&all_query)
        );
    }

    #[tokio::test]
    async fn is_available_should_be_safe_in_async_context() {
        let provider = FreesoundProvider::new(
            "freesound",
            FreesoundConfig {
                api_key: Some("async-key".to_string()),
                timeout_sec: 30,
            },
        );

        assert!(provider.is_available());
    }
}
