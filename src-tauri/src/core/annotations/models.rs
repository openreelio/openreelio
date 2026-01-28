//! Annotation Data Models
//!
//! Defines unified annotation schema for video analysis results.
//! All types are exported to TypeScript via tauri-specta.

use serde::{Deserialize, Serialize};
use specta::Type;

// =============================================================================
// Analysis Types
// =============================================================================

/// Types of analysis that can be performed on an asset
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AnalysisType {
    /// Shot/scene boundary detection
    Shots,
    /// Speech-to-text transcription
    Transcript,
    /// Object detection in frames
    Objects,
    /// Face detection and recognition
    Faces,
    /// Text detection (OCR)
    TextOcr,
}

impl AnalysisType {
    /// Returns all available analysis types
    pub fn all() -> Vec<AnalysisType> {
        vec![
            AnalysisType::Shots,
            AnalysisType::Transcript,
            AnalysisType::Objects,
            AnalysisType::Faces,
            AnalysisType::TextOcr,
        ]
    }
}

// =============================================================================
// Analysis Provider
// =============================================================================

/// Provider that performed the analysis
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisProvider {
    /// FFmpeg-based local analysis (shots only)
    Ffmpeg,
    /// Whisper-based local transcription (future plugin)
    Whisper,
    /// Google Cloud Video Intelligence / Vision API
    GoogleCloud,
    /// Custom/unknown provider
    Custom(String),
}

impl AnalysisProvider {
    /// Returns true if this is a local (free) provider
    pub fn is_local(&self) -> bool {
        matches!(self, AnalysisProvider::Ffmpeg | AnalysisProvider::Whisper)
    }

    /// Returns true if this is a cloud (paid) provider
    pub fn is_cloud(&self) -> bool {
        matches!(self, AnalysisProvider::GoogleCloud)
    }
}

// =============================================================================
// Analysis Result Wrapper
// =============================================================================

/// Generic wrapper for analysis results of a specific type
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult<T> {
    /// Provider that performed the analysis
    pub provider: AnalysisProvider,
    /// ISO 8601 timestamp when analysis was performed
    pub analyzed_at: String,
    /// Configuration used for analysis
    pub config: serde_json::Value,
    /// Cost in cents (for cloud providers)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_cents: Option<u32>,
    /// Analysis results
    pub results: Vec<T>,
}

impl<T> AnalysisResult<T> {
    /// Creates a new analysis result
    pub fn new(provider: AnalysisProvider, results: Vec<T>) -> Self {
        Self {
            provider,
            analyzed_at: chrono::Utc::now().to_rfc3339(),
            config: serde_json::Value::Object(serde_json::Map::new()),
            cost_cents: None,
            results,
        }
    }

    /// Sets the configuration
    pub fn with_config(mut self, config: serde_json::Value) -> Self {
        self.config = config;
        self
    }

    /// Sets the cost in cents
    pub fn with_cost(mut self, cost_cents: u32) -> Self {
        self.cost_cents = Some(cost_cents);
        self
    }

    /// Returns the number of results
    pub fn len(&self) -> usize {
        self.results.len()
    }

    /// Returns true if there are no results
    pub fn is_empty(&self) -> bool {
        self.results.is_empty()
    }
}

// =============================================================================
// Shot Result
// =============================================================================

/// A detected shot/scene boundary
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShotResult {
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Detection confidence (0.0 - 1.0)
    pub confidence: f64,
    /// Optional keyframe thumbnail path
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keyframe_path: Option<String>,
}

impl ShotResult {
    /// Creates a new shot result
    pub fn new(start_sec: f64, end_sec: f64, confidence: f64) -> Self {
        Self {
            start_sec,
            end_sec,
            confidence,
            keyframe_path: None,
        }
    }

    /// Sets the keyframe path
    pub fn with_keyframe(mut self, path: &str) -> Self {
        self.keyframe_path = Some(path.to_string());
        self
    }

