//! Cost Tracking System for AI Usage
//!
//! Tracks token usage and costs across different AI providers and models.
//! Provides budget management with per-request and monthly limits.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, warn};

use super::provider::TokenUsage;
use crate::core::generative::video::{VideoCostEstimate, VideoQuality};
use crate::core::settings::{AppSettings, ProviderType};

/// Error types for cost tracking operations
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CostError {
    /// Request would exceed per-request limit
    PerRequestLimitExceeded {
        estimated_cost_cents: u32,
        limit_cents: u32,
    },
    /// Monthly budget would be exceeded
    MonthlyBudgetExceeded {
        current_usage_cents: u32,
        estimated_cost_cents: u32,
        budget_cents: u32,
    },
    /// Approaching budget limit (warning, not error)
    ApproachingBudgetLimit {
        usage_percentage: f64,
        current_usage_cents: u32,
        budget_cents: u32,
    },
    /// Unknown model pricing
    UnknownModelPricing {
        provider: ProviderType,
        model: String,
    },
}

impl std::fmt::Display for CostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CostError::PerRequestLimitExceeded {
                estimated_cost_cents,
                limit_cents,
            } => {
                write!(
                    f,
                    "Request cost (${:.2}) exceeds per-request limit (${:.2})",
                    *estimated_cost_cents as f64 / 100.0,
                    *limit_cents as f64 / 100.0
                )
            }
            CostError::MonthlyBudgetExceeded {
                current_usage_cents,
                estimated_cost_cents,
                budget_cents,
            } => {
                write!(
                    f,
                    "Request would exceed monthly budget. Current: ${:.2}, Request: ${:.2}, Budget: ${:.2}",
                    *current_usage_cents as f64 / 100.0,
                    *estimated_cost_cents as f64 / 100.0,
                    *budget_cents as f64 / 100.0
                )
            }
            CostError::ApproachingBudgetLimit {
                usage_percentage,
                current_usage_cents,
                budget_cents,
            } => {
                write!(
                    f,
                    "Approaching budget limit ({:.1}% used). Current: ${:.2}, Budget: ${:.2}",
                    usage_percentage,
                    *current_usage_cents as f64 / 100.0,
                    *budget_cents as f64 / 100.0
                )
            }
            CostError::UnknownModelPricing { provider, model } => {
                write!(
                    f,
                    "Unknown pricing for model '{}' on provider {:?}",
                    model, provider
                )
            }
        }
    }
}

impl std::error::Error for CostError {}

/// Token pricing for a specific model (cents per 1K tokens)
#[derive(Debug, Clone, Copy)]
pub struct ModelPricing {
    /// Cost per 1K input tokens in cents
    pub input_cents_per_1k: f64,
    /// Cost per 1K output tokens in cents
    pub output_cents_per_1k: f64,
}

impl ModelPricing {
    pub const fn new(input_cents_per_1k: f64, output_cents_per_1k: f64) -> Self {
        Self {
            input_cents_per_1k,
            output_cents_per_1k,
        }
    }

    /// Calculate cost in cents for given token usage
    pub fn calculate_cost(&self, usage: &TokenUsage) -> u32 {
        let input_cost = (usage.prompt_tokens as f64 / 1000.0) * self.input_cents_per_1k;
        let output_cost = (usage.completion_tokens as f64 / 1000.0) * self.output_cents_per_1k;
        (input_cost + output_cost).ceil() as u32
    }
}

/// Summary of current usage
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    /// Current month's usage in cents
    pub current_month_usage_cents: u32,
    /// Monthly budget in cents (None = unlimited)
    pub monthly_budget_cents: Option<u32>,
    /// Usage percentage (0-100)
    pub usage_percentage: Option<f64>,
    /// Per-request limit in cents
    pub per_request_limit_cents: u32,
    /// Whether approaching budget limit (>= 80%)
    pub is_approaching_limit: bool,
    /// Whether over budget
    pub is_over_budget: bool,
    /// Current month in YYYYMM format
    pub current_month: u32,
}

/// Cost tracker for AI API usage
pub struct CostTracker {
    settings: Arc<RwLock<AppSettings>>,
    pricing_table: HashMap<(ProviderType, String), ModelPricing>,
}

impl CostTracker {
    /// Create a new cost tracker with the given settings
    pub fn new(settings: Arc<RwLock<AppSettings>>) -> Self {
        let mut tracker = Self {
            settings,
            pricing_table: HashMap::new(),
        };
        tracker.init_pricing_table();
        tracker
    }