    /// Returns the duration in seconds
    pub fn duration(&self) -> f64 {
        self.end_sec - self.start_sec
    }
}

// =============================================================================
// Transcript Segment
// =============================================================================

/// A transcribed speech segment
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Transcribed text
    pub text: String,
    /// Transcription confidence (0.0 - 1.0)
    pub confidence: f64,
    /// Detected language code (e.g., "en", "ko")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Speaker ID (if speaker diarization is enabled)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker_id: Option<String>,
}

impl TranscriptSegment {
    /// Creates a new transcript segment
    pub fn new(start_sec: f64, end_sec: f64, text: &str, confidence: f64) -> Self {
        Self {
            start_sec,
            end_sec,
            text: text.to_string(),
            confidence,
            language: None,
            speaker_id: None,
        }
    }

    /// Sets the language
    pub fn with_language(mut self, language: &str) -> Self {
        self.language = Some(language.to_string());
        self
    }

    /// Sets the speaker ID
    pub fn with_speaker(mut self, speaker_id: &str) -> Self {
        self.speaker_id = Some(speaker_id.to_string());
        self
    }

    /// Returns the duration in seconds
    pub fn duration(&self) -> f64 {
        self.end_sec - self.start_sec
    }
}

// =============================================================================
// Object Detection
// =============================================================================

/// Bounding box for detected objects
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BoundingBox {
    /// Normalized left coordinate (0.0 - 1.0)
    pub left: f64,
    /// Normalized top coordinate (0.0 - 1.0)
    pub top: f64,
    /// Normalized width (0.0 - 1.0)
    pub width: f64,
    /// Normalized height (0.0 - 1.0)
    pub height: f64,
}

impl BoundingBox {
    /// Creates a new bounding box
    pub fn new(left: f64, top: f64, width: f64, height: f64) -> Self {
        Self {
            left,
            top,
            width,
            height,
        }
    }

    /// Returns the area (0.0 - 1.0)
    pub fn area(&self) -> f64 {
        self.width * self.height
    }

    /// Returns the center point
    pub fn center(&self) -> (f64, f64) {
        (self.left + self.width / 2.0, self.top + self.height / 2.0)
    }
}

/// A detected object in a frame
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDetection {
    /// Time in seconds when object was detected
    pub time_sec: f64,
    /// Object labels/categories
    pub labels: Vec<String>,
    /// Detection confidence (0.0 - 1.0)
    pub confidence: f64,
    /// Bounding box (if available)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounding_box: Option<BoundingBox>,
}

impl ObjectDetection {
    /// Creates a new object detection
    pub fn new(time_sec: f64, labels: Vec<String>, confidence: f64) -> Self {
        Self {
            time_sec,
            labels,
            confidence,
            bounding_box: None,
        }
    }

    /// Sets the bounding box
    pub fn with_bounding_box(mut self, bbox: BoundingBox) -> Self {
        self.bounding_box = Some(bbox);
        self
    }

    /// Returns true if the object has a specific label
    pub fn has_label(&self, label: &str) -> bool {
        self.labels.iter().any(|l| l.eq_ignore_ascii_case(label))
    }
}

// =============================================================================
// Face Detection
// =============================================================================

/// A detected face in a frame
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FaceDetection {
    /// Time in seconds when face was detected
    pub time_sec: f64,
    /// Detection confidence (0.0 - 1.0)
    pub confidence: f64,
    /// Bounding box
    pub bounding_box: BoundingBox,
    /// Detected emotions (if available)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub emotions: Vec<String>,
    /// Face ID for tracking (if available)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub face_id: Option<String>,
}

impl FaceDetection {
    /// Creates a new face detection
    pub fn new(time_sec: f64, confidence: f64, bounding_box: BoundingBox) -> Self {
        Self {
            time_sec,
            confidence,
            bounding_box,
            emotions: Vec::new(),
            face_id: None,
        }
    }

    /// Sets the emotions
    pub fn with_emotions(mut self, emotions: Vec<String>) -> Self {
        self.emotions = emotions;
        self
    }

    /// Sets the face ID
    pub fn with_face_id(mut self, face_id: &str) -> Self {
        self.face_id = Some(face_id.to_string());
        self
    }
}

// =============================================================================
// Text Detection (OCR)
// =============================================================================

/// Detected text in a frame
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextDetection {
    /// Time in seconds when text was detected
    pub time_sec: f64,
    /// Detected text content
    pub text: String,
    /// Detection confidence (0.0 - 1.0)
    pub confidence: f64,
    /// Bounding box
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounding_box: Option<BoundingBox>,
    /// Detected language code
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

impl TextDetection {
    /// Creates a new text detection
    pub fn new(time_sec: f64, text: &str, confidence: f64) -> Self {
        Self {
            time_sec,
            text: text.to_string(),
            confidence,
            bounding_box: None,
            language: None,
        }
    }

    /// Sets the bounding box
    pub fn with_bounding_box(mut self, bbox: BoundingBox) -> Self {
        self.bounding_box = Some(bbox);
        self
    }

    /// Sets the language
    pub fn with_language(mut self, language: &str) -> Self {
        self.language = Some(language.to_string());
        self
    }
}

// =============================================================================
// Analysis Results Container
// =============================================================================

/// Container for all analysis results for an asset
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResults {
    /// Shot/scene detection results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shots: Option<AnalysisResult<ShotResult>>,
    /// Transcription results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript: Option<AnalysisResult<TranscriptSegment>>,
    /// Object detection results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objects: Option<AnalysisResult<ObjectDetection>>,
    /// Face detection results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub faces: Option<AnalysisResult<FaceDetection>>,
    /// Text detection (OCR) results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_ocr: Option<AnalysisResult<TextDetection>>,
}

impl AnalysisResults {
    /// Creates a new empty analysis results container
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns the types of analysis that have been performed
    pub fn available_types(&self) -> Vec<AnalysisType> {
        let mut types = Vec::new();
        if self.shots.is_some() {
            types.push(AnalysisType::Shots);
        }
        if self.transcript.is_some() {
            types.push(AnalysisType::Transcript);
        }
        if self.objects.is_some() {
            types.push(AnalysisType::Objects);
        }
        if self.faces.is_some() {
            types.push(AnalysisType::Faces);
        }
        if self.text_ocr.is_some() {
            types.push(AnalysisType::TextOcr);
        }
        types
    }

    /// Returns total cost in cents for all cloud analyses
    pub fn total_cost_cents(&self) -> u32 {
        let mut total = 0u32;
        if let Some(ref shots) = self.shots {
            total += shots.cost_cents.unwrap_or(0);
        }
        if let Some(ref transcript) = self.transcript {
            total += transcript.cost_cents.unwrap_or(0);
        }
        if let Some(ref objects) = self.objects {
            total += objects.cost_cents.unwrap_or(0);
        }
        if let Some(ref faces) = self.faces {
            total += faces.cost_cents.unwrap_or(0);
        }
        if let Some(ref text_ocr) = self.text_ocr {
            total += text_ocr.cost_cents.unwrap_or(0);
        }
        total
    }

    /// Returns true if any analysis has been performed
    pub fn has_any(&self) -> bool {
        self.shots.is_some()
            || self.transcript.is_some()
            || self.objects.is_some()
            || self.faces.is_some()
            || self.text_ocr.is_some()
    }
}

// =============================================================================
// Asset Annotation
// =============================================================================

/// Schema version for annotation files
pub const ANNOTATION_SCHEMA_VERSION: &str = "1.0";

/// Complete annotation data for an asset
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssetAnnotation {
    /// Schema version
    pub version: String,
    /// Asset ID this annotation belongs to
    pub asset_id: String,
    /// SHA256 hash of the asset file (for staleness detection)
    pub asset_hash: String,
    /// ISO 8601 timestamp when annotation was created
    pub created_at: String,
    /// ISO 8601 timestamp when annotation was last updated
    pub updated_at: String,
    /// Analysis results
    pub analysis: AnalysisResults,
}

impl AssetAnnotation {
    /// Creates a new annotation for an asset
    pub fn new(asset_id: &str, asset_hash: &str) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            version: ANNOTATION_SCHEMA_VERSION.to_string(),
            asset_id: asset_id.to_string(),
            asset_hash: asset_hash.to_string(),
            created_at: now.clone(),
            updated_at: now,
            analysis: AnalysisResults::new(),
        }
    }

    /// Updates the timestamp
    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }

    /// Checks if the annotation is stale (asset hash changed)
    pub fn is_stale(&self, current_hash: &str) -> bool {
        self.asset_hash != current_hash
    }

    /// Sets shot results
    pub fn set_shots(&mut self, result: AnalysisResult<ShotResult>) {
        self.analysis.shots = Some(result);
        self.touch();
    }

    /// Sets transcript results
    pub fn set_transcript(&mut self, result: AnalysisResult<TranscriptSegment>) {
        self.analysis.transcript = Some(result);
        self.touch();
    }

    /// Sets object detection results
    pub fn set_objects(&mut self, result: AnalysisResult<ObjectDetection>) {
        self.analysis.objects = Some(result);
        self.touch();
    }

    /// Sets face detection results
    pub fn set_faces(&mut self, result: AnalysisResult<FaceDetection>) {
        self.analysis.faces = Some(result);
        self.touch();
    }

    /// Sets text detection results
    pub fn set_text_ocr(&mut self, result: AnalysisResult<TextDetection>) {
        self.analysis.text_ocr = Some(result);
        self.touch();
    }
}