    /// Initialize the pricing table with known model prices (Jan 2026)
    fn init_pricing_table(&mut self) {
        // Anthropic models
        self.pricing_table.insert(
            (
                ProviderType::Anthropic,
                "claude-opus-4-5-20251101".to_string(),
            ),
            ModelPricing::new(15.0, 75.0),
        );
        self.pricing_table.insert(
            (
                ProviderType::Anthropic,
                "claude-sonnet-4-5-20251015".to_string(),
            ),
            ModelPricing::new(3.0, 15.0),
        );
        self.pricing_table.insert(
            (
                ProviderType::Anthropic,
                "claude-sonnet-4-20250514".to_string(),
            ),
            ModelPricing::new(3.0, 15.0),
        );
        self.pricing_table.insert(
            (
                ProviderType::Anthropic,
                "claude-haiku-4-5-20250124".to_string(),
            ),
            ModelPricing::new(0.25, 1.25),
        );

        // OpenAI models
        self.pricing_table.insert(
            (ProviderType::OpenAI, "gpt-4o".to_string()),
            ModelPricing::new(2.5, 10.0),
        );
        self.pricing_table.insert(
            (ProviderType::OpenAI, "gpt-4o-mini".to_string()),
            ModelPricing::new(0.15, 0.6),
        );
        self.pricing_table.insert(
            (ProviderType::OpenAI, "gpt-5.2".to_string()),
            ModelPricing::new(5.0, 20.0),
        );
        self.pricing_table.insert(
            (ProviderType::OpenAI, "o1".to_string()),
            ModelPricing::new(15.0, 60.0),
        );
        self.pricing_table.insert(
            (ProviderType::OpenAI, "o1-mini".to_string()),
            ModelPricing::new(3.0, 12.0),
        );

        // Google Gemini models
        self.pricing_table.insert(
            (ProviderType::Gemini, "gemini-2.5-pro".to_string()),
            ModelPricing::new(1.25, 5.0),
        );
        self.pricing_table.insert(
            (ProviderType::Gemini, "gemini-2.5-flash".to_string()),
            ModelPricing::new(0.075, 0.3),
        );
        self.pricing_table.insert(
            (ProviderType::Gemini, "gemini-3-flash-preview".to_string()),
            ModelPricing::new(0.1, 0.4),
        );

        // Local models (free)
        self.pricing_table.insert(
            (ProviderType::Local, "llama3.2".to_string()),
            ModelPricing::new(0.0, 0.0),
        );
        self.pricing_table.insert(
            (ProviderType::Local, "mistral".to_string()),
            ModelPricing::new(0.0, 0.0),
        );
    }

    /// Get pricing for a specific model, with fallback to default pricing
    pub fn get_pricing(&self, provider: ProviderType, model: &str) -> Option<ModelPricing> {
        // Try exact match first
        if let Some(pricing) = self.pricing_table.get(&(provider, model.to_string())) {
            return Some(*pricing);
        }

        // Try prefix match for model variants (e.g., "gpt-4o-2024-01-01" -> "gpt-4o")
        for ((p, m), pricing) in &self.pricing_table {
            if *p == provider && model.starts_with(m) {
                return Some(*pricing);
            }
        }

        // Local models are always free
        if provider == ProviderType::Local {
            return Some(ModelPricing::new(0.0, 0.0));
        }

        None
    }

    /// Calculate cost for a given token usage and model
    pub fn calculate_cost(
        &self,
        provider: ProviderType,
        model: &str,
        usage: &TokenUsage,
    ) -> Result<u32, CostError> {
        match self.get_pricing(provider, model) {
            Some(pricing) => Ok(pricing.calculate_cost(usage)),
            None => Err(CostError::UnknownModelPricing {
                provider,
                model: model.to_string(),
            }),
        }
    }

    /// Check if a request can proceed based on budget constraints
    pub async fn check_budget(&self, estimated_cost_cents: u32) -> Result<(), CostError> {
        let settings = self.settings.read().await;
        let ai_settings = &settings.ai;

        // Check per-request limit
        if estimated_cost_cents > ai_settings.per_request_limit_cents {
            return Err(CostError::PerRequestLimitExceeded {
                estimated_cost_cents,
                limit_cents: ai_settings.per_request_limit_cents,
            });
        }

        // Check monthly budget if set
        if let Some(budget) = ai_settings.monthly_budget_cents {
            let new_total = ai_settings.current_month_usage_cents + estimated_cost_cents;
            if new_total > budget {
                return Err(CostError::MonthlyBudgetExceeded {
                    current_usage_cents: ai_settings.current_month_usage_cents,
                    estimated_cost_cents,
                    budget_cents: budget,
                });
            }
        }

        Ok(())
    }

    /// Record usage after a successful API call
    pub async fn record_usage(
        &self,
        provider: ProviderType,
        model: &str,
        usage: &TokenUsage,
    ) -> Result<u32, CostError> {
        let cost = self.calculate_cost(provider, model, usage)?;

        let mut settings = self.settings.write().await;
        let ai_settings = &mut settings.ai;

        // Check if we need to reset for a new month
        let current_month = Self::get_current_month();
        if ai_settings.current_usage_month != Some(current_month) {
            info!("New month detected, resetting usage counter");
            ai_settings.current_month_usage_cents = 0;
            ai_settings.current_usage_month = Some(current_month);
        }

        // Record the usage
        ai_settings.current_month_usage_cents += cost;

        info!(
            "Recorded AI usage: {} cents (provider: {:?}, model: {}, tokens: {}+{})",
            cost, provider, model, usage.prompt_tokens, usage.completion_tokens
        );

        // Check if approaching limit and warn
        if let Some(budget) = ai_settings.monthly_budget_cents {
            let usage_percentage =
                (ai_settings.current_month_usage_cents as f64 / budget as f64) * 100.0;
            if (80.0..100.0).contains(&usage_percentage) {
                warn!(
                    "Approaching budget limit: {:.1}% used (${:.2} of ${:.2})",
                    usage_percentage,
                    ai_settings.current_month_usage_cents as f64 / 100.0,
                    budget as f64 / 100.0
                );
            }
        }

        Ok(cost)
    }

    /// Get current usage summary
    pub async fn get_usage_summary(&self) -> UsageSummary {
        let settings = self.settings.read().await;
        let ai_settings = &settings.ai;
        let current_month = Self::get_current_month();

        // Reset if new month (read-only check)
        let current_usage = if ai_settings.current_usage_month == Some(current_month) {
            ai_settings.current_month_usage_cents
        } else {
            0
        };

        let usage_percentage = ai_settings.monthly_budget_cents.map(|budget| {
            if budget == 0 {
                100.0
            } else {
                (current_usage as f64 / budget as f64) * 100.0
            }
        });

        UsageSummary {
            current_month_usage_cents: current_usage,
            monthly_budget_cents: ai_settings.monthly_budget_cents,
            usage_percentage,
            per_request_limit_cents: ai_settings.per_request_limit_cents,
            is_approaching_limit: usage_percentage.map(|p| p >= 80.0).unwrap_or(false),
            is_over_budget: usage_percentage.map(|p| p >= 100.0).unwrap_or(false),
            current_month,
        }
    }

    /// Reset monthly usage (usually automatic on month change)
    pub async fn reset_monthly_usage(&self) {
        let mut settings = self.settings.write().await;
        let ai_settings = &mut settings.ai;

        info!(
            "Resetting monthly usage. Previous: {} cents",
            ai_settings.current_month_usage_cents
        );

        ai_settings.current_month_usage_cents = 0;
        ai_settings.current_usage_month = Some(Self::get_current_month());
    }

    /// Get current month in YYYYMM format
    fn get_current_month() -> u32 {
        use chrono::{Datelike, Utc};
        let now = Utc::now();
        (now.year() as u32) * 100 + now.month()
    }

    /// Estimate cost for a given number of tokens (before making request)
    pub fn estimate_cost(
        &self,
        provider: ProviderType,
        model: &str,
        input_tokens: u32,
        estimated_output_tokens: u32,
    ) -> Result<u32, CostError> {
        let usage = TokenUsage {
            prompt_tokens: input_tokens,
            completion_tokens: estimated_output_tokens,
            total_tokens: input_tokens + estimated_output_tokens,
        };
        self.calculate_cost(provider, model, &usage)
    }

    /// Estimate cost for video generation based on quality tier and duration
    pub fn estimate_video_generation_cost(
        &self,
        quality: VideoQuality,
        duration_sec: f64,
    ) -> VideoCostEstimate {
        VideoCostEstimate::calculate(quality, duration_sec)
    }