// =============================================================================
// Cost Estimate
// =============================================================================

/// Cost estimate for analysis
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CostEstimate {
    /// Provider for the estimate
    pub provider: AnalysisProvider,
    /// Requested analysis types
    pub analysis_types: Vec<AnalysisType>,
    /// Estimated cost in cents
    pub estimated_cost_cents: u32,
    /// Asset duration in seconds (for reference)
    pub asset_duration_sec: f64,
    /// Breakdown by analysis type
    pub breakdown: Vec<CostBreakdownItem>,
}

/// Cost breakdown for a single analysis type
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CostBreakdownItem {
    /// Analysis type
    pub analysis_type: AnalysisType,
    /// Estimated cost in cents
    pub cost_cents: u32,
    /// Rate description (e.g., "$0.05/min")
    pub rate_description: String,
}

// =============================================================================
// Analysis Status
// =============================================================================

/// Status of analysis for an asset
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AnalysisStatus {
    /// No analysis has been performed
    NotAnalyzed,
    /// Analysis is in progress
    InProgress,
    /// Analysis completed successfully
    Completed,
    /// Analysis is stale (asset changed)
    Stale,
    /// Analysis failed
    Failed,
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // AnalysisType Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_analysis_type_serialization() {
        let cases = vec![
            (AnalysisType::Shots, "\"shots\""),
            (AnalysisType::Transcript, "\"transcript\""),
            (AnalysisType::Objects, "\"objects\""),
            (AnalysisType::Faces, "\"faces\""),
            (AnalysisType::TextOcr, "\"textOcr\""),
        ];

        for (analysis_type, expected) in cases {
            let json = serde_json::to_string(&analysis_type).unwrap();
            assert_eq!(json, expected, "AnalysisType::{:?}", analysis_type);
        }
    }

    #[test]
    fn test_analysis_type_deserialization() {
        let shots: AnalysisType = serde_json::from_str("\"shots\"").unwrap();
        assert_eq!(shots, AnalysisType::Shots);

        let text_ocr: AnalysisType = serde_json::from_str("\"textOcr\"").unwrap();
        assert_eq!(text_ocr, AnalysisType::TextOcr);
    }

    #[test]
    fn test_analysis_type_all() {
        let all = AnalysisType::all();
        assert_eq!(all.len(), 5);
        assert!(all.contains(&AnalysisType::Shots));
        assert!(all.contains(&AnalysisType::Transcript));
        assert!(all.contains(&AnalysisType::Objects));
        assert!(all.contains(&AnalysisType::Faces));
        assert!(all.contains(&AnalysisType::TextOcr));
    }

    // -------------------------------------------------------------------------
    // AnalysisProvider Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_analysis_provider_serialization() {
        let cases = vec![
            (AnalysisProvider::Ffmpeg, "\"ffmpeg\""),
            (AnalysisProvider::Whisper, "\"whisper\""),
            (AnalysisProvider::GoogleCloud, "\"google_cloud\""),
        ];

        for (provider, expected) in cases {
            let json = serde_json::to_string(&provider).unwrap();
            assert_eq!(json, expected, "AnalysisProvider::{:?}", provider);
        }
    }

    #[test]
    fn test_analysis_provider_custom() {
        let custom = AnalysisProvider::Custom("my_provider".to_string());
        let json = serde_json::to_string(&custom).unwrap();
        assert_eq!(json, r#"{"custom":"my_provider"}"#);

        let parsed: AnalysisProvider = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, custom);
    }

    #[test]
    fn test_analysis_provider_is_local() {
        assert!(AnalysisProvider::Ffmpeg.is_local());
        assert!(AnalysisProvider::Whisper.is_local());
        assert!(!AnalysisProvider::GoogleCloud.is_local());
        assert!(!AnalysisProvider::Custom("test".to_string()).is_local());
    }

    #[test]
    fn test_analysis_provider_is_cloud() {
        assert!(!AnalysisProvider::Ffmpeg.is_cloud());
        assert!(!AnalysisProvider::Whisper.is_cloud());
        assert!(AnalysisProvider::GoogleCloud.is_cloud());
        assert!(!AnalysisProvider::Custom("test".to_string()).is_cloud());
    }

    // -------------------------------------------------------------------------
    // ShotResult Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_shot_result_creation() {
        let shot = ShotResult::new(0.0, 5.0, 0.85);
        assert_eq!(shot.start_sec, 0.0);
        assert_eq!(shot.end_sec, 5.0);
        assert_eq!(shot.confidence, 0.85);
        assert!(shot.keyframe_path.is_none());
    }

    #[test]
    fn test_shot_result_with_keyframe() {
        let shot = ShotResult::new(0.0, 5.0, 0.85).with_keyframe("/path/to/keyframe.jpg");
        assert_eq!(
            shot.keyframe_path,
            Some("/path/to/keyframe.jpg".to_string())
        );
    }

    #[test]
    fn test_shot_result_duration() {
        let shot = ShotResult::new(2.5, 7.5, 0.9);
        assert_eq!(shot.duration(), 5.0);
    }

    #[test]
    fn test_shot_result_serialization() {
        let shot = ShotResult::new(0.0, 5.0, 0.85);
        let json = serde_json::to_string(&shot).unwrap();
        assert!(json.contains("\"startSec\":0.0"));
        assert!(json.contains("\"endSec\":5.0"));
        assert!(json.contains("\"confidence\":0.85"));

        let parsed: ShotResult = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, shot);
    }

    // -------------------------------------------------------------------------
    // TranscriptSegment Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_transcript_segment_creation() {
        let segment = TranscriptSegment::new(0.0, 2.5, "Hello world", 0.95);
        assert_eq!(segment.start_sec, 0.0);
        assert_eq!(segment.end_sec, 2.5);
        assert_eq!(segment.text, "Hello world");
        assert_eq!(segment.confidence, 0.95);
        assert!(segment.language.is_none());
        assert!(segment.speaker_id.is_none());
    }

    #[test]
    fn test_transcript_segment_with_metadata() {
        let segment = TranscriptSegment::new(0.0, 2.5, "Hello", 0.95)
            .with_language("en")
            .with_speaker("speaker_1");
        assert_eq!(segment.language, Some("en".to_string()));
        assert_eq!(segment.speaker_id, Some("speaker_1".to_string()));
    }

    #[test]
    fn test_transcript_segment_duration() {
        let segment = TranscriptSegment::new(1.0, 4.0, "Test", 0.9);
        assert_eq!(segment.duration(), 3.0);
    }

    // -------------------------------------------------------------------------
    // BoundingBox Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_bounding_box_creation() {
        let bbox = BoundingBox::new(0.1, 0.2, 0.3, 0.4);
        assert_eq!(bbox.left, 0.1);
        assert_eq!(bbox.top, 0.2);
        assert_eq!(bbox.width, 0.3);
        assert_eq!(bbox.height, 0.4);
    }

    #[test]
    fn test_bounding_box_area() {
        let bbox = BoundingBox::new(0.0, 0.0, 0.5, 0.5);
        assert_eq!(bbox.area(), 0.25);
    }

    #[test]
    fn test_bounding_box_center() {
        let bbox = BoundingBox::new(0.0, 0.0, 1.0, 1.0);
        assert_eq!(bbox.center(), (0.5, 0.5));
    }

    // -------------------------------------------------------------------------
    // ObjectDetection Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_object_detection_creation() {
        let obj =
            ObjectDetection::new(1.5, vec!["person".to_string(), "outdoor".to_string()], 0.92);
        assert_eq!(obj.time_sec, 1.5);
        assert_eq!(obj.labels.len(), 2);
        assert_eq!(obj.confidence, 0.92);
        assert!(obj.bounding_box.is_none());
    }

    #[test]
    fn test_object_detection_has_label() {
        let obj =
            ObjectDetection::new(1.5, vec!["Person".to_string(), "Outdoor".to_string()], 0.92);
        assert!(obj.has_label("person"));
        assert!(obj.has_label("OUTDOOR"));
        assert!(!obj.has_label("car"));
    }

    #[test]
    fn test_object_detection_with_bbox() {
        let bbox = BoundingBox::new(0.1, 0.2, 0.3, 0.4);
        let obj = ObjectDetection::new(1.5, vec!["person".to_string()], 0.92)
            .with_bounding_box(bbox.clone());
        assert_eq!(obj.bounding_box, Some(bbox));
    }

    // -------------------------------------------------------------------------
    // FaceDetection Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_face_detection_creation() {
        let bbox = BoundingBox::new(0.1, 0.1, 0.2, 0.2);
        let face = FaceDetection::new(2.0, 0.95, bbox);
        assert_eq!(face.time_sec, 2.0);
        assert_eq!(face.confidence, 0.95);
        assert!(face.emotions.is_empty());
        assert!(face.face_id.is_none());
    }

    #[test]
    fn test_face_detection_with_emotions() {
        let bbox = BoundingBox::new(0.1, 0.1, 0.2, 0.2);
        let face = FaceDetection::new(2.0, 0.95, bbox)
            .with_emotions(vec!["happy".to_string(), "surprised".to_string()]);
        assert_eq!(face.emotions.len(), 2);
    }

    // -------------------------------------------------------------------------
    // TextDetection Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_text_detection_creation() {
        let text = TextDetection::new(3.0, "Hello World", 0.98);
        assert_eq!(text.time_sec, 3.0);
        assert_eq!(text.text, "Hello World");
        assert_eq!(text.confidence, 0.98);
    }

    #[test]
    fn test_text_detection_with_metadata() {
        let bbox = BoundingBox::new(0.1, 0.1, 0.3, 0.1);
        let text = TextDetection::new(3.0, "Hello", 0.98)
            .with_bounding_box(bbox)
            .with_language("en");
        assert!(text.bounding_box.is_some());
        assert_eq!(text.language, Some("en".to_string()));
    }

    // -------------------------------------------------------------------------
    // AnalysisResult Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_analysis_result_creation() {
        let shots = vec![
            ShotResult::new(0.0, 5.0, 0.9),
            ShotResult::new(5.0, 10.0, 0.85),
        ];
        let result = AnalysisResult::new(AnalysisProvider::Ffmpeg, shots);
        assert_eq!(result.provider, AnalysisProvider::Ffmpeg);
        assert_eq!(result.len(), 2);
        assert!(!result.is_empty());
        assert!(result.cost_cents.is_none());
    }

    #[test]
    fn test_analysis_result_with_cost() {
        let result = AnalysisResult::new(
            AnalysisProvider::GoogleCloud,
            vec![ShotResult::new(0.0, 5.0, 0.9)],
        )
        .with_cost(150);
        assert_eq!(result.cost_cents, Some(150));
    }

    #[test]
    fn test_analysis_result_with_config() {
        let config = serde_json::json!({ "threshold": 0.3 });
        let result = AnalysisResult::new(
            AnalysisProvider::Ffmpeg,
            vec![ShotResult::new(0.0, 5.0, 0.9)],
        )
        .with_config(config.clone());
        assert_eq!(result.config, config);
    }

    // -------------------------------------------------------------------------
    // AnalysisResults Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_analysis_results_default() {
        let results = AnalysisResults::new();
        assert!(results.shots.is_none());
        assert!(results.transcript.is_none());
        assert!(results.objects.is_none());
        assert!(results.faces.is_none());
        assert!(results.text_ocr.is_none());
        assert!(!results.has_any());
    }

    #[test]
    fn test_analysis_results_available_types() {
        let mut results = AnalysisResults::new();
        results.shots = Some(AnalysisResult::new(AnalysisProvider::Ffmpeg, vec![]));
        results.transcript = Some(AnalysisResult::new(AnalysisProvider::Whisper, vec![]));

        let types = results.available_types();
        assert_eq!(types.len(), 2);
        assert!(types.contains(&AnalysisType::Shots));
        assert!(types.contains(&AnalysisType::Transcript));
    }

    #[test]
    fn test_analysis_results_total_cost() {
        let mut results = AnalysisResults::new();
        results.shots =
            Some(AnalysisResult::new(AnalysisProvider::GoogleCloud, vec![]).with_cost(50));
        results.objects =
            Some(AnalysisResult::new(AnalysisProvider::GoogleCloud, vec![]).with_cost(100));
        results.faces =
            Some(AnalysisResult::new(AnalysisProvider::GoogleCloud, vec![]).with_cost(75));

        assert_eq!(results.total_cost_cents(), 225);
    }

    #[test]
    fn test_analysis_results_has_any() {
        let mut results = AnalysisResults::new();
        assert!(!results.has_any());

        results.shots = Some(AnalysisResult::new(AnalysisProvider::Ffmpeg, vec![]));
        assert!(results.has_any());
    }

    // -------------------------------------------------------------------------
    // AssetAnnotation Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_asset_annotation_creation() {
        let annotation = AssetAnnotation::new("asset_001", "sha256:abc123");
        assert_eq!(annotation.version, ANNOTATION_SCHEMA_VERSION);
        assert_eq!(annotation.asset_id, "asset_001");
        assert_eq!(annotation.asset_hash, "sha256:abc123");
        assert!(!annotation.created_at.is_empty());
        assert!(!annotation.updated_at.is_empty());
        assert!(!annotation.analysis.has_any());
    }

    #[test]
    fn test_asset_annotation_is_stale() {
        let annotation = AssetAnnotation::new("asset_001", "sha256:abc123");
        assert!(!annotation.is_stale("sha256:abc123"));
        assert!(annotation.is_stale("sha256:def456"));
    }

    #[test]
    fn test_asset_annotation_set_shots() {
        let mut annotation = AssetAnnotation::new("asset_001", "sha256:abc123");
        let original_updated = annotation.updated_at.clone();

        // Wait a tiny bit to ensure timestamp changes
        std::thread::sleep(std::time::Duration::from_millis(10));

        let shots = AnalysisResult::new(
            AnalysisProvider::Ffmpeg,
            vec![ShotResult::new(0.0, 5.0, 0.9)],
        );
        annotation.set_shots(shots);

        assert!(annotation.analysis.shots.is_some());
        assert_ne!(annotation.updated_at, original_updated);
    }

    #[test]
    fn test_asset_annotation_serialization() {
        let mut annotation = AssetAnnotation::new("asset_001", "sha256:abc123");
        annotation.set_shots(AnalysisResult::new(
            AnalysisProvider::Ffmpeg,
            vec![ShotResult::new(0.0, 5.0, 0.9)],
        ));

        let json = serde_json::to_string(&annotation).unwrap();
        assert!(json.contains("\"version\":\"1.0\""));
        assert!(json.contains("\"assetId\":\"asset_001\""));
        assert!(json.contains("\"assetHash\":\"sha256:abc123\""));

        let parsed: AssetAnnotation = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.asset_id, annotation.asset_id);
        assert_eq!(parsed.asset_hash, annotation.asset_hash);
        assert!(parsed.analysis.shots.is_some());
    }

    #[test]
    fn test_asset_annotation_full_roundtrip() {
        let mut annotation = AssetAnnotation::new("asset_001", "sha256:abc123");

        // Add all analysis types
        annotation.set_shots(AnalysisResult::new(
            AnalysisProvider::Ffmpeg,
            vec![ShotResult::new(0.0, 5.0, 0.9)],
        ));
        annotation.set_transcript(AnalysisResult::new(
            AnalysisProvider::Whisper,
            vec![TranscriptSegment::new(0.0, 2.5, "Hello", 0.95)],
        ));
        annotation.set_objects(
            AnalysisResult::new(
                AnalysisProvider::GoogleCloud,
                vec![ObjectDetection::new(1.0, vec!["person".to_string()], 0.92)],
            )
            .with_cost(100),
        );

        let json = serde_json::to_string_pretty(&annotation).unwrap();
        let parsed: AssetAnnotation = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.analysis.available_types().len(), 3);
        assert_eq!(parsed.analysis.total_cost_cents(), 100);
    }

    // -------------------------------------------------------------------------
    // CostEstimate Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_cost_estimate_serialization() {
        let estimate = CostEstimate {
            provider: AnalysisProvider::GoogleCloud,
            analysis_types: vec![AnalysisType::Shots, AnalysisType::Objects],
            estimated_cost_cents: 150,
            asset_duration_sec: 60.0,
            breakdown: vec![
                CostBreakdownItem {
                    analysis_type: AnalysisType::Shots,
                    cost_cents: 50,
                    rate_description: "$0.05/min".to_string(),
                },
                CostBreakdownItem {
                    analysis_type: AnalysisType::Objects,
                    cost_cents: 100,
                    rate_description: "$0.10/min".to_string(),
                },
            ],
        };

        let json = serde_json::to_string(&estimate).unwrap();
        let parsed: CostEstimate = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.estimated_cost_cents, 150);
        assert_eq!(parsed.breakdown.len(), 2);
    }

    // -------------------------------------------------------------------------
    // AnalysisStatus Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_analysis_status_serialization() {
        let cases = vec![
            (AnalysisStatus::NotAnalyzed, "\"notAnalyzed\""),
            (AnalysisStatus::InProgress, "\"inProgress\""),
            (AnalysisStatus::Completed, "\"completed\""),
            (AnalysisStatus::Stale, "\"stale\""),
            (AnalysisStatus::Failed, "\"failed\""),
        ];

        for (status, expected) in cases {
            let json = serde_json::to_string(&status).unwrap();
            assert_eq!(json, expected, "AnalysisStatus::{:?}", status);
        }
    }
}