    /// Check if a video generation request fits within the budget
    pub async fn check_video_budget(&self, estimated_cents: u32) -> Result<(), CostError> {
        let settings = self.settings.read().await;
        let ai_settings = &settings.ai;

        // 0 means unlimited for video generation requests.
        if ai_settings.video_gen_per_request_limit_cents > 0
            && estimated_cents > ai_settings.video_gen_per_request_limit_cents
        {
            return Err(CostError::PerRequestLimitExceeded {
                estimated_cost_cents: estimated_cents,
                limit_cents: ai_settings.video_gen_per_request_limit_cents,
            });
        }

        // Reuse current month usage tracking until dedicated video usage metrics are introduced.
        if let Some(budget) = ai_settings.video_gen_budget_cents {
            let new_total = ai_settings.current_month_usage_cents + estimated_cents;
            if new_total > budget {
                return Err(CostError::MonthlyBudgetExceeded {
                    estimated_cost_cents: estimated_cents,
                    current_usage_cents: ai_settings.current_month_usage_cents,
                    budget_cents: budget,
                });
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_settings() -> Arc<RwLock<AppSettings>> {
        let mut settings = AppSettings::default();
        settings.ai.monthly_budget_cents = Some(1000); // $10 budget
        settings.ai.per_request_limit_cents = 100; // $1 per request limit
        settings.ai.current_month_usage_cents = 0;
        settings.ai.current_usage_month = Some(CostTracker::get_current_month());
        Arc::new(RwLock::new(settings))
    }

    #[test]
    fn test_model_pricing_calculation() {
        let pricing = ModelPricing::new(3.0, 15.0); // Claude Sonnet pricing
        let usage = TokenUsage {
            prompt_tokens: 1000,
            completion_tokens: 500,
            total_tokens: 1500,
        };

        // 1K input * 3 cents + 0.5K output * 15 cents = 3 + 7.5 = 10.5 -> 11 cents (ceiling)
        let cost = pricing.calculate_cost(&usage);
        assert_eq!(cost, 11);
    }

    #[test]
    fn test_model_pricing_zero_tokens() {
        let pricing = ModelPricing::new(3.0, 15.0);
        let usage = TokenUsage {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        };

        let cost = pricing.calculate_cost(&usage);
        assert_eq!(cost, 0);
    }

    #[test]
    fn test_local_models_are_free() {
        let settings = create_test_settings();
        let tracker = CostTracker::new(settings);

        let pricing = tracker.get_pricing(ProviderType::Local, "any-model");
        assert!(pricing.is_some());
        let pricing = pricing.unwrap();
        assert_eq!(pricing.input_cents_per_1k, 0.0);
        assert_eq!(pricing.output_cents_per_1k, 0.0);
    }

    #[test]
    fn test_known_model_pricing() {
        let settings = create_test_settings();
        let tracker = CostTracker::new(settings);

        // Claude Sonnet
        let pricing = tracker
            .get_pricing(ProviderType::Anthropic, "claude-sonnet-4-5-20251015")
            .unwrap();
        assert_eq!(pricing.input_cents_per_1k, 3.0);
        assert_eq!(pricing.output_cents_per_1k, 15.0);

        // GPT-4o
        let pricing = tracker.get_pricing(ProviderType::OpenAI, "gpt-4o").unwrap();
        assert_eq!(pricing.input_cents_per_1k, 2.5);
        assert_eq!(pricing.output_cents_per_1k, 10.0);

        // Gemini
        let pricing = tracker
            .get_pricing(ProviderType::Gemini, "gemini-2.5-pro")
            .unwrap();
        assert_eq!(pricing.input_cents_per_1k, 1.25);
        assert_eq!(pricing.output_cents_per_1k, 5.0);
    }

    #[test]
    fn test_unknown_model_returns_none() {
        let settings = create_test_settings();
        let tracker = CostTracker::new(settings);

        let pricing = tracker.get_pricing(ProviderType::OpenAI, "unknown-model-xyz");
        assert!(pricing.is_none());
    }

    #[tokio::test]
    async fn test_check_budget_within_limits() {
        let settings = create_test_settings();
        let tracker = CostTracker::new(settings);

        // 50 cents is within both per-request (100) and monthly (1000) limits
        let result = tracker.check_budget(50).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_check_budget_exceeds_per_request_limit() {
        let settings = create_test_settings();
        let tracker = CostTracker::new(settings);

        // 150 cents exceeds per-request limit of 100
        let result = tracker.check_budget(150).await;
        assert!(matches!(
            result,
            Err(CostError::PerRequestLimitExceeded { .. })
        ));
    }

    #[tokio::test]
    async fn test_check_budget_exceeds_monthly_budget() {
        let settings = create_test_settings();
        {
            let mut s = settings.write().await;
            s.ai.current_month_usage_cents = 950; // Already used $9.50
        }
        let tracker = CostTracker::new(settings);

        // 75 cents would put us over the $10 budget (950 + 75 = 1025 > 1000)
        let result = tracker.check_budget(75).await;
        assert!(matches!(
            result,
            Err(CostError::MonthlyBudgetExceeded { .. })
        ));
    }

    #[tokio::test]
    async fn test_record_usage() {
        let settings = create_test_settings();
        let tracker = CostTracker::new(settings.clone());

        let usage = TokenUsage {
            prompt_tokens: 1000,
            completion_tokens: 500,
            total_tokens: 1500,
        };

        let cost = tracker
            .record_usage(
                ProviderType::Anthropic,
                "claude-sonnet-4-5-20251015",
                &usage,
            )
            .await
            .unwrap();

        // Verify cost was recorded
        let s = settings.read().await;
        assert_eq!(s.ai.current_month_usage_cents, cost);
    }

    #[tokio::test]
    async fn test_get_usage_summary() {
        let settings = create_test_settings();
        {
            let mut s = settings.write().await;
            s.ai.current_month_usage_cents = 800; // $8 used
        }
        let tracker = CostTracker::new(settings);

        let summary = tracker.get_usage_summary().await;
        assert_eq!(summary.current_month_usage_cents, 800);
        assert_eq!(summary.monthly_budget_cents, Some(1000));
        assert!((summary.usage_percentage.unwrap() - 80.0).abs() < 0.01);
        assert!(summary.is_approaching_limit);
        assert!(!summary.is_over_budget);
    }

    #[tokio::test]
    async fn test_reset_monthly_usage() {
        let settings = create_test_settings();
        {
            let mut s = settings.write().await;
            s.ai.current_month_usage_cents = 500;
        }
        let tracker = CostTracker::new(settings.clone());

        tracker.reset_monthly_usage().await;

        let s = settings.read().await;
        assert_eq!(s.ai.current_month_usage_cents, 0);
    }

    #[test]
    fn test_estimate_cost() {
        let settings = create_test_settings();
        let tracker = CostTracker::new(settings);

        // Estimate for 2000 input, 1000 output tokens with Claude Sonnet
        let cost = tracker
            .estimate_cost(
                ProviderType::Anthropic,
                "claude-sonnet-4-5-20251015",
                2000,
                1000,
            )
            .unwrap();

        // 2K input * 3 cents + 1K output * 15 cents = 6 + 15 = 21 cents
        assert_eq!(cost, 21);
    }

    #[test]
    fn test_cost_error_display() {
        let error = CostError::PerRequestLimitExceeded {
            estimated_cost_cents: 150,
            limit_cents: 100,
        };
        let display = format!("{}", error);
        assert!(display.contains("$1.50"));
        assert!(display.contains("$1.00"));
    }

    #[tokio::test]
    async fn test_unlimited_budget() {
        let settings = Arc::new(RwLock::new(AppSettings::default()));
        {
            let mut s = settings.write().await;
            s.ai.monthly_budget_cents = None; // Unlimited
            s.ai.per_request_limit_cents = 1000;
        }
        let tracker = CostTracker::new(settings);

        // Large request should be allowed with unlimited budget
        let result = tracker.check_budget(500).await;
        assert!(result.is_ok());
    }

    // ========================================================================
    // Video Generation Cost Tests
    // ========================================================================

    #[test]
    fn test_estimate_video_generation_cost_basic() {
        let settings = create_test_settings();
        let tracker = CostTracker::new(settings);

        let estimate = tracker.estimate_video_generation_cost(VideoQuality::Basic, 60.0);
        assert_eq!(estimate.cents, 10); // 1 min * 10 cents/min
        assert_eq!(estimate.quality, VideoQuality::Basic);
    }

    #[test]
    fn test_estimate_video_generation_cost_pro() {
        let settings = create_test_settings();
        let tracker = CostTracker::new(settings);

        let estimate = tracker.estimate_video_generation_cost(VideoQuality::Pro, 30.0);
        assert_eq!(estimate.cents, 15); // 0.5 min * 30 cents/min
    }

    #[test]
    fn test_estimate_video_generation_cost_cinema() {
        let settings = create_test_settings();
        let tracker = CostTracker::new(settings);

        let estimate = tracker.estimate_video_generation_cost(VideoQuality::Cinema, 120.0);
        assert_eq!(estimate.cents, 160); // 2 min * 80 cents/min
    }

    #[tokio::test]
    async fn test_check_video_budget_within_limits() {
        let settings = create_test_settings();
        let tracker = CostTracker::new(settings);

        let result = tracker.check_video_budget(50).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_check_video_budget_exceeds_limit() {
        let settings = create_test_settings();
        let tracker = CostTracker::new(settings);

        // 150 cents exceeds per-request limit of 100
        let result = tracker.check_video_budget(150).await;
        assert!(matches!(
            result,
            Err(CostError::PerRequestLimitExceeded { .. })
        ));
    }
}
